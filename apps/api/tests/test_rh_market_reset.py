"""feat/studio-rh-market-reset：dry-run 规则单测（不写库、不调 bulk-public）。"""
from __future__ import annotations

from app.services.rh_market_reset import (
    KEEP_WHITELIST,
    AppView,
    chunk_ids,
    classify_app,
    plan_market_reset,
)


def test_whitelist_covers_intent_local_alts_and_longcat_continue():
    required = {
        "h3-i2v",
        "h3-t2v",
        "ovi-i2v",
        "avatar-talk",
        "longcat-continue",
        "longcat-t2v",
        "longcat-i2v",
        "removebg",
        "upscale",
        "ace-music",
        "vace-edit",
        "txt2img-basic",
    }
    assert required <= KEEP_WHITELIST


def test_keep_whitelist_skips_non_rh():
    d = classify_app(AppView(id="h3-i2v", is_public=True, smoke_status="pass"))
    assert d.action == "keep"
    assert d.reason == "KEEP_WHITELIST"


def test_non_rh_public_not_whitelisted_soft_hide():
    d = classify_app(AppView(id="random-local-app", is_public=True, smoke_status="pass"))
    assert d.action == "soft_hide"
    assert "non-RH" in d.reason


def test_rh_smoke_fail_soft_hide():
    d = classify_app(AppView(id="rh-acc-1", is_public=True, smoke_status="fail"))
    assert d.action == "soft_hide"
    d2 = classify_app(AppView(id="rh-acc-2", is_public=True, smoke_status="timeout"))
    assert d2.action == "soft_hide"


def test_rh_untested_deferred_on_pass1():
    d = classify_app(AppView(id="rh-acc-u", is_public=True, smoke_status=""))
    assert d.action == "defer_untested"
    d2 = classify_app(
        AppView(id="rh-acc-u", is_public=True, smoke_status=""),
        pass_index=2,
    )
    assert d2.action == "soft_hide"


def test_rh_pass_keep():
    d = classify_app(AppView(id="rh-acc-ok", is_public=True, smoke_status="pass"))
    assert d.action == "keep"


def test_localizable_filter():
    d = classify_app(
        AppView(id="rh-acc-x", is_public=True, smoke_status="pass"),
        localizable_ids=frozenset({"rh-acc-other"}),
    )
    assert d.action == "soft_hide"
    assert "localizable" in d.reason


def test_avatar_talk_revive_candidate():
    d = classify_app(AppView(id="avatar-talk", is_public=False, smoke_status=""))
    assert d.action == "revive_candidate"


def test_plan_public_only_counts():
    rows = [
        {"id": "h3-i2v", "is_public": True, "smoke_status": "pass"},
        {"id": "stray-local", "is_public": True, "smoke_status": "pass"},
        {"id": "rh-acc-fail", "is_public": True, "smoke_status": "fail"},
        {"id": "rh-acc-ok", "is_public": True, "smoke_status": "pass"},
        {"id": "rh-acc-u", "is_public": True, "smoke_status": ""},
        {"id": "avatar-talk", "is_public": False, "smoke_status": ""},
        {"id": "already-hid", "is_public": False, "smoke_status": "fail"},
    ]
    plan = plan_market_reset(rows, scope="public_only", pass_index=1)
    c = plan.counts()
    assert c["public_input"] == 5
    assert c["soft_hide"] == 2  # stray-local + rh-acc-fail
    assert c["defer_untested"] == 1
    assert c["revive_candidates"] == 1  # avatar-talk
    assert "stray-local" in plan.soft_hide_ids()
    assert "rh-acc-fail" in plan.soft_hide_ids()
    assert "longcat-continue" in plan.missing_whitelist_rows


def test_chunk_ids_bulk_limit():
    ids = [f"a{i}" for i in range(450)]
    chunks = chunk_ids(ids, 200)
    assert len(chunks) == 3
    assert len(chunks[0]) == 200
    assert len(chunks[2]) == 50
