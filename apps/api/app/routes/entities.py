"""P1 全局主体库 CRUD(2026-08-26,对标 Vidu Q3 My References/RefHub)。

角色/场景/道具三类主体跨项目复用:生成页「引用主体」多选、助手 entity_ids
注入、drama 分镜角色解析(services/entities.resolve_shot_characters)共用本表。

- GET /api/entities?kind=:列表(仅当前用户;可选 kind 过滤)
- POST /api/entities:创建(图片字段接受上传句柄 {filename,worker} 或 URL 字符串)
- PUT /api/entities/{id}:更新(仅非 None 字段生效;他人主体 404 防枚举)
- DELETE /api/entities/{id}
- GET /api/entities/{id}/images/{slot}:主体图回显(ref/front/side/back;
  句柄从 worker input 取字节,URL 串 302 到原地址)
- POST /api/entities/resolve-refs:entity_ids → 钉定 worker 的参考图句柄
  (生成页/助手注入参考图链用;复用 assets/from-job 的同机回退+转运思路)

多租户隔离:全部端点仅操作当前用户(user_id)的主体,他人一律 404。
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime
from typing import Literal
from urllib.parse import parse_qs, urlsplit

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, Field, field_validator
from sqlmodel import Session, select

from app.capabilities import required_models, required_nodes
from app.comfy.client import ComfyUIError
from app.comfy.pool import WorkerPool
from app.db import get_session
from app.deps import get_current_user, get_pool, resolve_worker
from app.models import Entity, User, _now
from app.pathsafe import PathTraversalError, validate_path_component
from app.routes.images import _host, _ranged_response
from app.services.entities import best_image_value, parse_image_handle

router = APIRouter()

EntityKind = Literal["character", "scene", "prop"]

# 图片槽位(路径参数 → 模型列名)
_SLOTS = {
    "ref": "ref_image",
    "front": "reference_front",
    "side": "reference_side",
    "back": "reference_back",
}


def _no_traversal(v: str) -> str:
    """文件名安全检查:拒绝路径穿越与绝对路径(仿 routes/reference_assets.py)。"""
    name = v.strip().replace("\\", "/")
    if ".." in name or name.startswith("/"):
        raise ValueError("文件名不允许路径穿越")
    return name


def _image_url_ok(v: str) -> str:
    """URL 字符串形态校验:站内相对路径(/api/...)或 http(s) 绝对地址。"""
    s = v.strip()
    if s.startswith("/"):
        return s
    parts = urlsplit(s)
    if parts.scheme in ("http", "https") and parts.hostname:
        return s
    raise ValueError("图片 URL 仅支持站内路径或 http(s) 地址")


# ---------------------------------------------------------------------------
# 请求 / 响应模型
# ---------------------------------------------------------------------------
class EntityImage(BaseModel):
    """上传句柄形态的图片引用(/api/upload 或 /api/assets/from-job 返回)。"""

    filename: str = Field(min_length=1, max_length=255)
    worker: str = Field(min_length=1, max_length=255)

    _fn_ok = field_validator("filename")(_no_traversal)


# 图片字段输入:句柄对象 / URL 字符串 / 空(清除)
ImageInput = EntityImage | str | None


def _store_image(v: ImageInput) -> str:
    """图片输入 → 持久化字符串(句柄 JSON 或 URL);None/空串 → ''。"""
    if v is None:
        return ""
    if isinstance(v, EntityImage):
        return json.dumps({"filename": v.filename, "worker": v.worker})
    s = v.strip()
    return _image_url_ok(s) if s else ""


def _v_image_str(v: ImageInput) -> ImageInput:
    """字符串形态图片的 URL 校验(422 语义;句柄对象/None/空串放行)。"""
    if isinstance(v, str) and v.strip():
        _image_url_ok(v)
    return v


class EntityCreate(BaseModel):
    kind: EntityKind = "character"
    name: str = Field(min_length=1, max_length=100)
    description: str = Field(default="", max_length=2000)
    prompt_hint: str = Field(default="", max_length=2000)
    ref_image: ImageInput = None
    reference_front: ImageInput = None
    reference_side: ImageInput = None
    reference_back: ImageInput = None

    _imgs_ok = field_validator(
        "ref_image", "reference_front", "reference_side", "reference_back"
    )(_v_image_str)


class EntityUpdate(BaseModel):
    """更新:仅非 None 字段生效(图片字段显式传空串 = 清除该图)。"""

    kind: EntityKind | None = None
    name: str | None = Field(default=None, min_length=1, max_length=100)
    description: str | None = Field(default=None, max_length=2000)
    prompt_hint: str | None = Field(default=None, max_length=2000)
    ref_image: ImageInput = None
    reference_front: ImageInput = None
    reference_side: ImageInput = None
    reference_back: ImageInput = None

    _imgs_ok = field_validator(
        "ref_image", "reference_front", "reference_side", "reference_back"
    )(_v_image_str)


class EntityOut(BaseModel):
    id: str
    kind: str
    name: str
    description: str
    prompt_hint: str
    ref_image: str
    reference_front: str
    reference_side: str
    reference_back: str
    # 已解析的上传句柄(注入参考图链直接用;URL 形态或空则无该槽)
    handles: dict[str, dict]
    # 预览 URL(/api/entities/{id}/images/{slot},带 token 即可 <img> 直显)
    image_urls: dict[str, str]
    # @主体引用前台化契约(lib/entities.ts EntityInfo 同构,camelCase 为既有约定):
    # thumbUrl = 最优图预览(无图空串);imageCount = 非空图槽数
    thumbUrl: str = ""
    imageCount: int = 0
    created_at: datetime
    updated_at: datetime


# ---------------------------------------------------------------------------
# 辅助
# ---------------------------------------------------------------------------
def _to_out(e: Entity) -> EntityOut:
    handles: dict[str, dict] = {}
    image_urls: dict[str, str] = {}
    for slot, col in _SLOTS.items():
        raw = (getattr(e, col) or "").strip()
        if not raw:
            continue
        h = parse_image_handle(raw)
        if h:
            handles[slot] = h
        image_urls[slot] = f"/api/entities/{e.id}/images/{slot}"
    # thumbUrl:与 best_image_value 同一优先级(正面→单图→侧面→背面)
    thumb = ""
    for slot in ("front", "ref", "side", "back"):
        if slot in image_urls:
            thumb = image_urls[slot]
            break
    return EntityOut(
        id=e.id,
        kind=e.kind,
        name=e.name,
        description=e.description,
        prompt_hint=e.prompt_hint,
        ref_image=e.ref_image,
        reference_front=e.reference_front,
        reference_side=e.reference_side,
        reference_back=e.reference_back,
        handles=handles,
        image_urls=image_urls,
        thumbUrl=thumb,
        imageCount=len(image_urls),
        created_at=e.created_at,
        updated_at=e.updated_at,
    )


def _get_owned(session: Session, entity_id: str, user: User) -> Entity:
    """单查 + 归属门控:不存在/非属主 → 统一 404(防枚举,与 reference_assets 同语义)。"""
    e = session.get(Entity, entity_id)
    if not e or e.user_id != user.id:
        raise HTTPException(status_code=404, detail="主体不存在")
    return e


def _apply_images(e: Entity, body: EntityCreate | EntityUpdate) -> None:
    for col in ("ref_image", "reference_front", "reference_side", "reference_back"):
        v = getattr(body, col)
        if v is not None:
            setattr(e, col, _store_image(v))


# ---------------------------------------------------------------------------
# 路由
# ---------------------------------------------------------------------------
@router.get("/entities", response_model=list[EntityOut])
def list_entities(
    kind: EntityKind | None = Query(default=None, description="按主体类别过滤"),
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> list[EntityOut]:
    """列表:仅当前用户主体;可选 kind 过滤;按创建时间升序。"""
    stmt = select(Entity).where(Entity.user_id == user.id)
    if kind is not None:
        stmt = stmt.where(Entity.kind == kind)
    rows = session.exec(stmt.order_by(Entity.created_at)).all()
    return [_to_out(e) for e in rows]


@router.post("/entities", response_model=EntityOut)
def create_entity(
    body: EntityCreate,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> EntityOut:
    """创建主体(图片字段:上传句柄对象 / URL 字符串均可)。"""
    e = Entity(
        tenant_id=user.tenant_id,
        user_id=user.id,
        kind=body.kind,
        name=body.name,
        description=body.description,
        prompt_hint=body.prompt_hint,
    )
    _apply_images(e, body)
    session.add(e)
    session.commit()
    session.refresh(e)
    return _to_out(e)


class ResolveRefsRequest(BaseModel):
    """entity_ids → 参考图句柄解析请求。

    kind:目标任务 kind(capabilities 门控选 worker,与 /api/upload 同款);
    worker:钉定目标 worker(与已选参考图同机,AssetPicker 同款钉点语义)。
    """

    entity_ids: list[str] = Field(min_length=1, max_length=8)
    kind: str = Field(default="img2img", max_length=64)
    worker: str | None = Field(default=None, max_length=255)


@router.post("/entities/resolve-refs")
async def resolve_entity_refs(
    body: ResolveRefsRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
    pool: WorkerPool = Depends(get_pool),
) -> dict:
    """主体图片 → 钉定 worker 的参考图句柄(注入生成参考图链)。

    每个主体取最优参考图(正面→单图→侧面→背面);句柄在同机直接复用,
    跨机/URL 形态取字节后转运到目标 worker input(与 assets/from-job 同链路)。
    无图/不可达主体跳过并记入 skipped,不让一个坏主体拖垮整批。
    """
    # 目标 worker:钉定优先;否则按任务 kind 选型(caps 门控)
    if body.worker:
        target = resolve_worker(body.worker)  # SSRF 白名单校验
        req_models = required_models(body.kind)
        req_nodes = required_nodes(body.kind)
        if req_models and not req_models.issubset(await target.model_names()):
            raise HTTPException(status_code=503, detail="指定 worker 缺少该任务所需模型")
        if req_nodes and not req_nodes.issubset(await target.node_names()):
            raise HTTPException(status_code=503, detail="指定 worker 缺少该任务所需节点")
    else:
        try:
            target = await pool.pick(
                required=required_models(body.kind),
                required_nodes=required_nodes(body.kind),
            )
        except ComfyUIError as e:
            raise HTTPException(status_code=503, detail=str(e)) from e

    refs: list[dict] = []
    skipped: list[dict] = []
    for eid in body.entity_ids:
        e = session.get(Entity, eid)
        if not e or e.user_id != user.id:
            skipped.append({"entity_id": eid, "reason": "主体不存在"})
            continue
        raw = best_image_value(e)
        if not raw:
            skipped.append({"entity_id": eid, "name": e.name, "reason": "无参考图"})
            continue
        handle = parse_image_handle(raw)
        url_type = "input"
        if handle is None:
            # URL 形态:仅支持站内 /api/images?filename=..&worker=..&type=.. 解析
            parts = urlsplit(raw)
            if not parts.path.startswith("/api/images"):
                skipped.append({"entity_id": eid, "name": e.name, "reason": "外部 URL 不可转运"})
                continue
            qs = parse_qs(parts.query)
            fn = (qs.get("filename") or [""])[0]
            wk = (qs.get("worker") or [""])[0]
            url_type = (qs.get("type") or ["output"])[0]
            if not fn or not wk:
                skipped.append({"entity_id": eid, "name": e.name, "reason": "URL 缺少 filename/worker"})
                continue
            handle = {"filename": fn, "worker": wk}
        try:
            safe_filename = validate_path_component(handle["filename"], allow_subdirs=False)
        except PathTraversalError:
            skipped.append({"entity_id": eid, "name": e.name, "reason": "非法文件名"})
            continue

        # 同机(worker base_url 一致且 input 形态)直接复用,否则取字节转运
        if handle["worker"] == target.base_url and url_type == "input":
            refs.append({
                "entity_id": e.id,
                "name": e.name,
                "prompt_hint": e.prompt_hint,
                "filename": safe_filename,
                "worker": target.base_url,
            })
            continue
        try:
            source = resolve_worker(handle["worker"])
        except HTTPException:
            skipped.append({"entity_id": eid, "name": e.name, "reason": "来源 worker 非法"})
            continue
        host = _host(source.base_url)
        siblings = [
            c for c in pool.clients
            if _host(c.base_url) == host and c.base_url != source.base_url
        ]
        content: bytes | None = None
        for client in [source, *siblings]:
            try:
                content, _ = await client.get_image_bytes(safe_filename, "", url_type)
                break
            except ComfyUIError:
                continue
        if content is None:
            skipped.append({"entity_id": eid, "name": e.name, "reason": "图片暂不可取"})
            continue
        ext = "." + safe_filename.rsplit(".", 1)[-1].lower() if "." in safe_filename else ".png"
        try:
            name = await target.upload_image(content, f"toiventity-{uuid.uuid4().hex}{ext}")
        except ComfyUIError as e2:
            skipped.append({"entity_id": eid, "name": e.name, "reason": f"转运失败: {e2}"})
            continue
        refs.append({
            "entity_id": e.id,
            "name": e.name,
            "prompt_hint": e.prompt_hint,
            "filename": name,
            "worker": target.base_url,
        })
    return {"refs": refs, "skipped": skipped, "worker": target.base_url}


@router.get("/entities/{entity_id}", response_model=EntityOut)
def get_entity(
    entity_id: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> EntityOut:
    """单查;他人主体 404。"""
    return _to_out(_get_owned(session, entity_id, user))


@router.put("/entities/{entity_id}", response_model=EntityOut)
def update_entity(
    entity_id: str,
    body: EntityUpdate,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> EntityOut:
    """更新:仅非 None 字段生效;他人主体 404。"""
    e = _get_owned(session, entity_id, user)
    if body.kind is not None:
        e.kind = body.kind
    if body.name is not None:
        e.name = body.name
    if body.description is not None:
        e.description = body.description
    if body.prompt_hint is not None:
        e.prompt_hint = body.prompt_hint
    _apply_images(e, body)
    e.updated_at = _now()
    session.add(e)
    session.commit()
    session.refresh(e)
    return _to_out(e)


@router.delete("/entities/{entity_id}")
def delete_entity(
    entity_id: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    """删除;他人主体 404。只删 DB 记录,不动 worker 上的文件本体。"""
    e = _get_owned(session, entity_id, user)
    session.delete(e)
    session.commit()
    return {"ok": True, "id": entity_id}


@router.get("/entities/{entity_id}/images/{slot}")
async def get_entity_image(
    entity_id: str,
    slot: str,
    request: Request,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
    pool: WorkerPool = Depends(get_pool),
):
    """主体图回显:句柄从 worker input 取字节(同机回退);URL 串 302 到原地址。"""
    if slot not in _SLOTS:
        raise HTTPException(status_code=404, detail="图片不存在")
    e = _get_owned(session, entity_id, user)
    raw = (getattr(e, _SLOTS[slot]) or "").strip()
    if not raw:
        raise HTTPException(status_code=404, detail="图片不存在")
    handle = parse_image_handle(raw)
    if handle is None:
        # 纯 URL 形态:交给原地址(站内签名 URL / 外部图床),不在本端点重复鉴权逻辑
        return RedirectResponse(url=raw, status_code=302)
    try:
        safe_filename = validate_path_component(handle["filename"], allow_subdirs=False)
    except PathTraversalError as exc:
        raise HTTPException(status_code=400, detail=f"非法路径: {exc}") from exc
    primary = resolve_worker(handle["worker"])  # SSRF 白名单校验
    host = _host(primary.base_url)
    siblings = [
        c for c in pool.clients
        if _host(c.base_url) == host and c.base_url != primary.base_url
    ]
    last_err: Exception | None = None
    for client in [primary, *siblings]:
        try:
            content, content_type = await client.get_image_bytes(safe_filename, "", "input")
            return _ranged_response(content, content_type, request.headers.get("range"))
        except ComfyUIError as exc:
            last_err = exc
    raise HTTPException(status_code=502, detail=f"图片暂不可取(同机 worker 均不可达): {last_err}")
