"""D-U1=B R18 统一口径不变量 —— 账号全局 content_mode(2026-10-26 TL)。

对照:app.redline。不生成任何成人内容;只锁门控/fail-closed/未成年硬阻断与策略常量。
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
from app.redline import (
    CONTENT_MODE_ADULT,
    CONTENT_MODE_ORDINARY,
    adult_at_submit,
    should_apply_softening,
)


def _adult(**extra):
    return SimpleNamespace(birthdate=None, content_mode=CONTENT_MODE_ADULT, **extra)


def _ordinary(**extra):
    return SimpleNamespace(birthdate=None, content_mode=CONTENT_MODE_ORDINARY, **extra)


def test_policy_constants_encode_d_u1b():
    assert r18_policy.POLICY_ID == "D-U1=B"
    assert r18_policy.CANVAS_IS_SOLE_MAIN_UI is True
    assert r18_policy.WEB_INDEPENDENT_NSFW_ZONE_RETIRED is True
    assert r18_policy.ACCOUNT_CONTENT_MODE_IS_SOLE_ALLOW is True
    assert r18_policy.FAIL_CLOSED_WITHOUT_ADULT_MODE is True
    assert r18_policy.UNDERAGE_HARD_BLOCK is True
    assert r18_policy.REQUEST_HEADER == "X-NSFW"
    assert r18_policy.REQUEST_HEADER_VALUE == "1"
    assert r18_policy.CONTENT_MODE_ORDINARY == "ordinary"
    assert r18_policy.CONTENT_MODE_ADULT == "adult"


def test_nsfw_ctx_docs_align_with_account_mode():
    doc = nsfw_ctx.__doc__ or ""
    assert "content_mode" in doc or "账号" in doc
    assert "D-U1" in doc or "adult" in doc.lower()


def test_fail_closed_without_adult_mode():
    token = nsfw_intent_var.set(True)  # 头不得单独放行
    try:
        assert nsfw_allowed(None) is False
        assert nsfw_allowed(_ordinary()) is False
        assert nsfw_allowed(SimpleNamespace(birthdate=None)) is False  # 缺字段 → ordinary
    finally:
        nsfw_intent_var.reset(token)


def test_allowed_with_account_adult_ignores_header():
    token = nsfw_intent_var.set(False)  # 无头仍放行(账号态为准)
    try:
        assert nsfw_allowed(_adult()) is True
    finally:
        nsfw_intent_var.reset(token)


def test_header_alone_never_allows():
    token = nsfw_intent_var.set(True)
    try:
        assert nsfw_allowed(_ordinary()) is False
        assert nsfw_allowed(None) is False
    finally:
        nsfw_intent_var.reset(token)


def test_underage_hard_block_beats_adult_mode():
    minor = SimpleNamespace(
        birthdate=date.today() - timedelta(days=365 * 12),
        content_mode=CONTENT_MODE_ADULT,
    )
    assert is_underage(minor) is True
    token = nsfw_intent_var.set(True)
    try:
        assert nsfw_allowed(minor) is False
    finally:
        nsfw_intent_var.reset(token)


def test_job_nsfw_from_intent_fail_closed_and_explicit_only():
    ordinary = _ordinary()
    assert job_nsfw_from_intent(ordinary, explicit=False) is False
    with pytest.raises(HTTPException) as ei:
        job_nsfw_from_intent(ordinary, explicit=True)
    assert ei.value.status_code == 403
    assert "R18" in ei.value.detail or "成人" in ei.value.detail

    adult = _adult()
    assert job_nsfw_from_intent(adult, explicit=True) is True
    assert job_nsfw_from_intent(adult, explicit=False) is False


def test_adult_at_submit_snapshot_and_softening_gate():
    assert adult_at_submit(_adult()) is True
    assert adult_at_submit(_ordinary()) is False
    assert should_apply_softening(_ordinary()) is True
    assert should_apply_softening(_adult()) is False
    assert should_apply_softening(None) is False


def test_middleware_still_wires_x_nsfw_for_audit_only():
    src = Path(__file__).resolve().parents[1].joinpath("app/main.py").read_text(encoding="utf-8")
    assert "x-nsfw" in src.lower()
    assert "nsfw_intent_var" in src
    assert "审计" in src or "audit" in src.lower() or "D-U1" in src


def test_http_roundtrip_header_does_not_alone_allow():
    """中间件仍置位审计 ContextVar,但 nsfw_allowed(None) 永不因头放行。"""

    @app.get("/__toiv_r18_probe_d_u1b")
    def probe():
        return {"allowed": nsfw_allowed(None), "audit_header": bool(nsfw_intent_var.get())}

    try:
        with TestClient(app) as c:
            r0 = c.get("/__toiv_r18_probe_d_u1b")
            assert r0.status_code == 200
            assert r0.json()["allowed"] is False
            r1 = c.get("/__toiv_r18_probe_d_u1b", headers={"X-NSFW": "1"})
            assert r1.status_code == 200
            body = r1.json()
            assert body["allowed"] is False  # 头不得单独放行
            assert body["audit_header"] is True
    finally:
        app.router.routes = [
            r
            for r in app.router.routes
            if getattr(r, "path", None) != "/__toiv_r18_probe_d_u1b"
        ]


def test_ltx_gate_detail_mentions_adult_mode():
    from app.routes.video import _gate_ltx_nsfw

    with pytest.raises(HTTPException) as ei:
        _gate_ltx_nsfw(_ordinary())
    assert ei.value.status_code == 403
    assert "R18" in ei.value.detail or "成人" in ei.value.detail


def test_redline_is_decision_ssot():
    from app import redline

    assert redline.POLICY_ID == "D-U1=B"
    assert redline.REQUEST_HEADER == "X-NSFW"
    assert redline.CONTENT_MODE_ADULT == "adult"
    assert redline.FAIL_CLOSED is True
    assert redline.ACCOUNT_CONTENT_MODE_IS_SOLE_ALLOW is True
    assert redline.UNDERAGE_HARD_BLOCK is True
    assert nsfw_ctx.nsfw_allowed is redline.nsfw_allowed
    assert nsfw_ctx.nsfw_intent_var is redline.nsfw_intent_var
    assert nsfw_ctx.is_underage is redline.is_underage
    assert nsfw_ctx.job_nsfw_from_intent is redline.job_nsfw_from_intent


def test_sfw_main_path_usable_without_adult_mode():
    from app.redline import nsfw_allowed as redline_nsfw_allowed

    @app.get("/__toiv_r18_sfw_probe")
    def probe():
        return {"allowed": redline_nsfw_allowed(None)}

    try:
        with TestClient(app) as c:
            r0 = c.get("/__toiv_r18_sfw_probe")
            assert r0.status_code == 200 and r0.json()["allowed"] is False
            h = c.get("/api/health")
            assert h.status_code == 200
            m = c.get("/api/models")
            assert m.status_code != 403, m.text
            assert m.status_code < 500
    finally:
        app.router.routes = [
            r
            for r in app.router.routes
            if getattr(r, "path", None) != "/__toiv_r18_sfw_probe"
        ]


def test_dual_gate_runtime_flags():
    from app import redline

    assert redline.BACKEND_RUNTIME_GATE is True
    assert redline.POLICY_ENFORCEMENT == "dual-gate-account"
    assert redline.FAIL_CLOSED_WITHOUT_ADULT_MODE is True
