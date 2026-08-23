"""次世代出图族(A 期):家族识别 + 采样档 + UNET 图构造的机械正确性。

只验结构与参数(节点类型、cfg=1、负向清空、族专用节点),不验出图质量(需 GPU + 人工)。
worker :8002 /object_info 实测:Z-Image 三件套已在(端到端出图成功),Qwen/FLUX.2 图结构正确;
注意:qwen_2.5_vl 编码器已废弃(2026-07-25),新编码器待 worker 侧核准后更新配方。
"""
from __future__ import annotations

import pytest

from app.workflows.model_profiles import (
    detect_model_family,
    is_nextgen,
    nextgen_recipe,
    profile_for,
)
from app.workflows.lora import LoraSpec
from app.workflows.nextgen import (
    NextgenError,
    NextgenImg2ImgParams,
    NextgenParams,
    build_nextgen_graph,
    build_nextgen_img2img_graph,
)

QWEN = "qwen_image_fp8_e4m3fn.safetensors"
ZIMG = "z_image_turbo_bf16.safetensors"
ZIMG_BASE = "z_image_bf16.safetensors"
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
        (ZIMG_BASE, "z_image_base"),
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
    # Z-Image **非蒸馏底座**:真 CFG≈4 + 负向有效 + euler+simple + 30 步质量档
    pz = profile_for(ZIMG_BASE)
    assert pz.cfg == 4.0
    assert pz.neg_prompt is True
    assert pz.sampler == "euler" and pz.scheduler == "simple"
    assert pz.steps == 30
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


def test_zimage_base_graph_shares_zimage_recipe_with_negative():
    """z_image_base 与 turbo 共用图配方(TE/VAE/TextEncodeZImageOmni),但负向有效。"""
    g = build_nextgen_graph(NextgenParams(model_name=ZIMG_BASE, positive="a fox",
                                          negative="blurry", cfg=4.0,
                                          sampler="euler", scheduler="simple", steps=30))
    t = _types(g)
    assert "UNETLoader" in t and "TextEncodeZImageOmni" in t and "VAELoader" in t
    assert "CLIPTextEncode" not in t
    ks = _by_type(g, "KSampler")
    assert ks["cfg"] == 4.0 and ks["sampler_name"] == "euler" and ks["steps"] == 30
    # 负向确实进入图(非空 TextEncodeZImageOmni 节点存在)
    encs = [n for n in g.values() if n["class_type"] == "TextEncodeZImageOmni"]
    assert any(e["inputs"]["prompt"] == "blurry" for e in encs)
    clip = _by_type(g, "CLIPLoader")
    assert clip["clip_name"] == "qwen_3_4b.safetensors"


def test_qwen_graph_has_auraflow_sd3latent_no_fluxguidance():
    g = build_nextgen_graph(NextgenParams(model_name=QWEN, positive="a fox"))
    t = _types(g)
    assert "ModelSamplingAuraFlow" in t
    assert "EmptySD3LatentImage" in t
    assert "FluxGuidance" not in t
    clip = _by_type(g, "CLIPLoader")
    assert clip["type"] == "qwen_image"


def test_qwen_graph_clip_override_wins():
    """clip_name 覆盖(按 worker 可用性解析后)优先于配方默认候选。"""
    g = build_nextgen_graph(
        NextgenParams(model_name=QWEN, positive="a fox",
                      clip_name="qwen_2.5_vl_7b_fp8_scaled.safetensors")
    )
    clip = _by_type(g, "CLIPLoader")
    assert clip["clip_name"] == "qwen_2.5_vl_7b_fp8_scaled.safetensors"
    # 不传覆盖时用配方默认(候选列表第一个,worker 实测存在的 Qwen3-VL 单文件)
    g2 = build_nextgen_graph(NextgenParams(model_name=QWEN, positive="a fox"))
    assert _by_type(g2, "CLIPLoader")["clip_name"] == "qwen3vl_4b_fp8_scaled.safetensors"


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


# ---------------------------------------------------------------------------
# img2img 测试
# ---------------------------------------------------------------------------

def test_zimage_img2img_uses_zimage_encoder_and_loadimage():
    g = build_nextgen_img2img_graph(NextgenImg2ImgParams(
        model_name=ZIMG, image="input.png", positive="a fox",
        cfg=1.0, sampler="res_multistep", scheduler="simple", denoise=0.6,
    ))
    t = _types(g)
    assert "UNETLoader" in t and "TextEncodeZImageOmni" in t and "VAELoader" in t
    assert "LoadImage" in t and "VAEEncode" in t
    assert "EmptySD3LatentImage" not in t and "EmptyFlux2LatentImage" not in t
    assert "CLIPTextEncode" not in t
    ks = _by_type(g, "KSampler")
    assert ks["cfg"] == 1.0 and ks["sampler_name"] == "res_multistep"
    assert ks["denoise"] == 0.6
    li = _by_type(g, "LoadImage")
    assert li["image"] == "input.png"


def test_qwen_img2img_has_auraflow_no_fluxguidance_supports_negative():
    g = build_nextgen_img2img_graph(NextgenImg2ImgParams(
        model_name=QWEN, image="input.png", positive="a fox", negative="blurry",
        denoise=0.75,
    ))
    t = _types(g)
    assert "ModelSamplingAuraFlow" in t
    assert "LoadImage" in t and "VAEEncode" in t
    assert "FluxGuidance" not in t
    assert "EmptySD3LatentImage" not in t
    clip = _by_type(g, "CLIPLoader")
    assert clip["type"] == "qwen_image"
    encs = [n for n in g.values() if n["class_type"] == "CLIPTextEncode"]
    assert any(e["inputs"]["text"] == "blurry" for e in encs)
    ks = _by_type(g, "KSampler")
    assert ks["denoise"] == 0.75


def test_flux2_img2img_has_fluxguidance_and_loadimage():
    g = build_nextgen_img2img_graph(NextgenImg2ImgParams(
        model_name=FLUX2, image="photo.jpg", positive="a portrait",
        denoise=0.5,
    ))
    t = _types(g)
    assert "ModelSamplingFlux" in t
    assert "FluxGuidance" in t
    assert "LoadImage" in t and "VAEEncode" in t
    assert "EmptyFlux2LatentImage" not in t
    assert _by_type(g, "FluxGuidance")["guidance"] == 3.5
    assert _by_type(g, "LoadImage")["image"] == "photo.jpg"
    assert _by_type(g, "KSampler")["denoise"] == 0.5


def test_img2img_shares_vae_between_encode_and_decode():
    g = build_nextgen_img2img_graph(NextgenImg2ImgParams(
        model_name=FLUX2, image="x.png", positive="test",
    ))
    vae_loader = _by_type(g, "VAELoader")
    vae_ref = None
    for nid, node in g.items():
        if node["class_type"] == "VAELoader":
            vae_ref = [nid, 0]
            break
    assert vae_ref is not None
    enc = _by_type(g, "VAEEncode")
    dec = _by_type(g, "VAEDecode")
    assert enc["vae"] == vae_ref
    assert dec["vae"] == vae_ref


def test_flux2_img2img_model_sampling_uses_explicit_dims():
    """显式传入输入图尺寸时,ModelSamplingFlux 用真实 w/h(shift 估算更准)。"""
    g = build_nextgen_img2img_graph(NextgenImg2ImgParams(
        model_name=FLUX2, image="photo.jpg", positive="a portrait",
        width=832, height=1216,
    ))
    msf = _by_type(g, "ModelSamplingFlux")
    assert msf["width"] == 832
    assert msf["height"] == 1216


def test_flux2_img2img_model_sampling_falls_back_when_dims_unknown():
    """尺寸未知(0)时回退 1024,绝不给 ComfyUI 送 0(其校验 min=16,会 400)。"""
    g = build_nextgen_img2img_graph(NextgenImg2ImgParams(
        model_name=FLUX2, image="photo.jpg", positive="a portrait",
    ))
    msf = _by_type(g, "ModelSamplingFlux")
    assert msf["width"] == 1024
    assert msf["height"] == 1024


def test_flux2_img2img_model_sampling_rejects_sub16_dims():
    """小于 16 的非法尺寸同样回退 1024(防御调用方传脏数据)。"""
    g = build_nextgen_img2img_graph(NextgenImg2ImgParams(
        model_name=FLUX2, image="photo.jpg", positive="a portrait",
        width=8, height=12,
    ))
    msf = _by_type(g, "ModelSamplingFlux")
    assert msf["width"] == 1024
    assert msf["height"] == 1024


def test_img2img_non_nextgen_raises():
    with pytest.raises(NextgenError):
        build_nextgen_img2img_graph(NextgenImg2ImgParams(
            model_name=SD15, image="x.png", positive="test",
        ))


# ---------------------------------------------------------------------------
# LoRA 链测试(场景预设 LoRA 生效点)
# ---------------------------------------------------------------------------

def test_txt2img_loras_insert_loraloader_chain_before_consumers():
    """LoRA 叠加:LoraLoader 链插在 UNET/CLIP 之后,model-sampling/编码/采样都消费链末端。"""
    g = build_nextgen_graph(NextgenParams(
        model_name=FLUX2, positive="a fox",
        loras=(LoraSpec("style_a.safetensors", 0.8), LoraSpec("style_b.safetensors", 0.6)),
    ))
    assert g["100"]["class_type"] == "LoraLoader"
    assert g["100"]["inputs"]["lora_name"] == "style_a.safetensors"
    assert g["100"]["inputs"]["strength_model"] == 0.8
    assert g["100"]["inputs"]["model"] == ["1", 0]
    assert g["100"]["inputs"]["clip"] == ["3", 0]
    # 第二个 LoRA 串在第一个之后
    assert g["101"]["inputs"]["model"] == ["100", 0]
    assert g["101"]["inputs"]["clip"] == ["100", 1]
    # ModelSamplingFlux 消费 LoRA 链末端(而非原始 UNET)
    assert _by_type(g, "ModelSamplingFlux")["model"] == ["101", 0]
    # 文本编码消费 LoRA 链末端 CLIP
    encs = [n for n in g.values() if n["class_type"] == "CLIPTextEncode"]
    assert encs and all(e["inputs"]["clip"] == ["101", 1] for e in encs)


def test_txt2img_no_loras_keeps_baseline_graph():
    """无 LoRA 时不出现 LoraLoader,结构与旧版一致。"""
    g = build_nextgen_graph(NextgenParams(model_name=FLUX2, positive="a fox"))
    assert "LoraLoader" not in {n["class_type"] for n in g.values()}
    assert _by_type(g, "ModelSamplingFlux")["model"] == ["1", 0]
    encs = [n for n in g.values() if n["class_type"] == "CLIPTextEncode"]
    assert all(e["inputs"]["clip"] == ["3", 0] for e in encs)


def test_img2img_loras_insert_loraloader_chain():
    g = build_nextgen_img2img_graph(NextgenImg2ImgParams(
        model_name=FLUX2, image="x.png", positive="a portrait",
        loras=(LoraSpec("style_a.safetensors", 0.7),),
    ))
    assert g["100"]["class_type"] == "LoraLoader"
    assert g["100"]["inputs"]["model"] == ["1", 0]
    assert g["100"]["inputs"]["clip"] == ["3", 0]
    assert _by_type(g, "ModelSamplingFlux")["model"] == ["100", 0]
    encs = [n for n in g.values() if n["class_type"] == "CLIPTextEncode"]
    assert encs and all(e["inputs"]["clip"] == ["100", 1] for e in encs)
