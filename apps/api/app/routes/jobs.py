"""GET /api/jobs/{prompt_id}/events —— SSE 转发 ComfyUI 进度，完成时回推图片 URL。

后端用 client_id 连 ComfyUI 的 WebSocket，把 progress 事件转成 SSE 推给前端；
执行结束后查 history 取图片引用，推 done 事件（含经后端代理的图片 URL）。
"""
from __future__ import annotations

import asyncio
import inspect
import json
from functools import lru_cache

import websockets
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field, ValidationError
from sqlmodel import Session, or_, select
from sse_starlette.sse import EventSourceResponse

from app.comfy.client import ComfyUIClient, ComfyUIError
from app.comfy.pool import WorkerPool
from app.comfy.tracker import mark_status, record_result
from app.config import get_settings
from app.db import engine, get_session
from app.deps import get_current_user, get_pool, resolve_worker
from app.models import Job, User
from app.nsfw_ctx import nsfw_allowed

router = APIRouter()


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
        # 版本树:parent 空=根;root_id 归一为自身 id,前端按它分组
        "parent_id": j.parent_id or "",
        "root_id": (j.root_id or j.id) if j.id else "",
        "has_params": bool(j.params),  # 有快照才能精确重生(旧数据无)
    }


@router.get("/jobs")
def list_jobs(
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> list[dict]:
    """当前用户的作业历史(最新在前)。"""
    stmt = select(Job).where(Job.user_id == user.id)
    # R18 门槛:仅 /nsfw 专页(带 X-NSFW header)才返回成人向作品;主站一律剔除。
    if not nsfw_allowed(user):
        stmt = stmt.where(Job.nsfw == False)  # noqa: E712  SQLModel 需 == 比较生成 SQL
    rows = session.exec(stmt.order_by(Job.created_at.desc()).limit(50)).all()
    return [_job_dict(j) for j in rows]


@router.delete("/jobs/{job_id}")
def delete_job(
    job_id: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    """从作品库删除当前用户的一件作品(删库记录使其从作品库消失)。

    仅删自己的作业(user_id 校验);非本人/不存在一律 404(不泄露存在性)。
    产物文件留在 worker 输出目录(物理清理属另一关注点,不在此处理)。
    """
    job = session.exec(select(Job).where(Job.id == job_id)).first()
    if not job or job.user_id != user.id:
        raise HTTPException(status_code=404, detail="作品不存在")
    session.delete(job)
    session.commit()
    return {"ok": True, "id": job_id}


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


async def _emit_done(client: ComfyUIClient, prompt_id: str) -> dict:
    urls = await record_result(client, prompt_id)
    return {"event": "done", "data": json.dumps({"images": urls})}


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
        # 防竞态：若任务在 WS 连接前已完成，直接回推结果
        try:
            if await client.get_result_files(prompt_id):
                yield await _emit_done(client, prompt_id)
                return
        except ComfyUIError:
            pass  # history 还没准备好，转入 WS 监听

        try:
            async with websockets.connect(client.ws_url(client_id), max_size=None) as ws:
                async for raw in ws:
                    if await request.is_disconnected():
                        break
                    if isinstance(raw, (bytes, bytearray)):
                        continue  # 预览图二进制帧，P0 忽略
                    msg = json.loads(raw)
                    mtype, data = msg.get("type"), msg.get("data", {})

                    if mtype == "progress":
                        yield {"event": "progress", "data": json.dumps({"value": data.get("value"), "max": data.get("max")})}
                    elif mtype == "executing" and data.get("node") is None and data.get("prompt_id") == prompt_id:
                        yield await _emit_done(client, prompt_id)
                        break
                    elif mtype == "execution_error" and data.get("prompt_id") == prompt_id:
                        mark_status(prompt_id, "error")
                        yield {"event": "error", "data": json.dumps({"message": data.get("exception_message", "执行失败")})}
                        break
        except (OSError, ComfyUIError, websockets.WebSocketException) as e:
            mark_status(prompt_id, "error")
            yield {"event": "error", "data": json.dumps({"message": str(e)})}

    return EventSourceResponse(stream())
