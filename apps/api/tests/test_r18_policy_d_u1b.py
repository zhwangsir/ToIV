"""D-U1=B R18 统一口径不变量(待办#9)。

对照:`docs/ops/UI_UNIFY_FUSION_PLAN_20261014.md` §4 + `app/r18_policy.py`。
不生成任何成人内容;只锁门控/fail-closed/未成年硬阻断与策略常量。
"""
from __future__ import annotations

from datetime import date, timedelta
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app import nsfw_ctx, r18_policy
from app.main import app
from app.nsfw_ctx import is_underage, job_nsfw_from_intent, nsfw_allowed, nsfw_intent_var


def test_policy_constants_encode_d_u1b():
    assert r18_policy.POLICY_ID == "D-U1=B"
    assert r18_policy.CANVAS_IS_SOLE_MAIN_UI is True
    assert r18_policy.WEB_INDEPENDENT_NSFW_ZONE_RETIRED is True
    assert r18_policy.ACCOUNT_FLAG_NO_LONGER_ALLOWS is True
    assert r18_policy.FAIL_CLOSED_WITHOUT_HEADER is False  # 2026-10-26:拦截改前端
    assert r18_policy.UNDERAGE_HARD_BLOCK is True
    assert r18_policy.REQUEST_HEADER == "X-NSFW"
    assert r18_policy.REQUEST_HEADER_VALUE == "1"


def test_nsfw_ctx_docs_align_with_canvas_not_legacy_zone_only():
    """旧口径『仅 /nsfw 专页』已废;模块文档须指向请求级头 + canvas 门控。"""
    doc = nsfw_ctx.__doc__ or ""
    assert "X-NSFW" in doc
    assert "D-U1" in doc or "canvas" in doc.lower()
    assert "仅** /nsfw" not in doc
    assert "仅 /nsfw 专页通过" not in doc


def test_fail_closed_without_header():
    token = nsfw_intent_var.set(False)
    try:
        assert nsfw_allowed(None) is False
        assert nsfw_allowed(SimpleNamespace(birthdate=None)) is False
    finally:
        nsfw_intent_var.reset(token)


def test_allowed_with_request_intent():
    token = nsfw_intent_var.set(True)
    try:
        assert nsfw_allowed(None) is True
    finally:
        nsfw_intent_var.reset(token)


def test_underage_readable_but_nsfw_allowed_is_header_only():
    """未成年判定仍可读；nsfw_allowed 仅看头（后端不拦，前端守卫执行硬阻断）。"""
    minor = SimpleNamespace(birthdate=date.today() - timedelta(days=365 * 12))
    assert is_underage(minor) is True
    token = nsfw_intent_var.set(True)
    try:
        assert nsfw_allowed(minor) is True  # 有头即 True；不在后端因未成年否决
    finally:
        nsfw_intent_var.reset(token)


def test_job_nsfw_from_intent_tags_without_403():
    """显式意图打标；无头不再 403（API 直调可绕过，本地自用接受）。"""
    token = nsfw_intent_var.set(False)
    try:
        assert job_nsfw_from_intent(None, explicit=False) is False
        assert job_nsfw_from_intent(None, explicit=True) is True  # 不 raise
    finally:
        nsfw_intent_var.reset(token)

    token = nsfw_intent_var.set(True)
    try:
        assert job_nsfw_from_intent(None, explicit=True) is True
        assert job_nsfw_from_intent(None, explicit=False) is False
    finally:
        nsfw_intent_var.reset(token)


def test_middleware_source_wires_x_nsfw_header():
    src = Path(__file__).resolve().parents[1].joinpath("app/main.py").read_text(encoding="utf-8")
    assert "x-nsfw" in src.lower()
    assert "nsfw_intent_var" in src
    assert "D-U1" in src or "X-NSFW" in src


def test_http_roundtrip_header_sets_intent():
    """中间件:无头 fail-closed;X-NSFW:1 → nsfw_allowed True。"""

    @app.get("/__toiv_r18_probe_d_u1b")
    def probe():
        return {"allowed": nsfw_allowed(None)}

    try:
        with TestClient(app) as c:
            r0 = c.get("/__toiv_r18_probe_d_u1b")
            assert r0.status_code == 200 and r0.json()["allowed"] is False
            r1 = c.get("/__toiv_r18_probe_d_u1b", headers={"X-NSFW": "1"})
            assert r1.status_code == 200 and r1.json()["allowed"] is True
    finally:
        app.router.routes = [
            r
            for r in app.router.routes
            if getattr(r, "path", None) != "/__toiv_r18_probe_d_u1b"
        ]


def test_ltx_gate_is_noop_without_header():
    from app.routes.video import _gate_ltx_nsfw

    token = nsfw_intent_var.set(False)
    try:
        assert _gate_ltx_nsfw(SimpleNamespace(birthdate=None)) is None
    finally:
        nsfw_intent_var.reset(token)


def test_redline_is_decision_ssot():
    """app.redline 为唯一决策真源;旧模块为同一对象的薄 re-export。"""
    from app import redline

    assert redline.POLICY_ID == "D-U1=B"
    assert redline.REQUEST_HEADER == "X-NSFW"
    assert redline.REQUEST_HEADER_VALUE == "1"
    assert redline.FAIL_CLOSED is False  # 2026-10-26 frontend guard
    assert redline.FAIL_CLOSED_WITHOUT_HEADER is False
    assert redline.UNDERAGE_HARD_BLOCK is True
    assert r18_policy.POLICY_ID is redline.POLICY_ID or r18_policy.POLICY_ID == redline.POLICY_ID
    assert nsfw_ctx.nsfw_allowed is redline.nsfw_allowed
    assert nsfw_ctx.nsfw_intent_var is redline.nsfw_intent_var
    assert nsfw_ctx.is_underage is redline.is_underage
    assert nsfw_ctx.job_nsfw_from_intent is redline.job_nsfw_from_intent


def test_sfw_main_path_usable_without_x_nsfw_header():
    """无 X-NSFW 时 fail-closed 且主站 health/models 仍可用(SFW 不依赖红线开关)。"""
    from app.redline import nsfw_allowed as redline_nsfw_allowed

    @app.get("/__toiv_r18_sfw_probe")
    def probe():
        return {"allowed": redline_nsfw_allowed(None)}

    try:
        with TestClient(app) as c:
            # 无头:不得放行 R18
            r0 = c.get("/__toiv_r18_sfw_probe")
            assert r0.status_code == 200 and r0.json()["allowed"] is False
            # 主站健康与模型列表在无头时仍 200(SFW 路径完整)
            h = c.get("/api/health")
            assert h.status_code == 200
            m = c.get("/api/models")
            # models 可能要鉴权;至少不得因缺 X-NSFW 而 403/5xx
            assert m.status_code != 403, m.text
            assert m.status_code < 500
    finally:
        app.router.routes = [
            r
            for r in app.router.routes
            if getattr(r, "path", None) != "/__toiv_r18_sfw_probe"
        ]


def test_require_nsfw_context_is_noop():
    from app.redline import require_nsfw_context

    token = nsfw_intent_var.set(False)
    try:
        assert require_nsfw_context(None) is None
    finally:
        nsfw_intent_var.reset(token)


def test_backend_runtime_gate_flag_off():
    from app import redline
    assert redline.BACKEND_RUNTIME_GATE is False
    assert redline.POLICY_ENFORCEMENT == "frontend-route-guard"
