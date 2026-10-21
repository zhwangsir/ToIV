"""市场应用更深参数(LoRA / resolution_target)——只接 apps.run 能真生效的 knobs。

segment_extend 依赖 h3_studio 续段链,本模块明确不接,避免假 UI。
"""
from __future__ import annotations

import copy
import logging
from typing import Any

from app.services.lora_catalog import catalog_options
from app.workflows.h3_video import _inject_loras as _inject_h3_loras
from app.workflows.lora import LoraSpec, lora_chain
from app.workflows.video_upscale import TARGET_CHOICES, validate_resolution_target

logger = logging.getLogger(__name__)

# 与 seed 同款保留键:即使 DB schema 未声明也可透传(类似 seed)
RESERVED_DEEP_KEYS = frozenset({"loras", "resolution_target"})

_MAX_LORAS = 3


def resolution_target_param() -> dict:
    return {
        "key": "resolution_target",
        "label": "输出超分",
        "type": "select",
        "default": "",
        "options": [
            {"value": "", "label": "原生直出(不超分)"},
            {"value": "720p", "label": "720P (二次超分)"},
            {"value": "1080p", "label": "1080P (二次超分)"},
            {"value": "2k", "label": "2K (二次超分)"},
            {"value": "4k", "label": "4K (二次超分)"},
        ],
        "hint": "生成完成后自动挂二次超分链;空=原生直出",
        "required": False,
    }


def h3_loras_param() -> dict:
    return {
        "key": "loras",
        "label": "LoRA 叠加",
        "type": "loras",
        "default": [],  # 市场默认关闭,保持历史无 LoRA 行为;UI 可改 AI/钉选
        "options": catalog_options("h3"),
        "min": 0.5,
        "max": 1.0,
        "step": 0.05,
        "hint": "默认关闭;可选 AI 选配或钉选最多 3 个(强度 0.5–1.0)",
        "required": False,
    }


def ltx_loras_param() -> dict:
    return {
        "key": "loras",
        "label": "LoRA 叠加",
        "type": "loras",
        "default": [],
        "options": catalog_options("ltx"),
        "min": 0.0,
        "max": 2.0,
        "step": 0.05,
        "hint": "默认关闭;可选钉选最多 3 个",
        "required": False,
    }


def supports_market_loras(app_id: str) -> bool:
    aid = (app_id or "").strip().lower()
    return aid.startswith("h3-") or aid.startswith("ltx")


def supports_market_resolution_target(app_id: str, *, output_kind: str | None = None) -> bool:
    aid = (app_id or "").strip().lower()
    if aid.startswith(("h3-", "ltx", "longcat-", "wan-")):
        return True
    return (output_kind or "").lower() == "video"


def parse_loras_value(raw: object) -> tuple[LoraSpec, ...]:
    """表单 loras → LoraSpec。None/缺省/[] → 空(不挂);钉选为 [{name,strength}]。"""
    if raw is None or raw == "" or raw is False:
        return ()
    if not isinstance(raw, list):
        raise ValueError("loras 须为数组(空=关闭;项为 {name,strength})")
    out: list[LoraSpec] = []
    for item in raw:
        if not isinstance(item, dict):
            raise ValueError("loras 每项须为对象 {name, strength}")
        name = str(item.get("name") or "").strip()
        if not name:
            continue
        try:
            strength = float(item.get("strength", 0.6))
        except (TypeError, ValueError) as e:
            raise ValueError(f"LoRA {name} strength 须为数字") from e
        out.append(LoraSpec(name=name, weight=strength))
        if len(out) > _MAX_LORAS:
            raise ValueError(f"最多叠加 {_MAX_LORAS} 个 LoRA")
    return tuple(out)


def normalize_resolution_target_value(raw: object) -> str | None:
    if raw is None:
        return None
    s = str(raw).strip()
    try:
        return validate_resolution_target(s if s else None)
    except ValueError as e:
        raise ValueError(str(e)) from e


def apply_ltx_loras(graph: dict, loras: tuple[LoraSpec, ...]) -> None:
    """在已有 LTX 市场图(UNET=1 / Gemma CLIP=2)上插入 LoraLoader 链并改接线。"""
    if not loras:
        return
    if "1" not in graph or graph["1"].get("class_type") != "UNETLoader":
        logger.warning("LTX LoRA 注入跳过:图无 UNETLoader@1")
        return
    clip_src = ["2", 0] if "2" in graph else ["1", 0]
    lora_nodes, model_ref, clip_ref = lora_chain(
        loras, src_model=["1", 0], src_clip=clip_src
    )
    graph.update(lora_nodes)
    for node in graph.values():
        if not isinstance(node, dict):
            continue
        ct = node.get("class_type")
        inputs = node.get("inputs") or {}
        if ct == "CLIPTextEncode" and "clip" in inputs:
            inputs["clip"] = clip_ref
        if ct == "KSampler" and "model" in inputs:
            inputs["model"] = model_ref


def apply_app_loras(
    graph: dict,
    app_id: str,
    values: dict,
    *,
    nsfw_intent: bool = False,
) -> dict:
    """按应用家族把 values['loras'] 注入图。返回 meta(applied/count/mode)。

    loras 缺省键 → 不改图(历史行为);
    null → AI 选配(resolve_submit_loras);
    [] → 关闭;
    非空 → 钉选。
    """
    meta: dict[str, Any] = {"applied": False, "count": 0, "family": None, "mode": None}
    if "loras" not in values:
        return meta
    raw = values.get("loras")
    aid = (app_id or "").strip().lower()
    family = "h3" if aid.startswith("h3-") else ("ltx" if aid.startswith("ltx") else None)
    if raw is None:
        if not family:
            return meta
        from app.services.lora_picker import resolve_submit_loras, to_specs

        positive = str(values.get("positive") or "")
        picks, mode, reason = resolve_submit_loras(family, positive, nsfw_intent, None)
        specs = to_specs(picks)
        meta["mode"] = mode
        meta["reason"] = reason
        values["loras"] = [{"name": p.name, "strength": p.strength} for p in picks]
    else:
        try:
            specs = parse_loras_value(raw)
        except ValueError:
            raise
        meta["mode"] = "off" if not specs else "pin"
    if not specs:
        return meta
    if aid.startswith("h3-"):
        if "6" in graph and graph["6"].get("class_type") == "UNETLoader":
            _inject_h3_loras(graph, specs)
            meta.update({"applied": True, "count": len(specs), "family": "h3"})
        else:
            logger.warning("H3 LoRA 注入跳过:图无 UNETLoader@6 app=%s", app_id)
    elif aid.startswith("ltx"):
        apply_ltx_loras(graph, specs)
        # 粗判:链节点 id 从 100 起
        if any(str(k).isdigit() and int(k) >= 100 for k in graph):
            meta.update({"applied": True, "count": len(specs), "family": "ltx"})
    else:
        logger.info("应用 %s 不支持市场 LoRA 注入,已忽略", app_id)
    return meta


def enrich_params_schema(
    app_id: str,
    schema: list[dict] | None,
    *,
    output_kind: str | None = None,
) -> list[dict]:
    """详情/运行表单:为可接家族补 LoRA + resolution_target(缺才补,不覆盖已有)。"""
    out: list[dict] = [copy.deepcopy(p) for p in (schema or []) if isinstance(p, dict)]
    keys = {str(p.get("key") or "") for p in out}
    aid = (app_id or "").strip()

    if supports_market_loras(aid) and "loras" not in keys:
        out.append(h3_loras_param() if aid.lower().startswith("h3-") else ltx_loras_param())
        keys.add("loras")
    elif "loras" in keys:
        for p in out:
            if p.get("key") == "loras" and p.get("type") == "loras" and not p.get("options"):
                eng = "h3" if aid.lower().startswith("h3-") else "ltx"
                if supports_market_loras(aid):
                    p["options"] = catalog_options(eng)

    if supports_market_resolution_target(aid, output_kind=output_kind) and "resolution_target" not in keys:
        out.append(resolution_target_param())

    return out


def segment_extend_unsupported_reason() -> str:
    return (
        "分段续写(segment_extend)仅经典引擎台 H3 路由支持末帧 i2v 续段链;"
        "市场 /api/apps/{id}/run 未接 DurationPlan 续写,故不提供该控件(禁止假 UI)"
    )
