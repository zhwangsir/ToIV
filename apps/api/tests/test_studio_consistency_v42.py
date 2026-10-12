"""V4-2 一致性深水区(2026-10-12):三视图注册表(景别视图优先级)+阶段感知换参考(ref_epoch)。

覆盖:景别→视图优先级推断、参考收集重排(不删只排)、ref_epoch 持久化与 PUT 通路、
模型默认值(存量行为不变)。
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.db import get_session
from app.main import app
from app.models import StudioCharacter, StudioProject, StudioShot, Tenant, User
from app.security import create_token, hash_password
from app.services.studio.shot_refs import (
    RefImage,
    collect_cast_ref_images,
    infer_view_priority,
)


@pytest.fixture()
def ctx():
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    SQLModel.metadata.create_all(engine)

    def override() -> Session:
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override
    with Session(engine) as s:
        tenant = Tenant(name="v42")
        s.add(tenant)
        s.commit()
        s.refresh(tenant)
        user = User(
            email="v42@toiv.ai",
            hashed_password=hash_password("password1"),
            tenant_id=tenant.id,
        )
        s.add(user)
        s.commit()
        s.refresh(user)
        uid = user.id
    yield TestClient(app), create_token(uid), engine
    app.dependency_overrides.clear()


# ── V4-2a:景别视图优先级 ──

def test_infer_view_priority_by_camera():
    assert infer_view_priority("背面", "")[0] == "back"
    assert infer_view_priority("", "她转身离开,背影渐远")[0] == "back"
    assert infer_view_priority("侧面跟拍", "")[0] == "side"
    assert infer_view_priority("", "眼神特写")[0] == "portrait"
    assert infer_view_priority("close-up on face", "")[0] == "portrait"
    # 默认(全景/中景/空) → front 优先
    assert infer_view_priority("", "")[0] == "front"
    assert infer_view_priority("全景", "街道全景")[0] == "front"


def _panel_url(view: str) -> str:
    return f"/api/studio/files/char_panel_c1_anime_{view}_abc123.png"


def test_collect_reorders_views_by_camera():
    """三视图注册表:背面镜下 back 参考排最前;参考不丢(只重排)。"""
    cast = [
        StudioCharacter(
            project_id="p", name="林晚",
            reference_images=json_ref_list(
                [_panel_url("front"), _panel_url("side"), _panel_url("back"), _panel_url("portrait")]
            ),
        )
    ]
    refs = collect_cast_ref_images(cast, camera="背影", prompt="她背对镜头远去")
    urls = [r.image_url for r in refs]
    assert urls[0] == _panel_url("back")
    # 全部参考保留(4 面板都在)
    for v in ("front", "side", "back", "portrait"):
        assert _panel_url(v) in urls
    # 槽位标签仍按视图键
    by_url = {r.image_url: r.label for r in refs}
    assert "背面" in by_url[_panel_url("back")]


def test_collect_closeup_puts_portrait_first():
    cast = [
        StudioCharacter(
            project_id="p", name="林晚",
            reference_images=json_ref_list(
                [_panel_url("front"), _panel_url("side"), _panel_url("portrait")]
            ),
        )
    ]
    refs = collect_cast_ref_images(cast, camera="", prompt="面部特写,眼含泪光")
    assert refs[0].image_url == _panel_url("portrait")


def json_ref_list(urls: list[str]) -> str:
    import json

    return json.dumps(urls, ensure_ascii=False)


# ── V4-2c:ref_epoch 持久化与 PUT ──

def _mk_project(client: TestClient, H: dict) -> str:
    r = client.post("/api/studio/projects", headers=H, json={"title": "v42"})
    assert r.status_code == 200, r.text
    return r.json()["id"]


def test_shot_ref_epoch_persist_and_put(ctx):
    """ref_epoch/note 经分镜保存通路持久化;缺省镜默认 epoch=0(存量不变)。"""
    client, token, engine = ctx
    H = {"Authorization": f"Bearer {token}"}
    pid = _mk_project(client, H)

    r = client.put(
        f"/api/studio/projects/{pid}/shots",
        headers=H,
        json={"shots": [{
            "scene": "巷口雨夜",
            "prompt": "rainy alley",
            "characters": ["林晚"],
            "ref_epoch": 2,
            "ref_epoch_note": "第3镜起换雨衣",
        }]},
    )
    assert r.status_code == 200, r.text
    saved = r.json()["shots"][0]
    sid = saved["id"]
    assert saved["ref_epoch"] == 2
    assert saved["ref_epoch_note"] == "第3镜起换雨衣"

    with Session(engine) as s:
        shot = s.get(StudioShot, sid)
        assert shot.ref_epoch == 2
        assert shot.ref_epoch_note == "第3镜起换雨衣"

    # PUT 改 epoch(notes 同步) — 走分镜批量保存通路
    r2 = client.get(f"/api/studio/projects/{pid}", headers=H)
    assert r2.status_code == 200
    # 再建一镜不留 epoch(默认 0)
    r3 = client.put(
        f"/api/studio/projects/{pid}/shots",
        headers=H,
        json={"shots": [{"scene": "便利店", "prompt": "store at midnight", "characters": []}]},
    )
    assert r3.status_code == 200
    assert r3.json()["shots"][0]["ref_epoch"] == 0
    assert r3.json()["shots"][0]["ref_epoch_note"] == ""


def test_shot_epoch_group_logging_smoke(ctx, caplog):
    """渲染入口 epoch 日志:带 epoch 的镜打归组日志(冒烟;不真渲染)。"""
    from app.services.studio import orchestrator

    client, token, engine = ctx
    H = {"Authorization": f"Bearer {token}"}
    pid = _mk_project(client, H)
    with Session(engine) as s:
        shot = StudioShot(
            project_id=pid, idx=0, scene="换装后", prompt="x",
            characters="[]", ref_epoch=3, ref_epoch_note="换礼服",
        )
        s.add(shot)
        s.commit()
        s.refresh(shot)
        sid = shot.id
    import logging

    with Session(engine) as s:
        shot = s.get(StudioShot, sid)
        import asyncio

        with caplog.at_level(logging.INFO, logger="app.services.studio.orchestrator"):
            # 不 mock 也会在参考图门处失败——只要日志先出即可;捕获 RenderError/HTTPException
            try:
                asyncio.get_event_loop().run_until_complete(
                    orchestrator.render_shot(s, shot, pool=None)
                )
            except Exception:  # noqa: BLE001 — 渲染门失败即到此为止
                pass
    assert any("ref_epoch=3" in rec.message for rec in caplog.records), caplog.messages[:5]
