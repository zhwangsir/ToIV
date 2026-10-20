"""项目宿主解析:StudioProject 唯一宿主,DramaProject 仅 legacy 别名。

待办 #4 收敛切片:查库顺序 Studio → Drama(旧实现曾 Drama 优先,碰撞时误绑旧域)。
不删 Drama 表;新功能只写 Studio。场景/分镜双域路由经本模块统一归属。
"""
from __future__ import annotations

from enum import Enum

from fastapi import HTTPException
from sqlmodel import Session

from app.models import DramaProject, StudioProject, User


class HostKind(str, Enum):
    STUDIO = "studio"
    DRAMA_LEGACY = "drama_legacy"


def resolve_host_project(
    session: Session,
    pid: str,
    user: User,
) -> tuple[HostKind, StudioProject | DramaProject]:
    """解析项目宿主。Studio 优先;均无或越权 → 404(不泄露存在性)。

    归属口径保持双域既有语义:
      · Studio:同 tenant 可见(与 drama_scenes 历史口径一致)
      · Drama legacy:仅属主 user_id
    """
    sp = session.get(StudioProject, pid)
    if sp is not None:
        if sp.tenant_id != user.tenant_id:
            raise HTTPException(status_code=404, detail="项目不存在")
        return HostKind.STUDIO, sp

    dp = session.get(DramaProject, pid)
    if dp is not None:
        if dp.user_id != user.id:
            raise HTTPException(status_code=404, detail="项目不存在")
        return HostKind.DRAMA_LEGACY, dp

    raise HTTPException(status_code=404, detail="项目不存在")
