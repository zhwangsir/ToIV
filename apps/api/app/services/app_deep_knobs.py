"""市场应用更深参数(LoRA / resolution_target)——只接 apps.run 能真生效的 knobs。

segment_extend 依赖 h3_studio 续段链,本模块明确不接,避免假 UI。
"""
from __future__ import annotations

import copy
import logging
from typing import Any

from app.limits import MARKET_MAX_LORAS
from app.services.lora_catalog import catalog_options
from app.workflows.h3_video import _inject_loras as _inject_h3_loras
from app.workflows.lora import LoraSpec, lora_chain
from app.workflows.video_upscale import TARGET_CHOICES, validate_resolution_target

logger = logging.getLogger(__name__)

# 与 seed 同款保留键:即使 DB schema 未声明也可透传(类似 seed)
RESERVED_DEEP_KEYS = frozenset({"loras", "resolution_target"})

# 市场 run 的 LoRA 上限(唯一事实源在 app.limits 的 MARKET_MAX_LORAS;
# 与 H3_MAX_LORAS 同值但作用域不同——parse 拒绝面覆盖市场全家族)
_MAX_LORAS = MARKET_MAX_LORAS


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
    "qwen-image-edit",
})


def image_loras_param() -> dict:
    """出图/编辑市场 LoRA:options 空(不发明文件名);默认关闭。含 qwen-image-edit(图内已有 LoraLoader)。"""
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
    # 本地出图(引擎 id + 市场 basic) + qwen-image-edit(工作流已有 LoraLoader 链)
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


def _next_lora_id_base(graph: dict) -> int:
    """Avoid colliding with existing LoraLoader ids (default chain starts at 100)."""
    hi = 99
    for nid, node in graph.items():
        if not isinstance(node, dict):
            continue
        if node.get("class_type") not in ("LoraLoader", "LoraLoaderModelOnly"):
            continue
        try:
            hi = max(hi, int(str(nid)))
        except ValueError:
            continue
    return hi + 1


def _terminal_unet_clip_refs(graph: dict) -> tuple[list, list] | None:
    """Find tip of existing MODEL/CLIP chain for nextgen UNET@1 + CLIP@3 graphs."""
    if "1" not in graph or graph["1"].get("class_type") != "UNETLoader":
        return None
    if "3" not in graph or graph["3"].get("class_type") != "CLIPLoader":
        return None
    model_src: list = ["1", 0]
    clip_src: list = ["3", 0]
    # Walk LoraLoaderModelOnly hanging off UNET
    for nid, node in graph.items():
        if not isinstance(node, dict):
            continue
        if node.get("class_type") != "LoraLoaderModelOnly":
            continue
        inputs = node.get("inputs") or {}
        m = inputs.get("model")
        if isinstance(m, list) and str(m[0]) == str(model_src[0]):
            model_src = [str(nid), 0]
    # Walk LoraLoader chain (model+clip); tip = node whose model/clip not consumed as input by another LoraLoader
    loaders = {
        str(nid): node
        for nid, node in graph.items()
        if isinstance(node, dict) and node.get("class_type") == "LoraLoader"
    }
    if loaders:
        consumed: set[str] = set()
        for node in loaders.values():
            inputs = node.get("inputs") or {}
            for key in ("model", "clip"):
                ref = inputs.get(key)
                if isinstance(ref, list) and str(ref[0]) in loaders:
                    consumed.add(str(ref[0]))
        tips = [nid for nid in loaders if nid not in consumed]
        if tips:
            # Prefer tip that ultimately traces to UNET/CLIP
            tip = tips[-1]
            model_src = [tip, 0]
            clip_src = [tip, 1]
    return model_src, clip_src


def apply_image_loras(graph: dict, loras: tuple[LoraSpec, ...]) -> bool:
    """出图/编辑图注入 LoraLoader 链:Checkpoint / nextgen UNET+CLIP / Qwen-Edit。

    Checkpoint 路径:链式改写 CLIPTextEncode.clip / KSampler.model。
    Nextgen/Edit 路径:接在已有 UNET(/加速 LoRA / 相机 LoraLoader)末端之后,
    并改写 CLIPTextEncode / TextEncodeQwenImageEdit / ModelSampling* / KSampler。
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
            loras, src_model=[ckpt_id, 0], src_clip=[ckpt_id, 1],
            id_base=_next_lora_id_base(graph),
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

    tip = _terminal_unet_clip_refs(graph)
    if tip is None:
        return False
    model_src, clip_src = tip
    lora_nodes, model_ref, clip_ref = lora_chain(
        loras, model_src, clip_src, id_base=_next_lora_id_base(graph),
    )
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
        if ct in ("CLIPTextEncode", "TextEncodeQwenImageEdit") and isinstance(clip, list) and str(clip[0]) == str(clip_src[0]):
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


# ---------------------------------------------------------------------------
# 引擎 limits → params_schema 可选上限(_to_out 与 run_app 共用有效 schema)
# ---------------------------------------------------------------------------

# 正向提示词的 schema key(positive 为主,prompt 兼容历史卡)
_PROMPT_TEXT_KEYS = frozenset({"positive", "prompt"})
# 媒体类型 → limits 的 max_bytes 键;params 的 max 仍是数量,语义不变
_MEDIA_MAX_BYTES_KEY = {"images": "image_max_bytes", "audio": "audio_max_bytes", "video": "video_max_bytes"}


def _engine_limits_for_app(app_id: str) -> dict | None:
    """已知引擎 → registry spec 的 limits(未挂 limits 的 spec 按 engine_limits() 缺省)。

    精确 engine id 优先;h3-* 市场变体(如 h3-t2v-15s-fast)回退 H3 家族(h3-t2v)声明;
    未知自定义/rh-* 返回 None——不猜能力,不注入任何上限。
    """
    from app.services.engine_registry import engine_limits, get_engine_spec  # 惰性 import:防 services 环

    aid = (app_id or "").strip()
    spec = get_engine_spec(aid)
    if spec is not None:
        return spec.get("limits") or engine_limits()
    if aid.lower().startswith("h3-"):
        base = get_engine_spec("h3-t2v")
        if base is not None:
            return base.get("limits") or engine_limits()
    return None


def apply_engine_limits(app_id: str, schema: list[dict]) -> list[dict]:
    """把已知引擎 limits 映射为 params_schema 项的可选上限(setdefault,不覆盖既有):

      · key ∈ {positive, prompt} 的 text/textarea 项 → max_chars=prompt_max_chars;
      · key=negative 的 text/textarea 项 → max_chars=negative_max_chars;
      · images/audio/video 项 → 对应类型的 max_bytes(数量上限 max 保持原语义);
      · loras 项 → max_items=lora_max_items(limits 未声明(None)不伪造,不注入)。

    未知引擎(None)原样返回。
    """
    limits = _engine_limits_for_app(app_id)
    if not limits:
        return schema
    out: list[dict] = []
    for p in schema:
        p = dict(p)
        key, ptype = str(p.get("key") or ""), p.get("type", "text")
        if ptype in ("text", "textarea"):
            if key in _PROMPT_TEXT_KEYS:
                cap = limits.get("prompt_max_chars")
            elif key == "negative":
                cap = limits.get("negative_max_chars")
            else:
                cap = None
            if cap:
                p.setdefault("max_chars", cap)
        elif ptype in _MEDIA_MAX_BYTES_KEY:
            cap = limits.get(_MEDIA_MAX_BYTES_KEY[ptype])
            if cap:
                p.setdefault("max_bytes", cap)
        elif ptype == "loras":
            cap = limits.get("lora_max_items")
            if cap:
                p.setdefault("max_items", cap)
        out.append(p)
    return out


def effective_params_schema(
    app_id: str,
    schema: list[dict] | None,
    *,
    output_kind: str | None = None,
) -> list[dict]:
    """_to_out(详情下发)与 run_app(提交校验)共用的有效 params_schema 入口:
    enrich_params_schema(LoRA/超分)之后,再映射已知引擎的 limits 声明。
    两侧同源——界面能下发的限制,提交必按同一 schema 校验,不可绕过。
    """
    enriched = enrich_params_schema(app_id, schema, output_kind=output_kind)
    return apply_engine_limits(app_id, enriched)


def segment_extend_unsupported_reason() -> str:
    return (
        "分段续写(segment_extend)仅经典引擎台 H3 路由支持末帧 i2v 续段链;"
        "市场 /api/apps/{id}/run 未接 DurationPlan 续写,故不提供该控件(禁止假 UI)"
    )
