"""Studio 编排:分镜状态机 + 渲染/配音/合成的服务侧入口。

状态机:draft → queued → rendering → rendered → voiced → (lipsynced) → done
任何步骤异常落 error 并记录 shot.error,支持单镜重试。
"""
from __future__ import annotations

import json
import logging
from typing import TYPE_CHECKING

from sqlmodel import Session, select

from app.models import StudioCharacter, StudioShot
from app.services.studio.renderers.base import RenderError, get_renderer

if TYPE_CHECKING:
    from app.comfy.pool import WorkerPool

logger = logging.getLogger(__name__)

# 已具备最终媒体的状态:批量渲染跳过
_TERMINAL_SKIP = {"rendered", "voiced", "lipsynced", "done"}


def terminal_states() -> set[str]:
    """批量渲染跳过的状态集合(副本,防调用方改内部常量)。"""
    return set(_TERMINAL_SKIP)


def _cast_for(session: Session, shot: StudioShot) -> list[StudioCharacter]:
    """按 shot.characters(角色名 JSON)取角色卡。"""
    names = set(json.loads(shot.characters or "[]"))
    if not names:
        return []
    rows = session.exec(
        select(StudioCharacter).where(StudioCharacter.project_id == shot.project_id)
    ).all()
    return [c for c in rows if c.name in names]


async def render_shot(
    session: Session, shot: StudioShot, pool: "WorkerPool | None" = None
) -> StudioShot:
    """渲染单镜:按 render_mode 分发;状态与媒体 URL 落库。"""
    if pool is None:
        from app.deps import get_pool

        pool = get_pool()
    shot.status = "rendering"
    shot.error = ""
    session.add(shot)
    session.commit()
    try:
        result = await get_renderer(shot).render(shot, _cast_for(session, shot), pool)
    except RenderError as e:
        shot.status = "error"
        shot.error = str(e)
        session.add(shot)
        session.commit()
        raise
    if result.kind == "image":
        shot.image_url = result.url
    else:
        shot.video_url = result.url
        shot.final_clip_url = result.url
    shot.status = "rendered"
    session.add(shot)
    session.commit()
    session.refresh(shot)
    return shot
