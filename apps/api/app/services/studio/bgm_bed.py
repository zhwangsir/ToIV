"""F3 / P4：短剧合成声床（BGM）纯函数。

项目可挂 bgm_url + 音量 + 对白闪避；assemble 在拼接后混入。
不做完整 DAW——只保证产品路径可挂垫乐。
"""
from __future__ import annotations

from typing import Any
from urllib.parse import urlsplit

DEFAULT_BGM_VOLUME = 0.35
MIN_BGM_VOLUME = 0.0
MAX_BGM_VOLUME = 1.0

# 站内相对路径前缀（防 SSRF；外链一律拒绝）
ALLOWED_BGM_PREFIXES = (
    "/api/studio/files/",
    "/api/manju/output/",
    "/api/manju/voice/",
    "/api/audio/files/",
    "/api/images/",
)


def normalize_bgm_volume(raw: Any) -> float:
    try:
        v = float(raw)
    except (TypeError, ValueError):
        return DEFAULT_BGM_VOLUME
    if v < MIN_BGM_VOLUME:
        return MIN_BGM_VOLUME
    if v > MAX_BGM_VOLUME:
        return MAX_BGM_VOLUME
    return v


def normalize_bgm_duck(raw: Any) -> bool:
    if isinstance(raw, bool):
        return raw
    if raw is None:
        return True
    s = str(raw).strip().lower()
    if s in {"0", "false", "no", "off"}:
        return False
    if s in {"1", "true", "yes", "on"}:
        return True
    return True


def normalize_bgm_url(raw: Any) -> str:
    """空或空白 → ""；剥离空白。不在此做白名单（白名单见 is_allowed_bgm_url）。"""
    if raw is None:
        return ""
    return str(raw).strip()


def is_allowed_bgm_url(url: str) -> bool:
    """仅允许站内相对路径前缀；拒绝 http(s) 外链（SSRF）。"""
    u = (url or "").strip()
    if not u:
        return True  # 清空声床合法
    if u.startswith("http://") or u.startswith("https://"):
        # 同源绝对 URL：抽 path 再验
        path = urlsplit(u).path or ""
        return any(path.startswith(p) for p in ALLOWED_BGM_PREFIXES)
    if not u.startswith("/"):
        return False
    return any(u.startswith(p) for p in ALLOWED_BGM_PREFIXES)


def to_relative_bgm_url(url: str) -> str:
    """绝对同源 URL → 相对 path；已是相对则原样。"""
    u = (url or "").strip()
    if not u:
        return ""
    if u.startswith("http://") or u.startswith("https://"):
        parts = urlsplit(u)
        path = parts.path or ""
        if parts.query:
            path = f"{path}?{parts.query}"
        return path
    return u


def bgm_active(url: str) -> bool:
    return bool(normalize_bgm_url(url))
