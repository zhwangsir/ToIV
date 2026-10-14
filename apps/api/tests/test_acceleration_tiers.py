"""任务 #24：统一「生成加速档」端点 + studio 渲染显式 accel 字段。

覆盖：
  · GET /api/acceleration/tiers：三家族形状；h3 过滤 recommended=false；wan/qwen 静态参考档
  · pipeline_c_render._apply_studio_accel：H3 图 balanced → transform 被调用；off → 不调用；
    非 H3 家族 → 不调用（monkeypatch apply_acceleration 断言）
  · POST /api/studio/shots/{sid}/render：非法 accel → 422；合法 accel 透传编排层
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

import app.services.h3_accel as h3_accel
import app.services.studio.orchestrator as orch
from app.db import get_session
from app.main import app
from app.models import Tenant, User
from app.security import create_token, hash_password
from app.services.studio.pipeline_c_render import _apply_studio_accel

# 假规格：lossless 下架(recommended=false 必须被过滤)；balanced 实测在架。
_FAKE_PROFILES = {
    "lossless": {
        "label": "无损加速",
        "speedup": 1.4,
        "ssim_vs_native": 0.88,
        "recommended": False,
        "reason": "基准方下架",
    },
    "balanced": {
        "label": "甜点位",
        "speedup": 2.94,
        "ssim_vs_native": 0.8194,
        "recommended": True,
        "reason": "实测 2.94x / SSIM 0.82",
    },
    "extreme": {
        "label": "极速预览",
        "speedup": 12.9,
        "ssim_vs_native": 0.7494,
        "recommended": True,
        "reason": "12.9x 预览级",
    },
}


@pytest.fixture()
def ctx(monkeypatch):
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    SQLModel.metadata.create_all(engine)

    def override() -> Session:
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override
    with Session(engine) as s:
        tenant = Tenant(name="accel")
        s.add(tenant)
        s.commit()
        s.refresh(tenant)
        user = User(
            email="accel@toiv.ai",
            hashed_password=hash_password("password1"),
            tenant_id=tenant.id,
        )
        s.add(user)
        s.commit()
        s.refresh(user)
        uid = user.id
    # tiers 端点默认吃假规格（含 recommended=false 的 lossless 用于验证过滤）
    monkeypatch.setattr(h3_accel, "load_profiles", lambda *a, **k: _FAKE_PROFILES)
    yield TestClient(app), create_token(uid)
    app.dependency_overrides.clear()


def _h(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


# ── /api/acceleration/tiers ────────────────────────────────────────────────


def test_tiers_requires_auth(ctx):
    client, _ = ctx
    assert client.get("/api/acceleration/tiers").status_code in (401, 403)


def test_tiers_shape_and_h3_filter(ctx):
    client, token = ctx
    r = client.get("/api/acceleration/tiers", headers=_h(token))
    assert r.status_code == 200, r.text
    fam = r.json()["families"]
    assert set(fam) == {"h3", "wan", "qwen"}

    h3_levels = [t["level"] for t in fam["h3"]]
    # off 满血档恒在；recommended=false 的 lossless 必须被过滤掉
    assert "off" in h3_levels
    assert "lossless" not in h3_levels
    assert "balanced" in h3_levels and "extreme" in h3_levels

    # 每档形状统一
    for t in fam["h3"] + fam["wan"] + fam["qwen"]:
        assert set(t) == {"level", "label", "speedup", "ssim", "recommended", "source", "note"}

    # balanced 带实测倍率/SSIM，来源 measured
    bal = next(t for t in fam["h3"] if t["level"] == "balanced")
    assert bal["speedup"] == pytest.approx(2.94)
    assert bal["ssim"] == pytest.approx(0.8194)
    assert bal["source"] == "measured"
    assert bal["recommended"] is True

    # off 档无实测倍率
    off = next(t for t in fam["h3"] if t["level"] == "off")
    assert off["speedup"] is None and off["ssim"] is None

    # wan/qwen 静态参考档：source=reference，speedup 恒 null（不编造数字）
    for fam_key in ("wan", "qwen"):
        levels = [t["level"] for t in fam[fam_key]]
        assert levels == ["off", "turbo", "turbo_cache"]
        for t in fam[fam_key]:
            assert t["source"] == "reference"
            assert t["speedup"] is None and t["ssim"] is None


# ── _apply_studio_accel transform 调用断言 ─────────────────────────────────


_H3_GRAPH = {
    "1": {"class_type": "UNETLoader", "inputs": {}},
    "2": {"class_type": "MiniMaxH3AudioConditioningT8", "inputs": {}},
}
_NON_H3_GRAPH = {
    "1": {"class_type": "CheckpointLoaderSimple", "inputs": {}},
    "2": {"class_type": "KSampler", "inputs": {}},
}


def test_apply_studio_accel_balanced_calls_transform(monkeypatch):
    calls = []

    def _fake(graph, level, **kw):
        calls.append(level)
        return graph, True

    monkeypatch.setattr(h3_accel, "apply_acceleration", _fake)
    out, applied = _apply_studio_accel(dict(_H3_GRAPH), "balanced")
    assert calls == ["balanced"]
    assert applied is True
    assert out is not None


def test_apply_studio_accel_off_skips_transform(monkeypatch):
    calls = []
    monkeypatch.setattr(
        h3_accel, "apply_acceleration", lambda g, l, **k: (calls.append(l), (g, False))[1]
    )
    _, applied = _apply_studio_accel(dict(_H3_GRAPH), "off")
    assert calls == []
    assert applied is False


def test_apply_studio_accel_non_h3_skips_transform(monkeypatch):
    calls = []
    monkeypatch.setattr(
        h3_accel, "apply_acceleration", lambda g, l, **k: (calls.append(l), (g, False))[1]
    )
    _, applied = _apply_studio_accel(dict(_NON_H3_GRAPH), "balanced")
    assert calls == []
    assert applied is False


# ── studio render 请求体 accel 校验/透传 ───────────────────────────────────


def _mk_project(client, H) -> str:
    r = client.post("/api/studio/projects", headers=H, json={"title": "雨夜", "premise": "重逢"})
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _mk_shot(client, H, pid) -> str:
    r = client.put(
        f"/api/studio/projects/{pid}/shots",
        headers=H,
        json={"shots": [{"scene": "A", "prompt": "a", "render_mode": "video"}]},
    )
    assert r.status_code == 200, r.text
    return r.json()["shots"][0]["id"]


def test_render_shot_invalid_accel_422(ctx):
    client, token = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    sid = _mk_shot(client, H, pid)
    r = client.post(f"/api/studio/shots/{sid}/render", headers=H, json={"accel": "bogus"})
    assert r.status_code == 422, r.text


def test_render_shot_passes_accel_and_echoes(ctx, monkeypatch):
    client, token = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    sid = _mk_shot(client, H, pid)

    seen = {}

    async def fake_render_shot(session, shot, pool=None, request=None, **kw):
        seen["accel"] = kw.get("accel")
        echo = kw.get("accel_echo")
        if isinstance(echo, dict):
            echo["applied"] = True
        shot.status = "rendered"
        shot.video_url = "/api/studio/files/fake.mp4"
        shot.final_clip_url = shot.video_url
        return shot

    monkeypatch.setattr(orch, "render_shot", fake_render_shot)
    r = client.post(f"/api/studio/shots/{sid}/render", headers=H, json={"accel": "balanced"})
    assert r.status_code == 200, r.text
    assert seen["accel"] == "balanced"
    body = r.json()
    assert body["acceleration"] == "balanced"
    assert body["acceleration_applied"] is True


def test_render_shot_default_accel_off(ctx, monkeypatch):
    client, token = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    sid = _mk_shot(client, H, pid)

    seen = {}

    async def fake_render_shot(session, shot, pool=None, request=None, **kw):
        seen["accel"] = kw.get("accel")
        shot.status = "rendered"
        shot.video_url = "/api/studio/files/fake.mp4"
        return shot

    monkeypatch.setattr(orch, "render_shot", fake_render_shot)
    r = client.post(f"/api/studio/shots/{sid}/render", headers=H)
    assert r.status_code == 200, r.text
    assert seen["accel"] == "off"
    assert r.json()["acceleration"] == "off"
    assert r.json()["acceleration_applied"] is False
