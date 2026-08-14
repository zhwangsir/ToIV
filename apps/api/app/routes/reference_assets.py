"""R2.3 参考资产库 CRUD —— 项目级常驻角色/场景/道具/风格卡。

对标 MiniMax Design 分工式参考 / Lovart Brand Kit:每镜头生成时从资产库勾选引用,
而非每次重新上传。本里程碑只做 DB + CRUD,不做前端 UI、不做 orchestrator 打通。

- GET /api/assets?kind=character:列表(可选 kind 过滤;仅当前用户;SFW 上下文滤掉 nsfw 资产)
- POST /api/assets:创建(kind 枚举、images 1-4 张、filename 路径穿越检查、name 1-100 字符)
- GET /api/assets/{asset_id}:单查(他人资产返 404 防枚举;nsfw 资产 SFW 上下文同样 404)
- PATCH /api/assets/{asset_id}:部分更新 name/description/images/kind/nsfw
- DELETE /api/assets/{asset_id}

images 只持久化 /api/upload 返回的 {filename, worker} 句柄,文件本体不重复存储;
1-4 张硬上限:业界共识参考元素 ≤4 是质量拐点。
NSFW 可见性复用 nsfw_ctx.nsfw_allowed()(按请求级 X-NSFW header)。
"""
from __future__ import annotations

from datetime import datetime
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field, field_validator
from sqlmodel import Session, select

from app.comfy.client import ComfyUIError
from app.comfy.pool import WorkerPool
from app.db import get_session
from app.deps import get_current_user, get_pool, resolve_worker
from app.models import ReferenceAsset, User, _now
from app.nsfw_ctx import nsfw_allowed
from app.pathsafe import PathTraversalError, validate_path_component
from app.routes.images import _host, _ranged_response

router = APIRouter()

# 参考资产类别:角色/场景/道具/风格卡
AssetKind = Literal["character", "scene", "prop", "style"]


def _no_traversal(v: str) -> str:
    """文件名安全检查:拒绝路径穿越与绝对路径(仿 routes/wan_studio.py)。"""
    name = v.strip().replace("\\", "/")
    if ".." in name or name.startswith("/"):
        raise ValueError("文件名不允许路径穿越")
    return name


# ---------------------------------------------------------------------------
# 请求 / 响应模型
# ---------------------------------------------------------------------------
class AssetImage(BaseModel):
    """单张参考图:/api/upload 返回的句柄(filename + worker 落点)。"""

    filename: str = Field(min_length=1, max_length=255)
    worker: str = Field(min_length=1, max_length=255)

    _fn_ok = field_validator("filename")(_no_traversal)


class AssetCreate(BaseModel):
    kind: AssetKind = "character"
    name: str = Field(min_length=1, max_length=100)
    description: str = Field(default="", max_length=2000)
    # 1-4 张三视图/多角度(≤4 是质量拐点,硬上限)
    images: list[AssetImage] = Field(min_length=1, max_length=4)
    nsfw: bool = False


class AssetPatch(BaseModel):
    """部分更新:仅非 None 字段生效。"""

    kind: AssetKind | None = None
    name: str | None = Field(default=None, min_length=1, max_length=100)
    description: str | None = Field(default=None, max_length=2000)
    images: list[AssetImage] | None = Field(default=None, min_length=1, max_length=4)
    nsfw: bool | None = None


class AssetOut(BaseModel):
    id: str
    kind: str
    name: str
    description: str
    images: list[AssetImage]
    nsfw: bool
    created_at: datetime
    updated_at: datetime


# ---------------------------------------------------------------------------
# 辅助
# ---------------------------------------------------------------------------
def _to_out(a: ReferenceAsset) -> AssetOut:
    return AssetOut(
        id=a.id,
        kind=a.kind,
        name=a.name,
        description=a.description,
        images=[AssetImage(**img) for img in a.images],
        nsfw=a.nsfw,
        created_at=a.created_at,
        updated_at=a.updated_at,
    )


def _get_visible(session: Session, asset_id: str, user: User) -> ReferenceAsset:
    """单查 + 可见性门控:不存在 / 非属主 / nsfw 但上下文未放行 → 统一 404。

    他人资产一律 404 而非 403:不泄露资产存在性,防枚举攻击。
    nsfw 资产在 SFW 上下文同样 404(与 agents 路由语义一致,主站零 R18)。
    """
    a = session.get(ReferenceAsset, asset_id)
    if not a or a.user_id != user.id:
        raise HTTPException(status_code=404, detail="资产不存在")
    if a.nsfw and not nsfw_allowed(user):
        raise HTTPException(status_code=404, detail="资产不存在")
    return a


# ---------------------------------------------------------------------------
# 路由
# ---------------------------------------------------------------------------
@router.get("/assets", response_model=list[AssetOut])
def list_assets(
    kind: AssetKind | None = Query(default=None, description="按资产类别过滤"),
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> list[AssetOut]:
    """列表:仅当前用户资产;可选 kind 过滤;SFW 上下文滤掉 nsfw 资产。"""
    stmt = select(ReferenceAsset).where(ReferenceAsset.user_id == user.id)
    if kind is not None:
        stmt = stmt.where(ReferenceAsset.kind == kind)
    if not nsfw_allowed(user):
        stmt = stmt.where(ReferenceAsset.nsfw == False)  # noqa: E712
    rows = session.exec(stmt.order_by(ReferenceAsset.created_at)).all()
    return [_to_out(a) for a in rows]


@router.post("/assets", response_model=AssetOut)
def create_asset(
    body: AssetCreate,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> AssetOut:
    """创建参考资产卡(images 1-4 张上传句柄,filename 已做路径穿越检查)。"""
    a = ReferenceAsset(
        user_id=user.id,
        kind=body.kind,
        name=body.name,
        description=body.description,
        images=[img.model_dump() for img in body.images],
        nsfw=body.nsfw,
    )
    session.add(a)
    session.commit()
    session.refresh(a)
    return _to_out(a)


@router.get("/assets/{asset_id}", response_model=AssetOut)
def get_asset(
    asset_id: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> AssetOut:
    """单查;他人资产与 nsfw 资产(SFW 上下文)均 404。"""
    return _to_out(_get_visible(session, asset_id, user))


@router.patch("/assets/{asset_id}", response_model=AssetOut)
def update_asset(
    asset_id: str,
    body: AssetPatch,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> AssetOut:
    """部分更新:仅非 None 字段生效,其余原样保留。"""
    a = _get_visible(session, asset_id, user)
    if body.kind is not None:
        a.kind = body.kind
    if body.name is not None:
        a.name = body.name
    if body.description is not None:
        a.description = body.description
    if body.images is not None:
        a.images = [img.model_dump() for img in body.images]
    if body.nsfw is not None:
        a.nsfw = body.nsfw
    a.updated_at = _now()
    session.add(a)
    session.commit()
    session.refresh(a)
    return _to_out(a)


@router.get("/assets/{asset_id}/images/{index}")
async def get_asset_image(
    asset_id: str,
    index: int,
    request: Request,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
    pool: WorkerPool = Depends(get_pool),
):
    """资产参考图回显(缩略图/预览)。

    上传句柄(filename, worker)不一定挂在任何 Job 上,/api/images 的 DB 归属
    回退不适用;资产记录的 user_id + NSFW 上下文即归属证明(复用 _get_visible,
    他人资产/SFW 上下文 nsfw 资产一律 404)。文件本体从落点 worker 的 input 目录
    取字节(type=input),主 worker 掉线时回退同机 worker(共享同一输入目录)。
    """
    a = _get_visible(session, asset_id, user)
    if index < 0 or index >= len(a.images):
        raise HTTPException(status_code=404, detail="图片不存在")
    img = a.images[index]
    try:
        safe_filename = validate_path_component(img["filename"], allow_subdirs=False)
    except PathTraversalError as e:
        raise HTTPException(status_code=400, detail=f"非法路径: {e}") from e

    primary = resolve_worker(img["worker"])  # SSRF 白名单校验
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
        except ComfyUIError as e:
            last_err = e
    raise HTTPException(status_code=502, detail=f"图片暂不可取(同机 worker 均不可达): {last_err}")


@router.delete("/assets/{asset_id}")
def delete_asset(
    asset_id: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    """删除;他人资产 404(防枚举)。只删 DB 记录,不动 worker 上的文件本体。"""
    a = _get_visible(session, asset_id, user)
    session.delete(a)
    session.commit()
    return {"ok": True, "id": asset_id}
