"""放大工作流构造器单测。"""
from __future__ import annotations

from app.workflows.upscale import UPSCALE_MODELS, UpscaleParams, build_upscale_graph


def _classes(g: dict) -> set[str]:
    return {n["class_type"] for n in g.values()}


def test_graph_has_core_upscale_nodes():
    g = build_upscale_graph(UpscaleParams(image="src.png"))
    cls = _classes(g)
    assert "UpscaleModelLoader" in cls
    assert "ImageUpscaleWithModel" in cls
    assert "SaveImage" in cls


def test_loader_and_image_wired_into_upscale():
    g = build_upscale_graph(UpscaleParams(image="hero.png", model_name=UPSCALE_MODELS[1]))
    assert g["10"]["inputs"]["model_name"] == UPSCALE_MODELS[1]
    assert g["11"]["inputs"]["image"] == "hero.png"
    up = g["12"]["inputs"]
    assert up["upscale_model"] == ["10", 0]
    assert up["image"] == ["11", 0]


def test_native_4x_skips_scaleby():
    g = build_upscale_graph(UpscaleParams(image="a.png", scale=4.0))
    assert "ImageScaleBy" not in _classes(g)
    # SaveImage 直接取放大节点输出
    assert g["9"]["inputs"]["images"] == ["12", 0]


def test_non_native_scale_inserts_scaleby():
    g = build_upscale_graph(UpscaleParams(image="a.png", scale=2.0))
    assert "ImageScaleBy" in _classes(g)
    sb = g["13"]["inputs"]
    assert sb["image"] == ["12", 0]
    # 2x 目标 / 4x 原生 = 0.5
    assert abs(sb["scale_by"] - 0.5) < 1e-6
    assert g["9"]["inputs"]["images"] == ["13", 0]


def test_returns_new_dict_each_call():
    p = UpscaleParams(image="a.png")
    assert build_upscale_graph(p) is not build_upscale_graph(p)
