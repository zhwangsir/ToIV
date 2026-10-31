"""[DEPRECATED · P0-5 R1] 媒体 URL 成人 UX 闸已退役(限制只前端)。

本模块保留薄壳 no-op,避免旧 import 炸裂;**禁止**再加 content_mode/NSFW 404。
未成年硬关见 ``app.redline.require_not_underage``(独立入口),不经本模块。

``shot_urls_nsfw`` 仍可标注分镜 ``nsfw`` 字段;调用方不得据此过滤/404。
"""
from __future__ import annotations

from sqlmodel import Session, select

from app.models import Job, User

# 保留内部探测供 shot_urls_nsfw 标注;断言函数一律 no-op。


def _nsfw_job_hits_filename(session: Session, filename: str) -> bool:
    """任一 Job.result 引用该 filename 且 nsfw=True。"""
    if not filename:
        return False
    needle = f"filename={filename}"
    row = session.exec(
        select(Job.id).where(Job.nsfw == True, Job.result.like(f"%{needle}%"))  # noqa: E712
    ).first()
    return row is not None


def _nsfw_job_hits_marker(session: Session, marker: str) -> bool:
    """任一 Job.result 含站内媒体路径且 nsfw=True。"""
    if not marker:
        return False
    row = session.exec(
        select(Job.id).where(Job.nsfw == True, Job.result.like(f"%{marker}%"))  # noqa: E712
    ).first()
    return row is not None


def assert_image_content_mode_allows(
    session: Session, user: User, filename: str
) -> None:
    """No-op:Wave8 媒体 UX 闸已退役(P0-5 R1)。参数保留兼容调用方。"""
    return


def assert_studio_file_content_mode_allows(
    session: Session, user: User, name: str
) -> None:
    """No-op:Wave8 媒体 UX 闸已退役(P0-5 R1)。参数保留兼容调用方。"""
    return


def shot_urls_nsfw(session: Session, urls: list[str]) -> bool:
    """分镜媒体 URL 是否命中任一 NSFW Job.result(仅标注,勿过滤)。"""
    for u in urls:
        u = (u or "").strip()
        if not u:
            continue
        if _nsfw_job_hits_marker(session, u):
            return True
        # /api/images?filename=x → 抽 filename
        if "filename=" in u:
            from urllib.parse import parse_qs, urlparse

            q = parse_qs(urlparse(u).query)
            fn = (q.get("filename") or [""])[0]
            if fn and _nsfw_job_hits_filename(session, fn):
                return True
    return False
