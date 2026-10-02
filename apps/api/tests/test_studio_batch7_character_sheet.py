"""Batch7 v2:角色设定卡 — 17:45 七条纠偏 + 拼版/Ref2VA/失败码。"""
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
    r = client.post(f"/api/studio/projects/{pid}/characters", headers=H, json=body)
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _all_panel_keys():
    return list(sheet_svc._PANEL_KEYS) + list(sheet_svc._EXPR_KEYS)


def _placeholder_panels():
    panels = {}
    for i, k in enumerate(_all_panel_keys()):
        panels[k] = sheet_svc.placeholder_panel((40 + i * 12, 80, 160), (512, 768))
    return panels


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
        design_notes="雨夜便利店\n黑雨衣主视觉\n三视图统一\n表情分格\n服饰平铺",
        visual_prompt="1girl",
    )
    panels = _placeholder_panels()
    png = sheet_svc.compose_character_sheet(panels, meta)
    assert png[:8] == b"\x89PNG\r\n\x1a\n"
    img = Image.open(BytesIO(png))
    assert img.size == (2400, 3200)


def test_compose_ancient_dark_theme_pixels():
    """古风卡画布应为深底(#0B0E14 类),非白底。"""
    meta = sheet_svc.SheetMeta(
        name="林夏",
        style="ancient_realistic",
        design_notes="a\nb\nc",
        visual_prompt="1girl raincoat",
    )
    panels = _placeholder_panels()
    png = sheet_svc.compose_character_sheet(panels, meta)
    img = Image.open(BytesIO(png)).convert("RGB")
    # 取角落背景像素
    px = img.getpixel((10, 50))
    assert px[0] < 40 and px[1] < 40 and px[2] < 50, px


def test_build_design_notes_min_3_lines():
    meta = sheet_svc.SheetMeta(
        name="林夏",
        style="anime",
        role="便利店员",
        personality="温柔果断",
        description="雨夜便利店冷白灯",
        visual_prompt="black raincoat",
    )
    notes = sheet_svc.build_design_notes(meta)
    assert len([ln for ln in notes.splitlines() if ln.strip()]) >= 3


def test_compose_rejects_empty_name():
    meta = sheet_svc.SheetMeta(name="  ", style="anime")
    panels = _placeholder_panels()
    with pytest.raises(sheet_svc.CharacterSheetError) as ei:
        sheet_svc.compose_character_sheet(panels, meta)
    assert ei.value.status_code == 422


def test_compose_rejects_bad_style():
    meta = sheet_svc.SheetMeta(name="林夏", style="oil")
    panels = _placeholder_panels()
    with pytest.raises(sheet_svc.CharacterSheetError) as ei:
        sheet_svc.compose_character_sheet(panels, meta)
    assert ei.value.status_code == 422


def test_merge_video_refs_no_sheet_front():
    panels = {
        "portrait": "/api/studio/files/char_panel_x_anime_portrait_a.png",
        "front": "/api/studio/files/char_panel_x_anime_front_b.png",
        "side": "/api/studio/files/char_panel_x_anime_side_c.png",
        "back": "/api/studio/files/char_panel_x_anime_back_d.png",
    }
    old = [
        "/api/studio/files/sample_linxia_front.png",
        "http://x/char_sheet_old_anime_abc.png",
    ]
    merged = sheet_svc.merge_video_refs(
        old, panel_urls=panels, sheet_url="/api/studio/files/char_sheet_new.png"
    )
    assert merged[0].endswith("portrait_a.png")
    assert all("char_sheet_" not in u for u in merged)
    assert "/api/studio/files/sample_linxia_front.png" in merged


def test_merge_sheet_into_refs_compat_no_front_sheet():
    old = ["/a/front.png", "http://x/char_sheet_old_anime_abc.png"]
    merged = sheet_svc.merge_sheet_into_refs(
        old, "/api/studio/files/char_sheet_new_anime_x.png"
    )
    assert not any("char_sheet_" in u for u in merged)
    assert "/a/front.png" in merged


def test_shot_refs_skips_character_sheet():
    c = StudioCharacter(
        project_id="p",
        name="林夏",
        reference_images=(
            '["/api/studio/files/char_panel_lin_anime_portrait_1.png",'
            '"/api/studio/files/char_panel_lin_anime_front_1.png",'
            '"/api/studio/files/char_panel_lin_anime_side_1.png",'
            '"/api/studio/files/char_panel_lin_anime_back_1.png",'
            '"/api/studio/files/char_sheet_lin_anime_1.png"]'
        ),
    )
    refs = collect_cast_ref_images([c])
    urls = ref_urls(refs)
    assert all("char_sheet_" not in u for u in urls)
    assert "portrait" in urls[0]
    assert "立绘" in refs[0].label


def test_costume_prompt_bans_hanfu():
    meta = sheet_svc.SheetMeta(
        name="林夏",
        style="anime",
        visual_prompt="young woman black raincoat",
        description="便利店员",
    )
    prompts = sheet_svc.build_panel_prompts(meta)
    assert "hanfu" in prompts["costume"].lower() or "no hanfu" in prompts["costume"]
    assert "raincoat" in prompts["costume"].lower()
    assert "anime" in prompts["portrait"].lower() or "cel" in prompts["portrait"].lower()


def test_forbidden_worker_ports():
    with pytest.raises(sheet_svc.CharacterSheetError) as ei:
        sheet_svc._assert_sheet_worker_allowed("http://100.68.100.90:8195")
    assert ei.value.status_code == 400
    with pytest.raises(sheet_svc.CharacterSheetError):
        sheet_svc._assert_sheet_worker_allowed("http://100.68.100.90:8196")
    sheet_svc._assert_sheet_worker_allowed("http://100.68.100.90:8261")


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


def test_api_success_writes_panel_refs_not_sheet(ctx):
    client, token, out_root, _ = ctx
    H = _h(token)
    cid = _mk_char(client, H)

    async def fake_gen(*, character_id, meta, pool, **kw):
        panels = {}
        for i, k in enumerate(_all_panel_keys()):
            buf = BytesIO()
            sheet_svc.placeholder_panel((40 + i * 10, 70, 150)).convert("RGB").save(
                buf, format="PNG"
            )
            panels[k] = buf.getvalue()
        png = sheet_svc.compose_character_sheet(panels, meta)
        url = sheet_svc.save_sheet_png(png, character_id=character_id, style=meta.style)
        panel_urls = {
            "portrait": sheet_svc.save_panel_png(
                panels["portrait"], character_id=character_id, style=meta.style, key="portrait"
            ),
            "front": sheet_svc.save_panel_png(
                panels["front"], character_id=character_id, style=meta.style, key="front"
            ),
            "side": sheet_svc.save_panel_png(
                panels["side"], character_id=character_id, style=meta.style, key="side"
            ),
            "back": sheet_svc.save_panel_png(
                panels["back"], character_id=character_id, style=meta.style, key="back"
            ),
        }
        return url, png, panel_urls

    with patch(
        "app.services.studio.character_sheet.generate_character_sheet",
        new=AsyncMock(side_effect=fake_gen),
    ):
        r = client.post(
            f"/api/studio/characters/{cid}/character-sheet",
            headers=H,
            json={
                "style": "anime",
                "height_cm": 165,
                "role": "店员",
                # 12:01:默认不写 reference_images;显式 true 才回写面板 refs
                "apply_to_video_refs": True,
            },
        )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["sheet_url"].startswith("/api/studio/files/char_sheet_")
    assert body["sheet_style"] == "anime"
    assert "panel_urls" in body
    assert body["panel_urls"]["portrait"]
    # 整卡不得置前进 reference_images
    assert all("char_sheet_" not in u for u in body["reference_images"])
    assert body["reference_images"], "apply_to_video_refs=true 应写入面板 refs"
    assert "char_panel_" in body["reference_images"][0]
    assert "portrait" in body["reference_images"][0]
    name = body["sheet_url"].rsplit("/", 1)[-1]
    assert (out_root / "studio" / name).is_file()


def test_font_missing_maps_503(monkeypatch):
    monkeypatch.setattr(sheet_svc, "_CJK_FONT_CANDIDATES", ("/no/such/font.ttf",))
    with pytest.raises(sheet_svc.CharacterSheetError) as ei:
        sheet_svc.resolve_cjk_font(24)
    assert ei.value.status_code == 503
