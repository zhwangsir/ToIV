"""Batch7:角色设定卡 — 拼版几何/字体/失败码/Ref2VA 回写。"""
from __future__ import annotations

from io import BytesIO
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient
from PIL import Image
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.db import get_session
from app.deps import get_pool
from app.main import app
from app.models import Tenant, User
from app.security import create_token, hash_password
from app.services.studio import character_sheet as sheet_svc
from app.services.studio.shot_refs import collect_cast_ref_images, ref_urls
from app.models import StudioCharacter


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

    pool = MagicMock()
    app.dependency_overrides[get_pool] = lambda: pool

    with Session(engine) as s:
        tenant = Tenant(name="b7sheet")
        s.add(tenant)
        s.commit()
        s.refresh(tenant)
        user = User(
            email="b7sheet@toiv.ai",
            hashed_password=hash_password("password1"),
            tenant_id=tenant.id,
        )
        s.add(user)
        s.commit()
        s.refresh(user)
        uid = user.id
    yield TestClient(app), create_token(uid), out_root, pool
    app.dependency_overrides.clear()


def _h(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def _mk_char(client: TestClient, H: dict, **kw) -> str:
    pid = client.post(
        "/api/studio/projects", headers=H, json={"title": "雨夜", "premise": "重逢"}
    ).json()["id"]
    body = {
        "name": kw.get("name", "林夏"),
        "description": kw.get("description", "身份:便利店员;性格:温柔果断"),
        "visual_prompt": kw.get(
            "visual_prompt", "1girl, black hair, rain coat, convenience store clerk"
        ),
    }
    if "name" in kw and kw["name"] == "":
        # bypass API min_length by direct DB? API requires min_length=1
        pass
    r = client.post(f"/api/studio/projects/{pid}/characters", headers=H, json=body)
    assert r.status_code == 200, r.text
    return r.json()["id"]


def test_layout_geometry_keys():
    assert sheet_svc.LAYOUT["canvas"] == (2400, 3200)
    for key in (
        "portrait",
        "name",
        "profile",
        "turnaround",
        "faces",
        "expressions",
        "costume",
        "palette",
        "notes",
    ):
        x, y, w, h = sheet_svc.LAYOUT[key]
        assert w > 0 and h > 0
        assert x + w <= 2400 and y + h <= 3200


def test_resolve_cjk_font_exists():
    font = sheet_svc.resolve_cjk_font(28)
    assert font.getbbox("林夏设定")[2] > 20


def test_compose_geometry_and_png_bytes():
    meta = sheet_svc.SheetMeta(
        name="林夏",
        style="anime",
        height_cm=165,
        role="店员",
        personality="温柔",
        design_notes="雨夜便利店",
        visual_prompt="1girl",
    )
    panels = {
        k: sheet_svc.placeholder_panel((40 + i * 20, 80, 160), (512, 768))
        for i, k in enumerate(sheet_svc._PANEL_KEYS)
    }
    png = sheet_svc.compose_character_sheet(panels, meta)
    assert png[:8] == b"\x89PNG\r\n\x1a\n"
    img = Image.open(BytesIO(png))
    assert img.size == (2400, 3200)


def test_compose_rejects_empty_name():
    meta = sheet_svc.SheetMeta(name="  ", style="anime")
    panels = {k: sheet_svc.placeholder_panel((100, 100, 100)) for k in sheet_svc._PANEL_KEYS}
    with pytest.raises(sheet_svc.CharacterSheetError) as ei:
        sheet_svc.compose_character_sheet(panels, meta)
    assert ei.value.status_code == 422


def test_compose_rejects_bad_style():
    meta = sheet_svc.SheetMeta(name="林夏", style="oil")
    panels = {k: sheet_svc.placeholder_panel((100, 100, 100)) for k in sheet_svc._PANEL_KEYS}
    with pytest.raises(sheet_svc.CharacterSheetError) as ei:
        sheet_svc.compose_character_sheet(panels, meta)
    assert ei.value.status_code == 422


def test_merge_sheet_into_refs_prefers_front():
    old = ["/a/front.png", "/a/side.png", "http://x/char_sheet_old_anime_abc.png"]
    merged = sheet_svc.merge_sheet_into_refs(old, "/api/studio/files/char_sheet_new_anime_x.png")
    assert merged[0].endswith("char_sheet_new_anime_x.png")
    assert "/a/front.png" in merged
    assert not any("char_sheet_old" in u for u in merged)


def test_shot_refs_prefers_character_sheet():
    c = StudioCharacter(
        project_id="p",
        name="林夏",
        reference_images='["/api/studio/files/char_sheet_lin_anime_1.png","/a/front.png","/a/side.png","/a/full.png"]',
    )
    refs = collect_cast_ref_images([c])
    urls = ref_urls(refs)
    assert "char_sheet_" in urls[0]
    assert "设定卡" in refs[0].label
    assert urls[1:] == ["/a/front.png", "/a/side.png", "/a/full.png"]


def test_api_missing_visual_422(ctx):
    client, token, _, _ = ctx
    H = _h(token)
    pid = client.post(
        "/api/studio/projects", headers=H, json={"title": "t", "premise": "p"}
    ).json()["id"]
    cid = client.post(
        f"/api/studio/projects/{pid}/characters",
        headers=H,
        json={"name": "空", "description": "", "visual_prompt": ""},
    ).json()["id"]
    r = client.post(
        f"/api/studio/characters/{cid}/character-sheet",
        headers=H,
        json={"style": "anime"},
    )
    assert r.status_code == 422, r.text


def test_api_not_found_404(ctx):
    client, token, _, _ = ctx
    r = client.post(
        "/api/studio/characters/nope/character-sheet",
        headers=_h(token),
        json={"style": "anime"},
    )
    assert r.status_code == 404


def test_api_bad_style_422(ctx):
    client, token, _, _ = ctx
    cid = _mk_char(client, _h(token))
    r = client.post(
        f"/api/studio/characters/{cid}/character-sheet",
        headers=_h(token),
        json={"style": "oil"},
    )
    assert r.status_code == 422


def test_api_backend_unavailable_503(ctx):
    client, token, _, pool = ctx
    cid = _mk_char(client, _h(token))

    async def boom(*_a, **_k):
        raise sheet_svc.CharacterSheetError("出图后端不可用:none", status_code=503)

    with patch(
        "app.services.studio.character_sheet.generate_character_sheet",
        new=AsyncMock(side_effect=boom),
    ):
        r = client.post(
            f"/api/studio/characters/{cid}/character-sheet",
            headers=_h(token),
            json={"style": "ancient_realistic"},
        )
    assert r.status_code == 503, r.text


def test_api_success_writes_reference_images(ctx):
    client, token, out_root, _ = ctx
    H = _h(token)
    cid = _mk_char(client, H)

    async def fake_gen(*, character_id, meta, pool, **kw):
        panels = {
            k: sheet_svc.placeholder_panel((50, 90, 140)).tobytes()  # wrong - need png
            for k in sheet_svc._PANEL_KEYS
        }
        # proper png bytes
        panels = {}
        for i, k in enumerate(sheet_svc._PANEL_KEYS):
            buf = BytesIO()
            sheet_svc.placeholder_panel((40 + i * 10, 70, 150)).convert("RGB").save(
                buf, format="PNG"
            )
            panels[k] = buf.getvalue()
        png = sheet_svc.compose_character_sheet(panels, meta)
        url = sheet_svc.save_sheet_png(png, character_id=character_id, style=meta.style)
        return url, png

    with patch(
        "app.services.studio.character_sheet.generate_character_sheet",
        new=AsyncMock(side_effect=fake_gen),
    ):
        r = client.post(
            f"/api/studio/characters/{cid}/character-sheet",
            headers=H,
            json={"style": "anime", "height_cm": 165, "role": "店员"},
        )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["sheet_url"].startswith("/api/studio/files/char_sheet_")
    assert body["sheet_style"] == "anime"
    assert any("char_sheet_" in u for u in body["reference_images"])
    assert body["reference_images"][0] == body["sheet_url"]
    # file on disk
    name = body["sheet_url"].rsplit("/", 1)[-1]
    assert (out_root / "studio" / name).is_file()


def test_font_missing_maps_503(monkeypatch):
    monkeypatch.setattr(sheet_svc, "_CJK_FONT_CANDIDATES", ("/no/such/font.ttf",))
    with pytest.raises(sheet_svc.CharacterSheetError) as ei:
        sheet_svc.resolve_cjk_font(24)
    assert ei.value.status_code == 503
