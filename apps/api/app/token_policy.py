"""受限服务令牌的接口白名单 + 令牌吊销清单。

服务令牌(claims.scope)只用于服务端到服务端调用(如画布 canvas-api 调 H3),
因此按「方法 + 路径」白名单放行,其余接口一律 403;普通登录令牌不受影响。
吊销清单是一个 JSON 文件(settings.revoked_tokens_file),按 mtime 热加载:
  {"tokens": ["<sha256 hex>", ...], "users": {"<user id>": <unix 秒>}}
tokens 吊销单个令牌(只存指纹);users 让该用户在给定时刻之前签发的全部令牌失效
(无 iat 的旧令牌视为 iat=0,同样失效)。
"""
from __future__ import annotations

import json
import os
import re
import threading

from app.config import get_settings

# scope -> [(METHOD, path regex, 可选 query 约束)]。路径不含 query。
SCOPES: dict[str, list[tuple[str, re.Pattern[str], dict[str, re.Pattern[str]] | None]]] = {
    # toiv-h3 画布插件(apps/canvas/plugin-packages/toiv-h3)用到的全部接口,再无其他
    "h3": [
        ("POST", re.compile(r"^/api/h3/(t2v|i2v|fl2v|r2v)$"), None),
        ("POST", re.compile(r"^/api/upload$"), {"kind": re.compile(r"^h3_[a-z0-9_]{1,32}$")}),
        ("GET", re.compile(r"^/api/jobs/lookup$"), None),
        ("POST", re.compile(r"^/api/jobs/[A-Za-z0-9_-]{1,80}/cancel$"), None),
        ("GET", re.compile(r"^/api/images$"), None),
        ("GET", re.compile(r"^/api/h3/(workers|acceleration/profiles)$"), None),
    ],
    # toiv-llm 渠道(OpenAI 兼容代理)
    "llm": [
        ("GET", re.compile(r"^/api/llm/v1/models$"), None),
        ("POST", re.compile(r"^/api/llm/v1/chat/completions$"), None),
    ],
}


def scope_allows(scope: str, method: str, path: str, query: dict[str, str] | None = None) -> bool:
    rules = SCOPES.get(scope)
    if not rules:
        return False
    method = method.upper()
    for rule_method, pattern, query_rules in rules:
        if method != rule_method or not pattern.match(path):
            continue
        if query_rules:
            q = query or {}
            if not all(name in q and rx.match(q[name] or "") for name, rx in query_rules.items()):
                continue
        return True
    return False


_lock = threading.Lock()
_cache: dict = {"path": None, "mtime": None, "tokens": frozenset(), "users": {}}


def _load(path: str) -> tuple[frozenset, dict]:
    try:
        mtime = os.stat(path).st_mtime_ns
    except OSError:
        return frozenset(), {}
    with _lock:
        if _cache["path"] == path and _cache["mtime"] == mtime:
            return _cache["tokens"], _cache["users"]
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        # 文件损坏:沿用上一次成功加载的清单(不因笔误把已吊销令牌放出来)
        with _lock:
            return _cache["tokens"], _cache["users"]
    tokens = frozenset(str(t).strip().lower() for t in data.get("tokens", []) if str(t).strip())
    users = {}
    for uid, ts in (data.get("users") or {}).items():
        try:
            users[str(uid)] = int(ts)
        except (TypeError, ValueError):
            continue
    with _lock:
        _cache.update(path=path, mtime=mtime, tokens=tokens, users=users)
    return tokens, users


def is_revoked(token_sha256: str, claims: dict) -> bool:
    path = (getattr(get_settings(), "revoked_tokens_file", "") or "").strip()
    if not path:
        return False
    tokens, users = _load(path)
    if token_sha256.lower() in tokens:
        return True
    not_before = users.get(str(claims.get("sub", "")))
    if not_before is None:
        return False
    try:
        iat = int(claims.get("iat") or 0)
    except (TypeError, ValueError):
        iat = 0
    return iat < not_before


def reset_cache_for_tests() -> None:
    with _lock:
        _cache.update(path=None, mtime=None, tokens=frozenset(), users={})
