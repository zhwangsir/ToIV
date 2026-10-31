"""10/8:短剧默认竖屏 768×1344@24 —— Ref2VA 构图尺寸与 Agent 建项默认。"""
from __future__ import annotations

import asyncio

from tests.test_ref2va_indep_pipeline import LX, SCENE, _char, _FakeClient, _patch_pcr, _shot


def _dims(g: dict) -> tuple[int, int]:
    t = g["9"]["inputs"]
    return int(t["width"]), int(t["height"])


def test_ref2va_graph_uses_portrait_default(monkeypatch):
    client = _FakeClient()
    pcr, _ = _patch_pcr(monkeypatch, client)
    asyncio.run(
        pcr.render_pipeline_c(
            _shot(), [_char("林夏", LX)], scene_images=[SCENE], pipeline_name="ref2va",
            width=768, height=1344,
        )
    )
    assert _dims(client.graphs[0]) == (768, 1344)


def test_ref2va_legacy_landscape_still_swapped_to_portrait(monkeypatch):
    """旧横屏项目 768×384 仍被对调为竖屏 384×768(老行为保留,新项目不再落到这里)。"""
    client = _FakeClient()
    pcr, _ = _patch_pcr(monkeypatch, client)
    asyncio.run(
        pcr.render_pipeline_c(
            _shot(), [_char("林夏", LX)], pipeline_name="ref2va", width=768, height=384,
        )
    )
    assert _dims(client.graphs[0]) == (384, 768)


def test_ref2va_oversize_clamped_to_1344(monkeypatch):
    client = _FakeClient()
    pcr, _ = _patch_pcr(monkeypatch, client)
    asyncio.run(
        pcr.render_pipeline_c(
            _shot(), [_char("林夏", LX)], pipeline_name="ref2va", width=1080, height=1920,
        )
    )
    w, h = _dims(client.graphs[0])
    assert h == 1344 and w % 32 == 0 and w <= h


def _run_setup(opts: dict) -> tuple[int, int, int]:
    import json

    from sqlalchemy.pool import StaticPool
    from sqlmodel import Session, SQLModel, create_engine, select

    from app.models import AgentRun, StudioProject, Tenant, User
    from app.services import agent_team_exec

    eng = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    SQLModel.metadata.create_all(eng)
    with Session(eng) as s:
        t = Tenant(name="t")
        s.add(t)
        s.commit()
        s.refresh(t)
        u = User(tenant_id=t.id, email="pd@toiv.ai", hashed_password="x")
        s.add(u)
        s.commit()
        s.refresh(u)
        run = AgentRun(
            user_id=u.id, level="L2", goal="雨夜便利店", status="running",
            plan_json=json.dumps({"opts": opts, "characters": [], "shots": []}),
        )
        s.add(run)
        s.commit()
        rid = run.id
    agent_team_exec._setup_studio_project(rid, eng)
    with Session(eng) as s:
        p = s.exec(select(StudioProject)).one()
        return p.width, p.height, p.fps


def test_agent_team_project_defaults_portrait():
    assert _run_setup({}) == (768, 1344, 24)


def test_agent_team_project_honors_explicit_opts():
    assert _run_setup({"width": 1280, "height": 720, "fps": 16}) == (1280, 720, 16)
