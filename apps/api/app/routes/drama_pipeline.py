"""短剧管线状态端点:GET /drama/projects/{pid}/pipeline/status。

状态由 DB 行 + 产物文件存在性实时重算(services/drama_pipeline.py),
直接给出 next_step 与 recoverable 分裂态清单;只读,零写入。
鉴权与归属校验仿照 drama_studio.py:537-554(get_current_user + user 归属,
404 不泄露存在性)。
"""
from __future__ import annotations

import time
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session

from app.db import get_session
from app.deps import get_current_user
from app.models import DramaProject, User
from app.services import drama_pipeline

router = APIRouter()


def _owned_project(pid: str, user: User, session: Session) -> DramaProject:
    """归属校验(同 drama_studio._owned_project):不存在/非本人一律 404,不泄露存在性。"""
    p = session.get(DramaProject, pid)
    if not p or p.user_id != user.id:
        raise HTTPException(status_code=404, detail="项目不存在")
    return p


@router.get("/drama/projects/{pid}/pipeline/status")
def get_pipeline_status(
    pid: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    """管线聚合状态:七阶段重算 + next_step + recoverable,供前端轮询与断点续跑。"""
    _owned_project(pid, user, session)
    t0 = time.monotonic()
    result = drama_pipeline.compute_drama_pipeline_status(session, pid)
    result["generated_at"] = datetime.now(timezone.utc).isoformat()
    result["elapsed_ms"] = round((time.monotonic() - t0) * 1000, 2)
    return result
