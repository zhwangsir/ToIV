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
    assert r18_policy.FAIL_CLOSED_WITHOUT_HEADER is True
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


def test_underage_hard_block_beats_header():
    minor = SimpleNamespace(birthdate=date.today() - timedelta(days=365 * 12))
    assert is_underage(minor) is True
    token = nsfw_intent_var.set(True)
    try:
        assert nsfw_allowed(minor) is False
    finally:
        nsfw_intent_var.reset(token)


def test_job_nsfw_from_intent_fail_closed_and_explicit_only():
    token = nsfw_intent_var.set(False)
    try:
        assert job_nsfw_from_intent(None, explicit=False) is False
        with pytest.raises(HTTPException) as ei:
            job_nsfw_from_intent(None, explicit=True)
        assert ei.value.status_code == 403
        assert "R18" in ei.value.detail
        assert "X-NSFW" in ei.value.detail
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


def test_ltx_gate_detail_mentions_r18_context_not_legacy_zone_only():
    from app.routes.video import _gate_ltx_nsfw

    token = nsfw_intent_var.set(False)
    try:
        with pytest.raises(HTTPException) as ei:
            _gate_ltx_nsfw(SimpleNamespace(birthdate=None))
        assert ei.value.status_code == 403
        assert "R18" in ei.value.detail
        assert "X-NSFW" in ei.value.detail
    finally:
        nsfw_intent_var.reset(token)
