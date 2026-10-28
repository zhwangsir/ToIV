"""P0-2 ProjectBible 内存仓（API-only 骨架）。

挂账落地：
1. GET 无 version → 返回工作副本；frozen 时工作副本须与当前冻版一致，否则 409 working_copy_stale
2. latest_version / current_version 仅展示；读历史必须显式 ?version=
3. ingest/freeze 哈希：文件钉用 raw bytes；逻辑文档用 canonical_json
"""
from __future__ import annotations

import threading
from copy import deepcopy
from datetime import datetime, timezone
from typing import Any

from app.services.canonical_json import canonical_dumps, canonical_sha256, sha256_bytes

_LOCK = threading.RLock()

# bible_id -> working record
_BIBLES: dict[str, dict[str, Any]] = {}
# (bible_id, version) -> version snapshot
_VERSIONS: dict[tuple[str, str], dict[str, Any]] = {}


_CORE_KEYS = (
    "facts",
    "characters",
    "locations",
    "timeline_beats",
    "style_prefix",
    "copyright_bans",
    "music_slots",
    "version",
    "frozen_at",
    "change_log",
)

_EXTENSION_KEYS = (
    "schema",
    "id",
    "title",
    "status",
    "source_docs",
    "runtime_policy",
    "creative_locks",
    "emotional_core",
    "causal_spine",
    "hard_rules",
    "style_negatives",
    "dialogue_tc",
    "acceptance",
    "shot_budget",
)


def reset() -> None:
    with _LOCK:
        _BIBLES.clear()
        _VERSIONS.clear()


def _now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def _split_document(document: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    core: dict[str, Any] = {}
    ext: dict[str, Any] = {}
    for k, v in document.items():
        if k in _CORE_KEYS:
            core[k] = deepcopy(v)
        else:
            ext[k] = deepcopy(v)
    # 保证扩展里也保留 id/title/status 便于整包重建
    for k in ("id", "title", "status", "schema"):
        if k in document and k not in ext:
            ext[k] = deepcopy(document[k])
    return core, ext


def _rebuild_document(rec: dict[str, Any]) -> dict[str, Any]:
    doc: dict[str, Any] = {}
    ext = deepcopy(rec.get("extensions") or {})
    doc.update(ext)
    for k in _CORE_KEYS:
        if k in rec:
            doc[k] = deepcopy(rec[k])
    doc["id"] = rec["id"]
    doc["title"] = rec.get("title") or ext.get("title") or rec["id"]
    doc["status"] = rec["status"]
    doc["version"] = rec["current_version"]
    doc["frozen_at"] = rec.get("frozen_at")
    doc["change_log"] = deepcopy(rec.get("change_log") or [])
    return doc


def ingest(
    *,
    document: dict[str, Any],
    expected_sha256: str | None = None,
    pin_version: str | None = None,
    raw_bytes: bytes | None = None,
    tenant_id: str = "",
) -> dict[str, Any]:
    """钉入一版 Bible。缺 version → 调用方应先 400；此处再兜底。"""
    version = document.get("version") or pin_version
    if not version:
        return {"_error": "version_required"}
    if pin_version and document.get("version") and pin_version != document.get("version"):
        return {"_error": "version_required", "message": "pin_version must match document.version"}
    version = str(version)
    bible_id = document.get("id")
    if not bible_id:
        return {"_error": "invalid_document", "message": "document.id required"}

    if expected_sha256:
        if raw_bytes is not None:
            got = sha256_bytes(raw_bytes)
        else:
            # 无 raw 时对请求 document 做规范哈希（跨端一致）
            got = canonical_sha256(document)
        if got != expected_sha256:
            return {"_error": "sha256_mismatch", "got": got, "expected": expected_sha256}

    with _LOCK:
        key = (bible_id, version)
        if key in _VERSIONS:
            return {"_error": "version_conflict"}

        core, ext = _split_document(document)
        status = str(document.get("status") or "draft")
        change_log = deepcopy(document.get("change_log") or [])
        # 文件钉哈希优先；否则规范哈希
        if raw_bytes is not None:
            sha = sha256_bytes(raw_bytes)
            blob = raw_bytes
        else:
            sha = canonical_sha256(document)
            blob = canonical_dumps(document)

        snap = {
            "bible_id": bible_id,
            "version": version,
            "sha256": sha,
            "blob": blob,
            "status": "snapshot" if status != "frozen" else "frozen",
            "frozen_at": document.get("frozen_at"),
            "document": deepcopy(document),
            "change_note": None,
            "created_at": _now_iso(),
        }
        _VERSIONS[key] = snap

        rec = {
            "id": bible_id,
            "tenant_id": tenant_id,
            "title": document.get("title") or bible_id,
            "status": status,
            "current_version": version,
            "frozen_at": document.get("frozen_at"),
            "facts": deepcopy(core.get("facts") or []),
            "characters": deepcopy(core.get("characters") or []),
            "locations": deepcopy(core.get("locations") or []),
            "timeline_beats": deepcopy(core.get("timeline_beats") or []),
            "style_prefix": core.get("style_prefix") or "",
            "copyright_bans": deepcopy(core.get("copyright_bans") or []),
            "music_slots": deepcopy(core.get("music_slots") or []),
            "extensions": ext,
            "change_log": change_log,
            "working_sha256": sha,
            "updated_at": _now_iso(),
        }
        _BIBLES[bible_id] = rec
        return {"bible": _public_bible(rec), "version": version, "sha256": sha}


def list_bibles(*, tenant_id: str | None = None) -> list[dict[str, Any]]:
    with _LOCK:
        out = []
        for rec in _BIBLES.values():
            if tenant_id is not None and rec.get("tenant_id") not in ("", tenant_id):
                continue
            out.append(
                {
                    "id": rec["id"],
                    "title": rec["title"],
                    "status": rec["status"],
                    "current_version": rec["current_version"],
                    "frozen_at": rec.get("frozen_at"),
                    # 展示用；禁止客户端把 current_version 当隐式 latest 缺省
                    "latest_version": rec["current_version"],
                }
            )
        return sorted(out, key=lambda x: x["id"])


def get_working(bible_id: str) -> dict[str, Any] | None:
    """挂账 1：无 version → 工作副本。frozen 时须与冻版一致。"""
    with _LOCK:
        rec = _BIBLES.get(bible_id)
        if not rec:
            return None
        if rec["status"] == "frozen":
            snap = _VERSIONS.get((bible_id, rec["current_version"]))
            if not snap:
                return {"_error": "working_copy_stale", "message": "frozen bible missing freeze snapshot"}
            # 工作副本文档视图 vs 冻版
            working_doc = _rebuild_document(rec)
            # 比较规范哈希（忽略磁盘 pretty 差异）
            if canonical_sha256(working_doc) != canonical_sha256(snap["document"]):
                # 也允许 working_sha256 与 snap.sha256 对齐（ingest 文件钉场景）
                if rec.get("working_sha256") != snap["sha256"]:
                    return {
                        "_error": "working_copy_stale",
                        "message": "frozen working copy diverges from freeze blob; refetch ?version= or re-freeze",
                    }
        return {
            "kind": "working_copy",
            "bible": _public_bible(rec),
            "document": _rebuild_document(rec),
        }


def get_version(bible_id: str, version: str) -> dict[str, Any] | None:
    with _LOCK:
        snap = _VERSIONS.get((bible_id, version))
        if not snap:
            if bible_id not in _BIBLES:
                return None
            return {"_error": "version_not_found"}
        return {
            "kind": "version",
            "version": version,
            "sha256": snap["sha256"],
            "status": snap["status"],
            "frozen_at": snap.get("frozen_at"),
            "document": deepcopy(snap["document"]),
        }


def list_versions(bible_id: str) -> dict[str, Any] | None:
    with _LOCK:
        if bible_id not in _BIBLES:
            return None
        items = []
        for (bid, ver), snap in sorted(_VERSIONS.items()):
            if bid != bible_id:
                continue
            items.append(
                {
                    "version": ver,
                    "sha256": snap["sha256"],
                    "status": snap["status"],
                    "frozen_at": snap.get("frozen_at"),
                    "created_at": snap.get("created_at"),
                }
            )
        rec = _BIBLES[bible_id]
        return {
            "id": bible_id,
            "current_version": rec["current_version"],
            "latest_version": rec["current_version"],  # 展示
            "versions": items,
        }


def patch(bible_id: str, patch_body: dict[str, Any], *, expected_version: str | None = None) -> dict[str, Any]:
    with _LOCK:
        rec = _BIBLES.get(bible_id)
        if not rec:
            return {"_error": "bible_not_found"}
        if rec["status"] == "frozen":
            return {"_error": "bible_frozen"}
        if expected_version and expected_version != rec["current_version"]:
            return {"_error": "version_conflict"}

        for field in (
            "facts",
            "characters",
            "locations",
            "timeline_beats",
            "copyright_bans",
            "music_slots",
            "style_prefix",
            "title",
        ):
            if field in patch_body:
                rec[field] = deepcopy(patch_body[field])
        if "extensions" in patch_body and isinstance(patch_body["extensions"], dict):
            rec["extensions"] = {**rec.get("extensions", {}), **deepcopy(patch_body["extensions"])}
        # 允许直接补 acceptance 等扩展顶栏
        for ek in _EXTENSION_KEYS:
            if ek in patch_body and ek not in ("id", "version", "status"):
                rec.setdefault("extensions", {})[ek] = deepcopy(patch_body[ek])

        rec["updated_at"] = _now_iso()
        doc = _rebuild_document(rec)
        rec["working_sha256"] = canonical_sha256(doc)
        return {"bible": _public_bible(rec), "document": doc}


def freeze(bible_id: str) -> dict[str, Any]:
    with _LOCK:
        rec = _BIBLES.get(bible_id)
        if not rec:
            return {"_error": "bible_not_found"}
        if rec["status"] == "frozen":
            return {"_error": "already_frozen"}

        doc = _rebuild_document(rec)
        doc["status"] = "frozen"
        frozen_at = _now_iso()
        doc["frozen_at"] = frozen_at
        sha = canonical_sha256(doc)
        blob = canonical_dumps(doc)
        ver = rec["current_version"]

        snap = _VERSIONS.get((bible_id, ver))
        if snap is None:
            snap = {
                "bible_id": bible_id,
                "version": ver,
                "sha256": sha,
                "blob": blob,
                "status": "frozen",
                "frozen_at": frozen_at,
                "document": deepcopy(doc),
                "change_note": "freeze",
                "created_at": frozen_at,
            }
            _VERSIONS[(bible_id, ver)] = snap
        else:
            snap["sha256"] = sha
            snap["blob"] = blob
            snap["status"] = "frozen"
            snap["frozen_at"] = frozen_at
            snap["document"] = deepcopy(doc)

        rec["status"] = "frozen"
        rec["frozen_at"] = frozen_at
        rec["working_sha256"] = sha
        # 同步工作副本核心字段与冻文档一致
        for k in ("facts", "characters", "locations", "timeline_beats", "style_prefix", "copyright_bans", "music_slots"):
            if k in doc:
                rec[k] = deepcopy(doc[k])
        rec["change_log"] = deepcopy(doc.get("change_log") or [])
        return {
            "id": bible_id,
            "version": ver,
            "sha256": sha,
            "status": "frozen",
            "frozen_at": frozen_at,
            "blob_key": f"project-bibles/{bible_id}/{ver}/{sha}.json",
        }


def fork_version(
    bible_id: str,
    *,
    base_version: str,
    new_version: str,
    note: str = "",
) -> dict[str, Any]:
    with _LOCK:
        rec = _BIBLES.get(bible_id)
        if not rec:
            return {"_error": "bible_not_found"}
        if not new_version:
            return {"_error": "version_required"}
        base = _VERSIONS.get((bible_id, base_version))
        if not base:
            return {"_error": "version_not_found"}
        if (bible_id, new_version) in _VERSIONS:
            return {"_error": "version_conflict"}

        doc = deepcopy(base["document"])
        doc["version"] = new_version
        doc["status"] = "pilot_unfrozen"
        doc["frozen_at"] = None
        log = list(doc.get("change_log") or [])
        log.append(
            {
                "at": _now_iso(),
                "from": base_version,
                "to": new_version,
                "note": note or "fork",
            }
        )
        doc["change_log"] = log
        sha = canonical_sha256(doc)
        _VERSIONS[(bible_id, new_version)] = {
            "bible_id": bible_id,
            "version": new_version,
            "sha256": sha,
            "blob": canonical_dumps(doc),
            "status": "snapshot",
            "frozen_at": None,
            "document": doc,
            "change_note": note or "fork",
            "created_at": _now_iso(),
        }
        core, ext = _split_document(doc)
        rec["status"] = "pilot_unfrozen"
        rec["current_version"] = new_version
        rec["frozen_at"] = None
        rec["facts"] = deepcopy(core.get("facts") or [])
        rec["characters"] = deepcopy(core.get("characters") or [])
        rec["locations"] = deepcopy(core.get("locations") or [])
        rec["timeline_beats"] = deepcopy(core.get("timeline_beats") or [])
        rec["style_prefix"] = core.get("style_prefix") or ""
        rec["copyright_bans"] = deepcopy(core.get("copyright_bans") or [])
        rec["music_slots"] = deepcopy(core.get("music_slots") or [])
        rec["extensions"] = ext
        rec["change_log"] = log
        rec["working_sha256"] = sha
        rec["updated_at"] = _now_iso()
        return {"bible": _public_bible(rec), "version": new_version, "sha256": sha}


def get_blob(bible_id: str, version: str) -> dict[str, Any] | None:
    with _LOCK:
        snap = _VERSIONS.get((bible_id, version))
        if not snap:
            if bible_id not in _BIBLES:
                return None
            return {"_error": "version_not_found"}
        return {
            "id": bible_id,
            "version": version,
            "sha256": snap["sha256"],
            "blob_key": f"project-bibles/{bible_id}/{version}/{snap['sha256']}.json",
            "content_type": "application/json",
            "bytes": len(snap["blob"]),
            "document": deepcopy(snap["document"]),
        }


def _public_bible(rec: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": rec["id"],
        "title": rec["title"],
        "status": rec["status"],
        "current_version": rec["current_version"],
        "latest_version": rec["current_version"],  # 展示；禁止隐式 latest
        "frozen_at": rec.get("frozen_at"),
        "working_sha256": rec.get("working_sha256"),
        "facts": deepcopy(rec.get("facts") or []),
        "characters": deepcopy(rec.get("characters") or []),
        "locations": deepcopy(rec.get("locations") or []),
        "timeline_beats": deepcopy(rec.get("timeline_beats") or []),
        "style_prefix": rec.get("style_prefix") or "",
        "copyright_bans": deepcopy(rec.get("copyright_bans") or []),
        "music_slots": deepcopy(rec.get("music_slots") or []),
        "change_log": deepcopy(rec.get("change_log") or []),
        "extensions": deepcopy(rec.get("extensions") or {}),
    }
