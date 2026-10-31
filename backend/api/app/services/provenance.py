"""模型/应用/引擎出处字段门控 —— 原始源 URL/ID 仅 admin 可见。

产品纪律(2026-09-07):
- 对外可展示:作者名(App.author / ModelCard.creator / engine.source.author)、
  封面、中文说明(不含 RH:webappId)。
- 仅 admin:RH webappId、civitai_url/civitai_id/version_id、engine.source.url、
  HF/Civitai 直链等「可回溯到外部源站」的原始标识。
- 普通用户 API/UI 不得依赖这些字段;EngineInfoCard 已兼容无 url 时只显示 name。
"""
from __future__ import annotations

import re
from typing import Any

# description 里由 rh_family_preset_seed.describe_preset 写入的「 · RH:{digits}」
_RH_WEBAPP_RE = re.compile(r"(?:\s*[·•|]\s*)?RH:\s*(\d+)\b", re.IGNORECASE)

# 百科/推荐卡上对普通用户抹掉的键(保留键名、置空,避免前端类型炸)
_WIKI_ADMIN_ONLY_KEYS = ("civitai_url", "civitai_id", "huggingface_url")
_NSFW_REC_ADMIN_ONLY_KEYS = ("civitai_url", "version_id")


def is_admin_user(user: Any) -> bool:
    return getattr(user, "role", "") == "admin"


def extract_rh_webapp_id(text: str | None) -> str:
    """从 App.description 解析 RH webappId;无则空串。"""
    m = _RH_WEBAPP_RE.search(text or "")
    return m.group(1) if m else ""


def strip_rh_webapp_id(text: str | None) -> str:
    """去掉 description 中的 RH:{id} 段,并收尾多余分隔符。"""
    cleaned = _RH_WEBAPP_RE.sub("", text or "")
    cleaned = re.sub(r"\s*[·•|]\s*$", "", cleaned)
    cleaned = re.sub(r"^\s*[·•|]\s*", "", cleaned)
    cleaned = re.sub(r"(\s*[·•]\s*){2,}", " · ", cleaned)
    return cleaned.strip()


def public_app_description(description: str | None, *, is_admin: bool) -> str:
    """普通用户看不到 RH:webappId;admin 看到库内原文。"""
    raw = description or ""
    return raw if is_admin else strip_rh_webapp_id(raw)


def redact_engine_source(source: dict[str, Any] | None, *, is_admin: bool) -> dict[str, Any] | None:
    """引擎出处:name/author/note 可公开;url 仅 admin。"""
    if not source:
        return source
    out = dict(source)
    if not is_admin:
        out.pop("url", None)
    return out


def redact_wiki_card(card: dict[str, Any], *, is_admin: bool) -> dict[str, Any]:
    """模型百科卡:抹掉 civitai_url/civitai_id(非 admin)。"""
    out = dict(card)
    if is_admin:
        return out
    for k in _WIKI_ADMIN_ONLY_KEYS:
        if k in out:
            out[k] = ""
    return out


def redact_nsfw_recommendation(item: dict[str, Any], *, is_admin: bool) -> dict[str, Any]:
    """R18 推荐清单:原始 civitai 链/version 仅 admin(前端本就只给 admin 挂载)。"""
    out = dict(item)
    if is_admin:
        return out
    for k in _NSFW_REC_ADMIN_ONLY_KEYS:
        if k in out:
            out[k] = ""
    return out

# RunningHub 应用详情页(与 RH 站内 ai-detail 路径一致;admin 出处外链用)
_RH_DETAIL_TMPL = "https://www.runninghub.ai/ai-detail/{webapp_id}"

# description / 未来字段里可识别的 http(s) 外链(admin 出处附加)
_HTTP_URL_RE = re.compile(r"https?://[^\s<>\"')\]]+", re.IGNORECASE)

# rh-* 应用 id 前缀 → 本地 base 引擎 id(与 knowledge_graph._RH_PREFIX_BASE 对齐)
_RH_PREFIX_BASE: tuple[tuple[str, str], ...] = (
    ("rh-wanim-", "wan-animate-2"),
    ("rh-vacee-", "vace-edit"),
    ("rh-vace-", "wan-vace"),
    ("rh-ltxlip-", "ltx-nsfw-lipsync"),
    ("rh-ltx-", "ltx-nsfw-i2v"),
    ("rh-wan-", "wan-nsfw-i2v"),
    ("rh-h3-", "h3-t2v"),
)


def rh_webapp_url(webapp_id: str | None) -> str:
    """RH webappId → 官网详情 URL;无效 id 返回空串。"""
    wid = (webapp_id or "").strip()
    if not wid or not wid.isdigit():
        return ""
    return _RH_DETAIL_TMPL.format(webapp_id=wid)


def resolve_app_base_engine_id(app_id: str) -> str:
    """app id → 关联引擎 id:同 id 引擎优先,否则 rh-* 前缀映射到 base。"""
    aid = (app_id or "").strip()
    if not aid:
        return ""
    # 延迟 import,避免 provenance ↔ engine_registry 启动环
    from app.services.engine_registry import get_engine_spec

    if get_engine_spec(aid):
        return aid
    low = aid.lower()
    for prefix, base in _RH_PREFIX_BASE:
        if low.startswith(prefix):
            return base if get_engine_spec(base) else base
    return ""


def public_engine_source(engine_id: str, *, is_admin: bool) -> dict[str, Any] | None:
    """引擎注册表 source 投影;url 仅 admin(与 list_engines 门控同口径)。"""
    if not engine_id:
        return None
    from app.services.engine_registry import get_engine_spec

    spec = get_engine_spec(engine_id)
    if not spec:
        return None
    return redact_engine_source(spec.get("source"), is_admin=is_admin)


def _label_for_url(url: str, fallback: str = "来源") -> str:
    u = url.lower()
    if "runninghub" in u:
        return "RunningHub"
    if "huggingface.co" in u or "hf.co" in u:
        return "HuggingFace"
    if "civitai" in u:
        return "Civitai"
    if "github.com" in u:
        return "GitHub"
    return fallback


def build_app_source_links(
    *,
    app_id: str,
    description: str | None,
    rh_webapp_id: str | None,
    is_admin: bool,
) -> list[dict[str, str]]:
    """admin 出处外链:{label,url}[];非 admin 恒空。去重保序。"""
    if not is_admin:
        return []
    links: list[dict[str, str]] = []
    seen: set[str] = set()

    def _add(label: str, url: str) -> None:
        u = (url or "").strip()
        if not u or u in seen:
            return
        seen.add(u)
        links.append({"label": label, "url": u})

    rh_url = rh_webapp_url(rh_webapp_id or extract_rh_webapp_id(description))
    if rh_url:
        _add("RunningHub", rh_url)

    eng_id = resolve_app_base_engine_id(app_id)
    src = public_engine_source(eng_id, is_admin=True) if eng_id else None
    if src and src.get("url"):
        _add(_label_for_url(str(src["url"]), str(src.get("name") or "引擎出处")), str(src["url"]))

    for m in _HTTP_URL_RE.finditer(description or ""):
        raw = m.group(0).rstrip(".,;:)")
        if raw.startswith(_RH_DETAIL_TMPL.split("{")[0]):
            continue  # RH 详情已由 rh_webapp_url 覆盖
        _add(_label_for_url(raw), raw)

    return links
