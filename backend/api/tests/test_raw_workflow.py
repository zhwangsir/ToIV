"""任意工作流(raw)端点的分级扫描单测。

P0-5 R5 语义:扫描只用于给 Job 打 nsfw 标(返回图内是否含成人模型),
后端不因 content_mode / X-NSFW / 未成年做 403。
"""
from __future__ import annotations

from app.routes.generate import _tag_raw_graph_nsfw

_SFW = "DreamShaper_8_pruned.safetensors"
_NSFW = "moodyPornMix_zitV7.safetensors"


def _graph(ckpt: str) -> dict:
    return {
        "4": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": ckpt}},
        "9": {"class_type": "SaveImage", "inputs": {"images": ["8", 0]}},
    }


def test_sfw_graph_passes_returns_false():
    assert _tag_raw_graph_nsfw(_graph(_SFW)) is False


def test_nsfw_graph_tagged_for_ordinary_account():
    """普通账号提交含 R18 底模的图:只打标,不 403(限制只在前端锁)。"""
    assert _tag_raw_graph_nsfw(_graph(_NSFW)) is True


def test_nsfw_graph_tagged_with_nsfw_header():
    """带 X-NSFW 上下文时扫描结果不变(头只是审计)。"""
    from app.nsfw_ctx import nsfw_intent_var

    token = nsfw_intent_var.set(True)
    try:
        assert _tag_raw_graph_nsfw(_graph(_NSFW)) is True
    finally:
        nsfw_intent_var.reset(token)


def test_graph_without_ckpt_is_sfw():
    g = {"1": {"class_type": "EmptyLatentImage", "inputs": {"width": 512}}}
    assert _tag_raw_graph_nsfw(g) is False


def test_malformed_nodes_ignored():
    g = {"1": "not a dict", "2": {"no_inputs": True}, "3": {"inputs": "bad"}}
    assert _tag_raw_graph_nsfw(g) is False


# ---------------------------------------------------------------------------
# 扫描键扩展:ckpt_name 之外的模型引用同样参与分级打标
# ---------------------------------------------------------------------------


def test_unet_name_10eros_scanned():
    """UNETLoader.unet_name 挂 10Eros 系 R18 UNET(绕开 ckpt_name 扫描)→ 打标。"""
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
    assert _tag_raw_graph_nsfw(g) is True


def test_lora_name_h3_nsfw_scanned():
    """LoraLoader.lora_name 挂 H3 已知 NSFW LoRA(文件名无 NSFW 子串,is_nsfw 漏判)→ 打标。"""
    g = {
        "1": {
            "class_type": "LoraLoader",
            "inputs": {"lora_name": "riding_pose_H3_i2v_v1.0.safetensors"},
        },
    }
    assert _tag_raw_graph_nsfw(g) is True


def test_lora_name_nsfw_hint_scanned():
    """lora_name 命中通用 NSFW 子串 → 打标。"""
    g = {
        "1": {"class_type": "LoraLoader", "inputs": {"lora_name": "nsfw_boost.safetensors"}},
    }
    assert _tag_raw_graph_nsfw(g) is True


def test_vae_and_model_name_scanned():
    """vae_name / model_name 等其余模型引用字段同样扫描。

    样本须用显式成人向文件名:pony/wai/illustrious 等两用底模不归为 R18,
    故用 10Eros 系 R18 UNET 验证扫描覆盖。"""
    for key in ("vae_name", "model_name"):
        g = {"1": {"class_type": "AnyLoader", "inputs": {key: "10Eros_v1.safetensors"}}}
        assert _tag_raw_graph_nsfw(g) is True


def test_nested_inputs_scanned():
    """嵌套 list/dict 内的模型引用也扫到(LoRA 链参数等)。"""
    g = {
        "1": {
            "class_type": "LoraLoaderModelOnly",
            "inputs": {"lora_name": ["deepthroat_v1.safetensors", 0.6]},
        },
    }
    assert _tag_raw_graph_nsfw(g) is True


def test_sfw_unet_lora_vae_pass():
    """SFW UNET/LoRA/VAE 不误伤(不打 nsfw 标)。"""
    g = {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": "z_image_bf16.safetensors"}},
        "2": {"class_type": "LoraLoader", "inputs": {"lora_name": "detail_tweaker.safetensors"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": "ae.safetensors"}},
        "4": {"class_type": "CLIPTextEncode", "inputs": {"text": "a pony in a meadow"}},
    }
    assert _tag_raw_graph_nsfw(g) is False
