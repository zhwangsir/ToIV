"""FU2 成片剪辑作业：EDL 提交 / 状态 / 产物发放。

- POST /api/admin/edit/jobs        提交剪辑作业(单飞;202)
- GET  /api/admin/edit/jobs/{id}   作业状态(done/needs_review/error + qa/findings)
- GET  /api/edit/files/{id}/{name} 产物发放(final/preview.mp4、timeline_view.png、takes_packed.md)
LLM/agent 只产 EDL 声明决策表,渲染与自评在服务端(video-use MIT 并码五件)。
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlmodel import Session

from app.db import get_session
from app.deps import get_current_admin, get_current_user
from app.models import User
from app.services import edit_job, edit_transcript
from app.services.edit_edl import Edl

router = APIRouter(tags=["film-edit"])


class EditJobRequest(BaseModel):
    edl: Edl
    preview: bool = False  # True=1080p crf22 可评档;False=final 1080p crf20


@router.post("/admin/edit/jobs", status_code=202)
async def create_edit_job(
    body: EditJobRequest,
    admin: User = Depends(get_current_admin),
) -> dict:
    job_id = edit_job.submit(body.edl, preview=body.preview)
    if not job_id:
        raise HTTPException(status_code=409, detail="已有剪辑作业在跑(单飞)")
    return {"job_id": job_id}


@router.get("/admin/edit/jobs/{job_id}")
def get_edit_job(job_id: str, admin: User = Depends(get_current_admin)) -> dict:
    st = edit_job.job_status(job_id)
    if not st:
        raise HTTPException(status_code=404, detail="作业不存在")
    return st


@router.get("/edit/files/{job_id}/{name}")
def get_edit_file(
    job_id: str,
    name: str,
    user: User = Depends(get_current_user),
) -> FileResponse:
    path = edit_job.safe_artifact(job_id, name)
    if path is None:
        raise HTTPException(status_code=404, detail="产物不存在")
    return FileResponse(path)


class TranscriptRequest(BaseModel):
    url: str


@router.post("/admin/media/transcript")
async def index_media_transcript(
    body: TranscriptRequest,
    admin: User = Depends(get_current_admin),
    session: Session = Depends(get_session),
) -> dict:
    """生成视频入库文本面:转录+打包+upsert(媒体库文本检索的数据层,UI 归 F11)。"""
    try:
        return await edit_transcript.index_media(session, body.url)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.get("/admin/media/transcripts/search")
def search_transcripts(
    q: str = Query(default=""),
    limit: int = Query(default=20, ge=1, le=100),
    admin: User = Depends(get_current_admin),
    session: Session = Depends(get_session),
) -> dict:
    return {"q": q, "results": edit_transcript.search(session, q, limit)}
