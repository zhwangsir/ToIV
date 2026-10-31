"""P0-1 材料库内存仓（API-only 骨架；不接真 DB / 对象存储）。

运行时约定：
- (id, version) → 唯一 sha256；缺 version 由路由层 400 version_required
- latest_version 仅展示字段；生产读路径禁止隐式 latest（无 version=latest 解析）
- 正文/文件/rendered 一律 fenced + content_kind=untrusted_material
"""
from __future__ import annotations

import hashlib
import threading
from copy import deepcopy
from typing import Any

from app.services.canonical_json import canonical_dumps, canonical_sha256

_LOCK = threading.RLock()

# material_id -> catalog meta
_CATALOG: dict[str, dict[str, Any]] = {}
# (material_id, version) -> version record
_VERSIONS: dict[tuple[str, str], dict[str, Any]] = {}


def reset() -> None:
    """测试隔离：清空内存仓。"""
    with _LOCK:
        _CATALOG.clear()
        _VERSIONS.clear()


def _seed_builtin() -> None:
    """内置 2 条夹具材料，供契约测与本地冒烟。"""
    with _LOCK:
        if _CATALOG:
            return
        prompt_body = "A cinematic shot of [Subject], anime medium, soft light."
        prompt_doc = {
            "id": "toiv/anime-medium-prefix",
            "type": "prompt",
            "title": "Anime medium prefix",
            "summary": "Fixed anime prefix with [Subject] slot",
            "category": "BOARD",
            "language": "en",
            "version": "1.0.0",
            "body": prompt_body,
            "parameters": [{"name": "Subject", "required": True, "maxLength": 2000}],
            "status": "available",
            "trust": "internal_reviewed",
        }
        prompt_sha = canonical_sha256(prompt_doc)
        _put_unlocked(
            {
                **prompt_doc,
                "sha256": prompt_sha,
                "files": {},
                "published": True,
            }
        )

        skill_files = {
            "SKILL.md": "# Character continuity lock\nKeep locks stable.\n",
            "META.json": '{"id":"toiv/character-continuity-lock","version":"0.1.0"}\n',
        }
        files_index = []
        for path, content in skill_files.items():
            raw = content.encode("utf-8")
            files_index.append(
                {
                    "path": path,
                    "sha256": hashlib.sha256(raw).hexdigest(),
                    "bytes": len(raw),
                }
            )
        skill_doc = {
            "id": "toiv/character-continuity-lock",
            "type": "skill",
            "title": "Character continuity lock",
            "summary": "Locks for costume/eye/badge continuity",
            "category": "ASSET_LOCK",
            "language": "zh",
            "version": "0.1.0",
            "body": None,
            "parameters": [],
            "status": "available",
            "trust": "untrusted_material",
            "files_index": files_index,
        }
        # 技能包哈希：规范序列化 meta + 文件映射
        pack = {"meta": skill_doc, "files": skill_files}
        skill_sha = canonical_sha256(pack)
        _put_unlocked(
            {
                **skill_doc,
                "sha256": skill_sha,
                "files": skill_files,
                "published": True,
            }
        )


def ensure_seeded() -> None:
    _seed_builtin()


def _put_unlocked(rec: dict[str, Any]) -> None:
    mid = rec["id"]
    ver = rec["version"]
    cat = _CATALOG.get(mid) or {
        "id": mid,
        "type": rec["type"],
        "title": rec["title"],
        "summary": rec.get("summary", ""),
        "category": rec.get("category"),
        "language": rec.get("language", "zh"),
        "status": rec.get("status", "available"),
        "trust": rec.get("trust", "untrusted_material"),
        "latest_version": ver,  # 仅展示；禁止作为生产隐式解析目标
    }
    # 展示用 latest：按写入顺序刷新为最新钉住的 version 字符串（非 semver 比较）
    cat["latest_version"] = ver
    cat["title"] = rec["title"]
    cat["summary"] = rec.get("summary", cat.get("summary", ""))
    cat["status"] = rec.get("status", cat.get("status", "available"))
    cat["trust"] = rec.get("trust", cat.get("trust", "untrusted_material"))
    _CATALOG[mid] = cat
    _VERSIONS[(mid, ver)] = {
        "id": mid,
        "type": rec["type"],
        "title": rec["title"],
        "summary": rec.get("summary", ""),
        "category": rec.get("category"),
        "language": rec.get("language", "zh"),
        "version": ver,
        "sha256": rec["sha256"],
        "trust": rec.get("trust", "untrusted_material"),
        "status": rec.get("status", "available"),
        "parameters": rec.get("parameters") or [],
        "body": rec.get("body"),
        "files": dict(rec.get("files") or {}),
        "files_index": list(rec.get("files_index") or []),
        "published": bool(rec.get("published", True)),
    }


def search(
    *,
    query: str | None = None,
    type_: str = "all",
    category: str | None = None,
    language: str = "zh",
    limit: int = 20,
    trust: str | None = None,
) -> dict[str, Any]:
    ensure_seeded()
    with _LOCK:
        items: list[dict[str, Any]] = []
        for mid, cat in sorted(_CATALOG.items()):
            ver = cat["latest_version"]
            # 展示用：列表带回 latest_version 对应的钉住记录字段，但仍标注 latest_version
            rec = _VERSIONS.get((mid, ver))
            if not rec:
                continue
            if type_ != "all" and rec["type"] != type_:
                continue
            if category and rec.get("category") != category:
                continue
            if language and rec.get("language") != language:
                # 宽松：language 过滤仅当记录有 language
                if rec.get("language"):
                    continue
            if trust and rec.get("trust") != trust:
                continue
            if query:
                q = query.lower()
                blob = f"{rec['id']} {rec['title']} {rec.get('summary','')}".lower()
                if q not in blob:
                    continue
            items.append(_summary(rec, latest_version=cat["latest_version"]))
            if len(items) >= limit:
                break
        return {
            "items": items,
            "catalog_revision": f"mem-{len(_VERSIONS)}",
        }


def get(material_id: str, version: str) -> dict[str, Any] | None:
    ensure_seeded()
    with _LOCK:
        rec = _VERSIONS.get((material_id, version))
        if not rec:
            return None
        out = _detail(rec)
        cat = _CATALOG.get(material_id)
        if cat:
            out["latest_version"] = cat["latest_version"]  # 仅展示
        return out


def get_file(material_id: str, version: str, path: str) -> dict[str, Any] | None:
    ensure_seeded()
    with _LOCK:
        rec = _VERSIONS.get((material_id, version))
        if not rec:
            return None
        content = rec["files"].get(path)
        if content is None:
            return {"_error": "file_not_found"}
        raw = content.encode("utf-8")
        return {
            "id": material_id,
            "version": version,
            "sha256": rec["sha256"],
            "path": path,
            "encoding": "utf-8",
            "content": content,
            "bytes": len(raw),
            "trust": rec["trust"],
            "fenced": True,
            "content_kind": "untrusted_material",
        }


def render(material_id: str, version: str, subject: str) -> dict[str, Any] | None:
    ensure_seeded()
    with _LOCK:
        rec = _VERSIONS.get((material_id, version))
        if not rec:
            return None
        body = rec.get("body") or ""
        if "[Subject]" not in body:
            return {"_error": "template_not_parameterized"}
        rendered = body.replace("[Subject]", subject)
        return {
            "id": material_id,
            "version": version,
            "sha256": rec["sha256"],
            "rendered": rendered,
            "trust": rec["trust"],
            "fenced": True,
            "content_kind": "untrusted_material",
        }


def install_info(material_id: str, version: str) -> dict[str, Any] | None:
    ensure_seeded()
    with _LOCK:
        rec = _VERSIONS.get((material_id, version))
        if not rec:
            return None
        if rec["type"] != "skill" or not rec.get("published"):
            return {"_error": "public_published_skill_required"}
        return {
            "id": material_id,
            "version": version,
            "sha256": rec["sha256"],
            "download_url": f"memory://materials/{material_id}/{version}/{rec['sha256']}.tar",
            "files": deepcopy(rec.get("files_index") or []),
            "trust": rec["trust"],
        }


def catalog_latest_version(material_id: str) -> str | None:
    """仅供测试断言展示字段；路由不得用此做隐式解析。"""
    ensure_seeded()
    with _LOCK:
        cat = _CATALOG.get(material_id)
        return cat["latest_version"] if cat else None


def _summary(rec: dict[str, Any], *, latest_version: str) -> dict[str, Any]:
    return {
        "id": rec["id"],
        "type": rec["type"],
        "title": rec["title"],
        "summary": rec.get("summary", ""),
        "category": rec.get("category"),
        "language": rec.get("language", "zh"),
        "version": rec["version"],
        "sha256": rec["sha256"],
        "trust": rec["trust"],
        "status": rec.get("status", "available"),
        "parameters": rec.get("parameters") or [],
        "latest_version": latest_version,  # 展示用
    }


def _detail(rec: dict[str, Any]) -> dict[str, Any]:
    out = {
        "id": rec["id"],
        "type": rec["type"],
        "title": rec["title"],
        "summary": rec.get("summary", ""),
        "category": rec.get("category"),
        "language": rec.get("language", "zh"),
        "version": rec["version"],
        "sha256": rec["sha256"],
        "trust": rec["trust"],
        "status": rec.get("status", "available"),
        "parameters": rec.get("parameters") or [],
        "content_kind": "untrusted_material",
        "fenced": True,
    }
    if rec.get("body") is not None:
        out["body"] = rec["body"]
    if rec.get("files_index"):
        out["files_index"] = deepcopy(rec["files_index"])
    return out
