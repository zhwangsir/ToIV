"""studioshot.candidates_json 统一按 JSON 字符串读写（列类型 VARCHAR，禁止 jsonb 强转）。"""
from __future__ import annotations

import json
import uuid
from typing import Any


def loads_candidates(raw: str | None) -> list[dict[str, Any]]:
    """解析 candidates_json；坏数据/非 list 时返回空列表。"""
    try:
        rows = json.loads(raw or "[]")
    except (ValueError, TypeError):
        return []
    if not isinstance(rows, list):
        return []
    return [c for c in rows if isinstance(c, dict)]


def dumps_candidates(rows: list[dict[str, Any]]) -> str:
    """序列化为 ORM/VARCHAR 可写入的 JSON 字符串。"""
    return json.dumps(list(rows or []), ensure_ascii=False)


def append_candidates(
    prior: str | None,
    items: list[dict[str, Any]],
) -> str:
    """追加候选（不覆盖已有项）；始终返回 JSON 字符串，永不产出 jsonb SQL。"""
    rows = loads_candidates(prior)
    for it in items or []:
        if isinstance(it, dict):
            rows.append(it)
    return dumps_candidates(rows)


def append_failure(
    prior: str | None,
    *,
    err_msg: str,
    video_model: str = "",
    attempt: list[dict[str, Any]] | None = None,
) -> str:
    """把本轮失败候选追加到已有列表；无 attempt 时造一条 error 记录。"""
    failed = [
        c for c in (attempt or [])
        if isinstance(c, dict) and c.get("status") == "error"
    ]
    if not failed:
        failed = [
            {
                "id": uuid.uuid4().hex,
                "url": "",
                "seed": 0,
                "status": "error",
                "is_picked": False,
                "error": str(err_msg)[:200],
                "video_model": video_model,
            }
        ]
    else:
        for c in failed:
            c["is_picked"] = False
            if not c.get("error"):
                c["error"] = str(err_msg)[:200]
    return append_candidates(prior, failed)
