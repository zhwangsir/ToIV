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



_IMAGE_LORA_APP_IDS = frozenset({
    "txt2img",
    "img2img",
    "nsfw-txt2img",
    "nsfw-img2img",
    "txt2img-basic",
    "img2img-basic",
})


def image_loras_param() -> dict:
    """出图市场 LoRA:options 空(不发明文件名);默认关闭。不含 qwen-image-edit。"""
    return {
        "key": "loras",
        "label": "LoRA 叠加",
        "type": "loras",
        "default": [],
        "options": [],
        "min": 0.0,
        "max": 2.0,
        "step": 0.05,
        "hint": "默认关闭;可钉选最多 3 个。设置页出图槽钉选可流入市场出图 run",
        "required": False,
    }


def supports_market_loras(app_id: str) -> bool:
    aid = (app_id or "").strip().lower()
    if aid.startswith("h3-") or aid.startswith("ltx"):
        return True
    # 本地出图(引擎 id + 市场 basic);明确不含 qwen-image-edit
    return aid in _IMAGE_LORA_APP_IDS


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


def apply_image_loras(graph: dict, loras: tuple[LoraSpec, ...]) -> bool:
    """出图图注入 LoraLoader 链:支持 CheckpointLoaderSimple 与 nextgen(UNET+CLIP)。

    Checkpoint 路径:链式改写 CLIPTextEncode.clip / KSampler.model。
    Nextgen 路径:插在 UNET(/加速 LoRA)与 ModelSampling* 之间,并改 CLIP 编码。
    """
    if not loras:
        return False

    # ── classic SD / URPM ──
    ckpt_id = None
    for nid, node in graph.items():
        if isinstance(node, dict) and node.get("class_type") == "CheckpointLoaderSimple":
            ckpt_id = str(nid)
            break
    if ckpt_id is not None:
        lora_nodes, model_ref, clip_ref = lora_chain(
            loras, src_model=[ckpt_id, 0], src_clip=[ckpt_id, 1]
        )
        graph.update(lora_nodes)
        for node in graph.values():
            if not isinstance(node, dict):
                continue
            ct = node.get("class_type")
            inputs = node.get("inputs") or {}
            clip = inputs.get("clip")
            model = inputs.get("model")
            if ct == "CLIPTextEncode" and isinstance(clip, list) and str(clip[0]) == ckpt_id:
                inputs["clip"] = clip_ref
            if ct == "KSampler" and isinstance(model, list) and str(model[0]) == ckpt_id:
                inputs["model"] = model_ref
        return True

    # ── nextgen Flux2 / Qwen-Image UNET ──
    if "1" not in graph or graph["1"].get("class_type") != "UNETLoader":
        return False
    if "3" not in graph or graph["3"].get("class_type") != "CLIPLoader":
        return False
    model_src: list = ["1", 0]
    for nid, node in graph.items():
        if not isinstance(node, dict):
            continue
        if node.get("class_type") != "LoraLoaderModelOnly":
            continue
        inputs = node.get("inputs") or {}
        m = inputs.get("model")
        if isinstance(m, list) and str(m[0]) == "1":
            model_src = [str(nid), 0]
    lora_nodes, model_ref, clip_ref = lora_chain(loras, model_src, ["3", 0])
    graph.update(lora_nodes)
    for node in graph.values():
        if not isinstance(node, dict):
            continue
        ct = str(node.get("class_type") or "")
        inputs = node.get("inputs") or {}
        model = inputs.get("model")
        clip = inputs.get("clip")
        if ct.startswith("ModelSampling") and isinstance(model, list) and str(model[0]) == str(model_src[0]):
            inputs["model"] = model_ref
        elif ct == "KSampler" and isinstance(model, list) and str(model[0]) == str(model_src[0]):
            inputs["model"] = model_ref
        if ct == "CLIPTextEncode" and isinstance(clip, list) and str(clip[0]) == "3":
            inputs["clip"] = clip_ref
    return True


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
    if aid.startswith("h3-"):
        family = "h3"
    elif aid.startswith("ltx"):
        family = "ltx"
    elif aid in _IMAGE_LORA_APP_IDS:
        family = "image"
    else:
        family = None
    if raw is None:
        # 出图无策划 AI 选配目录;null = 不改图(历史行为)
        if family not in ("h3", "ltx", "wan"):
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
    elif family == "image":
        if apply_image_loras(graph, specs):
            meta.update({"applied": True, "count": len(specs), "family": "image"})
        else:
            logger.warning("出图 LoRA 注入跳过:图无 Checkpoint/UNET+CLIP 钩子 app=%s", app_id)
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
        low = aid.lower()
        if low.startswith("h3-"):
            out.append(h3_loras_param())
        elif low.startswith("ltx"):
            out.append(ltx_loras_param())
        else:
            out.append(image_loras_param())
        keys.add("loras")
    elif "loras" in keys:
        for p in out:
            if p.get("key") == "loras" and p.get("type") == "loras" and not p.get("options"):
                low = aid.lower()
                if low.startswith("h3-"):
                    p["options"] = catalog_options("h3")
                elif low.startswith("ltx"):
                    p["options"] = catalog_options("ltx")
                # 出图:options 保持空,不发明文件名

    if supports_market_resolution_target(aid, output_kind=output_kind) and "resolution_target" not in keys:
        out.append(resolution_target_param())

    return out


def segment_extend_unsupported_reason() -> str:
    return (
        "分段续写(segment_extend)仅经典引擎台 H3 路由支持末帧 i2v 续段链;"
        "市场 /api/apps/{id}/run 未接 DurationPlan 续写,故不提供该控件(禁止假 UI)"
    )
