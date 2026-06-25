"""抠图去背工作流构造器单测。"""
from __future__ import annotations

from app.workflows.removebg import REMBG_MODES, RemoveBgParams, build_removebg_graph


def _classes(g: dict) -> set[str]:
    return {n["class_type"] for n in g.values()}


def test_graph_has_core_rembg_nodes():
    g = build_removebg_graph(RemoveBgParams(image="a.png"))
    assert {"RemBGSession+", "ImageRemoveBackground+", "SaveImage"} <= _classes(g)


def test_wiring_and_default_model():
    g = build_removebg_graph(RemoveBgParams(image="hero.png"))
    assert g["11"]["inputs"]["image"] == "hero.png"
    assert g["12"]["inputs"]["rembg_session"] == ["10", 0]
    assert g["12"]["inputs"]["image"] == ["11", 0]
    assert g["9"]["inputs"]["images"] == ["12", 0]
    # 默认 general → u2net,且模型值含后缀(逐字)
    assert g["10"]["inputs"]["model"] == "u2net: general purpose"


def test_anime_mode_picks_isnet_anime():
    g = build_removebg_graph(RemoveBgParams(image="a.png", mode="anime"))
    assert g["10"]["inputs"]["model"] == "isnet-anime: anime illustrations"


def test_unknown_mode_falls_back_to_general():
    g = build_removebg_graph(RemoveBgParams(image="a.png", mode="bogus"))
    assert g["10"]["inputs"]["model"] == "u2net: general purpose"


def test_modes_constant_exposed():
    assert "general" in REMBG_MODES and "anime" in REMBG_MODES
