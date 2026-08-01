"""llm_router 单一事实源测试(2026-08-01 P2-3)。

断言:
- resolve_llm_endpoint 四层端点全部取自 settings(与 agent/llm.py 同源);
- 改 settings 后 route_llm / list_llm_endpoints 结果跟随(不再有硬编码腐化);
- L4 NSFW 未配专用端点时回落主模型(与 chat() 的 NSFW 路由一致);
- drama refine/polish 分别读各自的配置层。
"""
from __future__ import annotations

from unittest.mock import patch

from app.config import Settings, get_settings
from app.workflows.llm_router import (
    ContentType,
    LLMLayer,
    list_llm_endpoints,
    llm_endpoints,
    resolve_llm_endpoint,
    route_llm,
)


def _custom_settings() -> Settings:
    return Settings(
        llm_base_url="http://l1.example:1000/v1/",
        llm_model="test-l1-model",
        llm_l2_base_url="http://l2.example:2000/v1/",
        llm_l2_model="test-l2-model",
        llm_l2_timeout=222.0,
        llm_l3_base_url="http://l3.example:3000/v1/",
        llm_l3_model="test-l3-model",
        llm_l3_timeout=333.0,
        llm_nsfw_base_url="http://l4.example:4000/v1/",
        llm_nsfw_model="test-l4-model",
    )


# ── 各层端点与 settings 一致 ─────────────────────────────────────────────
def test_resolve_l1_matches_settings():
    s = get_settings()
    ep = resolve_llm_endpoint("L1")
    assert ep.layer == LLMLayer.L1_DRAFT
    assert ep.base_url == s.llm_base_url.rstrip("/")
    assert ep.model_id == s.llm_model
    assert ep.timeout > 0


def test_resolve_l2_l3_match_settings():
    s = get_settings()
    l2 = resolve_llm_endpoint(LLMLayer.L2_MAIN)
    assert (l2.base_url, l2.model_id, l2.timeout) == (
        s.llm_l2_base_url.rstrip("/"), s.llm_l2_model, s.llm_l2_timeout
    )
    l3 = resolve_llm_endpoint(LLMLayer.L3_POLISH)
    assert (l3.base_url, l3.model_id, l3.timeout) == (
        s.llm_l3_base_url.rstrip("/"), s.llm_l3_model, s.llm_l3_timeout
    )


def test_resolve_l4_uses_nsfw_settings():
    s = _custom_settings()
    ep = resolve_llm_endpoint("L4", s)
    assert ep.base_url == "http://l4.example:4000/v1"  # 尾斜杠已去
    assert ep.model_id == "test-l4-model"


def test_resolve_l4_falls_back_to_primary_when_nsfw_unset():
    s = Settings(
        llm_base_url="http://l1.example:1000/v1",
        llm_model="test-l1-model",
        llm_nsfw_base_url="",
        llm_nsfw_model="",
    )
    ep = resolve_llm_endpoint("L4", s)
    assert ep.base_url == "http://l1.example:1000/v1"
    assert ep.model_id == "test-l1-model"


# ── 改 settings 后路由结果跟随(单一事实源,无硬编码) ──────────────────────
def test_route_llm_follows_settings_change(monkeypatch):
    custom = _custom_settings()
    monkeypatch.setattr("app.workflows.llm_router.get_settings", lambda: custom)

    ep = route_llm(ContentType.CHAT)  # → L1
    assert ep.model_id == "test-l1-model"
    assert ep.base_url == "http://l1.example:1000/v1"

    ep = route_llm(ContentType.MARKETING_COPY)  # → L2
    assert ep.model_id == "test-l2-model"
    assert ep.timeout == 222.0

    ep = route_llm(ContentType.SCRIPT)  # → L3
    assert ep.model_id == "test-l3-model"
    assert ep.timeout == 333.0

    ep = route_llm(ContentType.CHAT, is_nsfw=True)  # → L4
    assert ep.model_id == "test-l4-model"

    ep = route_llm(ContentType.CHAT, force_layer="L3")  # 强制层
    assert ep.model_id == "test-l3-model"


def test_llm_endpoints_snapshot_follows_settings(monkeypatch):
    custom = _custom_settings()
    monkeypatch.setattr("app.workflows.llm_router.get_settings", lambda: custom)
    endpoints = llm_endpoints()
    assert set(endpoints) == set(LLMLayer)
    assert endpoints[LLMLayer.L2_MAIN].model_id == "test-l2-model"

    listed = {e["layer"]: e for e in list_llm_endpoints()}
    assert listed["L3"]["model_id"] == "test-l3-model"
    assert listed["L3"]["timeout"] == 333.0
    assert listed["L4"]["base_url"] == "http://l4.example:4000/v1"


# ── drama refine / polish 分层配置 ────────────────────────────────────────
def test_drama_refine_and_polish_use_separate_layers():
    """refine 读 drama_refine_layer,polish 读 drama_polish_layer,互不干扰。"""
    from app.routes.drama_studio import _polish_layer, _refine_layer

    s = get_settings()
    with (
        patch.object(s, "drama_refine_layer", "L2"),
        patch.object(s, "drama_polish_layer", "L3"),
    ):
        assert _refine_layer() == "L2"
        assert _polish_layer() == "L3"


def test_drama_layer_invalid_value_falls_back_l1():
    from app.routes.drama_studio import _polish_layer, _refine_layer

    s = get_settings()
    with (
        patch.object(s, "drama_refine_layer", "L9"),
        patch.object(s, "drama_polish_layer", ""),
    ):
        assert _refine_layer() == "L1"
        assert _polish_layer() == "L1"
