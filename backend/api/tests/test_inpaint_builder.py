"""局部重绘(文字定向 Inpaint)工作流构造器单测。"""
from __future__ import annotations

from app.workflows.inpaint import InpaintParams, build_inpaint_graph


def _classes(g: dict) -> set[str]:
    return {n["class_type"] for n in g.values()}


def _p(**kw):
    base = dict(image="a.png", target="the hat", positive="a red cap")
    base.update(kw)
    return InpaintParams(**base)


def test_graph_has_core_inpaint_nodes():
    g = build_inpaint_graph(_p())
    assert {
        "DownloadAndLoadFlorence2Model",
        "Florence2Run",
        "VAEEncodeForInpaint",
        "KSampler",
        "SaveImage",
    } <= _classes(g)


def test_florence_segments_target_into_mask():
    g = build_inpaint_graph(_p(target="the sky"))
    fr = g["31"]["inputs"]
    assert fr["text_input"] == "the sky"
    assert fr["task"] == "referring_expression_segmentation"
    # VAEEncodeForInpaint 的 mask 取 Florence2Run 的 mask 输出(index 1)
    assert g["32"]["inputs"]["mask"] == ["31", 1]
    assert g["32"]["inputs"]["pixels"] == ["11", 0]


def test_ksampler_uses_inpaint_latent_and_prompt():
    g = build_inpaint_graph(_p(positive="a golden crown", denoise=0.7))
    ks = g["3"]["inputs"]
    assert ks["latent_image"] == ["32", 0]
    assert ks["denoise"] == 0.7
    assert g["6"]["inputs"]["text"] == "a golden crown"


def test_non_vpred_model_direct():
    g = build_inpaint_graph(_p(ckpt_name="DreamShaper_8_pruned.safetensors"))
    assert "ModelSamplingDiscrete" not in _classes(g)
    assert g["3"]["inputs"]["model"] == ["4", 0]


def test_vpred_inserts_model_sampling():
    g = build_inpaint_graph(_p(ckpt_name="noobaiXL_vpred10.safetensors"))
    assert "ModelSamplingDiscrete" in _classes(g)
    assert g["3"]["inputs"]["model"] != ["4", 0]
