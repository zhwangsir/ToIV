"""Studio 编排:分镜状态机 + 渲染/配音/合成的服务侧入口。

状态机:draft → queued → rendering → rendered → voiced → (lipsynced) → done
任何步骤异常落 error 并记录 shot.error,支持单镜重试。
"""
from __future__ import annotations

import json
import logging
from typing import TYPE_CHECKING, Any

from sqlmodel import Session, select

from app.harness import events as ev
from app.models import StudioCharacter, StudioProject, StudioShot
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
    session: Session, shot: StudioShot, pool: "WorkerPool | None" = None,
    request: Any = None,
) -> StudioShot:
    """渲染单镜:按 render_mode 分发;状态与媒体 URL 落库。"""
    if pool is None:
        from app.deps import get_pool

        pool = get_pool()
    shot.status = "rendering"
    shot.error = ""
    session.add(shot)
    session.commit()
    # 项目级产出规格 + 出图底模注入渲染器(此前 ckpt_name 定义了却从未下发,图像运镜链恒走默认底模)
    project = session.get(StudioProject, shot.project_id)
    render_kw: dict[str, Any] = {}
    if project is not None:
        render_kw = {
            "ckpt_name": project.ckpt_name,
            "width": project.width,
            "height": project.height,
            "fps": project.fps,
        }
    try:
        if request is not None:
            render_kw["request"] = request
        result = await get_renderer(shot).render(
            shot, _cast_for(session, shot), pool, **render_kw
        )
    except RenderError as e:
        shot.status = "error"
        shot.error = str(e)
        session.add(shot)
        session.commit()
        raise
    if result.kind == "image":
        shot.image_url = result.url
        # L2 质量门(advisory v1):渲染完成点发事件,由 QualityPlugin 订阅执行
        # evaluate_image(打分→三态决策,只记日志不阻断);打分器未装/异常一律降级,
        # 渲染结果不受影响。R2 接 best-of-K 重生成。
        # 无订阅者(quality 插件未激活)时 emit 为空操作,零开销。
        try:
            from app.harness.ctx import get_ctx

            await get_ctx().events.emit(
                ev.QUALITY_ADVISORY,
                {"image_url": result.url, "prompt": shot.prompt, "shot_id": shot.id},
            )
        except Exception:
            logger.debug("render_shot 质量门事件发射异常(降级忽略):shot=%s", shot.id, exc_info=True)
    else:
        shot.video_url = result.url
        shot.final_clip_url = result.url
    shot.status = "rendered"
    session.add(shot)
    session.commit()
    session.refresh(shot)
    return shot
