"""渲染策略基座:ShotRenderer 协议 + get_renderer 按 render_mode 分发。

渲染器为无会话工厂:get_renderer 返回的实例 render() 时注入 pool,
便于测试 mock 与后续扩展(新渲染模式 = 新实现类 + registry 注册)。
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Protocol

if TYPE_CHECKING:
    from app.comfy.pool import WorkerPool
    from app.models import StudioCharacter, StudioShot


class RenderError(RuntimeError):
    """渲染失败(未知模式 / worker 不可用 / ComfyUI 错误 / ffmpeg 错误)。"""


@dataclass
class RenderResult:
    """渲染产出。kind: video | image;url: 可访问媒体 URL。"""

    kind: str
    url: str


class ShotRenderer(Protocol):
    """渲染策略契约:单镜 + 角色资产 → 媒体 URL。"""

    name: str

    async def render(
        self,
        shot: "StudioShot",
        cast: list["StudioCharacter"],
        pool: "WorkerPool",
        **kw: Any,
    ) -> RenderResult: ...


def get_renderer(shot: "StudioShot") -> ShotRenderer:
    """按 shot.render_mode 分发渲染器实例。"""
    from app.services.studio.renderers.image_motion import ImageMotionRenderer
    from app.services.studio.renderers.video import VideoRenderer

    registry: dict[str, type] = {
        VideoRenderer.name: VideoRenderer,
        ImageMotionRenderer.name: ImageMotionRenderer,
    }
    cls = registry.get(shot.render_mode)
    if cls is None:
        raise RenderError(f"未知渲染模式:{shot.render_mode}")
    return cls()
