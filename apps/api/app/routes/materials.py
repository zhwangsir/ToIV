"""P0-1 材料库 MCP 同构 API（API-only 骨架）。

前缀：/api/materials（经 main include_router prefix=/api）
红线：不引入 content_mode/NSFW 403；trust 为供应链标记。

挂账：
- 缺 version → 400 version_required（不用 FastAPI 必填 Query，以免变成 422）
- latest_version 仅出现在响应展示字段；本模块无任何「缺省则取 latest」分支
"""
from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from app.deps import get_current_user
from app.models import User
from app.services import materials_store as store

router = APIRouter(prefix="/materials", tags=["materials"])

_CREDENTIAL_NAMES = {
    ".env",
    "id_rsa",
    "id_dsa",
    "id_ecdsa",
    "id_ed25519",
    "credentials",
    "credentials.json",
}
_CREDENTIAL_SUFFIXES = (".pem", ".key", ".p12", ".pfx")
_MAX_FILE = 256 * 1024


def _err(status: int, code: str, message: str = "", **extra: Any) -> None:
    detail: dict[str, Any] = {"code": code}
    if message:
        detail["message"] = message
    detail.update(extra)
    raise HTTPException(status_code=status, detail=detail)


def _require_version(version: str | None) -> str:
    if version is None or str(version).strip() == "":
        _err(400, "version_required", "version query/body is required; implicit latest is forbidden")
    v = str(version).strip()
    # 显式拒绝把 "latest" 当版本号解析
    if v.lower() == "latest":
        _err(
            400,
            "version_required",
            "version=latest is not allowed; pin an immutable version string",
        )
    return v


def _validate_path(path: str) -> str:
    if not path or not path.strip():
        _err(400, "invalid_path", "path is required")
    p = path.strip()
    if p.startswith("/") or p.startswith("\\") or ".." in p.split("/") or "\\" in p:
        _err(400, "invalid_path", "path traversal or absolute path rejected")
    base = p.split("/")[-1].lower()
    if base in _CREDENTIAL_NAMES or any(base.endswith(s) for s in _CREDENTIAL_SUFFIXES):
        _err(400, "credential_path_rejected", "credential-like path rejected")
    if p.startswith(".git/") or "/.git/" in p:
        _err(400, "credential_path_rejected", "git path rejected")
    if len(p) > 512:
        _err(400, "invalid_path", "path too long")
    return p


@router.get("")
def search_materials(
    query: str | None = Query(default=None, max_length=200),
    type: Literal["all", "skill", "prompt"] = Query(default="all"),
    category: str | None = Query(default=None, max_length=100),
    language: Literal["zh", "en"] = Query(default="zh"),
    limit: int = Query(default=20, ge=1, le=50),
    cursor: str | None = Query(default=None, max_length=2048),
    trust: str | None = Query(default=None),
    user: User = Depends(get_current_user),
) -> dict[str, Any]:
    _ = user, cursor  # cursor TTL 后续接真仓
    return store.search(
        query=query,
        type_=type,
        category=category,
        language=language,
        limit=limit,
        trust=trust,
    )


@router.get("/{material_id:path}/files")
def read_material_file(
    material_id: str,
    version: str | None = Query(default=None),
    path: str | None = Query(default=None, max_length=512),
    language: Literal["zh", "en"] | None = Query(default=None),
    user: User = Depends(get_current_user),
) -> dict[str, Any]:
    _ = user, language
    ver = _require_version(version)
    if path is None:
        _err(400, "invalid_path", "path is required")
    safe = _validate_path(path)
    out = store.get_file(material_id, ver, safe)
    if out is None:
        latest = store.catalog_latest_version(material_id)
        if latest is None:
            _err(404, "material_not_found")
        _err(404, "version_not_found")
    if out.get("_error") == "file_not_found":
        _err(404, "file_not_found", f"path {safe} not in material")
    if int(out.get("bytes") or 0) > _MAX_FILE:
        _err(413, "file_too_large", "UTF-8 file exceeds 256KiB")
    return out


class RenderBody(BaseModel):
    parameters: dict[str, str] = Field(default_factory=dict)
    language: Literal["zh", "en"] | None = None
    version: str | None = None  # 允许 body 顶栏带 version


@router.post("/{material_id:path}/render")
def render_material(
    material_id: str,
    body: RenderBody,
    version: str | None = Query(default=None),
    user: User = Depends(get_current_user),
) -> dict[str, Any]:
    _ = user
    ver = _require_version(version if version is not None else body.version)
    subject = (body.parameters or {}).get("Subject")
    if subject is None or str(subject).strip() == "":
        _err(422, "subject_required", "parameters.Subject is required")
    subject_s = str(subject)
    if len(subject_s) > 2000:
        _err(422, "subject_required", "Subject maxLength 2000")
    out = store.render(material_id, ver, subject_s)
    if out is None:
        latest = store.catalog_latest_version(material_id)
        if latest is None:
            _err(404, "material_not_found")
        _err(404, "version_not_found")
    if out.get("_error") == "template_not_parameterized":
        _err(422, "template_not_parameterized", "template has no [Subject] placeholder")
    return out


@router.get("/{material_id:path}/install-info")
def material_install_info(
    material_id: str,
    version: str | None = Query(default=None),
    user: User = Depends(get_current_user),
) -> dict[str, Any]:
    _ = user
    ver = _require_version(version)
    out = store.install_info(material_id, ver)
    if out is None:
        latest = store.catalog_latest_version(material_id)
        if latest is None:
            _err(404, "material_not_found")
        _err(404, "version_not_found")
    if out.get("_error") == "public_published_skill_required":
        _err(404, "public_published_skill_required", "install-info requires published skill")
    return out
@router.get("/{material_id:path}")
def get_material(
    material_id: str,
    version: str | None = Query(default=None),
    language: Literal["zh", "en"] | None = Query(default=None),
    user: User = Depends(get_current_user),
) -> dict[str, Any]:
    _ = user, language
    ver = _require_version(version)
    rec = store.get(material_id, ver)
    if rec is None:
        # 区分 id 不存在 vs version 不存在：先查 catalog latest 展示字段
        latest = store.catalog_latest_version(material_id)
        if latest is None:
            _err(404, "material_not_found", f"material {material_id:path} not found")
        _err(404, "version_not_found", f"version {ver} not found for {material_id:path}")
    return rec


