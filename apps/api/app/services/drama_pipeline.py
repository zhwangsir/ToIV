"""短剧/Studio 管线状态重算(参照 DramaClaw pipeline.py,docs/2026-08-15 第二节第 1 条)。

核心思想:不存全局状态机,管线状态由「DB 行 + 产物文件存在性」实时重算,
直接给出 next_step;断点续跑 = 从首个缺失阶段继续,天然免疫状态漂移。

- compute_drama_pipeline_status:DramaProject/DramaShot/DramaCharacter 三表
  + 本地产物存在性 + /api/images 产物 Job 行 → 七阶段状态 + next_step +
  recoverable(分裂态:shot 标 error 但 Job 已 done 且产物可用)。
- compute_studio_next_step:Studio 单 status 列 → 首个未达阶段(纯函数)。

全程只读 DB/文件系统,零写入副作用。文件 stat 带短 TTL 缓存,
单项目重算控制在 ms 级。
"""
from __future__ import annotations

import json
import logging
import time
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlsplit

from sqlmodel import Session, select

from app.models import DramaCharacter, DramaProject, DramaShot, Job, StudioShot
from app.storage import drama_output_root

logger = logging.getLogger(__name__)

# ── 产物存在性判定(ok / missing / unknown)────────────────────────────────
# unknown = 判不了的(URL 形态不认识、Job 行查不到),不武断标 missing。

_VERDICTS = ("ok", "missing", "unknown")

# 文件 stat 短 TTL 缓存:同一轮轮询(前端几秒一次)不重复 syscall;
# 与 storage.drama_output_root 的 60s 缓存同一模式,这里窗口更短(产物随时落盘)。
_STAT_TTL = 2.0
_stat_cache: dict[str, tuple[float, bool]] = {}


def _is_file_cached(path: Path) -> bool:
    """带短 TTL 的 is_file();OSError 一律按 False 记并缓存(NAS 抖动不刷屏)。"""
    key = str(path)
    now = time.monotonic()
    hit = _stat_cache.get(key)
    if hit is not None and now - hit[0] < _STAT_TTL:
        return hit[1]
    try:
        ok = path.is_file()
    except OSError:
        ok = False
    # 缓存量级受控:短剧项目产物文件名空间有限,超阈值直接清空重建
    if len(_stat_cache) > 4096:
        _stat_cache.clear()
    _stat_cache[key] = (now, ok)
    return ok


def _filename_from_images_url(url: str) -> str:
    """从 /api/images?filename=...&worker=... 提取 filename(失败返回空串)。"""
    try:
        qs = parse_qs(urlsplit(url).query)
    except ValueError:
        return ""
    return (qs.get("filename") or [""])[0]


def _job_verdict(session: Session, tenant_id: str, user_id: str, filename: str) -> tuple[str, str]:
    """/api/images 产物只能查 Job 行:status==done 且 result 含该 filename → ok。

    返回 (verdict, job_id);查不到归属 Job → unknown(可能是历史数据/异机产物,
    或产物来自非 Job 链路),不武断标 missing —— recoverable 检测另有专查。
    """
    jobs = session.exec(
        select(Job)
        .where(Job.tenant_id == tenant_id)
        .where(Job.user_id == user_id)
        .where(Job.result.contains(filename))
        .where(Job.deleted_at == None)  # noqa: E712  软删作品产物不参与归属判定(SAFETY)
        .order_by(Job.created_at.desc())  # type: ignore[union-attr]
    ).all()
    for job in jobs:
        if job.status != "done" or not job.result:
            continue
        try:
            urls = json.loads(job.result)
        except (ValueError, TypeError):
            continue
        if isinstance(urls, list) and any(filename in str(u) for u in urls):
            return "ok", job.id
    return "unknown", ""


def artifact_verdict(session: Session, tenant_id: str, user_id: str, url: str) -> tuple[str, str]:
    """判定单个产物 URL 的存在性。返回 (verdict, job_id|"")。

    路由映射(与 drama_studio.py / studio.py 的文件服务端点一致):
    - /api/drama/output/{name}  → drama_output_root()/{name}
    - /api/drama/voice/{name}   → drama_output_root()/{name}
    - /api/studio/files/{name}  → drama_output_root()/studio/{name}
    - /api/images?filename=...  → ComfyUI worker 产物,core 侧查 Job 行
    其余(外链/空串)→ unknown。
    """
    if not url:
        return "unknown", ""
    if url.startswith("/api/drama/output/") or url.startswith("/api/drama/voice/"):
        name = Path(urlsplit(url).path).name
        if not name:
            return "unknown", ""
        return ("ok" if _is_file_cached(drama_output_root() / name) else "missing"), ""
    if url.startswith("/api/studio/files/"):
        name = Path(urlsplit(url).path).name
        if not name:
            return "unknown", ""
        return ("ok" if _is_file_cached(drama_output_root() / "studio" / name) else "missing"), ""
    if url.startswith("/api/images?"):
        filename = _filename_from_images_url(url)
        if not filename:
            return "unknown", ""
        return _job_verdict(session, tenant_id, user_id, filename)
    return "unknown", ""


# ── Drama 域:七阶段重算 ───────────────────────────────────────────────────

# next_step 的 step → (中文 label, 建议调用的端点路径模板,{pid}=项目 id)
# 注:ingest/characters 是信息化阶段(项目创建=已摄入;角色库可空裸跑),
# 不进入 next_step 顺序判定;首个可执行动作从 storyboard 开始。
_STEP_LABELS: dict[str, tuple[str, str]] = {
    "ingest": ("录入剧本", "/drama/projects/{pid}"),
    "characters": ("建立角色库", "/drama/projects/{pid}/characters"),
    "storyboard": ("拆解分镜", "/drama/projects/{pid}/storyboard"),
    "video": ("生成分镜视频", "/drama/shots/{sid}/generate-video"),
    "voice": ("分镜配音", "/drama/shots/{sid}/generate-voice"),
    "lipsync": ("对口型", "/drama/shots/{sid}/lipsync"),
    "assemble": ("合成成片", "/drama/projects/{pid}/assemble"),
    "done": ("全部完成", ""),
}

_SHOT_ACTION = {
    "video": "generate-video",
    "voice": "generate-voice",
    "lipsync": "lipsync",
}


def _chain_stage(
    session: Session,
    tenant_id: str,
    user_id: str,
    shots: list[DramaShot],
    status_attr: str,
    url_attr: str,
    applicable: list[DramaShot] | None = None,
) -> dict[str, Any]:
    """聚合单链(视频/配音/对口型)的阶段状态。

    applicable:适用该链的分镜子集(如配音链只适用有台词的分镜);None=全部。
    - 无适用分镜 → done+skipped(无可做事项,不阻塞 next_step)
    - 任一分镜 error → error(先救火)
    - 状态列 done 即计入完成;产物存在性(ok/missing/unknown)做 advisory 分级,
      missing 在 detail.missing_shot_ids 点名,但不阻塞阶段完成(状态列是写回事实,
      unknown 多为历史/异机产物,不该把 next_step 卡死)
    - 其余 → partial
    """
    pool = applicable if applicable is not None else shots
    skipped = len(shots) - len(pool)
    if not pool:
        return {
            "status": "done",
            "detail": {"total": 0, "done": 0, "error": 0, "skipped": True},
        }
    artifacts: dict[str, int] = {v: 0 for v in _VERDICTS}
    n_done = n_error = n_active = 0
    missing_ids: list[str] = []
    for s in pool:
        st = getattr(s, status_attr)
        if st == "error":
            n_error += 1
            continue
        if st in ("generating", "continuing"):
            n_active += 1
            continue
        if st == "done":
            n_done += 1
            verdict, _ = artifact_verdict(session, tenant_id, user_id, getattr(s, url_attr))
            artifacts[verdict] += 1
            if verdict == "missing":
                missing_ids.append(s.id)
    detail: dict[str, Any] = {
        "total": len(pool),
        "done": n_done,
        "error": n_error,
        "artifacts": artifacts,
    }
    if skipped:
        detail["skipped"] = skipped  # 不适用本链的分镜数(如无台词不配音)
    if missing_ids:
        detail["missing_shot_ids"] = missing_ids
    if n_error:
        return {"status": "error", "detail": detail}
    if n_done == len(pool):
        return {"status": "done", "detail": detail}
    # 一个都还没开始(无 done/进行中)→ pending 等上游;已有进展 → partial
    if n_done + n_active == 0:
        return {"status": "pending", "detail": detail}
    return {"status": "partial", "detail": detail}


def _continue_stage(shots: list[DramaShot]) -> dict[str, Any]:
    """末帧续写链聚合(可选链:默认空串=未启用;段产物多 URL 不逐段 stat,控制 stat 数量)。"""
    enabled = [s for s in shots if s.continue_status]
    if not enabled:
        return {"status": "pending", "detail": {"total": 0, "done": 0, "error": 0}}
    n_done = sum(1 for s in enabled if s.continue_status == "done")
    n_error = sum(1 for s in enabled if s.continue_status == "error")
    detail = {"total": len(enabled), "done": n_done, "error": n_error}
    if n_error:
        return {"status": "error", "detail": detail}
    if n_done == len(enabled):
        return {"status": "done", "detail": detail}
    return {"status": "partial", "detail": detail}


def _find_recoverable(
    session: Session,
    tenant_id: str,
    user_id: str,
    shots: list[DramaShot],
) -> list[dict[str, Any]]:
    """分裂态检测:shot.video_status==error,但存在匹配 Job done 且产物可用 → 可恢复。

    Job 匹配策略(对齐 drama_studio.reconcile_interrupted :4436-4442 的 seed+prompt
    思路,简化为三步):① kind like drama_shot_video% ② seed 相等
    ③ prompt 相等(shot.prompt 非空时);命中后 result 首条 URL 再过一次
    artifact_verdict,确认真能取回才标记,避免误报。
    """
    recoverable: list[dict[str, Any]] = []
    candidates = [s for s in shots if s.video_status == "error"]
    if not candidates:
        return recoverable
    for shot in candidates:
        q = (
            select(Job)
            .where(Job.tenant_id == tenant_id)
            .where(Job.user_id == user_id)
            .where(Job.kind.like("drama_shot_video%"))  # type: ignore[union-attr]
            .where(Job.status == "done")
            .where(Job.seed == shot.seed)
            .order_by(Job.created_at.desc())  # type: ignore[union-attr]
        )
        if shot.prompt.strip():
            q = q.where(Job.prompt == shot.prompt.strip())
        job = session.exec(q).first()
        if job is None or not job.result:
            continue
        try:
            urls = json.loads(job.result)
        except (ValueError, TypeError):
            continue
        if not isinstance(urls, list) or not urls:
            continue
        verdict, _ = artifact_verdict(session, tenant_id, user_id, str(urls[0]))
        if verdict != "ok":
            continue
        recoverable.append(
            {
                "shot_id": shot.id,
                "shot_idx": shot.idx,
                "job_id": job.id,
                "url": str(urls[0]),
                "chain": "video",
            }
        )
    return recoverable


def _lipsync_todo(shots: list[DramaShot]) -> list[str]:
    """对口型待办:已启用未完成的 + 满足前置(video/voice done)且有台词未启用的。"""
    ids: list[str] = []
    for s in shots:
        if s.lipsync_status in ("generating", "error"):
            ids.append(s.id)
        elif (
            not s.lipsync_status
            and s.dialogue.strip()
            and s.video_status == "done"
            and s.voice_status == "done"
        ):
            ids.append(s.id)
    return ids[:20]


def _next_step(
    stages: dict[str, dict[str, Any]],
    shots: list[DramaShot],
    project_id: str,
) -> dict[str, Any]:
    """按管线顺序找首个未 done 阶段,给出建议动作。

    按管线顺序取第一个 error/pending/partial 阶段(error 即该阶段的救火,
    不会让下游 pending 抢在上游 error 前,也不会让上游未就绪时催下游);
    shot_ids 上限 20 个,防大项目响应膨胀。ingest/characters 不参与顺序
    (项目创建即已摄入,角色库可空裸跑),首个可执行阶段是 storyboard。
    """
    order = ("storyboard", "video", "voice", "lipsync", "assemble")
    target = "done"
    for name in order:
        st = stages[name]["status"]
        if st == "error" or st in ("pending", "partial"):
            target = name
            break
    label, action_tpl = _STEP_LABELS[target]
    action = action_tpl.replace("{pid}", project_id)
    out: dict[str, Any] = {"step": target, "label": label, "action": action}
    if target in _SHOT_ACTION:
        if target == "lipsync":
            todo = _lipsync_todo(shots)
        else:
            status_attr = f"{target}_status"
            pool = shots if target == "video" else [s for s in shots if s.dialogue.strip()]
            todo = [
                s.id for s in pool if getattr(s, status_attr) in ("pending", "generating", "error")
            ][:20]
        if todo:
            out["shot_ids"] = todo
            out["action"] = f"/drama/shots/{todo[0]}/{_SHOT_ACTION[target]}"
    return out


def compute_drama_pipeline_status(session: Session, project_id: str) -> dict[str, Any]:
    """重算短剧项目管线状态(只读)。返回 stages/next_step/recoverable/summary。

    调用方须先做完归属校验;项目不存在时抛 KeyError(路由层转 404)。
    """
    t0 = time.monotonic()
    project = session.get(DramaProject, project_id)
    if project is None:
        raise KeyError(project_id)
    chars = session.exec(
        select(DramaCharacter).where(DramaCharacter.project_id == project_id)
    ).all()
    shots = session.exec(
        select(DramaShot).where(DramaShot.project_id == project_id).order_by(DramaShot.idx)
    ).all()
    tid, uid = project.tenant_id, project.user_id

    stages: dict[str, dict[str, Any]] = {}

    # ① ingest:项目已创建即视作已摄入(信息化阶段,不参与 next_step 顺序);
    #    has_script 仅作 detail 透出,剧本可后补
    stages["ingest"] = {
        "status": "done",
        "detail": {"has_script": bool(project.script.strip())},
    }
    # ② characters:有角色卡;无角色但已有分镜 = 越过(裸跑),标 done+skipped
    if chars:
        stages["characters"] = {"status": "done", "detail": {"count": len(chars)}}
    elif shots:
        stages["characters"] = {"status": "done", "detail": {"count": 0, "skipped": True}}
    else:
        stages["characters"] = {"status": "pending", "detail": {"count": 0}}
    # ③ storyboard:分镜已拆解
    stages["storyboard"] = {
        "status": "done" if shots else "pending",
        "detail": {"count": len(shots)},
    }
    # ④ 视频(全分镜适用)
    stages["video"] = _chain_stage(session, tid, uid, shots, "video_status", "video_url")
    # ⑤ 配音(仅有台词分镜适用;空台词分镜 422 不可配音,算 skipped)
    voiceable = [s for s in shots if s.dialogue.strip()]
    stages["voice"] = _chain_stage(
        session, tid, uid, shots, "voice_status", "voice_url", applicable=voiceable
    )
    # ⑥ 对口型(可选链:有台词且视频/配音就绪才可启用;全部未启用 → pending 等用户触发)
    lipsyncable = [s for s in shots if s.dialogue.strip()]
    stages["lipsync"] = _chain_stage(
        session, tid, uid, shots, "lipsync_status", "lipsync_video_url", applicable=lipsyncable
    )
    # 续写链(参考信息,不参与 next_step 顺序判定)
    stages["continue"] = _continue_stage(shots)
    # ⑦ assemble:成片 URL + 本地存在性;URL 在但文件丢了 → error(漂移,值得标红)
    if not project.video_url:
        stages["assemble"] = {
            "status": "pending",
            "detail": {"video_url": False, "artifact": "unknown"},
        }
    else:
        asm_verdict, _ = artifact_verdict(session, tid, uid, project.video_url)
        stages["assemble"] = {
            "status": "error" if asm_verdict == "missing" else "done",
            "detail": {"video_url": True, "artifact": asm_verdict},
        }

    next_step = _next_step(stages, shots, project_id)
    recoverable = _find_recoverable(session, tid, uid, shots)

    elapsed_ms = round((time.monotonic() - t0) * 1000, 2)
    logger.info(
        "drama pipeline 重算: project=%s stages=%s next=%s recoverable=%d 耗时=%.2fms",
        project_id,
        {k: v["status"] for k, v in stages.items()},
        next_step["step"],
        len(recoverable),
        elapsed_ms,
    )
    return {
        "project_id": project_id,
        "stages": stages,
        "next_step": next_step,
        "recoverable": recoverable,
        "summary": {
            "shots": len(shots),
            "characters": len(chars),
            "project_status_column": project.status,  # 原状态列原样透出,便于对照
        },
        "elapsed_ms": elapsed_ms,
    }


# ── Studio 域:单 status 列 → next_step(纯函数,供 routes/studio.py 复用)───

# StudioShot.status 流转顺序(orchestrator.py 注释的状态机):
# draft → queued → rendering → rendered → voiced → lipsynced → done;任何步骤可落 error。
# 各阶段「已越过」集合:状态落在集合内 = 该阶段已完成。
_STUDIO_REACH: dict[str, set[str]] = {
    "render": {"rendered", "voiced", "lipsynced", "done"},
    "voice": {"voiced", "lipsynced", "done"},
    "lipsync": {"lipsynced", "done"},
    "assemble": {"done"},
}

_STUDIO_STEP_LABELS: dict[str, tuple[str, str]] = {
    "render": ("渲染分镜", "/studio/projects/{pid}/render"),
    "voice": ("分镜配音", "/studio/shots/{sid}/voice"),
    "lipsync": ("对口型", "/studio/shots/{sid}/lipsync"),
    "assemble": ("合成成片", "/studio/projects/{pid}/assemble"),
    "done": ("全部完成", ""),
}


def compute_studio_next_step(shots: list[StudioShot]) -> dict[str, Any]:
    """Studio 管线纯函数:首个未达阶段 = next_step(draft→render→voice→lipsync→assemble→done)。

    - 无分镜 → render(先拆/先渲)
    - 全体越过某阶段才进入下一阶段;待办分镜 error 优先排序
    - 全体 done → done
    返回 action 中 {pid}/{sid} 为占位符,由路由层按项目填充。
    """
    if not shots:
        label, action = _STUDIO_STEP_LABELS["render"]
        return {"step": "render", "label": label, "action": action, "todo": 0}

    first: str | None = None
    pending: list[StudioShot] = []
    for stage in ("render", "voice", "lipsync", "assemble"):
        pending = [s for s in shots if s.status not in _STUDIO_REACH[stage]]
        if pending:
            first = stage
            break
    if first is None:
        label, _ = _STUDIO_STEP_LABELS["done"]
        return {"step": "done", "label": label, "action": "", "todo": 0}

    label, action_tpl = _STUDIO_STEP_LABELS[first]
    # error 优先排在前面(先救火),其余按分镜序号
    pending.sort(key=lambda s: (s.status != "error", s.idx))
    todo_ids = [s.id for s in pending[:20]]
    action = action_tpl
    if "{sid}" in action_tpl and todo_ids:
        action = action_tpl.replace("{sid}", todo_ids[0])
    return {
        "step": first,
        "label": label,
        "action": action,
        "todo": len(pending),
        "shot_ids": todo_ids,
    }
