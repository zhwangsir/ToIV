"""Batch7:设定卡资料重拼 — 锁图像格只改文字,不写 refs。"""
from __future__ import annotations

from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.db import get_session
from app.deps import get_pool
from app.main import app
from app.models import StudioCharacter, Tenant, User
from app.security import create_token, hash_password
from app.services.studio import character_sheet as sheet_svc


@pytest.fixture()
def ctx(tmp_path, monkeypatch):
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    SQLModel.metadata.create_all(engine)

    def override() -> Session:
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override
    out_root = tmp_path / "drama_out"
    out_root.mkdir()
    monkeypatch.setattr("app.storage.drama_output_root", lambda: out_root)
    app.dependency_overrides[get_pool] = lambda: MagicMock()

    with Session(engine) as s:
        tenant = Tenant(name="b7recompose")
        s.add(tenant)
        s.commit()
        s.refresh(tenant)
        user = User(
            email="b7recompose@toiv.ai",
            hashed_password=hash_password("password1"),
            tenant_id=tenant.id,
        )
        s.add(user)
        s.commit()
        s.refresh(user)
        uid = user.id
        tid = tenant.id

    client = TestClient(app)
    token = create_token(uid)
    headers = {"Authorization": f"Bearer {token}"}
    pid = client.post(
        "/api/studio/projects", headers=headers, json={"title": "雨夜", "premise": "重逢"}
    ).json()["id"]
    cid = client.post(
        f"/api/studio/projects/{pid}/characters",
        headers=headers,
        json={
            "name": "林夏",
            "description": "旧说明",
            "visual_prompt": "black raincoat",
        },
    ).json()["id"]

    studio = out_root / "studio"
    studio.mkdir(parents=True)
    from io import BytesIO
    from PIL import Image as PILImage

    def _panel_bytes(i: int) -> bytes:
        im = sheet_svc.placeholder_panel((40 + i * 12, 80, 160), (512, 768))
        if isinstance(im, PILImage.Image):
            buf = BytesIO()
            im.convert("RGB").save(buf, format="PNG")
            return buf.getvalue()
        return im

    panels = {}
    for i, k in enumerate(list(sheet_svc._PANEL_KEYS) + list(sheet_svc._EXPR_KEYS)):
        panels[k] = _panel_bytes(i)
    style = "ancient_realistic"
    meta = sheet_svc.SheetMeta(
        name="林夏",
        style=style,
        height_cm=165,
        role="店员",
        personality="果断",
        design_notes="旧设计说明一行。\n第二行。\n第三行。",
        description="旧说明",
    )
    sheet_png = sheet_svc.compose_character_sheet(panels, meta)
    cid8 = cid[:8]
    sheet_name = f"char_sheet_{cid8}_{style}_seedold000001.png"
    (studio / sheet_name).write_bytes(sheet_png)
    for k, data in panels.items():
        (studio / f"char_panel_{cid8}_{style}_{k}_seedold.png").write_bytes(data)

    yield {
        "client": client,
        "headers": headers,
        "studio": studio,
        "cid": cid,
        "style": style,
        "engine": engine,
        "sheet_name": sheet_name,
        "tid": tid,
    }
    app.dependency_overrides.clear()


def test_recompose_updates_text_keeps_refs(ctx):
    client = ctx["client"]
    headers = ctx["headers"]
    cid = ctx["cid"]
    r = client.post(
        f"/api/studio/characters/{cid}/character-sheet/recompose",
        headers=headers,
        json={
            "style": ctx["style"],
            "role": "雨夜店员",
            "personality": "温柔果断",
            "design_notes": "黑金褙子与披发。\n三视图同源。\n表情深底金字。",
            "height_cm": 168,
            "persist_description": True,
        },
    )
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["sheet_style"] == ctx["style"]
    assert data["apply_to_video_refs"] is False
    assert data["sheet_url"].startswith("/api/studio/files/char_sheet_")
    assert data["description"].startswith("雨夜店员")
    assert "温柔果断" in data["description"]
    new_name = data["sheet_url"].rsplit("/", 1)[-1]
    assert (ctx["studio"] / new_name).is_file()
    assert new_name != ctx["sheet_name"]
    with Session(ctx["engine"]) as session:
        c = session.get(StudioCharacter, cid)
        assert c is not None
        assert (c.reference_images or "[]") == "[]"


def test_recompose_404_without_sheet(ctx):
    client = ctx["client"]
    r = client.post(
        f"/api/studio/characters/{ctx['cid']}/character-sheet/recompose",
        headers=ctx["headers"],
        json={"style": "anime", "design_notes": "x"},
    )
    assert r.status_code == 404


def test_recompose_never_writes_refs_or_by_style(ctx):
    """recompose 只改文字/整卡文件,绝不写扁平 refs 或分桶 by_style。"""
    import json

    cid = ctx["cid"]
    ancient_refs = [
        "/api/studio/files/char_panel_aaaaaaaa_ancient_realistic_portrait_2.png",
        "/api/studio/files/char_panel_aaaaaaaa_ancient_realistic_front_2.png",
    ]
    samples = [
        "/api/studio/files/sample_linxia_front.png",
        "/api/studio/files/sample_linxia_side.png",
    ]
    by_style = {"ancient_realistic": list(ancient_refs)}
    with Session(ctx["engine"]) as session:
        c = session.get(StudioCharacter, cid)
        assert c is not None
        c.reference_images = json.dumps(samples, ensure_ascii=False)
        c.reference_images_by_style = json.dumps(by_style, ensure_ascii=False)
        session.add(c)
        session.commit()

    r = ctx["client"].post(
        f"/api/studio/characters/{cid}/character-sheet/recompose",
        headers=ctx["headers"],
        json={
            "style": ctx["style"],
            "role": "雨夜店员",
            "personality": "温柔果断",
            "design_notes": "锁图只改字。\n不写 refs。\n分桶不动。",
            "height_cm": 168,
            "persist_description": True,
        },
    )
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["apply_to_video_refs"] is False
    with Session(ctx["engine"]) as session:
        c = session.get(StudioCharacter, cid)
        assert c is not None
        assert json.loads(c.reference_images or "[]") == samples
        assert json.loads(c.reference_images_by_style or "{}") == by_style


def test_recompose_rejects_design_notes_out_of_range(ctx):
    """非空设计说明须 3–5 行；过短/过长 422，不改卡。"""
    cid = ctx["cid"]
    before = ctx["sheet_name"]
    r = ctx["client"].post(
        f"/api/studio/characters/{cid}/character-sheet/recompose",
        headers=ctx["headers"],
        json={
            "style": ctx["style"],
            "role": "雨夜店员",
            "personality": "温柔果断",
            "design_notes": "只有一行不合法",
            "height_cm": 168,
            "persist_description": False,
        },
    )
    assert r.status_code == 422, r.text
    assert "3–5" in (r.json().get("detail") or "")
    assert (ctx["studio"] / before).is_file()
    r2 = ctx["client"].post(
        f"/api/studio/characters/{cid}/character-sheet/recompose",
        headers=ctx["headers"],
        json={
            "style": ctx["style"],
            "design_notes": "1\n2\n3\n4\n5\n6",
            "persist_description": False,
        },
    )
    assert r2.status_code == 422, r2.text

