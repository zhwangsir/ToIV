"""S5(2026-10-11): Studio 域异步渲染回写——Job 终态 → 镜状态/candidates 落库。

设计缺口修复:wait=false 路径按设计「保持 rendering,成片由后续轮询/回收接上」,
但该回收此前不存在——tracker 只把 Job 推到终态,无人把结果映射回 StudioShot。
实测病灶:Job done 且产出 mp4,镜却永久 rendering、candidates 空。

触发点:
  ① GET /studio/projects/{pid} 详情读取时按项目惰性 reconcile(工作区 UI 在
     渲染期每 10s 轮询详情,即自愈通道);
  ② api 启动时全量 reconcile(与既有 reconcile 家族同批)。

语义(逐候选,以候选自带 db_job_id 为准):
  Job done    → 该候选 url=Job.result[0]、status=done;若无任何 is_picked,
                首个完成候选 is_picked=True 并写 shot.video_url/status=rendered。
  Job error   → 候选标 error(带 job.error);全部候选终态且无入选 → 镜 status=error。
  queued/running/canceled 之外的未知态不动(canceled 按 error 记「已取消」)。
"""
from __future__ import annotations

import json
import logging

from sqlmodel import Session, select

from app.models import Job, StudioShot

logger = logging.getLogger(__name__)


def _load_candidates(raw: str | None) -> list[dict]:
    try:
        v = json.loads(raw or "[]")
    except (ValueError, TypeError):
        return []
    return [c for c in v if isinstance(c, dict)] if isinstance(v, list) else []


def _job_results(job: Job) -> list[str]:
    try:
        v = json.loads(job.result or "[]")
    except (ValueError, TypeError):
        return []
    if not isinstance(v, list):
        return []
    return [str(u) for u in v if isinstance(u, str) and u]


def _reconcile_shot(session: Session, shot: StudioShot) -> bool:
    cands = _load_candidates(shot.candidates_json)
    pending = [
        i
        for i, c in enumerate(cands)
        if c.get("status") == "queued" and c.get("db_job_id")
    ]
    if not pending:
        return False
    changed = False
    for i in pending:
        job = session.get(Job, str(cands[i]["db_job_id"]))
        if job is None:
            continue
        if job.status == "done":
            urls = _job_results(job)
            if not urls:
                # done 但无产物:等下一轮(产物回填可能滞后),不误标
                continue
            cands[i]["url"] = urls[0]
            cands[i]["status"] = "done"
            cands[i]["error"] = ""
            changed = True
            if not any(c.get("is_picked") and c.get("url") for c in cands):
                cands[i]["is_picked"] = True
                shot.video_url = urls[0]
                shot.status = "rendered"
                shot.error = ""
        elif job.status in ("error", "canceled"):
            cands[i]["status"] = "error"
            cands[i]["error"] = (
                "已取消" if job.status == "canceled" else (job.error or "渲染失败")[:200]
            )
            changed = True
    if not changed:
        return False
    # 全部候选终态且无任何入选 → 镜失败
    terminal = all(
        c.get("status") in ("done", "error") for c in cands if c.get("db_job_id")
    )
    has_pick = any(c.get("is_picked") and c.get("url") for c in cands)
    if terminal and not has_pick:
        shot.status = "error"
        first_err = next(
            (c.get("error") for c in cands if c.get("status") == "error" and c.get("error")),
            "全部候选生成失败",
        )
        shot.error = str(first_err)[:500]
    shot.candidates_json = json.dumps(cands, ensure_ascii=False)
    session.add(shot)
    session.commit()
    return True


def reconcile_project_renders(session: Session, project_id: str) -> int:
    """惰性通道:项目详情读取时按项目 reconcile(渲染期 UI 10s 轮询即自愈)。"""
    shots = session.exec(
        select(StudioShot).where(
            StudioShot.project_id == project_id,
            StudioShot.status == "rendering",  # type: ignore[attr-defined]
        )
    ).all()
    n = 0
    for shot in shots:
        try:
            if _reconcile_shot(session, shot):
                n += 1
        except Exception:  # noqa: BLE001 — 单镜回写失败不炸详情读取
            logger.exception("render_reconcile 单镜失败 shot=%s", str(shot.id)[:12])
    return n


def reconcile_all_renders(session: Session) -> int:
    """启动通道:api 启动时全量 reconcile(渲染中且带 queued 候选的镜)。"""
    shots = session.exec(
        select(StudioShot).where(
            StudioShot.status == "rendering",  # type: ignore[attr-defined]
        )
    ).all()
    n = 0
    for shot in shots:
        try:
            if _reconcile_shot(session, shot):
                n += 1
        except Exception:  # noqa: BLE001
            logger.exception("render_reconcile 单镜失败 shot=%s", str(shot.id)[:12])
    if n:
        logger.info("render_reconcile: 启动回写 %d 个等待 Job 的镜次", n)
    return n
