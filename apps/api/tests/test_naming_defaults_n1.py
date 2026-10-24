"""Naming-spec Wave N1: config / Settings 默认值不得伪装异家族模型名或退役端口。"""
from __future__ import annotations

from app.config import Settings


def test_llm_defaults_are_dsv4_canonical():
    f = Settings.model_fields
    assert f["llm_model"].default == "deepseek-v4-flash-dspark"
    assert "DeepSeek" in f["llm_display_name"].default
    assert "Qwen" not in f["llm_display_name"].default
    assert "GLM" not in f["llm_display_name"].default
    assert f["llm_l2_model"].default == "deepseek-v4-flash-dspark"
    assert f["llm_l3_model"].default == "deepseek-v4-flash-dspark"
    proxy = f["llm_proxy_models"].default
    assert proxy.startswith("deepseek-v4-flash-dspark")


def test_vlm_and_comfy_defaults_match_live_eps():
    f = Settings.model_fields
    assert f["vlm_server_url"].default == "http://192.168.71.127:9311"
    assert f["vlm_model_id"].default == "toiv-vlm"
    assert f["comfy_workers"].default == "http://192.168.71.127:8188"
    assert ":8189" not in f["comfy_workers"].default
    ups = f["upscale_workers"].default
    assert ":8261" not in ups
    assert ":8262" in ups and ":8263" in ups
    assert f["eval_vlm_model"].default == "toiv-vlm"
    assert f["h3_base_url"].default.endswith(":8264")
    assert f["canvas_comfy_url"].default.endswith(":8188")
