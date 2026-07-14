"""GET /api/backlot —— Backlot 看板(OpenMontage 风格的项目仪表盘)。

聚合 ManjuProject + ManjuShot 推导阶段与进度,无需扩展 Job 表。

阶段(stage)由 shot 状态推导:
- drafting:  有 shot 仍 draft(分镜未完成)
- imaging:   全部 shot ≥ image_done,部分未 video_done
- filming:   全部 shot 已 video_done,部分未配音
- voicing:   全部 shot 已配音,部分未合成
- done:      全部完成(后期合成暂以 voice_url+video_url 齐备为准)

返回字段对齐前端看板组件:每个项目卡含阶段/进度/最近活动/缩略图。
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, select

from app.db import get_session
from app.deps import get_current_user
from app.models import ManjuProject, ManjuShot, User

router = APIRouter()


def _project_stage(shots: list[ManjuShot]) -> str:
    """从 shot 状态推导项目当前阶段。"""
    if not shots:
        return "drafting"
    has_draft = any(s.status == "draft" for s in shots)
    if has_draft:
        return "drafting"
    # 至少全部 image_done 才进入 filming
    all_image = all(bool(s.image_url) or s.status != "draft" for s in shots)
    if not all_image:
        return "imaging"
    all_video = all(bool(s.video_url) for s in shots)
    if not all_video:
        return "filming"
    all_voiced = all(bool(s.voice_url) for s in shots)
    if not all_voiced:
        return "voicing"
    return "done"


def _project_progress(shots: list[ManjuShot]) -> dict:
    """统计每阶段完成度(分子/分母)。"""
    total = len(shots)
    if total == 0:
        return {"total": 0, "image_done": 0, "video_done": 0, "voiced": 0}
    return {
        "total": total,
        "image_done": sum(1 for s in shots if bool(s.image_url)),
        "video_done": sum(1 for s in shots if bool(s.video_url)),
        "voiced": sum(1 for s in shots if bool(s.voice_url)),
    }


def _latest_thumbnail(shots: list[ManjuShot]) -> str:
    """取最近一镜(按 idx 倒序)有图的关键帧作为看板缩略图。"""
    for s in sorted(shots, key=lambda x: x.idx, reverse=True):
        if s.image_url:
            return s.image_url
    return ""


@router.get("/backlot")
def list_backlot(
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> list[dict]:
    """看板视图:当前用户的所有项目卡片(最新更新在前)。"""
    projects = session.exec(
        select(ManjuProject)
        .where(ManjuProject.user_id == user.id)
        .order_by(ManjuProject.updated_at.desc())
    ).all()

    cards: list[dict] = []
    for p in projects:
        shots = session.exec(
            select(ManjuShot)
            .where(ManjuShot.project_id == p.id)
            .order_by(ManjuShot.idx.asc())
        ).all()
        cards.append({
            "id": p.id,
            "title": p.title or "(未命名)",
            "premise": (p.premise[:200] + "...") if len(p.premise) > 200 else p.premise,
            "style": p.style,
            "ckpt": p.ckpt_name,
            "stage": _project_stage(shots),
            "progress": _project_progress(shots),
            "thumbnail": _latest_thumbnail(shots),
            "shot_count": len(shots),
            "updated_at": p.updated_at.isoformat(),
            "created_at": p.created_at.isoformat(),
        })
    return cards


@router.get("/backlot/{project_id}")
def backlot_detail(
    project_id: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    """项目看板详情:基础信息 + 所有 shot 列表 + 阶段/进度。"""
    project = session.exec(
        select(ManjuProject).where(
            ManjuProject.id == project_id, ManjuProject.user_id == user.id
        )
    ).first()
    if not project:
        raise HTTPException(status_code=404, detail="项目不存在")

    shots = session.exec(
        select(ManjuShot)
        .where(ManjuShot.project_id == project_id)
        .order_by(ManjuShot.idx.asc())
    ).all()

    return {
        "project": {
            "id": project.id,
            "title": project.title,
            "premise": project.premise,
            "style": project.style,
            "ckpt": project.ckpt_name,
            "created_at": project.created_at.isoformat(),
            "updated_at": project.updated_at.isoformat(),
        },
        "stage": _project_stage(shots),
        "progress": _project_progress(shots),
        "shots": [
            {
                "id": s.id,
                "idx": s.idx,
                "scene": s.scene,
                "camera": s.camera,
                "dialogue": s.dialogue,
                "status": s.status,
                "image_url": s.image_url,
                "video_url": s.video_url,
                "voice_url": s.voice_url,
                "speaker": s.speaker,
                "duration_sec": s.duration_sec,
            }
            for s in shots
        ],
    }
