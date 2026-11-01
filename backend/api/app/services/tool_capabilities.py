"""生成工具能力归一化(唯一出口:GET /api/models/capabilities)。

输入是 engine_registry.list_engines 的引擎条目,本模块只做投影/换算:
模型档来自 ckpt_name 选项、尺寸档由 width/height 的 min/max/step/ar 推导、
时长档来自 duration 选项。这里不得另写一份模型/比例/时长清单——
新增模型或时长只改引擎注册表(或 worker 选项),前端随能力响应自动生效。
"""
from __future__ import annotations

from fractions import Fraction
from typing import Any, Callable

SCHEMA_VERSION = 1

# (id, label, ratio, 中文注解)
_RATIOS: list[tuple[str, float, str]] = [
    ("1:1", 1.0, "方形"),
    ("16:9", 16 / 9, "横屏"),
    ("9:16", 9 / 16, "竖屏"),
    ("2:1", 2.0, "宽幅"),
]

_AVATAR_SUBMITS = {"avatar-talk", "wan-animate", "wan-animate-2", "phantom_s2v"}

_TOOL_SPECS: dict[str, dict[str, Any]] = {
    "image": {
        "engine_id": "txt2img",
        "label": "文生图",
        "kind": "image",
        "model_param": "ckpt_name",
        "affects": ["工具中心 · 文生图", "画布 · 节点生成", "项目 · 分镜首帧"],
    },
    "video": {
        "engine_id": "h3-t2v",
        "label": "文生视频",
        "kind": "video",
        "model_param": None,
        "affects": ["工具中心 · 文生视频", "流水线 · 分镜渲染"],
    },
}

_SLOT_SPECS: list[tuple[str, str, Callable[[dict], bool], list[str]]] = [
    (
        "image", "出图",
        lambda e: e.get("kind") == "image",
        ["工具中心 · 文生图", "画布 · 节点生成", "项目 · 分镜首帧"],
    ),
    (
        "video", "视频",
        lambda e: e.get("kind") == "video" and _submit_kind(e) not in _AVATAR_SUBMITS,
        ["工具中心 · 文生视频", "流水线 · 分镜渲染"],
    ),
    (
        "avatar", "数字人",
        lambda e: _submit_kind(e) in _AVATAR_SUBMITS,
        ["流水线 · 数字人口播", "项目 · 配音与口型"],
    ),
    (
        "audio", "音乐",
        lambda e: e.get("kind") == "audio" or _submit_kind(e) == "audio",
        ["配音 · 台词配音", "工具中心 · 音乐"],
    ),
]


def _submit_kind(engine: dict) -> str | None:
    submit = engine.get("submit") or {}
    return submit.get("kind") if isinstance(submit, dict) else None


def _route(engine: dict) -> str | None:
    submit = engine.get("submit") or {}
    return submit.get("route") if isinstance(submit, dict) else None


def _param(engine: dict, key: str) -> dict | None:
    return next((p for p in engine.get("params") or [] if p.get("key") == key), None)


def _snap(value: float, step: float) -> int:
    if step and step > 0:
        value = round(value / step) * step
    return int(round(value))


def _ratio_label(value: float) -> str:
    frac = Fraction(value).limit_denominator(20)
    return f"{frac.numerator}:{frac.denominator}"


def _in_range(value: float, param: dict) -> bool:
    low = param.get("min")
    high = param.get("max")
    return (low is None or value >= low) and (high is None or value <= high)


def _derive_sizes(width: dict | None, height: dict | None) -> list[dict]:
    if not width or not height:
        return []
    long_side = _snap(max(width.get("default") or 0, height.get("default") or 0), max(
        width.get("step") or 0, height.get("step") or 0,
    ))
    if long_side <= 0:
        return []
    ar = width.get("ar") or [None, None]
    ar_low, ar_high = ar[0], ar[1]
    sizes: list[dict] = []
    for key, ratio, note in _RATIOS:
        if ratio >= 1:
            w = long_side
            h = _snap(long_side / ratio, height.get("step") or 0)
        else:
            h = long_side
            w = _snap(long_side * ratio, width.get("step") or 0)
        reason = None
        if not _in_range(w, width) or not _in_range(h, height):
            reason = (
                f"超出引擎尺寸范围 {width.get('min')}–{width.get('max')}"
                f"×{height.get('min')}–{height.get('max')}"
            )
        elif ar_low is not None and ar_high is not None and not (ar_low <= w / h <= ar_high):
            reason = (
                f"超出引擎宽高比范围 {_ratio_label(ar_low)}–{_ratio_label(ar_high)}"
                f"(当前 {_ratio_label(w / h)})"
            )
        sizes.append({
            "value": key,
            "label": f"{key} {note}",
            "width": w,
            "height": h,
            "available": reason is None,
            "reason": reason,
        })
    return sizes


def _derive_models(engine: dict, key: str | None) -> list[dict]:
    if not key:
        return []
    param = _param(engine, key)
    if not param:
        return []
    default = param.get("default")
    return [
        {
            "value": opt.get("value"),
            "label": opt.get("label") or opt.get("value"),
            "default": opt.get("value") == default,
            "nsfw": bool(opt.get("nsfw")),
            "desc": opt.get("desc") or "",
        }
        for opt in param.get("options") or []
    ]


def _derive_durations(engine: dict) -> list[dict]:
    param = _param(engine, "duration")
    if not param:
        return []
    durations: list[dict] = []
    for opt in param.get("options") or []:
        raw = opt.get("value")
        try:
            seconds = float(raw)
        except (TypeError, ValueError):
            continue
        durations.append({
            "value": raw,
            "label": opt.get("label") or f"{raw} 秒",
            "seconds": seconds,
            "default": raw == param.get("default"),
            "available": not opt.get("disabled"),
            "reason": opt.get("disabled_reason"),
        })
    return durations


def _tool(tool_id: str, spec: dict, engine: dict | None) -> dict:
    available = bool(engine and engine.get("available"))
    reason = None
    if engine is None:
        reason = "引擎未注册(检查引擎注册表或 profile 配置)"
    elif not available:
        reason = engine.get("unavailable_reason") or "引擎不可用"
    width = _param(engine, "width") if engine else None
    height = _param(engine, "height") if engine else None
    duration_param = _param(engine, "duration") if engine else None
    return {
        "id": tool_id,
        "label": spec["label"],
        "kind": spec["kind"],
        "engine_id": spec["engine_id"],
        "engine_label": engine.get("label") if engine else None,
        "route": _route(engine) if engine else None,
        "available": available,
        "unavailable_reason": reason,
        "model_param": spec["model_param"],
        "models": _derive_models(engine, spec["model_param"]) if engine else [],
        "sizes": _derive_sizes(width, height),
        "size_hint": width.get("hint") if width else None,
        "duration_param": "duration" if duration_param else None,
        "duration_hint": duration_param.get("hint") if duration_param else None,
        "durations": _derive_durations(engine) if engine else [],
        "limits": dict(engine.get("limits") or {}) if engine else {},
        "affects": list(spec["affects"]),
    }


def _slots(engines: list[dict]) -> list[dict]:
    slots: list[dict] = []
    for slot_id, label, match, affects in _SLOT_SPECS:
        matched = [e for e in engines if not e.get("hidden") and match(e)]
        available = any(bool(e.get("available")) for e in matched)
        reason = None
        if not matched:
            reason = "暂无已注册引擎"
        elif not available:
            reason = next(
                (e.get("unavailable_reason") for e in matched if e.get("unavailable_reason")),
                "该业务槽位暂无可用引擎",
            )
        slots.append({
            "id": slot_id,
            "label": label,
            "available": available,
            "unavailable_reason": reason,
            "affects": list(affects),
            "engines": [
                {
                    "id": e.get("id"),
                    "label": e.get("label"),
                    "kind": e.get("kind"),
                    "nsfw": bool(e.get("nsfw")),
                    "description": e.get("description") or "",
                    "route": _route(e),
                    "available": bool(e.get("available")),
                    "unavailable_reason": e.get("unavailable_reason"),
                    "params": e.get("params") or [],
                    "limits": dict(e.get("limits") or {}),
                }
                for e in matched
            ],
        })
    return slots


def _issues(tools: dict[str, dict], slots: list[dict]) -> list[dict]:
    issues: list[dict] = []
    for tool in tools.values():
        if tool["available"]:
            continue
        issues.append({
            "id": f"tool-{tool['id']}-unavailable",
            "severity": "error",
            "title": f"{tool['label']}暂不可用",
            "reason": tool["unavailable_reason"],
            "affects": list(tool["affects"]),
        })
    for slot in slots:
        if slot["available"]:
            continue
        issues.append({
            "id": f"slot-{slot['id']}-empty",
            "severity": "error",
            "title": f"{slot['label']}槽位暂无可用引擎",
            "reason": slot["unavailable_reason"],
            "affects": list(slot["affects"]),
        })
    return issues


def build_tool_capabilities(engines: list[dict]) -> dict:
    """把引擎条目归一化为工具能力 + 业务槽位 + 未配置影响。"""
    by_id = {e.get("id"): e for e in engines}
    tools = {
        tool_id: _tool(tool_id, spec, by_id.get(spec["engine_id"]))
        for tool_id, spec in _TOOL_SPECS.items()
    }
    slots = _slots(engines)
    return {
        "schema_version": SCHEMA_VERSION,
        "tools": tools,
        "slots": slots,
        "issues": _issues(tools, slots),
    }
