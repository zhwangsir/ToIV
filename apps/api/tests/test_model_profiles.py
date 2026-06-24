"""model_profiles 单测:v-pred 检测/插节点 + NSFW 分类(仅打标,不封锁)。

ComfyUI(.100)从沙箱不可达,全部以 graph/纯函数断言验证。
"""
from __future__ import annotations

import pytest

from app.workflows.img2img import Img2ImgParams, build_img2img_graph
from app.workflows.model_profiles import (
    VPRED_SAMPLING,
    is_nsfw,
    is_vpred,
    model_sampling_node,
    nsfw_hints,
    vpred_sampling,
)
from app.workflows.txt2img import Txt2ImgParams, build_txt2img_graph

# ---------------------------------------------------------------------------
# v-pred 检测
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "name",
    [
        "noobaiXLVpred_v10.safetensors",
        "NoobAI-XL-Vpred-v1.0.safetensors",
        "some_model_v-pred.safetensors",
        "model_v_pred_final.safetensors",
        "Foo-v-prediction.ckpt",
        "bar_v_prediction.safetensors",
        "UPPER_VPRED.safetensors",  # 大小写不敏感
    ],
)
def test_is_vpred_true(name: str):
    assert is_vpred(name) is True


@pytest.mark.parametrize(
    "name",
    [
        "DreamShaper_8_pruned.safetensors",
        "sd_xl_base_1.0.safetensors",
        "illustriousXL_v01.safetensors",  # eps illustrious,不应误判 vpred
        "animagineXL_v3.safetensors",
        "majicMIX.safetensors",
        "prediction_helper.safetensors",  # 含 prediction 但无 v 前缀
    ],
)
def test_is_vpred_false(name: str):
    assert is_vpred(name) is False


def test_vpred_sampling_profile():
    prof = vpred_sampling()
    assert prof is VPRED_SAMPLING  # 单例
    assert prof.sampling == "v_prediction"
    assert prof.zsnr is True
    assert prof.sampler == "euler"
    assert 4.0 <= prof.cfg <= 5.0


# ---------------------------------------------------------------------------
# NSFW 分类(仅打标)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "name",
    [
        "ponyDiffusionV6XL.safetensors",
        "noobaiXL_vpred.safetensors",
        "animagineXL_v3.safetensors",
        "illustriousXL_v01.safetensors",
        "realisticVisionV6.safetensors",
        "some_nsfw_model.safetensors",
        "Model_R18.safetensors",
        "hentai_diffusion.safetensors",
        "uncensored_mix.safetensors",
        "PORN_model.safetensors",  # 大小写不敏感
        "xxx_pack.safetensors",
    ],
)
def test_is_nsfw_true(name: str):
    assert is_nsfw(name) is True


@pytest.mark.parametrize(
    "name",
    [
        "DreamShaper_8_pruned.safetensors",
        "sd_xl_base_1.0.safetensors",
        "majicMIX.safetensors",
        "epicRealism.safetensors",
    ],
)
def test_is_nsfw_false(name: str):
    assert is_nsfw(name) is False


def test_nsfw_hints_default_nonempty():
    hints = nsfw_hints()
    assert "pony" in hints and "noobai" in hints and "nsfw" in hints


def test_nsfw_env_override_replaces(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("TOIV_NSFW_HINTS", "custom_brand, Another")
    # 替换:默认 pony 不再命中,自定义子串命中(大小写不敏感)
    assert is_nsfw("ponyDiffusion.safetensors") is False
    assert is_nsfw("my_CUSTOM_BRAND_model.safetensors") is True
    assert is_nsfw("another_thing.safetensors") is True


def test_nsfw_env_extra_appends(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("TOIV_NSFW_EXTRA", "studioX")
    # 追加:默认仍命中,新子串也命中
    assert is_nsfw("ponyDiffusion.safetensors") is True
    assert is_nsfw("studioX_pack.safetensors") is True


# ---------------------------------------------------------------------------
# model_sampling_node 构造器
# ---------------------------------------------------------------------------


def test_model_sampling_node_shape_and_wiring():
    nodes, ref = model_sampling_node([("4"), 0])
    assert list(nodes) == ["50"]
    node = nodes["50"]
    assert node["class_type"] == "ModelSamplingDiscrete"
    assert node["inputs"]["model"] == ["4", 0]
    assert node["inputs"]["sampling"] == "v_prediction"
    assert node["inputs"]["zsnr"] is True
    assert ref == ["50", 0]


def test_model_sampling_node_does_not_mutate_src():
    src = ["100", 0]
    nodes, ref = model_sampling_node(src)
    # 入参引用未被改动(返回新 list)
    assert src == ["100", 0]
    assert nodes["50"]["inputs"]["model"] is not src
    assert nodes["50"]["inputs"]["model"] == ["100", 0]


# ---------------------------------------------------------------------------
# txt2img:v-pred 插节点 + eps 回归
# ---------------------------------------------------------------------------


def test_txt2img_eps_graph_has_no_model_sampling():
    """非 v-pred(eps)路径:不应出现 ModelSamplingDiscrete,KSampler 直引 checkpoint。"""
    g = build_txt2img_graph(Txt2ImgParams(positive="x", ckpt_name="DreamShaper_8.safetensors"))
    assert "ModelSamplingDiscrete" not in {n["class_type"] for n in g.values()}
    assert "50" not in g
    assert g["3"]["inputs"]["model"] == ["4", 0]


def test_txt2img_vpred_inserts_model_sampling_between_ckpt_and_ksampler():
    g = build_txt2img_graph(
        Txt2ImgParams(positive="x", ckpt_name="noobaiXL_vpred_v10.safetensors")
    )
    assert g["50"]["class_type"] == "ModelSamplingDiscrete"
    # model 线:checkpoint → ModelSamplingDiscrete → KSampler
    assert g["50"]["inputs"]["model"] == ["4", 0]
    assert g["50"]["inputs"]["sampling"] == "v_prediction"
    assert g["50"]["inputs"]["zsnr"] is True
    assert g["3"]["inputs"]["model"] == ["50", 0]
    # CLIP 线不受影响(仍直引 checkpoint)
    assert g["6"]["inputs"]["clip"] == ["4", 1]
    assert g["7"]["inputs"]["clip"] == ["4", 1]


def test_txt2img_vpred_with_lora_chains_model_through_both():
    from app.workflows.lora import LoraSpec

    g = build_txt2img_graph(
        Txt2ImgParams(
            positive="x",
            ckpt_name="model_vpred.safetensors",
            loras=(LoraSpec("style.safetensors", 0.7),),
        )
    )
    # LoRA 接 checkpoint;ModelSamplingDiscrete 接 LoRA 末端;KSampler 接 vpred 节点
    assert g["100"]["inputs"]["model"] == ["4", 0]
    assert g["50"]["inputs"]["model"] == ["100", 0]
    assert g["3"]["inputs"]["model"] == ["50", 0]
    # CLIP 仍走 LoRA 链末端(不经 vpred 节点)
    assert g["6"]["inputs"]["clip"] == ["100", 1]


def test_txt2img_eps_graph_byte_identical_to_baseline():
    """eps 路径回归:插节点改动不得影响非 v-pred 图(逐键比对)。"""
    p = Txt2ImgParams(positive="cat", negative="blur", ckpt_name="DreamShaper_8.safetensors", seed=1)
    g = build_txt2img_graph(p)
    assert set(g) == {"3", "4", "5", "6", "7", "8", "9"}


# ---------------------------------------------------------------------------
# img2img:v-pred 插节点 + eps 回归
# ---------------------------------------------------------------------------


def test_img2img_eps_graph_has_no_model_sampling():
    g = build_img2img_graph(
        Img2ImgParams(positive="x", image="in.png", ckpt_name="DreamShaper_8.safetensors")
    )
    assert "ModelSamplingDiscrete" not in {n["class_type"] for n in g.values()}
    assert "50" not in g
    assert g["3"]["inputs"]["model"] == ["4", 0]


def test_img2img_vpred_inserts_model_sampling():
    g = build_img2img_graph(
        Img2ImgParams(positive="x", image="in.png", ckpt_name="noobai_vpred.safetensors")
    )
    assert g["50"]["class_type"] == "ModelSamplingDiscrete"
    assert g["50"]["inputs"]["model"] == ["4", 0]
    assert g["3"]["inputs"]["model"] == ["50", 0]
    # img2img 专有节点不受影响
    assert g["11"]["class_type"] == "VAEEncode"
    assert g["3"]["inputs"]["latent_image"] == ["11", 0]
