"""任意工作流(raw)端点的 R18 门槛扫描单测。"""
from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import HTTPException

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


def test_nsfw_graph_blocked_when_disabled():
    user = SimpleNamespace(nsfw_enabled=False)
    with pytest.raises(HTTPException) as ei:
        _gate_raw_graph_nsfw(_graph(_NSFW), user)
    assert ei.value.status_code == 403


def test_nsfw_graph_allowed_when_enabled():
    """新语义:放行看 X-NSFW 头(nsfw_intent ContextVar),账户开关不再生效。"""
    from app.nsfw_ctx import nsfw_intent_var

    user = SimpleNamespace(nsfw_enabled=False)
    token = nsfw_intent_var.set(True)  # 模拟 /nsfw 专页请求(中间件置位)
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


# ---------------------------------------------------------------------------
# 扫描键扩展(T0 安全红线):ckpt_name 之外的模型引用同样过 R18 门控
# ---------------------------------------------------------------------------


def test_unet_name_10eros_blocked():
    """UNETLoader.unet_name 挂 10Eros 系 R18 UNET(绕开 ckpt_name 扫描)→ 403。"""
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
    with pytest.raises(HTTPException) as ei:
        _gate_raw_graph_nsfw(g, user)
    assert ei.value.status_code == 403
    assert "R18" in ei.value.detail


def test_lora_name_h3_nsfw_blocked():
    """LoraLoader.lora_name 挂 H3 已知 NSFW LoRA(文件名无 NSFW 子串,is_nsfw 漏判)→ 403。"""
    user = SimpleNamespace(nsfw_enabled=False)
    g = {
        "1": {
            "class_type": "LoraLoader",
            "inputs": {"lora_name": "riding_pose_H3_i2v_v1.0.safetensors"},
        },
    }
    with pytest.raises(HTTPException) as ei:
        _gate_raw_graph_nsfw(g, user)
    assert ei.value.status_code == 403


def test_lora_name_nsfw_hint_blocked():
    """lora_name 命中通用 NSFW 子串 → 403。"""
    user = SimpleNamespace(nsfw_enabled=False)
    g = {
        "1": {"class_type": "LoraLoader", "inputs": {"lora_name": "nsfw_boost.safetensors"}},
    }
    with pytest.raises(HTTPException) as ei:
        _gate_raw_graph_nsfw(g, user)
    assert ei.value.status_code == 403


def test_vae_and_model_name_scanned():
    """vae_name / model_name 等其余模型引用字段同样扫描。

    门控样本须用显式成人向文件名:fb78872 后 pony/wai/illustrious 等两用底模
    不再归为 R18(不再触发 403),故改用 10Eros 系 R18 UNET 验证扫描覆盖。"""
    user = SimpleNamespace(nsfw_enabled=False)
    for key in ("vae_name", "model_name"):
        g = {"1": {"class_type": "AnyLoader", "inputs": {key: "10Eros_v1.safetensors"}}}
        with pytest.raises(HTTPException) as ei:
            _gate_raw_graph_nsfw(g, user)
        assert ei.value.status_code == 403


def test_nested_inputs_scanned():
    """嵌套 list/dict 内的模型引用也扫到(LoRA 链参数等)。"""
    user = SimpleNamespace(nsfw_enabled=False)
    g = {
        "1": {
            "class_type": "LoraLoaderModelOnly",
            "inputs": {"lora_name": ["deepthroat_v1.safetensors", 0.6]},
        },
    }
    with pytest.raises(HTTPException) as ei:
        _gate_raw_graph_nsfw(g, user)
    assert ei.value.status_code == 403


def test_sfw_unet_lora_vae_pass():
    """SFW UNET/LoRA/VAE 不误伤(放行且不打 nsfw 标)。"""
    user = SimpleNamespace(nsfw_enabled=False)
    g = {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": "z_image_bf16.safetensors"}},
        "2": {"class_type": "LoraLoader", "inputs": {"lora_name": "detail_tweaker.safetensors"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": "ae.safetensors"}},
        "4": {"class_type": "CLIPTextEncode", "inputs": {"text": "a pony in a meadow"}},
    }
    assert _gate_raw_graph_nsfw(g, user) is False


def test_nsfw_unet_allowed_with_nsfw_header():
    """带 X-NSFW 上下文时 10Eros UNET 放行并打标(与其它端点同语义)。"""
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
