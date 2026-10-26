"""任意工作流(raw)端点的 R18 扫描单测。

2026-10-26:后端不再因 R18 模型 403；扫描仍返回是否成人向供打标。
拦截改 canvas 前端路由守卫。
"""
from __future__ import annotations

from types import SimpleNamespace

from app.routes.generate import _gate_raw_graph_nsfw

_SFW = "DreamShaper_8_pruned.safetensors"
_NSFW = "moodyPornMix_zitV7.safetensors"


def _graph(ckpt: str) -> dict:
    return {
        "4": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": ckpt}},
        "9": {"class_type": "SaveImage", "inputs": {"images": ["8", 0]}},
    }


def test_sfw_graph_passes_returns_false():
    user = SimpleNamespace(nsfw_enabled=False)
    assert _gate_raw_graph_nsfw(_graph(_SFW), user) is False


def test_nsfw_graph_allowed_when_disabled_no_403():
    """无头不再 403；仍返回 True 供打标。"""
    user = SimpleNamespace(nsfw_enabled=False)
    assert _gate_raw_graph_nsfw(_graph(_NSFW), user) is True


def test_nsfw_graph_allowed_when_enabled():
    from app.nsfw_ctx import nsfw_intent_var

    user = SimpleNamespace(nsfw_enabled=False)
    token = nsfw_intent_var.set(True)
    try:
        assert _gate_raw_graph_nsfw(_graph(_NSFW), user) is True
    finally:
        nsfw_intent_var.reset(token)


def test_graph_without_ckpt_is_sfw():
    user = SimpleNamespace(nsfw_enabled=False)
    g = {"1": {"class_type": "EmptyLatentImage", "inputs": {"width": 512}}}
    assert _gate_raw_graph_nsfw(g, user) is False


def test_malformed_nodes_ignored():
    user = SimpleNamespace(nsfw_enabled=False)
    g = {"1": "not a dict", "2": {"no_inputs": True}, "3": {"inputs": "bad"}}
    assert _gate_raw_graph_nsfw(g, user) is False


def test_unet_name_10eros_detected():
    """UNETLoader.unet_name 挂 10Eros → 扫描命中打标（不 403）。"""
    user = SimpleNamespace(nsfw_enabled=False)
    g = {
        "1": {
            "class_type": "UNETLoader",
            "inputs": {
                "unet_name": "10Eros_Max_h3_TURBO_ref2va_beta2_int8_convrot.safetensors",
                "weight_dtype": "default",
            },
        },
        "2": {"class_type": "SaveImage", "inputs": {}},
    }
    assert _gate_raw_graph_nsfw(g, user) is True


def test_lora_name_h3_nsfw_detected():
    user = SimpleNamespace(nsfw_enabled=False)
    g = {
        "1": {
            "class_type": "LoraLoader",
            "inputs": {"lora_name": "riding_pose_H3_i2v_v1.0.safetensors"},
        },
    }
    assert _gate_raw_graph_nsfw(g, user) is True


def test_lora_name_nsfw_hint_detected():
    user = SimpleNamespace(nsfw_enabled=False)
    g = {
        "1": {"class_type": "LoraLoader", "inputs": {"lora_name": "nsfw_boost.safetensors"}},
    }
    assert _gate_raw_graph_nsfw(g, user) is True


def test_vae_and_model_name_scanned():
    user = SimpleNamespace(nsfw_enabled=False)
    for key in ("vae_name", "model_name"):
        g = {"1": {"class_type": "AnyLoader", "inputs": {key: "10Eros_v1.safetensors"}}}
        assert _gate_raw_graph_nsfw(g, user) is True


def test_nested_inputs_scanned():
    user = SimpleNamespace(nsfw_enabled=False)
    g = {
        "1": {
            "class_type": "LoraLoaderModelOnly",
            "inputs": {"lora_name": ["deepthroat_v1.safetensors", 0.6]},
        },
    }
    assert _gate_raw_graph_nsfw(g, user) is True


def test_sfw_unet_lora_vae_pass():
    user = SimpleNamespace(nsfw_enabled=False)
    g = {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": "z_image_bf16.safetensors"}},
        "2": {"class_type": "LoraLoader", "inputs": {"lora_name": "detail_tweaker.safetensors"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": "ae.safetensors"}},
        "4": {"class_type": "CLIPTextEncode", "inputs": {"text": "a pony in a meadow"}},
    }
    assert _gate_raw_graph_nsfw(g, user) is False


def test_nsfw_unet_allowed_with_nsfw_header():
    from app.nsfw_ctx import nsfw_intent_var

    user = SimpleNamespace(nsfw_enabled=False)
    g = {
        "1": {
            "class_type": "UNETLoader",
            "inputs": {"unet_name": "10Eros_Max_h3_TURBO_ref2va_beta2_int8_convrot.safetensors"},
        },
    }
    token = nsfw_intent_var.set(True)
    try:
        assert _gate_raw_graph_nsfw(g, user) is True
    finally:
        nsfw_intent_var.reset(token)
