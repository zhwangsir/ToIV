"""管线 C 异步链（阶段 B）：c-chains 建档 + 后台逐段渲染。

契约：docs/ops/PIPELINE_C_API.md
- HTTP 立即返回的 job_id = DB Job.id（绝非 Comfy prompt_id）
- 不动现有 /studio/shots|projects/.../render 同步语义
- 进度走 /api/jobs lookup；取消走 /api/jobs/{id}/cancel + params.segment_prompt_ids
"""
from __future__ import annotations

import json
import logging
from typing import Any

from pydantic import BaseModel, Field, field_validator
from pydantic_core import PydanticCustomError
from sqlmodel import Session, select

from app.db import engine
from app.models import Job, StudioCharacter, StudioProject, StudioShot, User
from app.services.studio import assemble as assemble_svc
from app.services.studio import orchestrator
from app.services.studio.pipelines import VIDEO_PIPELINES
from app.services.studio.renderers.base import RenderError

logger = logging.getLogger(__name__)

KIND_C_CHAIN = "studio_c_chain"
_MAX_SEGMENTS = 8


class CChainStart(BaseModel):
    type: str = "makeup"  # makeup | video | job（MVP：makeup）
    video_url: str | None = None
    job_id: str | None = None

    @field_validator("type")
    @classmethod
    def _check_type(cls, v: str) -> str:
        t = (v or "makeup").strip().lower() or "makeup"
        if t not in ("makeup", "video", "job"):
            raise PydanticCustomError("start_type", "start.type 仅支持 makeup | video | job")
        return t


class CChainSegmentIn(BaseModel):
    prompt: str = Field(min_length=1, max_length=4000)
    duration_sec: int = Field(default=6, ge=1, le=15)
    dialogue: str = ""
    speaker: str = ""
    camera: str = ""
    scene: str = ""
    characters: list[str] = Field(default_factory=list)
    scene_images: list[str] | None = None
    ref_overrides: dict[str, str] | None = None
    outfit_desc: str | None = None
    num_candidates: int | None = Field(default=None, ge=1, le=4)


class CChainCreateBody(BaseModel):
    pipeline: str = Field(default="c_hybrid", max_length=16)
    project_id: str | None = None
    start: CChainStart = Field(default_factory=CChainStart)
    character_ids: list[str] = Field(default_factory=list)
    style: str | None = Field(default=None, max_length=32)
    aspect_ratio: str = "9:16"
    resolution: dict[str, int] | None = None
    keep_audio: bool = True
    num_candidates: int = Field(default=2, ge=1, le=4)
    seed: int | None = Field(default=None, ge=0)
    ref_images: list[str] | None = Field(default=None, max_length=9)
    scene_images: list[str] = Field(default_factory=list)
    outfit_desc: str = ""
    auto_assemble: bool = True
    worker_url: str | None = Field(default=None, max_length=64)
    segments: list[CChainSegmentIn] = Field(min_length=1, max_length=_MAX_SEGMENTS)

    @field_validator("pipeline")
    @classmethod
    def _check_pipeline(cls, v: str) -> str:
        p = (v or "c_hybrid").strip().lower() or "c_hybrid"
        if p not in VIDEO_PIPELINES:
            raise PydanticCustomError(
                "pipeline_invalid", "pipeline 仅支持 ref2va | c | c_hybrid"
            )
        return p

    @field_validator("aspect_ratio")
    @classmethod
    def _check_aspect(cls, v: str) -> str:
        a = (v or "9:16").strip() or "9:16"
        if a != "9:16":
            raise PydanticCustomError(
                "aspect_unsupported", "首版仅支持 aspect_ratio=9:16"
            )
        return a


class CChainAppendBody(BaseModel):
    segments: list[CChainSegmentIn] = Field(min_length=1, max_length=_MAX_SEGMENTS)
    num_candidates: int = Field(default=2, ge=1, le=4)
    keep_audio: bool = True
    auto_assemble: bool = True
    seed: int | None = Field(default=None, ge=0)
    outfit_desc: str = ""
    worker_url: str | None = None
    from_segment: int | None = None
    confirm_discard: bool = False


class CChainPickBody(BaseModel):
    candidate_id: str = Field(min_length=1, max_length=64)
    rerender_after: bool = False


def _load_params(job: Job) -> dict[str, Any]:
    try:
        snap = json.loads(job.params or "{}")
    except (ValueError, TypeError):
        return {}
    return snap if isinstance(snap, dict) else {}


def _save_params(session: Session, job: Job, snap: dict[str, Any]) -> None:
    job.params = json.dumps(snap, ensure_ascii=False)
    session.add(job)
    session.commit()


def append_segment_prompt_id(chain_job_id: str, prompt_id: str) -> None:
    """Comfy queue 后立刻登记，供 cancel_job 链式清场。"""
    pid = (prompt_id or "").strip()
    if not chain_job_id or not pid:
        return
    try:
        with Session(engine) as s:
            job = s.get(Job, chain_job_id)
            if not job or job.status == "canceled":
                return
            snap = _load_params(job)
            ids = [x for x in (snap.get("segment_prompt_ids") or []) if isinstance(x, str)]
            if pid not in ids:
                ids.append(pid)
            snap["segment_prompt_ids"] = ids
            snap["current_prompt_id"] = pid
            job.params = json.dumps(snap, ensure_ascii=False)
            s.add(job)
            s.commit()
    except Exception as e:  # noqa: BLE001
        logger.warning("c-chain 登记 segment_prompt_id 失败 job=%s: %s", chain_job_id[:12], e)


def is_chain_canceled(job_id: str) -> bool:
    try:
        with Session(engine) as s:
            job = s.get(Job, job_id)
            return bool(job and job.status == "canceled")
    except Exception:  # noqa: BLE001
        return False


def _set_progress(job_id: str, **fields: Any) -> None:
    try:
        with Session(engine) as s:
            job = s.get(Job, job_id)
            if not job or job.status in ("done", "error", "canceled"):
                return
            try:
                prog = json.loads(job.progress or "{}")
            except (ValueError, TypeError):
                prog = {}
            if not isinstance(prog, dict):
                prog = {}
            prog.update({k: v for k, v in fields.items() if v is not None})
            total = int(prog.get("segments_total") or 0)
            done = int(prog.get("segments_done") or 0)
            if total > 0:
                prog["pct"] = min(99, int(100 * done / total))
            job.progress = json.dumps(prog, ensure_ascii=False)
            if job.status == "queued":
                job.status = "running"
            s.add(job)
            s.commit()
    except Exception as e:  # noqa: BLE001
        logger.warning("c-chain progress 写失败 %s: %s", job_id[:12], e)


def _finish_job(
    job_id: str,
    status: str,
    *,
    result: list[str] | None = None,
    error: str | None = None,
    error_code: str | None = None,
    failed_segment: int | None = None,
) -> None:
    with Session(engine) as s:
        job = s.get(Job, job_id)
        if not job or job.status in ("done", "error", "canceled"):
            return
        job.status = status
        if error is not None:
            job.error = error[:500]
        snap = _load_params(job)
        if error_code:
            snap["error_code"] = error_code
        if failed_segment is not None:
            snap["failed_segment"] = failed_segment
        if result is not None:
            job.result = json.dumps(result, ensure_ascii=False)
            if result:
                snap["final_url"] = result[0]
        job.params = json.dumps(snap, ensure_ascii=False)
        try:
            prog = json.loads(job.progress or "{}")
        except (ValueError, TypeError):
            prog = {}
        if isinstance(prog, dict):
            if status == "done":
                prog["pct"] = 100
            job.progress = json.dumps(prog, ensure_ascii=False)
        s.add(job)
        s.commit()


def _chain_busy(session: Session, chain_id: str, user_id: str) -> Job | None:
    rows = session.exec(
        select(Job).where(
            Job.user_id == user_id,
            Job.kind == KIND_C_CHAIN,
            Job.status.in_(("queued", "held", "running")),  # type: ignore[attr-defined]
        )
    ).all()
    for j in rows:
        snap = _load_params(j)
        if snap.get("chain_id") == chain_id:
            return j
    return None


def _resolution(body: CChainCreateBody) -> tuple[int, int]:
    w, h = 768, 1344
    if isinstance(body.resolution, dict):
        try:
            w = int(body.resolution.get("width") or w)
            h = int(body.resolution.get("height") or h)
        except (TypeError, ValueError):
            pass
    if w > h:
        w, h = h, w
    return w, h


def create_c_chain(
    session: Session,
    user: User,
    body: CChainCreateBody,
    *,
    worker_url: str | None = None,
) -> dict[str, Any]:
    """建档 Job + 项目/分镜，立即返回 job_id=DB id；调用方再 create_task(run)。"""
    if body.start.type != "makeup":
        raise RenderError("首版 c-chains 仅支持 start.type=makeup")

    if body.project_id:
        project = session.get(StudioProject, body.project_id)
        if not project or project.tenant_id != user.tenant_id:
            raise RenderError("项目不存在")
    else:
        w, h = _resolution(body)
        project = StudioProject(
            tenant_id=user.tenant_id,
            user_id=user.id,
            title="c-chain",
            style=(body.style or "").strip(),
            width=w,
            height=h,
            fps=24,
            scene_images_json=json.dumps(
                [u for u in body.scene_images if isinstance(u, str) and u.strip()],
                ensure_ascii=False,
            ),
            status="generating",
        )
        session.add(project)
        session.commit()
        session.refresh(project)

        if body.character_ids:
            srcs = session.exec(
                select(StudioCharacter).where(
                    StudioCharacter.id.in_(body.character_ids)  # type: ignore[attr-defined]
                )
            ).all()
            by_id = {c.id: c for c in srcs}
            for cid in body.character_ids:
                src = by_id.get(cid)
                if src is None:
                    continue
                src_proj = session.get(StudioProject, src.project_id)
                if not src_proj or src_proj.tenant_id != user.tenant_id:
                    continue
                session.add(
                    StudioCharacter(
                        project_id=project.id,
                        name=src.name,
                        description=src.description,
                        visual_prompt=src.visual_prompt,
                        reference_images=src.reference_images,
                        reference_images_by_style=getattr(
                            src, "reference_images_by_style", None
                        )
                        or "{}",
                        voice_ref_url=src.voice_ref_url or "",
                    )
                )
            session.commit()

    if body.style:
        project.style = body.style.strip()
        session.add(project)

    existing = session.exec(
        select(StudioShot).where(StudioShot.project_id == project.id)
    ).all()
    base_idx = max((s.idx for s in existing), default=-1) + 1
    shot_rows: list[StudioShot] = []
    for i, seg in enumerate(body.segments):
        shot = StudioShot(
            project_id=project.id,
            idx=base_idx + i,
            scene=seg.scene or "",
            prompt=seg.prompt,
            negative="blurry, low quality, text, watermark, deformed",
            camera=seg.camera or "",
            dialogue=seg.dialogue or "",
            speaker=seg.speaker or "",
            duration_sec=int(seg.duration_sec),
            characters=json.dumps(seg.characters or [], ensure_ascii=False),
            render_mode="video",
            status="draft",
            video_model="h3",
        )
        session.add(shot)
        shot_rows.append(shot)
    session.commit()
    for s in shot_rows:
        session.refresh(s)

    segment_metas = [
        {"index": i, "segment_id": s.id, "status": "pending", "shot_idx": s.idx}
        for i, s in enumerate(shot_rows)
    ]
    snap = {
        "chain_id": project.id,
        "pipeline": body.pipeline,
        "keep_audio": body.keep_audio,
        "auto_assemble": body.auto_assemble,
        "num_candidates": body.num_candidates,
        "seed": body.seed,
        "style": body.style,
        "outfit_desc": body.outfit_desc or "",
        "ref_images": body.ref_images,
        "scene_images": body.scene_images,
        "worker_url": worker_url,
        "segment_prompt_ids": [],
        "segments": segment_metas,
        "segment_opts": [
            {
                "segment_id": s.id,
                "ref_overrides": seg.ref_overrides,
                "outfit_desc": seg.outfit_desc,
                "num_candidates": seg.num_candidates,
                "scene_images": seg.scene_images,
            }
            for s, seg in zip(shot_rows, body.segments)
        ],
        "stage": "B",
    }
    job = Job(
        tenant_id=user.tenant_id,
        user_id=user.id,
        prompt_id="",
        worker="",
        kind=KIND_C_CHAIN,
        status="queued",
        prompt=(body.segments[0].prompt or "")[:200],
        seed=int(body.seed or 0),
        params=json.dumps(snap, ensure_ascii=False),
        progress=json.dumps(
            {
                "pct": 0,
                "segments_total": len(shot_rows),
                "segments_done": 0,
                "current_segment": 0,
            },
            ensure_ascii=False,
        ),
    )
    session.add(job)
    session.commit()
    session.refresh(job)
    job.prompt_id = f"chain-{job.id}"
    job.root_id = job.id
    session.add(job)
    session.commit()

    return {
        "job_id": job.id,  # ★ DB Job.id
        "chain_id": project.id,
        "status": "queued",
        "prompt_id": job.prompt_id,
        "segments": segment_metas,
    }


def create_append_job(
    session: Session,
    user: User,
    chain_id: str,
    body: CChainAppendBody,
    *,
    worker_url: str | None = None,
) -> dict[str, Any]:
    project = session.get(StudioProject, chain_id)
    if not project or project.tenant_id != user.tenant_id:
        raise RenderError("链不存在")
    busy = _chain_busy(session, chain_id, user.id)
    if busy is not None:
        raise RenderError("链上已有进行中的作业")

    prev = None
    rows = session.exec(
        select(Job).where(
            Job.user_id == user.id,
            Job.kind == KIND_C_CHAIN,
            Job.status == "done",
        )
    ).all()
    for j in rows:
        if _load_params(j).get("chain_id") == chain_id:
            if prev is None or (
                j.created_at and prev.created_at and j.created_at > prev.created_at
            ):
                prev = j

    existing = session.exec(
        select(StudioShot).where(StudioShot.project_id == chain_id)
    ).all()
    base_idx = max((s.idx for s in existing), default=-1) + 1
    shot_rows: list[StudioShot] = []
    for i, seg in enumerate(body.segments):
        shot = StudioShot(
            project_id=chain_id,
            idx=base_idx + i,
            scene=seg.scene or "",
            prompt=seg.prompt,
            negative="blurry, low quality, text, watermark, deformed",
            camera=seg.camera or "",
            dialogue=seg.dialogue or "",
            speaker=seg.speaker or "",
            duration_sec=int(seg.duration_sec),
            characters=json.dumps(seg.characters or [], ensure_ascii=False),
            render_mode="video",
            status="draft",
            video_model="h3",
        )
        session.add(shot)
        shot_rows.append(shot)
    session.commit()
    for s in shot_rows:
        session.refresh(s)

    pipeline = "c_hybrid"
    if prev is not None:
        pipeline = str(_load_params(prev).get("pipeline") or pipeline)

    segment_metas = [
        {"index": i, "segment_id": s.id, "status": "pending", "shot_idx": s.idx}
        for i, s in enumerate(shot_rows)
    ]
    snap = {
        "chain_id": chain_id,
        "pipeline": pipeline,
        "keep_audio": body.keep_audio,
        "auto_assemble": body.auto_assemble,
        "num_candidates": body.num_candidates,
        "seed": body.seed,
        "outfit_desc": body.outfit_desc or "",
        "worker_url": worker_url,
        "segment_prompt_ids": [],
        "segments": segment_metas,
        "segment_opts": [
            {
                "segment_id": s.id,
                "ref_overrides": seg.ref_overrides,
                "outfit_desc": seg.outfit_desc,
                "num_candidates": seg.num_candidates,
                "scene_images": seg.scene_images,
            }
            for s, seg in zip(shot_rows, body.segments)
        ],
        "stage": "B",
        "append": True,
    }
    job = Job(
        tenant_id=user.tenant_id,
        user_id=user.id,
        prompt_id="",
        worker="",
        kind=KIND_C_CHAIN,
        status="queued",
        prompt=(body.segments[0].prompt or "")[:200],
        seed=int(body.seed or 0),
        params=json.dumps(snap, ensure_ascii=False),
        continued_from=(prev.id if prev else ""),
        root_id=(prev.root_id or prev.id) if prev else "",
        progress=json.dumps(
            {
                "pct": 0,
                "segments_total": len(shot_rows),
                "segments_done": 0,
                "current_segment": 0,
            },
            ensure_ascii=False,
        ),
    )
    session.add(job)
    session.commit()
    session.refresh(job)
    job.prompt_id = f"chain-{job.id}"
    if not job.root_id:
        job.root_id = job.id
    session.add(job)
    session.commit()
    return {
        "job_id": job.id,
        "chain_id": chain_id,
        "status": "queued",
        "prompt_id": job.prompt_id,
        "segments": segment_metas,
    }


async def run_c_chain(job_id: str) -> None:
    """后台：按段 render_shot；取消则退出；可选自动拼接。"""
    with Session(engine) as s:
        job0 = s.get(Job, job_id)
        if not job0 or job0.status == "canceled":
            return
        if job0.status == "queued":
            job0.status = "running"
            s.add(job0)
            s.commit()
        snap0 = _load_params(job0)
        chain_id = str(snap0.get("chain_id") or "")
        pipeline = str(snap0.get("pipeline") or "c_hybrid")
        num_candidates = int(snap0.get("num_candidates") or 2)
        seed = snap0.get("seed")
        style = snap0.get("style")
        outfit_desc = str(snap0.get("outfit_desc") or "")
        ref_images = snap0.get("ref_images")
        scene_images = snap0.get("scene_images")
        worker_url = snap0.get("worker_url")
        auto_assemble = bool(snap0.get("auto_assemble", True))
        segment_metas = list(snap0.get("segments") or [])
        opts_by_sid = {
            str(o.get("segment_id")): o
            for o in (snap0.get("segment_opts") or [])
            if isinstance(o, dict) and o.get("segment_id")
        }

    if not chain_id or not segment_metas:
        _finish_job(job_id, "error", error="链参数缺失", error_code="PC_BAD_REQUEST")
        return

    failed_at: int | None = None
    fail_msg = ""
    fail_code = "PC_CHAIN_ABORTED"
    clip_url = ""

    for i, meta in enumerate(segment_metas):
        if is_chain_canceled(job_id):
            return
        sid = str(meta.get("segment_id") or "")
        _set_progress(
            job_id,
            current_segment=i,
            segments_done=i,
            segments_total=len(segment_metas),
            step=f"segment_{i}",
        )
        with Session(engine) as s:
            job = s.get(Job, job_id)
            if not job or job.status == "canceled":
                return
            snap = _load_params(job)
            segs = list(snap.get("segments") or [])
            if i < len(segs) and isinstance(segs[i], dict):
                segs[i]["status"] = "rendering"
                segs[i]["job_id"] = job_id
            snap["segments"] = segs
            _save_params(s, job, snap)
            shot = s.get(StudioShot, sid)
            if shot is None:
                failed_at = i
                fail_msg = f"分镜不存在:{sid[:12]}"
                fail_code = "PC_BAD_REQUEST"
                break

        opt = opts_by_sid.get(sid) or {}
        n_cand = opt.get("num_candidates")
        if n_cand is None:
            n_cand = num_candidates
        seg_outfit = opt.get("outfit_desc")
        if seg_outfit is None:
            seg_outfit = outfit_desc
        seg_scenes = opt.get("scene_images")
        if seg_scenes is None:
            seg_scenes = scene_images
        ref_overrides = opt.get("ref_overrides")

        try:
            with Session(engine) as s:
                shot = s.get(StudioShot, sid)
                if shot is None:
                    raise RenderError(f"分镜不存在:{sid[:12]}")
                seed_arg = None if seed is None else int(seed) + i
                await orchestrator.render_shot(
                    s,
                    shot,
                    video_model="h3",
                    num_candidates=int(n_cand),
                    ref_images=ref_images if isinstance(ref_images, list) else None,
                    scene_images=seg_scenes if isinstance(seg_scenes, list) else None,
                    pipeline=pipeline,
                    ref_style=style if isinstance(style, str) else None,
                    seed=seed_arg,
                    worker_url=worker_url if isinstance(worker_url, str) else None,
                    ref_overrides=ref_overrides if isinstance(ref_overrides, dict) else None,
                    outfit_desc=str(seg_outfit or ""),
                    parent_chain_job_id=job_id,
                    wait=True,
                )
                s.refresh(shot)
                clip_url = shot.video_url or shot.final_clip_url or ""
        except RenderError as e:
            if is_chain_canceled(job_id):
                return
            failed_at = i
            fail_msg = str(e)[:400]
            fail_code = "PC_CHAIN_ABORTED"
            with Session(engine) as s:
                job = s.get(Job, job_id)
                if job and job.status not in ("canceled",):
                    snap = _load_params(job)
                    segs = list(snap.get("segments") or [])
                    if i < len(segs) and isinstance(segs[i], dict):
                        segs[i]["status"] = "error"
                        segs[i]["error"] = fail_msg
                    snap["segments"] = segs
                    _save_params(s, job, snap)
            break
        except Exception as e:  # noqa: BLE001
            logger.exception("c-chain job %s segment %s 失败", job_id, i)
            failed_at = i
            fail_msg = f"段失败:{e}"[:400]
            fail_code = "PC_INTERNAL"
            break

        if is_chain_canceled(job_id):
            return

        with Session(engine) as s:
            job = s.get(Job, job_id)
            if not job or job.status == "canceled":
                return
            snap = _load_params(job)
            segs = list(snap.get("segments") or [])
            if i < len(segs) and isinstance(segs[i], dict):
                segs[i]["status"] = "done"
                segs[i]["clip_url"] = clip_url
            snap["segments"] = segs
            _save_params(s, job, snap)
        _set_progress(
            job_id,
            segments_done=i + 1,
            current_segment=i,
            segments_total=len(segment_metas),
        )

    if is_chain_canceled(job_id):
        return

    if failed_at is not None:
        _finish_job(
            job_id,
            "error",
            error=fail_msg or "链中止",
            error_code=fail_code,
            failed_segment=failed_at,
        )
        return

    final_url = ""
    if auto_assemble:
        try:
            with Session(engine) as s:
                project = s.get(StudioProject, chain_id)
                if project is not None:
                    shots = list(
                        s.exec(
                            select(StudioShot)
                            .where(StudioShot.project_id == chain_id)
                            .order_by(StudioShot.idx)
                        ).all()
                    )
                    for sh in shots:
                        if (sh.video_url or "") and not (sh.final_clip_url or ""):
                            sh.final_clip_url = sh.video_url
                            s.add(sh)
                    s.commit()
                    await assemble_svc.assemble_project(s, project, shots)
                    s.refresh(project)
                    final_url = project.final_url or ""
        except Exception as e:  # noqa: BLE001
            logger.warning("c-chain assemble 失败 job=%s: %s", job_id[:12], e)
            _finish_job(
                job_id,
                "done",
                result=[],
                error=f"段已完成，拼接失败:{e}"[:400],
                error_code="PC_ASSEMBLE_FAILED",
            )
            return

    _finish_job(job_id, "done", result=[final_url] if final_url else [])


def get_c_chain(session: Session, user: User, chain_id: str) -> dict[str, Any]:
    project = session.get(StudioProject, chain_id)
    if not project or project.tenant_id != user.tenant_id:
        raise RenderError("链不存在")
    shots = session.exec(
        select(StudioShot)
        .where(StudioShot.project_id == chain_id)
        .order_by(StudioShot.idx)
    ).all()
    jobs = session.exec(
        select(Job).where(Job.user_id == user.id, Job.kind == KIND_C_CHAIN)
    ).all()
    chain_jobs = [j for j in jobs if _load_params(j).get("chain_id") == chain_id]
    chain_jobs.sort(key=lambda j: j.created_at or j.id)
    active = next(
        (j for j in chain_jobs if j.status in ("queued", "held", "running")),
        None,
    )
    segments_out = []
    for shot in shots:
        try:
            cands = json.loads(shot.candidates_json or "[]")
        except (ValueError, TypeError):
            cands = []
        if not isinstance(cands, list):
            cands = []
        picked = next(
            (c for c in cands if isinstance(c, dict) and c.get("is_picked")),
            None,
        )
        status = "pending"
        if shot.status in ("rendered", "voiced", "lipsynced", "done") and (
            shot.video_url or shot.final_clip_url
        ):
            status = "done"
        elif shot.status == "rendering":
            status = "rendering"
        elif shot.status == "error":
            status = "error"
        segments_out.append(
            {
                "index": shot.idx,
                "segment_id": shot.id,
                "status": status,
                "shot_status": shot.status,
                "prompt": shot.prompt,
                "duration_sec": shot.duration_sec,
                "clip_url": shot.video_url or shot.final_clip_url or "",
                "error": shot.error or "",
                "candidates": cands,
                "context_latent": (picked or {}).get("context_latent") if picked else "",
                "worker": (picked or {}).get("worker") if picked else "",
                "first_frame_url": (picked or {}).get("first_frame") if picked else "",
            }
        )
    return {
        "chain_id": chain_id,
        "jobs": [j.id for j in chain_jobs],
        "active_job_id": active.id if active else None,
        "final_url": project.final_url or "",
        "keep_audio": True,
        "segments": segments_out,
    }


def pick_segment_candidate(
    session: Session,
    user: User,
    chain_id: str,
    seg_index: int,
    candidate_id: str,
) -> dict[str, Any]:
    project = session.get(StudioProject, chain_id)
    if not project or project.tenant_id != user.tenant_id:
        raise RenderError("链不存在")
    if _chain_busy(session, chain_id, user.id) is not None:
        raise RenderError("链上已有进行中的作业")
    shots = session.exec(
        select(StudioShot)
        .where(StudioShot.project_id == chain_id)
        .order_by(StudioShot.idx)
    ).all()
    if seg_index < 0 or seg_index >= len(shots):
        raise RenderError("段下标越界")
    if seg_index != len(shots) - 1:
        raise RenderError("仅允许改选链尾段")
    orchestrator.pick_candidate(session, shots[seg_index], candidate_id)
    return get_c_chain(session, user, chain_id)


def chain_lookup_extra(job: Job) -> dict[str, Any] | None:
    """供 /jobs/lookup 增量键 chain=…。"""
    if job.kind != KIND_C_CHAIN:
        return None
    snap = _load_params(job)
    try:
        prog = json.loads(job.progress or "{}")
    except (ValueError, TypeError):
        prog = {}
    if not isinstance(prog, dict):
        prog = {}
    results: list[str] = []
    try:
        raw = json.loads(job.result or "[]")
        if isinstance(raw, list):
            results = [u for u in raw if isinstance(u, str)]
    except (ValueError, TypeError):
        results = []
    return {
        "chain_id": snap.get("chain_id"),
        "pipeline": snap.get("pipeline"),
        "worker": snap.get("worker_url") or "",
        "progress": {
            "segments_total": prog.get("segments_total"),
            "segments_done": prog.get("segments_done"),
            "current_segment": prog.get("current_segment"),
            "pct": prog.get("pct"),
            "eta_sec": prog.get("eta_sec"),
        },
        "error_code": snap.get("error_code"),
        "failed_segment": snap.get("failed_segment"),
        "final_url": (results[0] if results else snap.get("final_url") or ""),
        "segments": snap.get("segments") or [],
    }
