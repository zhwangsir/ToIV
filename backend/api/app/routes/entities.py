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
import logging
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

logger = logging.getLogger(__name__)

router = APIRouter()

EntityKind = Literal["character", "scene", "prop", "avatar"]

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
    # avatar 扩展(数字人形象):绿幕标记 / 默认音色参考 / R18 标记
    green_screen: bool = False
    ref_audio: str = Field(default="", max_length=2000)
    nsfw: bool = False

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
    green_screen: bool | None = None
    ref_audio: str | None = Field(default=None, max_length=2000)
    nsfw: bool | None = None

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
    # avatar 扩展 + 三视图生成状态(2026-08-29)
    green_screen: bool = False
    ref_audio: str = ""
    nsfw: bool = False
    reference_status: str = ""
    reference_error: str = ""
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
        green_screen=e.green_screen,
        ref_audio=e.ref_audio,
        nsfw=e.nsfw,
        reference_status=e.reference_status,
        reference_error=e.reference_error,
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
        green_screen=body.green_screen,
        ref_audio=body.ref_audio,
        nsfw=body.nsfw,
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
    if body.green_screen is not None:
        e.green_screen = body.green_screen
    if body.ref_audio is not None:
        e.ref_audio = body.ref_audio
    if body.nsfw is not None:
        e.nsfw = body.nsfw
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


# ---------------------------------------------------------------------------
# 补图(2026-08-29 主体库重做):AI 生成三视图(正/侧/背),异步回写
# ---------------------------------------------------------------------------
# 与 drama_studio 三视图同一模式:提交 3 个 t2i 作业即返回 reference_status=
# generating,后台任务等待 ≤900s 回写四个图槽(front 顺带回填 ref_image,
# 仅当 ref_image 原本为空——不覆盖用户已有单图)。前端轮询 /api/entities 刷新。

_BG_TASKS: set = set()


def _spawn(coro) -> None:
    """fire-and-forget 启动后台协程,持强引用直到完成,防 GC 提前回收。"""
    import asyncio as _asyncio

    task = _asyncio.create_task(coro)
    _BG_TASKS.add(task)
    task.add_done_callback(_BG_TASKS.discard)


class GenerateEntityReferenceRequest(BaseModel):
    """AI 生成三视图请求。空 visual_prompt_override 用 prompt_hint,
    再空则用 LLM 把中文 description 翻成英文 visual prompt(一次性落库)。"""

    visual_prompt_override: str | None = Field(default=None, max_length=1000)
    seed: int | None = Field(default=None, ge=0, le=2**63 - 1)


@router.post("/entities/{entity_id}/generate-reference", response_model=EntityOut)
async def generate_entity_reference(
    entity_id: str,
    body: GenerateEntityReferenceRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
    pool: WorkerPool = Depends(get_pool),
) -> EntityOut:
    """AI 生成主体三视图(正/侧/背):异步提交 + 后台回写,解决主体库 87% 无图。

    同步段只做快速失败校验(主体归属/prompt 可得/worker 可选/提交成功),
    生成等待(1-3 分钟)全部在后台;前端按 reference_status 轮询。
    """
    import uuid as _uuid

    from app.comfy.tracker import spawn as spawn_tracker
    from app.config import get_settings
    from app.models import Job
    from app.routes.drama_studio import _build_t2i_graph, _t2i_required_models
    from app.versioning import params_snapshot

    e = _get_owned(session, entity_id, user)
    if e.reference_status == "generating":
        raise HTTPException(status_code=409, detail="三视图正在生成中,请稍候")

    from app.ratelimit import enforce_generation_rate_limit

    enforce_generation_rate_limit(user, count=3)

    prompt = (body.visual_prompt_override or e.prompt_hint).strip()
    if not prompt and e.description.strip():
        # 中文描述 → LLM 翻译英文 visual prompt(关 thinking 消除推理延迟)
        from app.harness.ctx import get_ctx

        try:
            msg = await get_ctx().service("llm").chat_layered(
                [
                    {"role": "system", "content": (
                        "你是角色视觉描述翻译器。把中文角色描述转成一段英文视觉提示词(visual prompt),"
                        "用于文生图模型的角色参考图生成。要求:\n"
                        "1) 输出一段连贯英文(50-100词),描述角色的外观/服装/体态/气质;\n"
                        "2) 忠实中文原意,不添加原描述没有的特征;\n"
                        "3) 只输出英文提示词本身,不要解释/引号/换行。"
                    )},
                    {"role": "user", "content": e.description.strip()},
                ],
                layer="L1",
                enable_thinking=False,
            )
            prompt = (msg.get("content") or "").strip().strip('"').strip()
        except Exception:
            logger.warning("entity generate-reference: LLM 翻译失败 eid=%s", entity_id)
        if prompt:
            # 落库:后续生成/分镜直接复用
            e.prompt_hint = prompt
            session.add(e)
            session.commit()
    if not prompt:
        raise HTTPException(status_code=422, detail="主体缺少描述或提示词,无法生成参考图")

    settings = get_settings()
    ckpt_name = settings.default_ckpt
    required = _t2i_required_models(ckpt_name)
    try:
        client = await pool.pick(required=required)
    except ComfyUIError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    views: list[tuple[str, str]] = [
        ("front", f"{prompt}, front view, character reference sheet"),
        ("side", f"{prompt}, side view, character reference sheet"),
        ("back", f"{prompt}, back view, character reference sheet"),
    ]
    prompt_ids: list[str] = []
    for view_name, view_prompt in views:
        graph, seed_used = _build_t2i_graph(
            positive=view_prompt,
            ckpt_name=ckpt_name,
            width=768,
            height=1024,  # 竖图适合角色全身参考
            seed=body.seed,
            filename_prefix=f"ToIV_entity_{view_name}",
        )
        try:
            pid = await client.queue_prompt(graph, _uuid.uuid4().hex)
        except ComfyUIError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc
        prompt_ids.append(pid)
        session.add(
            Job(
                tenant_id=user.tenant_id,
                user_id=user.id,
                prompt_id=pid,
                worker=client.base_url,
                kind=f"entity_reference_{view_name}",
                status="queued",
                prompt=view_prompt,
                seed=seed_used,
                # entity_id 入快照:api 重启后 reconcile 按此反查作业重挂回写
                params=params_snapshot(body, seed=seed_used, ckpt_name=ckpt_name, entity_id=entity_id),
            )
        )
    e.reference_status = "generating"
    e.reference_error = ""
    session.add(e)
    session.commit()
    for pid in prompt_ids:
        spawn_tracker(client, pid)
    _spawn(_writeback_entity_reference(entity_id, prompt_ids))
    session.refresh(e)
    return _to_out(e)


# 回写任务多轮等待的总预算:tracker 作业生命周期远大于单轮窗口;worker 停机维护
# (如 2026-08-29 :8189 驱动级挂死、整机重启 ~2h)期间一次性超时退出会把主体永久
# 卡在 generating(生产实证),改为小睡后进入下一轮,直到作业全部终态或超出总预算。
_WRITEBACK_ROUND_SEC = 900.0
_WRITEBACK_MAX_WAIT_SEC = 7200.0
_WRITEBACK_RETRY_GAP_SEC = 30.0


async def _writeback_entity_reference(entity_id: str, prompt_ids: list[str]) -> None:
    """三视图作业完成后回写四图槽 + 状态(多轮等待;作业仍在跑不标 error)。"""
    import asyncio as _asyncio
    import time as _time

    from app.comfy.tracker import wait_for_jobs
    from app.db import engine as _engine
    from app.models import Job

    deadline = _time.monotonic() + _WRITEBACK_MAX_WAIT_SEC
    try:
        while True:
            with Session(_engine) as s:
                wait_err: RuntimeError | None = None
                results: dict[str, list[str]] = {}
                try:
                    results = await wait_for_jobs(s, prompt_ids, timeout=_WRITEBACK_ROUND_SEC)
                except RuntimeError as exc:
                    wait_err = exc
                s.commit()  # 结束读事务快照,看到 tracker 最新提交
                jobs = {
                    j.prompt_id: j
                    for j in s.exec(select(Job).where(Job.prompt_id.in_(prompt_ids))).all()  # type: ignore[attr-defined]
                }
                urls: list[list[str]] = []
                for pid in prompt_ids:
                    pid_urls = results.get(pid, [])
                    job = jobs.get(pid)
                    if not pid_urls and job and job.status == "done" and job.result:
                        try:
                            pid_urls = json.loads(job.result)
                        except (ValueError, TypeError):
                            pid_urls = []
                    urls.append(pid_urls)
                ent = s.get(Entity, entity_id)
                if all(urls) and ent:
                    ent.reference_front = urls[0][0]
                    ent.reference_side = urls[1][0]
                    ent.reference_back = urls[2][0]
                    if not ent.ref_image.strip():
                        ent.ref_image = urls[0][0]  # 无单图时正面回填,不覆盖已有
                    ent.reference_status = "done"
                    ent.reference_error = ""
                    ent.updated_at = _now()
                    s.add(ent)
                    s.commit()
                    return
                alive = [j for j in jobs.values() if j.status not in ("done", "error")]
                if alive and _time.monotonic() < deadline:
                    logger.info(
                        "entity %s reference writeback: %d/%d 作业仍在跑,%.0fs 后下一轮等待",
                        entity_id, len(alive), len(prompt_ids), _WRITEBACK_RETRY_GAP_SEC,
                    )
                else:
                    if ent and ent.reference_status == "generating":
                        failed = [j for j in jobs.values() if j.status == "error"]
                        reason = next((j.hold_reason for j in failed if j.hold_reason), "")
                        ent.reference_status = "error"
                        ent.reference_error = (reason or "三视图生成失败或超时")[:200]
                        s.add(ent)
                        s.commit()
                    return
            await _asyncio.sleep(_WRITEBACK_RETRY_GAP_SEC)
    except Exception as exc:  # noqa: BLE001
        logger.exception("entity %s reference writeback failed: %s", entity_id, exc)
        with Session(_engine) as s:
            ent = s.get(Entity, entity_id)
            if ent and ent.reference_status == "generating":
                ent.reference_status = "error"
                ent.reference_error = str(exc)[:200]
                s.add(ent)
                s.commit()


def reconcile_entity_references() -> dict:
    """api 启动时收口 reference_status=generating 的主体(参照 drama_studio.reconcile_interrupted)。

    回写任务是进程内协程,api 重启即消失;按 params 快照里的 entity_id 反查该主体
    最近一次三视图作业(kind=entity_reference_{front,side,back} 按 created_at 最新):
    - 三视图作业齐且全 alive / 全 done → 重挂回写任务(后者即时收尾写图槽)
    - 有 error / 作业找不回(旧数据无 entity_id、回收站清理)→ 标 error 允许重试
    需在已有事件循环的上下文调用(_spawn 内用 create_task)。返回处置计数。
    """
    from app.db import engine as _engine
    from app.models import Job

    stats = {"rehang": 0, "error": 0}
    with Session(_engine) as s:
        ents = s.exec(select(Entity).where(Entity.reference_status == "generating")).all()
        for ent in ents:
            candidates = s.exec(
                select(Job)
                .where(Job.user_id == ent.user_id)
                .where(Job.kind.like("entity_reference_%"))  # type: ignore[union-attr]
                .order_by(Job.created_at.desc())  # type: ignore[attr-defined]
            ).all()
            pids_by_view: dict[str, str] = {}
            for j in candidates:
                view = j.kind.removeprefix("entity_reference_")
                if view not in ("front", "side", "back") or view in pids_by_view:
                    continue
                try:
                    p = json.loads(j.params or "{}")
                except (ValueError, TypeError):
                    p = {}
                if p.get("entity_id") == ent.id:
                    pids_by_view[view] = j.prompt_id
            prompt_ids = [pids_by_view.get(v) for v in ("front", "side", "back")]
            jobs: list[Job] = []
            if all(prompt_ids):
                jobs = list(
                    s.exec(select(Job).where(Job.prompt_id.in_(prompt_ids))).all()  # type: ignore[attr-defined]
                )
            if len(jobs) < 3 or any(j.status == "error" for j in jobs):
                ent.reference_status = "error"
                ent.reference_error = "生成中断或失败,请重新发起"
                ent.updated_at = _now()
                s.add(ent)
                stats["error"] += 1
                continue
            # alive(tracker 会继续推进)或全 done(回写即时收尾)→ 重挂回写任务
            _spawn(_writeback_entity_reference(ent.id, [p for p in prompt_ids if p]))
            stats["rehang"] += 1
        if stats["rehang"] or stats["error"]:
            s.commit()
            logger.info("entity reference reconcile: %s", stats)
    return stats
