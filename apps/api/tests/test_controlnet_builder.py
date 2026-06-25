"""ControlNet 工作流构造器单测(ComfyUI 不可达,纯 graph 断言)。"""
import pytest

from app.workflows.controlnet import (
    CONTROL_TYPES,
    ControlNetParams,
    build_controlnet_graph,
    controlnet_model_name,
    is_sdxl,
)
from app.workflows.lora import LoraSpec


# --------------------------------------------------------------------------
# SD1.5 canny:核心链路 + 接线 + 模型名匹配
# --------------------------------------------------------------------------


def test_canny_sd15_has_loader_apply_and_preprocessor():
    g = build_controlnet_graph(
        ControlNetParams(positive="x", image="ctrl.png", control_type="canny")
    )
    class_types = {n["class_type"] for n in g.values()}
    assert "ControlNetLoader" in class_types
    assert "ControlNetApplyAdvanced" in class_types
    assert "CannyEdgePreprocessor" in class_types
    # SD1.5 不应出现 union 专用节点
    assert "SetUnionControlNetType" not in class_types


def test_canny_sd15_full_chain():
    g = build_controlnet_graph(
        ControlNetParams(positive="x", image="ctrl.png", control_type="canny")
    )
    assert {n["class_type"] for n in g.values()} == {
        "KSampler",
        "CheckpointLoaderSimple",
        "EmptyLatentImage",
        "CLIPTextEncode",
        "LoadImage",
        "CannyEdgePreprocessor",
        "ControlNetLoader",
        "ControlNetApplyAdvanced",
        "VAEDecode",
        "SaveImage",
    }


def test_canny_sd15_model_name_matches():
    g = build_controlnet_graph(
        ControlNetParams(positive="x", image="ctrl.png", control_type="canny")
    )
    loader = next(n for n in g.values() if n["class_type"] == "ControlNetLoader")
    assert loader["inputs"]["control_net_name"] == "control_v11p_sd15_canny_fp16.safetensors"


def test_loadimage_uses_uploaded_filename():
    g = build_controlnet_graph(
        ControlNetParams(positive="x", image="my_control.png", control_type="canny")
    )
    load = next(n for n in g.values() if n["class_type"] == "LoadImage")
    assert load["inputs"]["image"] == "my_control.png"


def test_preprocessor_consumes_loadimage_output():
    g = build_controlnet_graph(
        ControlNetParams(positive="x", image="ctrl.png", control_type="canny")
    )
    load_id = next(k for k, n in g.items() if n["class_type"] == "LoadImage")
    pre = next(n for n in g.values() if n["class_type"] == "CannyEdgePreprocessor")
    assert pre["inputs"]["image"] == [load_id, 0]


def test_apply_advanced_wiring():
    """ControlNetApplyAdvanced 必填项接线正确:正负条件 + control_net + 预处理图。"""
    g = build_controlnet_graph(
        ControlNetParams(
            positive="x",
            image="ctrl.png",
            control_type="canny",
            strength=0.6,
            start_percent=0.1,
            end_percent=0.9,
        )
    )
    apply_id, apply = next(
        (k, n) for k, n in g.items() if n["class_type"] == "ControlNetApplyAdvanced"
    )
    loader_id = next(k for k, n in g.items() if n["class_type"] == "ControlNetLoader")
    pre_id = next(k for k, n in g.items() if n["class_type"] == "CannyEdgePreprocessor")
    pos_id = next(
        k
        for k, n in g.items()
        if n["class_type"] == "CLIPTextEncode" and n["inputs"]["text"] == "x"
    )
    ins = apply["inputs"]
    # 必填字段齐全
    assert set(ins) >= {
        "positive",
        "negative",
        "control_net",
        "image",
        "strength",
        "start_percent",
        "end_percent",
    }
    assert ins["positive"] == [pos_id, 0]
    assert ins["control_net"] == [loader_id, 0]  # SD1.5 直引 loader
    assert ins["image"] == [pre_id, 0]  # 接预处理图,不接原图
    assert ins["strength"] == 0.6
    assert ins["start_percent"] == 0.1
    assert ins["end_percent"] == 0.9


def test_ksampler_consumes_apply_advanced_conditioning():
    g = build_controlnet_graph(
        ControlNetParams(positive="x", image="ctrl.png", control_type="canny")
    )
    apply_id = next(
        k for k, n in g.items() if n["class_type"] == "ControlNetApplyAdvanced"
    )
    ks = next(n for n in g.values() if n["class_type"] == "KSampler")
    assert ks["inputs"]["positive"] == [apply_id, 0]
    assert ks["inputs"]["negative"] == [apply_id, 1]


def test_decode_and_save_chain():
    g = build_controlnet_graph(
        ControlNetParams(positive="x", image="ctrl.png", control_type="canny")
    )
    ks_id = next(k for k, n in g.items() if n["class_type"] == "KSampler")
    dec_id, dec = next(
        (k, n) for k, n in g.items() if n["class_type"] == "VAEDecode"
    )
    save = next(n for n in g.values() if n["class_type"] == "SaveImage")
    assert dec["inputs"]["samples"] == [ks_id, 0]
    assert save["inputs"]["images"] == [dec_id, 0]


# --------------------------------------------------------------------------
# 其它 SD1.5 控制类型 → AIO_Preprocessor + 对应模型名
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("ctype", "expected_model", "expected_preproc"),
    [
        ("depth", "control_v11f1p_sd15_depth_fp16.safetensors", "DepthAnythingV2Preprocessor"),
        ("lineart", "control_v11p_sd15_lineart_fp16.safetensors", "LineArtPreprocessor"),
        ("openpose", "control_v11p_sd15_openpose_fp16.safetensors", "OpenposePreprocessor"),
    ],
)
def test_non_canny_uses_aio_preprocessor_and_correct_model(
    ctype, expected_model, expected_preproc
):
    g = build_controlnet_graph(
        ControlNetParams(positive="x", image="ctrl.png", control_type=ctype)
    )
    aio = next(n for n in g.values() if n["class_type"] == "AIO_Preprocessor")
    assert aio["inputs"]["preprocessor"] == expected_preproc
    assert "CannyEdgePreprocessor" not in {n["class_type"] for n in g.values()}
    loader = next(n for n in g.values() if n["class_type"] == "ControlNetLoader")
    assert loader["inputs"]["control_net_name"] == expected_model


# --------------------------------------------------------------------------
# SDXL union 分支:union 模型 + SetUnionControlNetType
# --------------------------------------------------------------------------


def test_sdxl_uses_union_model_and_set_union_type():
    g = build_controlnet_graph(
        ControlNetParams(
            positive="x",
            image="ctrl.png",
            control_type="canny",
            ckpt_name="someSDXLModel.safetensors",
        )
    )
    loader = next(n for n in g.values() if n["class_type"] == "ControlNetLoader")
    assert loader["inputs"]["control_net_name"] == (
        "controlnet-union-sdxl-1.0-promax.safetensors"
    )
    union_id, union = next(
        (k, n) for k, n in g.items() if n["class_type"] == "SetUnionControlNetType"
    )
    loader_id = next(k for k, n in g.items() if n["class_type"] == "ControlNetLoader")
    assert union["inputs"]["control_net"] == [loader_id, 0]
    # apply 的 control_net 应接 union 输出,而非 loader 直引
    apply = next(n for n in g.values() if n["class_type"] == "ControlNetApplyAdvanced")
    assert apply["inputs"]["control_net"] == [union_id, 0]


def test_is_sdxl_detection():
    assert is_sdxl("anySDXL_v1.safetensors")
    assert is_sdxl("ponyDiffusionXL.safetensors")
    assert not is_sdxl("DreamShaper_8_pruned.safetensors")


def test_controlnet_model_name_picks_by_ckpt():
    assert (
        controlnet_model_name("canny", "DreamShaper_8_pruned.safetensors")
        == "control_v11p_sd15_canny_fp16.safetensors"
    )
    assert (
        controlnet_model_name("depth", "myXLckpt.safetensors")
        == "controlnet-union-sdxl-1.0-promax.safetensors"
    )


# --------------------------------------------------------------------------
# 校验 / 不可变 / LoRA 叠加
# --------------------------------------------------------------------------


def test_invalid_control_type_rejected():
    with pytest.raises(ValueError):
        ControlNetParams(positive="x", image="ctrl.png", control_type="scribble")


def test_all_supported_control_types_build():
    for ctype in CONTROL_TYPES:
        g = build_controlnet_graph(
            ControlNetParams(positive="x", image="ctrl.png", control_type=ctype)
        )
        assert "ControlNetApplyAdvanced" in {n["class_type"] for n in g.values()}


def test_builder_returns_new_dict_each_call():
    p = ControlNetParams(positive="x", image="ctrl.png", control_type="canny", seed=42)
    assert build_controlnet_graph(p) is not build_controlnet_graph(p)
    assert build_controlnet_graph(p) == build_controlnet_graph(p)


def test_lora_chain_feeds_model_and_clip():
    g = build_controlnet_graph(
        ControlNetParams(
            positive="x",
            image="ctrl.png",
            control_type="canny",
            loras=(LoraSpec(name="style.safetensors", weight=0.7),),
        )
    )
    loaders = [n for n in g.values() if n["class_type"] == "LoraLoader"]
    assert len(loaders) == 1
    lora_id = next(k for k, n in g.items() if n["class_type"] == "LoraLoader")
    ks = next(n for n in g.values() if n["class_type"] == "KSampler")
    assert ks["inputs"]["model"] == [lora_id, 0]
