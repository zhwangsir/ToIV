"""次世代出图族(A 期):家族识别 + 采样档 + UNET 图构造的机械正确性。

只验结构与参数(节点类型、cfg=1、负向清空、族专用节点),不验出图质量(需 GPU + 人工)。
worker :8002 /object_info 实测:Z-Image 三件套已在(端到端出图成功),Qwen 图结构正确
仅缺 qwen_2.5_vl 编码器,FLUX.2 图过校验但缺正确编码器(见 A 期人工验证清单)。
"""
from __future__ import annotations

import pytest

from app.workflows.model_profiles import (
    detect_model_family,
    is_nextgen,
    nextgen_recipe,
    profile_for,
)
from app.workflows.nextgen import NextgenError, NextgenParams, build_nextgen_graph

QWEN = "qwen_image_fp8_e4m3fn.safetensors"
ZIMG = "z_image_turbo_bf16.safetensors"
FLUX2 = "flux-2-klein-4b.safetensors"
SD15 = "DreamShaper_8_pruned.safetensors"


def _types(graph: dict) -> list[str]:
    return [graph[k]["class_type"] for k in sorted(graph, key=int)]


def _by_type(graph: dict, ctype: str) -> dict:
    for node in graph.values():
        if node["class_type"] == ctype:
            return node["inputs"]
    raise KeyError(ctype)


@pytest.mark.parametrize(
    "name,fam",
    [
        (QWEN, "qwen_image"),
        (ZIMG, "z_image"),
        (FLUX2, "flux2"),
        (SD15, "sd15"),
        ("ponyDiffusionV6XL.safetensors", "pony"),
        ("animagineXL40.safetensors", "sdxl_anime"),
    ],
)
def test_family_detection(name, fam):
    assert detect_model_family(name) == fam


def test_is_nextgen():
    assert is_nextgen(QWEN) and is_nextgen(ZIMG) and is_nextgen(FLUX2)
    assert not is_nextgen(SD15)
    assert not is_nextgen("ponyDiffusionV6XL.safetensors")


def test_distilled_families_force_cfg1_no_negative():
    # FLUX.2 dev / Z-Image:真实 CFG=1 + 负向失效 + simple(禁 Karras)
    for name in (FLUX2, ZIMG):
        p = profile_for(name)
        assert p.cfg == 1.0, name
        assert p.neg_prompt is False, name
        assert p.scheduler == "simple", name
    # Qwen-Image **底模**(非蒸馏):真 CFG 2.5~4 + 负向有效
    pq = profile_for(QWEN)
    assert 2.0 <= pq.cfg <= 5.0
    assert pq.neg_prompt is True
    assert pq.scheduler == "simple"
    # 传统族保留常规 CFG + 负向
    assert profile_for(SD15).neg_prompt is True
    assert profile_for(SD15).cfg > 1.0


def test_flux2_encoder_by_variant():
    # Klein → qwen_3_4b(worker 已有);dev → Mistral-3-small(需下载)
    assert nextgen_recipe("flux-2-klein-4b.safetensors").clip_name == "qwen_3_4b.safetensors"
    assert "mistral" in nextgen_recipe("flux2-dev-fp8mixed.safetensors").clip_name.lower()


def test_zimage_graph_uses_zimage_encoder_and_res_multistep():
    g = build_nextgen_graph(NextgenParams(model_name=ZIMG, positive="a fox", cfg=1.0,
                                          sampler="res_multistep", scheduler="simple"))
    t = _types(g)
    assert "UNETLoader" in t and "TextEncodeZImageOmni" in t and "VAELoader" in t
    assert "CLIPTextEncode" not in t  # Z-Image 走专用编码节点
    ks = _by_type(g, "KSampler")
    assert ks["cfg"] == 1.0 and ks["sampler_name"] == "res_multistep"


def test_qwen_graph_has_auraflow_sd3latent_no_fluxguidance():
    g = build_nextgen_graph(NextgenParams(model_name=QWEN, positive="a fox"))
    t = _types(g)
    assert "ModelSamplingAuraFlow" in t
    assert "EmptySD3LatentImage" in t
    assert "FluxGuidance" not in t
    clip = _by_type(g, "CLIPLoader")
    assert clip["type"] == "qwen_image"


def test_flux2_graph_has_fluxguidance_and_flux2latent():
    g = build_nextgen_graph(NextgenParams(model_name=FLUX2, positive="a fox"))
    t = _types(g)
    assert "ModelSamplingFlux" in t
    assert "FluxGuidance" in t
    assert "EmptyFlux2LatentImage" in t
    assert _by_type(g, "FluxGuidance")["guidance"] == 3.5


def test_negative_dropped_when_profile_disables_it():
    # 端点会在 neg_prompt=False 时清空负向;此处直接建图验证空负向仍产出合法结构
    g = build_nextgen_graph(NextgenParams(model_name=QWEN, positive="a fox", negative=""))
    # 两个 CLIPTextEncode(正 + 空负),KSampler 的 negative 指向空编码
    encs = [n for n in g.values() if n["class_type"] == "CLIPTextEncode"]
    assert len(encs) == 2
    assert any(e["inputs"]["text"] == "" for e in encs)


def test_non_nextgen_raises():
    with pytest.raises(NextgenError):
        build_nextgen_graph(NextgenParams(model_name=SD15, positive="a fox"))
    assert nextgen_recipe(SD15) is None
