"""媒体 URL 双闸:普通态不得裸出 NSFW 产物(Wave8 P0)。

判据仅 ``nsfw_allowed(user)``(账号 ``content_mode`` + 未成年硬关);
X-NSFW 头不作放行。失败统一 404,不泄露存在性。

能关联到 ``Job.nsfw=True`` 的产物才闸;纯 StudioShot/签名 URL 无 Job 行时
无法判定 —— 见 handback。
"""
from __future__ import annotations

from fastapi import HTTPException
from sqlmodel import Session, select

from app.models import Job, User
from app.redline import nsfw_allowed

_NOT_FOUND = HTTPException(status_code=404, detail="产物不存在")


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
    """/api/images 与 /api/images/thumb:NSFW 产物仅成人态可取。"""
    if nsfw_allowed(user):
        return
    if _nsfw_job_hits_filename(session, filename):
        raise _NOT_FOUND


def assert_studio_file_content_mode_allows(
    session: Session, user: User, name: str
) -> None:
    """/api/studio/files:若 Job.result 标 NSFW,普通态 404。"""
    if nsfw_allowed(user):
        return
    marker = f"/api/studio/files/{name}"
    if _nsfw_job_hits_marker(session, marker):
        raise _NOT_FOUND


def shot_urls_nsfw(session: Session, urls: list[str]) -> bool:
    """分镜媒体 URL 是否命中任一 NSFW Job.result。"""
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
