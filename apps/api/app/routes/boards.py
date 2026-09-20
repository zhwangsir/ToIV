"""画板(/api/boards)——手动主题板(2026-09-21,纯本地组织工具)。

端点:
- GET    /api/boards            板列表(含成员数/封面)
- POST   /api/boards            建板 {name, description?}
- PATCH  /api/boards/{id}       改名/描述/封面/排序
- DELETE /api/boards/{id}       删板(级联成员)
- GET    /api/boards/{id}/items 板内成员(按 sort_order;带作品字段)
- PUT    /api/boards/{id}/items 整组替换成员(增删+重排一次写,防半状态)
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlmodel import Session, select

from app.db import get_session
from app.deps import get_current_user
from app.models import Board, BoardItem, Job, User
from app.routes.jobs import _app_id_of, _app_names_map, _job_dict

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
    job_id: str = Field(min_length=1, max_length=64)
    note: str = Field(default="", max_length=500)
    shot_text: str = Field(default="", max_length=2000)


class ItemsPut(BaseModel):
    """整组替换(增删+排序一次写):job_id 重复时以后面出现者为准。"""

    items: list[ItemPut] = Field(default_factory=list, max_length=500)


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
            job = session.get(Job, it.job_id)
            if job and job.result:
                import json as _json
                try:
                    rs = _json.loads(job.result)
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
    jobs = [session.get(Job, it.job_id) for it in rows]
    alive_jobs = [j for j in jobs if j is not None]
    names = _app_names_map(session, alive_jobs)
    out = []
    for it, job in zip(rows, jobs):
        if job is None or job.deleted_at is not None:
            continue  # 作品已彻底删除的成员静默跳过(不炸板)
        out.append({
            "id": it.id,
            "sort_order": it.sort_order,
            "note": it.note,
            "shot_text": it.shot_text,
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
    """整组替换:body.items 即期望终态(存在性校验:作业须属本人且未删)。"""
    b = _owned_board(session, user, board_id)
    seen: set[str] = set()
    clean: list[ItemPut] = []
    for it in body.items:
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
        session.add(BoardItem(board_id=b.id, job_id=it.job_id,
                              sort_order=idx, note=it.note, shot_text=it.shot_text))
    session.commit()
    return {"item_count": len(clean)}
