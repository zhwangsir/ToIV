"""P0-2 ProjectBible API（API-only 骨架）。

前缀：/api/project-bibles
存储：内存仓；DB+对象存储表草稿见 alembic 草案，本刀不强绑生产。

挂账：
1. GET /{id} 无 version → kind=working_copy；frozen 且漂移 → 409 working_copy_stale
2. latest_version / current_version 仅展示；读历史必须 ?version=；拒绝 version=latest
3. ingest 规范序列化见 app/services/canonical_json.py + SERIALIZATION.md
"""
from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from app.deps import get_current_user
from app.models import User
from app.services import project_bible_store as store

router = APIRouter(prefix="/project-bibles", tags=["project-bibles"])


def _err(status: int, code: str, message: str = "", **extra: Any) -> None:
    detail: dict[str, Any] = {"code": code}
    if message:
        detail["message"] = message
    detail.update(extra)
    raise HTTPException(status_code=status, detail=detail)


def _raise_store_error(out: dict[str, Any]) -> None:
    code = out.get("_error")
    if not code:
        return
    mapping = {
        "version_required": 400,
        "invalid_document": 400,
        "bible_not_found": 404,
        "version_not_found": 404,
        "sha256_mismatch": 409,
        "bible_frozen": 409,
        "version_conflict": 409,
        "already_frozen": 409,
        "working_copy_stale": 409,
    }
    status = mapping.get(code, 400)
    _err(status, code, out.get("message") or "", **{k: v for k, v in out.items() if k not in ("_error", "message")})


class IngestBody(BaseModel):
    document: dict[str, Any] = Field(default_factory=dict)
    expected_sha256: str | None = None
    pin_version: str | None = None
    # 可选：客户端上送原始文件文本，用于与磁盘夹具字节钉哈希对齐
    raw_text: str | None = None


class PatchBody(BaseModel):
    expected_version: str | None = None
    facts: list[Any] | None = None
    characters: list[Any] | None = None
    locations: list[Any] | None = None
    timeline_beats: list[Any] | None = None
    style_prefix: str | None = None
    copyright_bans: list[Any] | None = None
    music_slots: list[Any] | None = None
    title: str | None = None
    extensions: dict[str, Any] | None = None
    acceptance: Any | None = None


class ForkBody(BaseModel):
    base_version: str
    new_version: str
    note: str = ""


@router.post("/ingest", status_code=201)
def ingest_bible(body: IngestBody, user: User = Depends(get_current_user)) -> dict[str, Any]:
    doc = body.document or {}
    version = doc.get("version") or body.pin_version
    if not version:
        _err(400, "version_required", "document.version or pin_version required")
    raw_bytes = body.raw_text.encode("utf-8") if body.raw_text is not None else None
    out = store.ingest(
        document=doc,
        expected_sha256=body.expected_sha256,
        pin_version=body.pin_version,
        raw_bytes=raw_bytes,
        tenant_id=user.tenant_id,
    )
    if out.get("_error"):
        _raise_store_error(out)
    return out


@router.get("")
def list_bibles(user: User = Depends(get_current_user)) -> dict[str, Any]:
    return {"items": store.list_bibles(tenant_id=user.tenant_id)}


@router.get("/{bible_id}")
def get_bible(
    bible_id: str,
    version: str | None = Query(default=None),
    user: User = Depends(get_current_user),
) -> dict[str, Any]:
    _ = user
    if version is not None and str(version).strip() != "":
        v = str(version).strip()
        if v.lower() == "latest":
            _err(
                400,
                "version_required",
                "version=latest is not allowed; omit version for working copy or pin immutable version",
            )
        out = store.get_version(bible_id, v)
        if out is None:
            _err(404, "bible_not_found")
        if out.get("_error"):
            _raise_store_error(out)
        return out
    # 挂账 1：无 version → 工作副本
    out = store.get_working(bible_id)
    if out is None:
        _err(404, "bible_not_found")
    if out.get("_error"):
        _raise_store_error(out)
    return out


@router.get("/{bible_id}/versions")
def list_versions(bible_id: str, user: User = Depends(get_current_user)) -> dict[str, Any]:
    _ = user
    out = store.list_versions(bible_id)
    if out is None:
        _err(404, "bible_not_found")
    return out


@router.patch("/{bible_id}")
def patch_bible(
    bible_id: str,
    body: PatchBody,
    user: User = Depends(get_current_user),
) -> dict[str, Any]:
    _ = user
    patch_data = body.model_dump(exclude_none=True)
    expected = patch_data.pop("expected_version", None)
    out = store.patch(bible_id, patch_data, expected_version=expected)
    if out.get("_error"):
        _raise_store_error(out)
    return out


@router.post("/{bible_id}/freeze")
def freeze_bible(bible_id: str, user: User = Depends(get_current_user)) -> dict[str, Any]:
    _ = user
    out = store.freeze(bible_id)
    if out.get("_error"):
        _raise_store_error(out)
    return out


@router.post("/{bible_id}/versions", status_code=201)
def fork_bible_version(
    bible_id: str,
    body: ForkBody,
    user: User = Depends(get_current_user),
) -> dict[str, Any]:
    _ = user
    if not body.new_version or not str(body.new_version).strip():
        _err(400, "version_required", "new_version required")
    if str(body.new_version).strip().lower() == "latest":
        _err(400, "version_required", "new_version=latest forbidden")
    out = store.fork_version(
        bible_id,
        base_version=body.base_version,
        new_version=str(body.new_version).strip(),
        note=body.note,
    )
    if out.get("_error"):
        _raise_store_error(out)
    return out


@router.get("/{bible_id}/blob")
def get_bible_blob(
    bible_id: str,
    version: str | None = Query(default=None),
    user: User = Depends(get_current_user),
) -> dict[str, Any]:
    _ = user
    if version is None or str(version).strip() == "":
        _err(400, "version_required", "blob requires explicit version")
    v = str(version).strip()
    if v.lower() == "latest":
        _err(400, "version_required", "version=latest forbidden on blob")
    out = store.get_blob(bible_id, v)
    if out is None:
        _err(404, "bible_not_found")
    if out.get("_error"):
        _raise_store_error(out)
    return out
