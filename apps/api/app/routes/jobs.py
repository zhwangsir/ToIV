"""GET /api/jobs/{prompt_id}/events —— SSE 转发 ComfyUI 进度，完成时回推图片 URL。

后端用 client_id 连 ComfyUI 的 WebSocket，把 progress 事件转成 SSE 推给前端；
执行结束后查 history 取图片引用，推 done 事件（含经后端代理的图片 URL）。
"""
from __future__ import annotations

import asyncio
import inspect
import json
import logging
import time
from datetime import datetime, timedelta, timezone
from functools import lru_cache

import websockets
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field, ValidationError
from sqlmodel import Session, or_, select
from sse_starlette.sse import EventSourceResponse

from app import audit
from app.comfy.client import ComfyUIClient, ComfyUIError
from app.comfy.pool import WorkerPool
from app.comfy.tracker import mark_status, record_result, write_progress
from app.config import get_settings
from app.db import engine, get_session
from app.deps import get_current_user, get_pool, resolve_worker
from app.models import Job, User
from app.nsfw_ctx import nsfw_allowed
from app.scoring import VideoScorer, VideoScoreResult

router = APIRouter()
logger = logging.getLogger(__name__)

# 视频生成类作业 kind —— SSE done 之前会调 VideoScorer 评估质量、低分推 quality_warning。
# 非视频(txt2img/img2img/...) 与后处理(frame_interpolate)不评估,避免无意义 VLM 调用。
VIDEO_KINDS = frozenset(
    {
        "ltx_t2v",
        "ltx_i2v",
        "ltx_lipsync",
        "ltx2_t2v",
        "ltx2_i2v",
        "wan_t2v",
        "wan_i2v",
        "hunyuan_i2v",
        "anime_lipsync",
        "dub_lipsync_long",
    }
)


def _batch_id_of(j: Job) -> str:
    """内容分组 id(360° 环绕序列同批归组):从 params 快照解析,快照缺失/损坏回落空串。

    纯增量键,旧前端忽略;不新增列——params 快照已是唯一事实源。
    """
    if not j.params:
        return ""
    try:
        v = json.loads(j.params).get("batch_id")
    except (ValueError, AttributeError):
        return ""
    return v if isinstance(v, str) else ""


def _job_dict(j: Job) -> dict:
    """作业 → 前端条目(作品库列表与版本链共用同一形状)。"""
    return {
        "id": j.id,
        "prompt_id": j.prompt_id,
        "kind": j.kind,
        "status": j.status,
        "prompt": j.prompt,
        "seed": j.seed,
        "created_at": j.created_at.isoformat(),
        "results": json.loads(j.result) if j.result else [],
        # 时长后处理(trim/extend)标记:processing 时 results 为未裁原片,
        # 前端结果区应显示「精确裁切中」,待清零后重拉取终产物
        "post_status": j.post_status or "",
        # R18 标记:专区内(/nsfw 带 X-NSFW)前端据此过滤出 R18 作品库
        "nsfw": bool(j.nsfw),
        # 版本树:parent 空=根;root_id 归一为自身 id,前端按它分组
        "parent_id": j.parent_id or "",
        "root_id": (j.root_id or j.id) if j.id else "",
        "has_params": bool(j.params),  # 有快照才能精确重生(旧数据无)
        # 资源预算二期:held 作业的排队原因(资源不足说明/超时说明);非 held 为空串。
        # 纯增量键,旧前端忽略;status=held 属未知状态,前端按排队态展示不炸。
        "hold_reason": j.hold_reason or "",
        # 内容分组 id(360° 环绕序列同批归组):无分组为空串;从 params 快照解析
        "batch_id": _batch_id_of(j),
    }


# ---------------------------------------------------------------------------
# 全量进度体系(2026-08-29):任务中心 GET /api/jobs/active
# ---------------------------------------------------------------------------
# 引擎典型耗时(秒,ETA 粗估;按 kind 前缀最长匹配,未命中回落 120s)。
# 来源:生产实测经验值(H3 单段 10-15min、wan_i2v ~5-8min、t2i ~1min)。
# 仅用于「心里有数」级 ETA,不用于任何调度决策。
_KIND_TYPICAL_SEC: tuple[tuple[str, int], ...] = (
    ("drama_char_reference", 120),
    ("h3_extend", 900),
    ("h3_", 900),
    ("longcat", 600),
    ("phantom", 600),
    ("ovi_", 600),
    ("wan_", 420),
    ("ltx25_multishot", 600),
    ("ltx", 300),
    ("qwen_edit", 90),
    ("threed", 180),
    ("avatar", 300),
    ("upscale", 300),
    ("img2img", 60),
    ("txt2img", 60),
)
_TYPICAL_FALLBACK_SEC = 120


def _typical_sec(kind: str) -> int:
    for prefix, sec in _KIND_TYPICAL_SEC:
        if kind.startswith(prefix):
            return sec
    return _TYPICAL_FALLBACK_SEC


@router.get("/jobs/active")
def list_active_jobs(
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    """任务中心:当前租户全部非终态作业 + 进度快照 + ETA 粗估。

    进度来源:Job.progress JSON(tracker 写 queue_pos / SSE 写 step)。
    ETA:排队位 × 引擎均耗;生成中按 pct 折算剩余,无 pct 给均耗全量。
    held 作业无 ETA(等资源释放,返回 hold_reason)。
    """
    rows = session.exec(
        select(Job)
        .where(
            Job.tenant_id == user.tenant_id,
            Job.status.in_(("queued", "running", "held")),  # type: ignore[attr-defined]
            Job.deleted_at.is_(None),  # type: ignore[union-attr]
        )
        .order_by(Job.created_at)  # type: ignore[arg-type]
    ).all()
    now = datetime.now(timezone.utc)
    items: list[dict] = []
    for j in rows:
        created = j.created_at
        if created.tzinfo is None:
            created = created.replace(tzinfo=timezone.utc)
        wait_sec = max(0, int((now - created).total_seconds()))
        try:
            snap = json.loads(j.progress) if j.progress else {}
        except (ValueError, TypeError):
            snap = {}
        queue_pos = snap.get("queue_pos")
        pct = snap.get("pct")
        typical = _typical_sec(j.kind)
        eta_sec: int | None
        if j.status == "held":
            eta_sec = None
        elif isinstance(queue_pos, int) and queue_pos > 0:
            eta_sec = queue_pos * typical
        elif isinstance(pct, int) and pct > 0:
            eta_sec = max(0, int(typical * (100 - pct) / 100))
        else:
            eta_sec = typical
        items.append(
            {
                "id": j.id,
                "prompt_id": j.prompt_id,
                "kind": j.kind,
                "status": j.status,
                "prompt": j.prompt[:200],
                "worker": j.worker,
                "created_at": created.isoformat(),
                "wait_sec": wait_sec,
                "eta_sec": eta_sec,
                "progress": {
                    "pct": pct if isinstance(pct, int) else None,
                    "step": snap.get("step"),
                    "total": snap.get("total"),
                    "queue_pos": queue_pos if isinstance(queue_pos, int) else None,
                    "updated_at": snap.get("updated_at"),
                },
                "hold_reason": j.hold_reason or "",
                "nsfw": bool(j.nsfw),
            }
        )
    return {"items": items, "server_time": now.isoformat()}


@router.get("/jobs")
def list_jobs(
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0, description="分页偏移(作品库无限滚动;返回数==limit 即可能还有下一页)"),
    status: str = Query(default="", description="按状态过滤:queued/held/running/done/error,空=全部"),
    kind: str = Query(default="", description="按媒体类型过滤:txt2img/img2img/video/txt2video/audio/3d 等,逗号分隔多值,空=全部"),
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> list[dict]:
    """当前用户的作业历史(最新在前)。limit 可调,默认 50,上限 200;offset 分页;kind/status 过滤叠加。"""
    stmt = select(Job).where(Job.user_id == user.id)
    # 软删除(SAFETY):撤销窗口内已移除的作品不进列表;undo 恢复后自动回归
    stmt = stmt.where(Job.deleted_at == None)  # noqa: E712
    # R18 门槛:仅 /nsfw 专页(带 X-NSFW header)才返回成人向作品;主站一律剔除。
    if not nsfw_allowed(user):
        stmt = stmt.where(Job.nsfw == False)  # noqa: E712  SQLModel 需 == 比较生成 SQL
    if status:
        stmt = stmt.where(Job.status == status)
    if kind:
        kinds = [k.strip() for k in kind.split(",") if k.strip()]
        if kinds:
            stmt = stmt.where(Job.kind.in_(kinds))
    rows = session.exec(
        stmt.order_by(Job.created_at.desc()).offset(offset).limit(limit)
    ).all()
    return [_job_dict(j) for j in rows]


@router.delete("/jobs/{job_id}")
def delete_job(
    job_id: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    """从作品库移除当前用户的一件作品(SAFETY:软删除 + 72 小时回收站保留期)。

    仅删自己的作业(user_id 校验);非本人/不存在一律 404(不泄露存在性)。
    产物文件留在 worker 输出目录;行只打 deleted_at 标记,保留期内凭返回的
    undo_token POST /api/undo/{token} 或经回收站 POST /api/jobs/{id}/restore 恢复;
    过期由清理任务物理删除(audit.trash_purge_loop)。
    """
    job = session.exec(select(Job).where(Job.id == job_id)).first()
    if not job or job.user_id != user.id:
        raise HTTPException(status_code=404, detail="作品不存在")
    job.deleted_at = datetime.now(timezone.utc)
    session.add(job)
    _, token = audit.record(
        session, user=user, action="job.delete", target_type="job", target_id=job.id,
        summary=f"删除作品:{(job.prompt or '')[:40]}",
        detail={"kind": job.kind, "status": job.status},
        undo_ttl=audit.UNDO_TTL_SECONDS,
    )
    session.commit()
    return {
        "ok": True,
        "id": job_id,
        "undo_token": token,
        "undo_expires_at": (
            job.deleted_at + timedelta(seconds=audit.UNDO_TTL_SECONDS)
        ).isoformat(),
        "undo_ttl": audit.UNDO_TTL_SECONDS,
    }


# ---------------------------------------------------------------------------
# 回收站(2026-08-23):软删作品在保留期(audit.UNDO_TTL_SECONDS,72h)内可浏览/恢复/
# 彻底删除;过期行由 audit.trash_purge_loop 物理删除,不再出现在列表。
# deleted_at 列是 naive UTC TIMESTAMP,读出统一 _as_utc 归一再算剩余时间。
# ---------------------------------------------------------------------------


def _as_utc(dt: datetime) -> datetime:
    """naive UTC datetime → aware(库列是 naive TIMESTAMP;已 aware 则原样)。"""
    return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt


def _trash_cutoff() -> datetime:
    """保留期截止点(naive UTC,与 deleted_at 列同口径,可直接进 WHERE)。"""
    return (datetime.now(timezone.utc) - timedelta(seconds=audit.UNDO_TTL_SECONDS)).replace(
        tzinfo=None
    )


def _trash_dict(j: Job) -> dict:
    """回收站条目 = 作品库条目形状 + 删除时间/恢复截止/剩余秒数。"""
    deleted = _as_utc(j.deleted_at)  # type: ignore[arg-type]  调用方保证非空
    expires = deleted + timedelta(seconds=audit.UNDO_TTL_SECONDS)
    remaining = max(0, int((expires - datetime.now(timezone.utc)).total_seconds()))
    return {
        **_job_dict(j),
        "deleted_at": deleted.isoformat(),
        "restore_expires_at": expires.isoformat(),
        "restore_remaining_seconds": remaining,
    }


def _trashed_owned_job(session: Session, user: User, job_id: str) -> Job:
    """取当前用户回收站中的一件作品;不存在/非本人/未删除一律 404(不泄露存在性)。"""
    job = session.exec(select(Job).where(Job.id == job_id)).first()
    if not job or job.user_id != user.id or job.deleted_at is None:
        raise HTTPException(status_code=404, detail="回收站中没有该作品")
    return job


@router.get("/jobs/trash")
def list_trash(
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> list[dict]:
    """当前用户的回收站(删除时间倒序;仅保留期内的条目,过期由清理任务物理删除)。

    归属/门控规则与 GET /api/jobs 一致:只看自己的;主站(非 X-NSFW 上下文)剔除 R18。
    """
    stmt = select(Job).where(
        Job.user_id == user.id,
        Job.deleted_at != None,  # noqa: E712  SQLModel 需 == 比较生成 SQL
        Job.deleted_at > _trash_cutoff(),
    )
    if not nsfw_allowed(user):
        stmt = stmt.where(Job.nsfw == False)  # noqa: E712
    rows = session.exec(
        stmt.order_by(Job.deleted_at.desc()).offset(offset).limit(limit)
    ).all()
    return [_trash_dict(j) for j in rows]


@router.post("/jobs/{job_id}/restore")
def restore_job(
    job_id: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    """从回收站恢复一件作品(清 deleted_at,作品回归作品库;与 undo 同一条复活路径)。"""
    job = _trashed_owned_job(session, user, job_id)
    if _as_utc(job.deleted_at) + timedelta(seconds=audit.UNDO_TTL_SECONDS) < datetime.now(
        timezone.utc
    ):
        raise HTTPException(status_code=410, detail="保留期已过,作品已被清理,无法恢复")
    job.deleted_at = None
    session.add(job)
    audit.record(
        session, user=user, action="job.restore", target_type="job", target_id=job.id,
        summary=f"回收站恢复作品:{(job.prompt or '')[:40]}",
    )
    session.commit()
    return {"ok": True, "restored": True, "id": job.id}


@router.delete("/jobs/{job_id}/permanent")
def permanent_delete_job(
    job_id: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    """立即物理删除回收站中的一件作品(不可恢复;与定期清理同一删除路径)。"""
    job = _trashed_owned_job(session, user, job_id)
    audit.purge_job_row(session, job)
    audit.record(
        session, user=user, action="job.purge", target_type="job", target_id=job_id,
        summary=f"彻底删除作品:{(job.prompt or '')[:40]}",
        detail={"kind": job.kind, "status": job.status},
    )
    session.commit()
    return {"ok": True, "id": job_id}


@router.post("/jobs/trash/purge")
def purge_trash(
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    """一键清空回收站:当前用户保留期内的软删作品全部物理删除(不可恢复)。

    路径用 /jobs/trash/purge 而非 DELETE /jobs/trash:DELETE /jobs/{job_id} 注册
    在前,会把 "trash" 当成 job_id 吞掉。归属/门控口径与 GET /jobs/trash 一致
    (只看自己的;主站上下文不碰 R18 条目——它们留在桶里等过期清理)。
    """
    stmt = select(Job).where(
        Job.user_id == user.id,
        Job.deleted_at != None,  # noqa: E712  SQLModel 需 == 比较生成 SQL
        Job.deleted_at > _trash_cutoff(),
    )
    if not nsfw_allowed(user):
        stmt = stmt.where(Job.nsfw == False)  # noqa: E712
    rows = session.exec(stmt).all()
    for job in rows:
        audit.purge_job_row(session, job)
    audit.record(
        session, user=user, action="job.purge_all", target_type="job",
        summary=f"清空回收站:{len(rows)} 件作品彻底删除",
        detail={"count": len(rows)},
    )
    session.commit()
    return {"ok": True, "purged": len(rows)}


# ---------------------------------------------------------------------------
# 版本树:任意历史作业可精确重生(rerun)/ 查同根版本链(versions)。
# 寻址同时接受 Job.id 与 prompt_id(前端结果卡只拿得到 prompt_id)。
# ---------------------------------------------------------------------------


def _owned_job(session: Session, user: User, key: str) -> Job:
    """按 id 或 prompt_id 取当前用户的作业;不存在/非本人/主站碰 R18 一律 404。"""
    job = session.exec(select(Job).where(Job.id == key, Job.user_id == user.id)).first()
    if job is None:
        job = session.exec(
            select(Job).where(Job.prompt_id == key, Job.user_id == user.id)
        ).first()
    # 软删除(SAFETY):已移除作品视同不存在(rerun/版本链/详情均不可达;undo 恢复后回归)
    if job is not None and job.deleted_at is not None:
        job = None
    if job is None or (job.nsfw and not nsfw_allowed(user)):
        raise HTTPException(status_code=404, detail="作品不存在")
    return job


@lru_cache
def _rerun_registry() -> dict[str, tuple[type[BaseModel], object]]:
    """kind → (请求模型, 原生成端点函数)。惰性导入,避免启动期路由互相依赖。

    rerun 直接调用原端点函数:同一套参数校验 / R18 门槛 / 限流 / 建档 / 追踪,
    不复制任何生成逻辑。agent_* 与 cad_* 类作业不在表内(暂不支持精确重生)。
    """
    from app.routes import generate as g
    from app.routes.audio import AudioRequest, generate_audio
    from app.routes.lipsync import LipsyncRequest, lipsync_shot
    from app.routes.manju import ShotRenderRequest, render_shot
    from app.routes.threed import Gen3DRequest, generate_3d
    from app.routes.video import WanI2VRequest, generate_video
    from app.routes.video_upscale import VideoUpscaleRequest, upscale_video

    return {
        "txt2img": (g.Txt2ImgRequest, g.generate_txt2img),
        "wan_t2v": (g.Txt2VideoRequest, g.generate_txt2video),
        "img2img": (g.Img2ImgRequest, g.generate_img2img),
        "controlnet": (g.ControlNetRequest, g.generate_controlnet),
        "upscale": (g.UpscaleRequest, g.generate_upscale),
        "facedetailer": (g.FaceDetailerRequest, g.generate_facedetailer),
        "raw": (g.RawWorkflowRequest, g.generate_raw),
        "removebg": (g.RemoveBgRequest, g.generate_removebg),
        "inpaint": (g.InpaintRequest, g.generate_inpaint),
        "wan_i2v": (WanI2VRequest, generate_video),
        "hunyuan3d": (Gen3DRequest, generate_3d),
        "ace_audio": (AudioRequest, generate_audio),
        "manju_lipsync": (LipsyncRequest, lipsync_shot),
        "manju_shot_txt2img": (ShotRenderRequest, render_shot),
        "manju_shot_ipadapter": (ShotRenderRequest, render_shot),
        "video_upscale": (VideoUpscaleRequest, upscale_video),
    }


class RerunRequest(BaseModel):
    """seed_mode:keep=锁 seed 微调 / random=换 seed 重抽 / explicit=指定 seed。"""

    seed_mode: str = Field(default="keep", pattern="^(keep|random|explicit)$")
    seed: int | None = Field(default=None, ge=0, le=2**63 - 1)
    # 增量覆盖(如只改 positive);仅接受该类型请求模型认识的字段
    overrides: dict[str, object] = Field(default_factory=dict)


@router.post("/jobs/{job_key}/rerun")
async def rerun_job(
    job_key: str,
    body: RerunRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
    pool: WorkerPool = Depends(get_pool),
) -> dict:
    """从历史作业的参数快照精确重生;新作业自动挂进版本链(parent/root)。

    改动最小化:除 seed 策略与显式 overrides 外,快照参数原样复放。
    """
    src = _owned_job(session, user, job_key)
    entry = _rerun_registry().get(src.kind)
    if entry is None:
        raise HTTPException(status_code=400, detail=f"该类型作业暂不支持重新生成:{src.kind}")
    if not src.params:
        raise HTTPException(
            status_code=400,
            detail="该作品是旧版数据,缺少参数快照,无法精确重生;重新创作一次后即可使用版本功能",
        )
    try:
        data = json.loads(src.params)
    except ValueError as e:
        raise HTTPException(status_code=400, detail="参数快照损坏,无法重生") from e
    if not isinstance(data, dict):
        raise HTTPException(status_code=400, detail="参数快照损坏,无法重生")

    model_cls, handler = entry
    fields = model_cls.model_fields
    for k, v in (body.overrides or {}).items():
        if k in fields:
            data[k] = v
    if "seed" in fields:
        if body.seed_mode == "keep":
            data["seed"] = src.seed if src.seed is not None else data.get("seed")
        elif body.seed_mode == "random":
            data.pop("seed", None)  # 原端点按缺省随机
        else:  # explicit
            if body.seed is None:
                raise HTTPException(status_code=422, detail="seed_mode=explicit 需提供 seed")
            data["seed"] = body.seed
    data = {k: v for k, v in data.items() if k in fields}

    try:
        req = model_cls(**data)
    except ValidationError as e:
        raise HTTPException(
            status_code=422, detail=f"快照参数校验失败:{e.errors()[:3]}"
        ) from e

    kwargs: dict = {"user": user, "session": session}
    if "pool" in inspect.signature(handler).parameters:  # type: ignore[arg-type]
        kwargs["pool"] = pool
    result = await handler(req, **kwargs)  # type: ignore[operator]

    # 原端点已建档;按新 prompt_id 回查,补版本链关系
    new_prompt_id = result.get("prompt_id") if isinstance(result, dict) else None
    if new_prompt_id:
        new_job = session.exec(
            select(Job).where(Job.prompt_id == new_prompt_id)
        ).first()
        if new_job:
            new_job.parent_id = src.id
            new_job.root_id = src.root_id or src.id
            session.add(new_job)
            session.commit()
            result = {
                **result,
                "job_id": new_job.id,
                "parent_id": src.id,
                "root_id": new_job.root_id,
            }
    return result


@router.get("/jobs/{job_key}/versions")
def job_versions(
    job_key: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> list[dict]:
    """同根版本链(时间升序)。主站过滤 R18 版本(与 /jobs 列表同一门槛)。"""
    job = _owned_job(session, user, job_key)
    root = job.root_id or job.id
    stmt = select(Job).where(
        Job.user_id == user.id, or_(Job.id == root, Job.root_id == root)
    )
    if not nsfw_allowed(user):
        stmt = stmt.where(Job.nsfw == False)  # noqa: E712  SQLModel 需 == 比较生成 SQL
    rows = session.exec(stmt.order_by(Job.created_at.asc(), Job.id.asc())).all()
    return [_job_dict(j) for j in rows]


async def _emit_done(client: ComfyUIClient, prompt_id: str) -> tuple[dict, list[str]]:
    """落库 + 构造 done SSE 事件。

    返回 (done_event, urls) 元组,urls 一并返回给调用方用于在 yield done 之前
    异步评估视频质量并可能推 quality_warning(见 _maybe_quality_warning)。

    done 事件带 post_status(emit 时现读 DB):trim/extend 链进行中为 processing,
    前端结果区据此显示「精确裁切中」而非直接播放未裁原片;清零后前端重拉终产物。
    """
    urls = await record_result(client, prompt_id)
    with Session(engine) as s:
        db = s.exec(select(Job).where(Job.prompt_id == prompt_id)).first()
        post = (db.post_status if db else "") or ""
    return {"event": "done", "data": json.dumps({"images": urls, "post_status": post})}, urls


def _persist_quality_eval(job: Job, result: VideoScoreResult) -> None:
    """评分结果(含 degraded)落库 Job 三列,供灰度观察期回溯统计降级率/低分率。

    落库失败仅 warning,绝不影响主流程(SSE done/quality_warning 照常)。
    """
    try:
        with Session(engine) as s:
            db = s.get(Job, job.id)
            if db is None:
                return
            db.quality_total = result.total
            db.quality_degraded = result.degraded
            db.quality_issues = json.dumps(result.issues[:3], ensure_ascii=False)
            s.add(db)
            s.commit()
    except Exception as e:  # noqa: BLE001 — 观察性写入,失败不阻塞
        logger.warning("quality_eval 落库失败 job=%s: %s", job.prompt_id, e)


async def _maybe_quality_warning(job: Job | None, video_url: str | None) -> dict | None:
    """视频质量评估 → 低分时返回 quality_warning SSE 事件,其余情况返回 None。

    容错优先:任何失败(配置关闭/非视频作业/无 URL/VLM 不可达/超时/降级/高分)
    都返回 None,绝不阻塞主流程、不影响 done 推送。
    """
    settings = get_settings()
    # 1. 灰度开关:VLM Server 不可达时关掉即可,零影响
    if not settings.video_scorer_enabled:
        return None
    # 2. 仅视频作业评估,图片/3D/音频等跳过
    if job is None or job.kind not in VIDEO_KINDS:
        return None
    # 3. 无产物 URL(罕见:完成但无文件)直接跳过
    if not video_url:
        return None

    started = time.monotonic()
    try:
        scorer = VideoScorer(
            settings.vlm_server_url, settings.vlm_model_id, timeout=settings.video_scorer_timeout
        )
        # 单独 wait_for:VideoScorer 内部 httpx 已按 video_scorer_timeout 超时,
        # 这里 +10s 套一层兜底防 VLM 卡死拖死 SSE。
        result = await asyncio.wait_for(
            scorer.score(video_url, job.prompt or None),
            timeout=settings.video_scorer_timeout + 10,
        )
    except asyncio.TimeoutError:
        logger.warning(
            "quality_eval job=%s total=%.3f quality_score=%d degraded=%s reason=%s dur_ms=%d",
            job.prompt_id, 0.0, 0, True, "timeout", int((time.monotonic() - started) * 1000),
        )
        return None
    except Exception as e:  # noqa: BLE001 — 评估失败绝不能影响主流程
        logger.warning(
            "quality_eval job=%s total=%.3f quality_score=%d degraded=%s reason=%s dur_ms=%d",
            job.prompt_id, 0.0, 0, True, f"error: {e}",
            int((time.monotonic() - started) * 1000),
        )
        return None

    # 每次真实点火都留结构化日志 + 落库(灰度观察期降级率/低分率回溯的唯一数据源)。
    logger.info(
        "quality_eval job=%s total=%.3f quality_score=%d degraded=%s reason=%s dur_ms=%d",
        job.prompt_id, result.total, result.quality_score, result.degraded,
        result.issues[0] if result.degraded and result.issues else "",
        int((time.monotonic() - started) * 1000),
    )
    _persist_quality_eval(job, result)

    # 4. 模型对齐降级(全 0)/解析失败:无信息,不推 warning(避免噪声)
    if result.degraded:
        return None

    # 5. 高于阈值:质量过关,无需警告
    if result.total >= settings.video_scorer_threshold:
        return None

    # raw_judgment 不进 SSE(可能很长且含敏感描述),仅留日志/库排查。
    return {
        "event": "quality_warning",
        "data": json.dumps(
            {
                "total": result.total,
                "quality_score": result.quality_score,
                "aesthetic": result.aesthetic,
                "technical": result.technical,
                "prompt_alignment": result.prompt_alignment,
                "issues": result.issues,
                "suggested_prompt": result.suggested_prompt,
                "degraded": result.degraded,
            },
            ensure_ascii=False,
        ),
    }


async def _forge_stream(prompt_id: str, request: Request):
    """Forge 引擎作业的 SSE:轮询 sdapi 全局进度 + 监听进程内作业态(完成/出错)。

    Forge 同步出图无 WS / per-job 进度;ToIV 单实例串行,/sdapi/v1/progress 即当前任务。
    进程态(forge.engine._jobs)由后台出图 task 写;api 重启丢失则回落 DB Job。
    """
    from app.forge.client import ForgeClient, ForgeError
    from app.forge.engine import job_state

    fc = ForgeClient(get_settings().forge_base, timeout=12.0)
    while True:
        if await request.is_disconnected():
            return
        st = job_state(prompt_id)
        if st and st["status"] == "done":
            yield {"event": "done", "data": json.dumps({"images": st["images"]})}
            return
        if st and st["status"] == "error":
            yield {"event": "error", "data": json.dumps({"message": st.get("error") or "Forge 出图失败"})}
            return
        if st is None:
            # 进程态丢失(api 重启)→ 回落 DB
            with Session(engine) as s:
                db = s.exec(select(Job).where(Job.prompt_id == prompt_id)).first()
                if db and db.status == "done":
                    yield {"event": "done", "data": json.dumps({"images": json.loads(db.result or "[]")})}
                    return
                if db and db.status == "error":
                    yield {"event": "error", "data": json.dumps({"message": "Forge 出图失败"})}
                    return
        try:
            pr = await fc.progress()
            stt = pr.get("state") or {}
            step = int(stt.get("sampling_step") or 0)
            total = int(stt.get("sampling_steps") or 0)
            if total > 0:
                yield {"event": "progress", "data": json.dumps({"value": step, "max": total})}
        except ForgeError:
            pass
        await asyncio.sleep(0.6)


@router.get("/jobs/{prompt_id}/events")
async def job_events(
    prompt_id: str,
    client_id: str,
    worker: str,
    request: Request,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    # 租户隔离:本作业必须属于当前用户的租户
    job = session.exec(select(Job).where(Job.prompt_id == prompt_id)).first()
    if job and job.tenant_id != user.tenant_id:
        raise HTTPException(status_code=403, detail="无权访问该作业")

    # Forge 引擎作业:无 ComfyUI WS,改轮询 sdapi 进度 + 进程内作业态。
    settings = get_settings()
    if settings.forge_base and worker.rstrip("/") == settings.forge_base:
        return EventSourceResponse(_forge_stream(prompt_id, request))

    client = resolve_worker(worker)

    async def stream():
        nonlocal prompt_id
        # 资源预算二期:held 作业(资源排队中)尚未提交,占位 prompt_id 在 worker 上
        # 不存在;周期查库等放行/终态,期间推 held 事件让前端显示「资源排队中」。
        # 不连 WS(连上也不会有事件),更不会因 WS 异常把 held 误标 error。
        while job is not None and prompt_id.startswith("hold-"):
            with Session(engine) as s:
                db = s.get(Job, job.id)
            if db is None:
                return  # 作业被物理删除(回收站 purge)
            if db.status == "held":
                if await request.is_disconnected():
                    return
                yield {"event": "held", "data": json.dumps({"reason": db.hold_reason or ""})}
                await asyncio.sleep(3.0)
                continue
            prompt_id = db.prompt_id  # 放行后占位符已换成 worker 真实 prompt_id
            if db.status == "error":
                yield {"event": "error", "data": json.dumps({"message": db.hold_reason or "执行失败"})}
                return
            if db.status == "done":
                yield {"event": "done", "data": json.dumps({"images": json.loads(db.result or "[]"), "post_status": db.post_status or ""})}
                return
            break  # queued/running:已放行,转正常 WS 流程
        # 防竞态：若任务在 WS 连接前已完成，直接回推结果
        try:
            if await client.get_result_files(prompt_id):
                done_event, urls = await _emit_done(client, prompt_id)
                # done 之前若视频质量低,先推 quality_warning(不阻塞,失败容错)
                warning = await _maybe_quality_warning(job, urls[0] if urls else None)
                if warning is not None:
                    yield warning
                yield done_event
                return
        except ComfyUIError:
            pass  # history 还没准备好，转入 WS 监听

        try:
            # proxy=None:绕过 urllib.request.getproxies() 在 macOS 上读取系统
            # 网络代理(Clash 等会注入 SOCKS,导致 WS 握手走 SOCKS 失败)。worker
            # 是 Tailscale 内网地址,无需代理。
            async with websockets.connect(client.ws_url(client_id), max_size=None, proxy=None) as ws:
                async for raw in ws:
                    if await request.is_disconnected():
                        break
                    if isinstance(raw, (bytes, bytearray)):
                        continue  # 预览图二进制帧，P0 忽略
                    msg = json.loads(raw)
                    mtype, data = msg.get("type"), msg.get("data", {})

                    if mtype == "progress":
                        # 首个进度到达时把 Job 从 queued 标为 running,让作品库状态更准确
                        if job and job.status == "queued":
                            mark_status(prompt_id, "running")
                        # 全量进度体系:step 进度节流写库(2s),任务中心无观众时也可读
                        value, total = data.get("value"), data.get("max")
                        if isinstance(value, (int, float)) and isinstance(total, (int, float)) and total > 0:
                            write_progress(
                                prompt_id,
                                pct=int(value / total * 100),
                                step=int(value),
                                total=int(total),
                                throttle=True,
                            )
                        yield {"event": "progress", "data": json.dumps({"value": data.get("value"), "max": data.get("max")})}
                    elif mtype == "executing" and data.get("node") is None and data.get("prompt_id") == prompt_id:
                        done_event, urls = await _emit_done(client, prompt_id)
                        # done 之前若视频质量低,先推 quality_warning(不阻塞,失败容错)
                        warning = await _maybe_quality_warning(job, urls[0] if urls else None)
                        if warning is not None:
                            yield warning
                        yield done_event
                        break
                    elif mtype == "execution_error" and data.get("prompt_id") == prompt_id:
                        mark_status(prompt_id, "error")
                        yield {"event": "error", "data": json.dumps({"message": data.get("exception_message", "执行失败")})}
                        break
        except (OSError, ComfyUIError, websockets.WebSocketException) as e:
            mark_status(prompt_id, "error")
            yield {"event": "error", "data": json.dumps({"message": str(e)})}

    return EventSourceResponse(stream())
