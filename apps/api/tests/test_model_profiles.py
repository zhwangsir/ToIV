"""model_profiles 单测:v-pred 检测/插节点 + NSFW 分类(仅打标,不封锁)。

ComfyUI(.100)从沙箱不可达,全部以 graph/纯函数断言验证。
"""
from __future__ import annotations

import pytest

from app.workflows.img2img import Img2ImgParams, build_img2img_graph
from app.workflows.model_profiles import (
    VPRED_SAMPLING,
    fit_resolution,
    is_nsfw,
    is_sdxl,
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
        "ponyDiffusionV6XL.safetensors",
        "noobaiXL_vpred.safetensors",
        "animagineXL_v3.safetensors",
        "illustriousXL_v01.safetensors",
        "realisticVisionV6.safetensors",
        "waiIllustriousSDXL_v170.safetensors",
    ],
)
def test_is_nsfw_false(name: str):
    assert is_nsfw(name) is False


def test_nsfw_hints_default_nonempty():
    hints = nsfw_hints()
    assert "nsfw" in hints and "10eros" in hints
    assert "pony" not in hints


def test_nsfw_env_override_replaces(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("TOIV_NSFW_HINTS", "custom_brand, Another")
    # 替换:默认 pony 不再命中,自定义子串命中(大小写不敏感)
    assert is_nsfw("ponyDiffusion.safetensors") is False
    assert is_nsfw("my_CUSTOM_BRAND_model.safetensors") is True
    assert is_nsfw("another_thing.safetensors") is True


def test_nsfw_env_extra_appends(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("TOIV_NSFW_EXTRA", "studioX")
    # 追加:默认仍命中,新子串也命中
    assert is_nsfw("hassakuXL.safetensors") is True
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


# ── SDXL 架构判定 + 分辨率档(漫剧出图质量)────────────────────────────


@pytest.mark.parametrize(
    "name",
    [
        "animagineXL40.safetensors",
        "noobaiXL_vpred10.safetensors",
        "ponyDiffusionV6XL_v6.safetensors",
        "prefectIllustriousXL_40.safetensors",
        "sd_xl_base_1.0.safetensors",
    ],
)
def test_is_sdxl_true_for_xl_models(name):
    assert is_sdxl(name) is True


@pytest.mark.parametrize(
    "name",
    [
        "DreamShaper_8_pruned.safetensors",
        "GhostMix_V2.0.safetensors",
        "majicMIX_realistic_v7.safetensors",
        "v1-5-pruned-emaonly-fp16.safetensors",
    ],
)
def test_is_sdxl_false_for_sd15(name):
    assert is_sdxl(name) is False


def test_fit_resolution_sdxl_targets_1mp_keeps_aspect():
    w, h = fit_resolution("animagineXL40.safetensors", 768, 432)
    # 16:9 SDXL ≈ 1MP,长边显著大于 SD1.5 档
    assert w > h and w >= 1200
    assert abs((w / h) - (768 / 432)) < 0.05
    assert w % 8 == 0 and h % 8 == 0


def test_fit_resolution_sd15_caps_long_side():
    w, h = fit_resolution("DreamShaper_8_pruned.safetensors", 768, 432)
    # SD1.5 长边封顶,避免高分辨率出双头/重复
    assert max(w, h) <= 896
    assert w > h
    assert w % 8 == 0 and h % 8 == 0


def test_fit_resolution_square_sdxl_is_1024():
    w, h = fit_resolution("ponyDiffusionV6XL_v6.safetensors", 512, 512)
    assert w == 1024 and h == 1024


# ---------------------------------------------------------------------------
# 次世代族(flux2/flux/qwen_image/z_image)分辨率预算 ~1.37MP —— 2026-08-10 修复
# 背景:原 1MP 预算下 1024×1344 纵向请求被压到 896×1168,低于质量门 1024² 阈值。
# 修复:次世代族预算提至 1024×1360,使 3:4 纵向也能达到 ≥1024 双维度。
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "name",
    [
        "flux2_dev_fp8mixed.safetensors",
        "flux1-dev-fp8.safetensors",
        "qwen_image_fp8.safetensors",
        "z_image_turbo_fp8.safetensors",
        "z_image_bf16.safetensors",
    ],
)
def test_fit_resolution_nextgen_portrait_both_dims_above_1024(name: str):
    """次世代模型 3:4 纵向构图(1024×1344)须产出 ≥1024 双维度,过质量门。"""
    w, h = fit_resolution(name, 1024, 1344)
    assert w >= 1024 and h >= 1024, f"{name}: {w}×{h} 未达 1024²"
    assert w % 8 == 0 and h % 8 == 0
    # 宽高比保持 ~3:4(0.75±0.05)
    assert abs((w / h) - (1024 / 1344)) < 0.05


def test_fit_resolution_nextgen_square_above_1024():
    """次世代模型方形构图须 ≥1024×1024(预算上调后应 >1024)。"""
    w, h = fit_resolution("flux2_dev_fp8mixed.safetensors", 512, 512)
    assert w >= 1024 and h >= 1024
    assert w == h  # 方形保持


def test_fit_resolution_nextgen_landscape_both_dims_above_1024():
    """次世代模型 4:3 横向构图(1344×1024)也须 ≥1024 双维度。"""
    w, h = fit_resolution("flux2_dev_fp8mixed.safetensors", 1344, 1024)
    assert w >= 1024 and h >= 1024, f"{w}×{h} 未达 1024²"
    assert w % 8 == 0 and h % 8 == 0


def test_fit_resolution_sdxl_still_1mp_not_affected():
    """回归:SDXL 族预算不变(1MP),次世代上调不影响传统族。"""
    w, h = fit_resolution("animagineXL40.safetensors", 1024, 1344)
    # SDXL 1MP 下 3:4 纵向 → ~896×1168(低于 1024,SDXL 原生限制)
    assert w < 1024 or h < 1024, "SDXL 不应被次世代上调波及"
    assert w * h <= 1024 * 1024 + 8192  # 允许 snap 误差


# ---------------------------------------------------------------------------
# 新增 NSFW 底模(civitai 调研批,2026-07)—— 分类/族/采样正确性
# 确保:① 全部归 NSFW 档(不泄漏到主站)② 架构族正确(→ 分辨率/采样档)
#      ③ vpred 模型触发 v_prediction 注入
# ---------------------------------------------------------------------------

from app.workflows.model_profiles import detect_model_family, is_nextgen  # noqa: E402


@pytest.mark.parametrize(
    "name",
    [
        "hassakuXLIllustrious_v34.safetensors",
        "waiSHUFFLENOOB_vPred04.safetensors",
        "autismmixSDXL_autismmixPony.safetensors",
        "lustifySDXLNSFW_zenithV9.safetensors",
    ],
)
def test_new_nsfw_checkpoints_tagged(name: str):
    """新下载的 NSFW 底模必须被判为 NSFW → 只在 /nsfw 专区可见,不泄漏主站。"""
    assert is_nsfw(name) is True


@pytest.mark.parametrize(
    "name,family",
    [
        ("waiIllustriousSDXL_v170.safetensors", "sdxl_anime"),
        ("hassakuXLIllustrious_v34.safetensors", "sdxl_anime"),
        ("waiSHUFFLENOOB_vPred04.safetensors", "sdxl_anime"),  # wai → 动漫族
        ("cyberrealisticPony_v180Coreshift.safetensors", "pony"),
        ("autismmixSDXL_autismmixPony.safetensors", "pony"),
        ("ponyRealism_V22.safetensors", "pony"),
        ("lustifySDXLNSFW_zenithV9.safetensors", "sdxl"),  # 纯SDXL写实,自然语言
        ("cyberrealistic_v120.safetensors", "sdxl_anime"),  # 修:曾误判 sd15(0.4MP 崩)
        ("nova3DCGXL_ilV90.safetensors", "sdxl"),
    ],
)
def test_new_nsfw_checkpoint_family(name: str, family: str):
    """架构族决定分辨率档(SDXL≈1MP)与采样/提示词方言。无一可落 sd15(否则 640px 崩)。"""
    assert detect_model_family(name) == family
    assert family != "sd15"
    # 均非次世代 UNET 图,走传统 checkpoint 图
    assert is_nextgen(name) is False


@pytest.mark.parametrize(
    "name,vpred",
    [
        ("waiSHUFFLENOOB_vPred04.safetensors", True),
        ("waiIllustriousSDXL_v170.safetensors", False),
        ("cyberrealisticPony_v180Coreshift.safetensors", False),
        ("lustifySDXLNSFW_zenithV9.safetensors", False),
    ],
)
def test_new_nsfw_vpred_flag(name: str, vpred: bool):
    """vpred 底模须触发 ModelSamplingDiscrete(v_prediction),eps 底模不触发。"""
    assert is_vpred(name) is vpred


def test_cyberillustrious_gets_sdxl_resolution():
    """回归:cyberrealistic_v120(Illustrious 基,文件名无 xl/illustrious)须走 1MP 档而非 640px。"""
    w, h = fit_resolution("cyberrealistic_v120.safetensors", 512, 512)
    assert w >= 900 and h >= 900  # ~1024²,非 sd15 的 640²
