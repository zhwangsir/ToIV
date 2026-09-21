"""画板(/api/boards)——手动主题板(2026-09-21,纯本地组织工具)。

端点:
- GET    /api/boards            板列表(含成员数/封面)
- POST   /api/boards            建板 {name, description?}
- POST   /api/boards/from-script 分镜板 v2(M1):LLM 拆剧本 → 建板+占位分镜行
- PATCH  /api/boards/{id}       改名/描述/封面/排序
- DELETE /api/boards/{id}       删板(级联成员)
- GET    /api/boards/{id}/items 板内成员(按 sort_order;带作品字段;占位行 job=null)
- PUT    /api/boards/{id}/items 整组替换成员(增删+重排一次写,防半状态;job_id 空=占位行)
- POST   /api/boards/{id}/items/{item_id}/generate 分镜单镜生成(M2:角色实体→phantom/h3 参考图)
- POST   /api/boards/{id}/assemble 一键成片(M3:逐镜生成+配音+词锚定字幕+ffmpeg 拼接)
- POST   /api/boards/{id}/remix 整片级 remix(M3.5:克隆板+换主角/换词/换背景+一键成片)
- GET    /api/boards/{id}/film-jobs 该板成片作业(新→旧,带进度)
- GET    /api/boards/film/{name} 成片/字幕文件(mp4|ass|srt)
- GET    /api/boards/{id}/export 整板导出 drama_studio 格式 JSON(附件下载)
"""
from __future__ import annotations

import json
import logging
import re
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field
from sqlmodel import Session, select

from app.agent.llm import LLMError
from app.comfy.pool import WorkerPool
from app.db import get_session
from app.deps import get_current_user, get_pool
from app.models import Board, BoardItem, Job, User
from app.ratelimit import enforce_generation_rate_limit
from app.routes.jobs import _app_id_of, _app_names_map, _job_dict
from app.services.board_film import KIND as BOARD_FILM_KIND, start_board_film
from app.services.board_generate import prepare_shot_meta, submit_shot_generation
from app.services.board_storyboard import (
    build_export_document,
    create_board_from_script as create_board_from_script_svc,
)
from app.services.studio.storyboard import StoryboardError
from app.storage import drama_output_root

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


class ShotGenerateIn(BaseModel):
    """分镜单镜生成(M2):按行 shot_meta + 角色实体参考图提交引擎。"""

    engine: str = Field(pattern="^(phantom-s2v|h3-r2v|h3-t2v)$")
    seed: int | None = Field(default=None, ge=0, le=2**63 - 1)
    fps: int = Field(default=16, ge=8, le=30)


class AssembleIn(BaseModel):
    """一键成片(M3):缺失镜逐镜生成 → 台词镜配音 → 词锚定字幕 → ffmpeg 拼接。

    reuse_existing=true(默认):行已挂 done 视频作业直接复用(审片循环——改镜重生成后
    重拼只补缺失/被换镜);burn_subtitles=false 时只拼接不烧字(ass/srt 侧车仍产出)。
    """

    engine: str = Field(default="phantom-s2v", pattern="^(phantom-s2v|h3-r2v|h3-t2v)$")
    fps: int = Field(default=16, ge=8, le=30)
    reuse_existing: bool = True
    burn_subtitles: bool = True


class RemixIn(BaseModel):
    """整片级 remix(M3.5):克隆板+结构级改写+一键成片(默认自动发起)。

    - kind=protagonist:character_map={旧角色名: 新主体 id}(命中行强制重出);
    - kind=words:dialogue_overrides={item_id: {dialogue, speaker?}}(视频全复用,最省);
    - kind=broll:prompt_suffix 全局追加 或 prompt_overrides={item_id: prompt}(强制重出)。
    """

    kind: str = Field(pattern="^(protagonist|words|broll)$")
    engine: str = Field(default="phantom-s2v", pattern="^(phantom-s2v|h3-r2v|h3-t2v)$")
    fps: int = Field(default=16, ge=8, le=30)
    character_map: dict[str, str] = Field(default_factory=dict)
    dialogue_overrides: dict[int, dict] = Field(default_factory=dict)
    prompt_suffix: str = Field(default="", max_length=500)
    prompt_overrides: dict[int, str] = Field(default_factory=dict)
    auto_assemble: bool = True


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
    M2:角色草稿幂等落库 Entity(kind=character),shot_meta 写 entity_ids(与 characters 同序)。
    """
    try:
        b, item_count, _cast = await create_board_from_script_svc(
            session, user, body.script, body.num_shots, body.style, body.name
        )
    except (StoryboardError, LLMError) as exc:
        raise HTTPException(status_code=503, detail=f"剧本拆解服务暂不可用: {exc}") from exc
    return {"board": _board_out(session, b), "item_count": item_count}


@router.post("/boards/{board_id}/items/{item_id}/generate")
async def generate_board_shot(
    board_id: str,
    item_id: int,
    body: ShotGenerateIn,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
    pool: WorkerPool = Depends(get_pool),
) -> dict:
    """分镜单镜生成(M2):按行 shot_meta(prompt/时长)+角色实体(定妆照)提交引擎。

    phantom-s2v=角色锁定(实体需有定妆照)/h3-r2v=多参考(resolve-refs 出句柄)/
    h3-t2v=快速兜底(无角色也可)。手动添加的无 shot_meta 行以 shot_text 作 scene 兜底。
    """
    b = _owned_board(session, user, board_id)
    item = session.get(BoardItem, item_id)
    if not item or item.board_id != b.id:
        raise HTTPException(status_code=404, detail="分镜行不存在")
    try:
        return await submit_shot_generation(
            session, pool, user, prepare_shot_meta(item), body.engine, seed=body.seed, fps=body.fps
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.get("/boards/{board_id}/export")
def export_board(
    board_id: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> JSONResponse:
    """整板导出 drama_studio 格式 JSON(字段对齐 _shot_dict;媒体取自挂载作品;M2 角色升维)。"""
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
    doc = build_export_document(b, rows, session=session, user_id=user.id)
    quoted = quote(f"{b.name}.drama_studio.json")
    return JSONResponse(
        content=doc,
        headers={
            "Content-Disposition": (
                f"attachment; filename=board.drama_studio.json; filename*=UTF-8''{quoted}"
            )
        },
    )


_FILM_NAME_RE = re.compile(r"^board-film-[0-9a-f]{32}\.(mp4|ass|srt)$")


@router.post("/boards/{board_id}/remix")
async def remix_board(
    board_id: str,
    body: RemixIn,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    """整片级 remix(M3.5):克隆板+按类改写+(默认)一键成片。

    返回新板 id 与(若 auto_assemble)成片作业 prompt_id;原版不动。
    """
    enforce_generation_rate_limit(user)
    b = _owned_board(session, user, board_id)
    from app.services.board_remix import clone_board_with_remix, resolve_character_map

    character_map = None
    if body.kind == "protagonist":
        character_map = resolve_character_map(session, user, body.character_map)
    nb, stats = clone_board_with_remix(
        session, user, b, body.kind,
        character_map=character_map,
        dialogue_overrides=body.dialogue_overrides,
        prompt_suffix=body.prompt_suffix,
        prompt_overrides=body.prompt_overrides,
    )
    out: dict = {"board": _board_out(session, nb), "stats": stats, "film": None}
    if body.auto_assemble:
        job = start_board_film(session, user, nb, body.engine, body.fps)
        out["film"] = {"prompt_id": job.prompt_id, "kind": job.kind, "status": job.status}
    return out


@router.post("/boards/{board_id}/assemble")
async def assemble_board(
    board_id: str,
    body: AssembleIn,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    """一键成片(M3):建合成 Job(kind=board_film, worker="")+后台管线,秒回 prompt_id。

    同一板已有活跃(queued/running)成片作业 → 409 防重(返回在跑作业 id)。
    """
    enforce_generation_rate_limit(user)
    b = _owned_board(session, user, board_id)
    job = start_board_film(
        session, user, b, body.engine, body.fps, body.reuse_existing, body.burn_subtitles
    )
    return {"prompt_id": job.prompt_id, "kind": job.kind, "status": job.status}


@router.get("/boards/{board_id}/film-jobs")
def list_film_jobs(
    board_id: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> list[dict]:
    """该板成片作业(新→旧),progress JSON 解析透出。"""
    b = _owned_board(session, user, board_id)
    rows = session.exec(
        select(Job)
        .where(Job.user_id == user.id, Job.kind == BOARD_FILM_KIND)
        .order_by(Job.created_at.desc())
        .limit(10)
    ).all()
    out = []
    for j in rows:
        try:
            plan = json.loads(j.params or "{}")
        except ValueError:
            plan = {}
        if plan.get("board_id") != b.id:
            continue
        progress = None
        if j.progress:
            try:
                progress = json.loads(j.progress)
            except ValueError:
                progress = None
        results = []
        if j.result:
            try:
                results = json.loads(j.result)
            except ValueError:
                results = []
        out.append({
            "prompt_id": j.prompt_id,
            "status": j.status,
            "progress": progress,
            "results": results,
            "error": j.error or "",
            "film": plan.get("film") or {},
            "created_at": j.created_at.isoformat(),
        })
    return out


@router.get("/boards/film/{name}")
def get_film_file(
    name: str,
    user: User = Depends(get_current_user),
) -> FileResponse:
    """成片/字幕文件(mp4 播放;ass/srt 侧车下载)。"""
    if not _FILM_NAME_RE.match(name):
        raise HTTPException(status_code=400, detail="非法文件名")
    path = drama_output_root() / name
    if not path.is_file():
        raise HTTPException(status_code=404, detail="文件不存在")
    media = "video/mp4" if name.endswith(".mp4") else "text/plain; charset=utf-8"
    return FileResponse(
        path,
        media_type=media,
        filename=name,
        headers={"Cache-Control": "public, max-age=86400"},
    )
