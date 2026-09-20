"""画板(/api/boards)——手动主题板(2026-09-21,纯本地组织工具)。

端点:
- GET    /api/boards            板列表(含成员数/封面)
- POST   /api/boards            建板 {name, description?}
- POST   /api/boards/from-script 分镜板 v2(M1):LLM 拆剧本 → 建板+占位分镜行
- PATCH  /api/boards/{id}       改名/描述/封面/排序
- DELETE /api/boards/{id}       删板(级联成员)
- GET    /api/boards/{id}/items 板内成员(按 sort_order;带作品字段;占位行 job=null)
- PUT    /api/boards/{id}/items 整组替换成员(增删+重排一次写,防半状态;job_id 空=占位行)
- GET    /api/boards/{id}/export 整板导出 drama_studio 格式 JSON(附件下载)
"""
from __future__ import annotations

import json
import logging
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sqlmodel import Session, select

from app.agent.llm import LLMError
from app.db import get_session
from app.deps import get_current_user
from app.models import Board, BoardItem, Job, User
from app.routes.jobs import _app_id_of, _app_names_map, _job_dict
from app.services.board_storyboard import build_export_document, compose_shot_text
from app.services.studio.storyboard import StoryboardError, parse_script

logger = logging.getLogger(__name__)
router = APIRouter()


def _owned_board(session: Session, user: User, board_id: str) -> Board:
    b = session.get(Board, board_id)
    if not b or b.user_id != user.id:
        raise HTTPException(status_code=404, detail="画板不存在")
    return b


class BoardCreate(BaseModel):
    name: str = Field(min_length=1, max_length=64)
    description: str = Field(default="", max_length=500)


class BoardPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=64)
    description: str | None = Field(default=None, max_length=500)
    cover_job_id: str | None = Field(default=None, max_length=64)
    sort: int | None = None


class ItemPut(BaseModel):
    # job_id 空串 = 占位分镜行(LLM 拆剧本产出、尚未挂作品的行)
    job_id: str = Field(default="", max_length=64)
    note: str = Field(default="", max_length=500)
    shot_text: str = Field(default="", max_length=2000)
    shot_meta: str = Field(default="", max_length=8000)


class ItemsPut(BaseModel):
    """整组替换(增删+排序一次写):非空 job_id 重复时以先出现者为准;空 job_id(占位行)不去重。"""

    items: list[ItemPut] = Field(default_factory=list, max_length=500)


class ScriptBoardCreate(BaseModel):
    """分镜板 v2(M1):LLM 拆剧本 → 建板+占位分镜行(巨日禄模式)。"""

    script: str = Field(min_length=1, max_length=20000)
    num_shots: int = Field(default=8, ge=1, le=50)
    style: str = Field(default="", max_length=2000)
    name: str = Field(default="", max_length=64)


def _board_out(session: Session, b: Board) -> dict:
    count = len(session.exec(select(BoardItem).where(BoardItem.board_id == b.id)).all())
    cover_url = ""
    cover_id = b.cover_job_id
    if cover_id:
        job = session.get(Job, cover_id)
        if job and job.result:
            import json as _json
            try:
                rs = _json.loads(job.result)
                cover_url = rs[0] if rs else ""
            except ValueError:
                pass
    if not cover_url:
        items = session.exec(
            select(BoardItem).where(BoardItem.board_id == b.id).order_by(BoardItem.sort_order)
        ).all()
        for it in items:
            if not it.job_id:
                continue  # 占位分镜行无作品,跳过
            job = session.get(Job, it.job_id)
            if job and job.result:
                try:
                    rs = json.loads(job.result)
                    if rs:
                        cover_url = rs[0]
                        break
                except ValueError:
                    continue
    return {
        "id": b.id, "name": b.name, "description": b.description,
        "cover_job_id": b.cover_job_id, "cover_url": cover_url,
        "item_count": count, "sort": b.sort, "created_at": b.created_at.isoformat(),
    }


@router.get("/boards")
def list_boards(
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> list[dict]:
    rows = session.exec(
        select(Board).where(Board.user_id == user.id).order_by(Board.sort, Board.created_at.desc())
    ).all()
    return [_board_out(session, b) for b in rows]


@router.post("/boards")
def create_board(
    body: BoardCreate,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    b = Board(tenant_id=user.tenant_id, user_id=user.id, name=body.name, description=body.description)
    session.add(b)
    session.commit()
    session.refresh(b)
    return _board_out(session, b)


@router.patch("/boards/{board_id}")
def patch_board(
    board_id: str,
    body: BoardPatch,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    b = _owned_board(session, user, board_id)
    for field in ("name", "description", "cover_job_id", "sort"):
        val = getattr(body, field)
        if val is not None:
            setattr(b, field, val)
    session.add(b)
    session.commit()
    return _board_out(session, b)


@router.delete("/boards/{board_id}")
def delete_board(
    board_id: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    b = _owned_board(session, user, board_id)
    for it in session.exec(select(BoardItem).where(BoardItem.board_id == b.id)).all():
        session.delete(it)
    session.delete(b)
    session.commit()
    return {"deleted": True}


@router.get("/boards/{board_id}/items")
def list_items(
    board_id: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> list[dict]:
    b = _owned_board(session, user, board_id)
    rows = session.exec(
        select(BoardItem).where(BoardItem.board_id == b.id).order_by(BoardItem.sort_order)
    ).all()
    jobs = [session.get(Job, it.job_id) if it.job_id else None for it in rows]
    alive_jobs = [j for j in jobs if j is not None]
    names = _app_names_map(session, alive_jobs)
    out = []
    for it, job in zip(rows, jobs):
        if not it.job_id:
            # 占位分镜行(尚未挂作品):job=null 透出,行保留
            out.append({
                "id": it.id,
                "sort_order": it.sort_order,
                "note": it.note,
                "shot_text": it.shot_text,
                "shot_meta": it.shot_meta,
                "job": None,
            })
            continue
        if job is None or job.deleted_at is not None:
            continue  # 作品已彻底删除的成员静默跳过(不炸板)
        out.append({
            "id": it.id,
            "sort_order": it.sort_order,
            "note": it.note,
            "shot_text": it.shot_text,
            "shot_meta": it.shot_meta,
            "job": _job_dict(job, names.get(_app_id_of(job), "")),
        })
    return out


@router.put("/boards/{board_id}/items")
def put_items(
    board_id: str,
    body: ItemsPut,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    """整组替换:body.items 即期望终态(非空 job_id 校验:作业须属本人且未删;空=占位行)。"""
    b = _owned_board(session, user, board_id)
    seen: set[str] = set()
    clean: list[ItemPut] = []
    for it in body.items:
        if not it.job_id:
            clean.append(it)  # 占位分镜行:无作品可校验,互不去重
            continue
        if it.job_id in seen:
            continue
        seen.add(it.job_id)
        job = session.get(Job, it.job_id)
        if job is None or job.user_id != user.id or job.deleted_at is not None:
            raise HTTPException(status_code=422, detail=f"作品不存在或不属于当前用户: {it.job_id[:12]}")
        clean.append(it)
    for old in session.exec(select(BoardItem).where(BoardItem.board_id == b.id)).all():
        session.delete(old)
    for idx, it in enumerate(clean):
        session.add(BoardItem(board_id=b.id, job_id=it.job_id, sort_order=idx,
                              note=it.note, shot_text=it.shot_text, shot_meta=it.shot_meta))
    session.commit()
    return {"item_count": len(clean)}


@router.post("/boards/from-script")
async def create_board_from_script(
    body: ScriptBoardCreate,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    """分镜板 v2(M1):LLM 拆剧本 → 建板 + 占位分镜行(shot_text 人读/shot_meta 结构化)。

    复用现役 studio 链 parse_script(L3 精修层 + 指代消解后处理,实测 20-30s)。
    """
    try:
        _characters, shots = await parse_script(
            premise=body.script, num_shots=body.num_shots, style=body.style
        )
    except (StoryboardError, LLMError) as exc:
        raise HTTPException(status_code=503, detail=f"剧本拆解服务暂不可用: {exc}") from exc
    name = body.name.strip()
    if not name:
        head = " ".join(body.script.split())[:12]
        name = f"漫剧分镜 · {head}" if head else "漫剧分镜"
    b = Board(tenant_id=user.tenant_id, user_id=user.id, name=name[:64])
    session.add(b)
    session.commit()
    session.refresh(b)
    for idx, draft in enumerate(shots):
        session.add(BoardItem(
            board_id=b.id,
            job_id="",
            sort_order=idx,
            shot_text=compose_shot_text(draft),
            shot_meta=json.dumps(draft.model_dump(), ensure_ascii=False),
        ))
    session.commit()
    return {"board": _board_out(session, b), "item_count": len(shots)}


@router.get("/boards/{board_id}/export")
def export_board(
    board_id: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> JSONResponse:
    """整板导出 drama_studio 格式 JSON(字段对齐 _shot_dict;媒体取自挂载作品)。"""
    b = _owned_board(session, user, board_id)
    items = session.exec(
        select(BoardItem).where(BoardItem.board_id == b.id).order_by(BoardItem.sort_order)
    ).all()
    rows: list[tuple[BoardItem, Job | None]] = []
    for it in items:
        job = session.get(Job, it.job_id) if it.job_id else None
        if job is not None and job.deleted_at is not None:
            job = None
        rows.append((it, job))
    doc = build_export_document(b, rows)
    quoted = quote(f"{b.name}.drama_studio.json")
    return JSONResponse(
        content=doc,
        headers={
            "Content-Disposition": (
                f"attachment; filename=board.drama_studio.json; filename*=UTF-8''{quoted}"
            )
        },
    )
