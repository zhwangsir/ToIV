"""市场更深参数:LoRA / resolution_target 真注入;segment_extend 明确不接。"""
from __future__ import annotations

import copy

import pytest

from app.services.app_deep_knobs import (
    RESERVED_DEEP_KEYS,
    apply_app_loras,
    enrich_params_schema,
    normalize_resolution_target_value,
    parse_loras_value,
    segment_extend_unsupported_reason,
    supports_market_loras,
    supports_market_resolution_target,
)
from app.workflows.h3_video import build_h3_t2v_graph
from app.workflows.h3_video import H3T2VParams
from app.workflows.lora import LoraSpec


def test_reserved_keys_and_segment_extend_gate():
    assert "loras" in RESERVED_DEEP_KEYS
    assert "resolution_target" in RESERVED_DEEP_KEYS
    assert "segment_extend" not in RESERVED_DEEP_KEYS
    reason = segment_extend_unsupported_reason()
    assert "segment_extend" in reason
    assert "假 UI" in reason or "不提供" in reason


def test_supports_families():
    assert supports_market_loras("h3-t2v")
    assert supports_market_loras("h3-nsfw-i2v")
    assert supports_market_loras("ltx-txt2video")
    assert not supports_market_loras("longcat-t2v")
    assert not supports_market_loras("txt2img-basic")
    assert supports_market_resolution_target("h3-t2v")
    assert supports_market_resolution_target("longcat-t2v")
    assert supports_market_resolution_target("wan-nsfw-i2v")
    assert supports_market_resolution_target("x", output_kind="video")


def test_parse_loras_value_modes():
    assert parse_loras_value(None) == ()
    assert parse_loras_value([]) == ()
    specs = parse_loras_value([{"name": "a.safetensors", "strength": 0.7}])
    assert specs == (LoraSpec(name="a.safetensors", weight=0.7),)
    with pytest.raises(ValueError, match="数组"):
        parse_loras_value("bad")
    with pytest.raises(ValueError, match="最多"):
        parse_loras_value([{"name": f"l{i}.safetensors", "strength": 0.6} for i in range(4)])


def test_normalize_resolution_target():
    assert normalize_resolution_target_value("") is None
    assert normalize_resolution_target_value("1080p") == "1080p"
    with pytest.raises(ValueError):
        normalize_resolution_target_value("999p")


def test_apply_h3_loras_injects_loader_nodes():
    graph = build_h3_t2v_graph(H3T2VParams(positive="rain"))
    # t2v params may not need image - check signature
    before = set(graph.keys())
    meta = apply_app_loras(
        graph,
        "h3-t2v",
        {"loras": [{"name": "cxy_kiss_lora_h3_v01_step1500.safetensors", "strength": 0.6}]},
    )
    assert meta["applied"] is True and meta["family"] == "h3" and meta["count"] == 1
    added = set(graph.keys()) - before
    assert added
    loaders = [graph[k] for k in added if graph[k].get("class_type") == "LoraLoaderModelOnly"]
    assert loaders and loaders[0]["inputs"]["lora_name"].endswith(".safetensors")
    # consumers rewired
    assert graph["16"]["inputs"]["model"][0] in added
    assert graph["9"]["inputs"]["model"][0] in added


def test_apply_h3_loras_empty_noop():
    graph = build_h3_t2v_graph(H3T2VParams(positive="x"))
    snap = copy.deepcopy(graph)
    meta = apply_app_loras(graph, "h3-t2v", {"loras": []})
    assert meta["applied"] is False
    assert graph == snap


def test_apply_ltx_loras_on_minimal_graph():
    graph = {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": "u.safetensors"}},
        "2": {"class_type": "LTXVGemmaCLIPModelLoader", "inputs": {}},
        "4": {"class_type": "CLIPTextEncode", "inputs": {"text": "p", "clip": ["2", 0]}},
        "5": {"class_type": "CLIPTextEncode", "inputs": {"text": "n", "clip": ["2", 0]}},
        "8": {"class_type": "KSampler", "inputs": {"model": ["1", 0], "seed": 1}},
    }
    meta = apply_app_loras(
        graph,
        "ltx-txt2video",
        {"loras": [{"name": "cam.safetensors", "strength": 0.8}]},
    )
    assert meta["applied"] is True and meta["family"] == "ltx"
    assert graph["8"]["inputs"]["model"][0] != "1"
    assert graph["4"]["inputs"]["clip"][0] != "2"


def test_enrich_params_schema_adds_deep_knobs():
    schema = [{"key": "positive", "label": "提示词", "type": "textarea", "default": ""}]
    enriched = enrich_params_schema("h3-t2v", schema)
    keys = [p["key"] for p in enriched]
    assert "loras" in keys and "resolution_target" in keys
    assert "segment_extend" not in keys
    loras = next(p for p in enriched if p["key"] == "loras")
    assert loras["type"] == "loras"
    assert loras["default"] == []
    assert isinstance(loras.get("options"), list)

    # 不重复追加
    again = enrich_params_schema("h3-t2v", enriched)
    assert sum(1 for p in again if p["key"] == "loras") == 1

    longcat = enrich_params_schema("longcat-t2v", schema)
    assert "loras" not in [p["key"] for p in longcat]
    assert "resolution_target" in [p["key"] for p in longcat]


def test_seed_h3_ltx_schemas_include_deep_knobs():
    from app.services.app_seed import _build_specs

    specs = {s["id"]: s for s in _build_specs()}
    h3_keys = [p["key"] for p in specs["h3-t2v"]["params_schema"]]
    assert "loras" in h3_keys and "resolution_target" in h3_keys
    assert "segment_extend" not in h3_keys
    ltx_keys = [p["key"] for p in specs["ltx-txt2video"]["params_schema"]]
    assert "loras" in ltx_keys and "resolution_target" in ltx_keys


def test_validate_params_accepts_reserved_deep_keys():
    from fastapi import HTTPException

    from app.routes.apps import _validate_params

    schema = [{"key": "positive", "label": "提示词", "type": "textarea", "default": ""}]
    out = _validate_params(
        schema,
        {
            "positive": "rain",
            "loras": [{"name": "a.safetensors", "strength": 0.6}],
            "resolution_target": "720p",
        },
    )
    assert out["loras"][0]["name"] == "a.safetensors"
    assert out["resolution_target"] == "720p"
    try:
        _validate_params(schema, {"positive": "x", "resolution_target": "999p"})
        raise AssertionError("expected 422")
    except HTTPException as e:
        assert e.status_code == 422
