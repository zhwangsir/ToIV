"""角色资产协议 L2:锚点数据化 / 覆盖登记 / 版本级联 / 展示卡渲染 / 路由端点。

协议 docs/ops/CHARACTER_ASSET_PROTOCOL.md(2026-10-06 拍板,D1–D3 落地)。
"""
from __future__ import annotations

import json
from io import BytesIO
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.db import get_session
from app.main import app
from app.models import Tenant, User
from app.security import create_token, hash_password
from app.services.studio import character_asset as asset_svc
from app.services.studio import character_sheet as sheet_svc


# ── 服务层单测 ────────────────────────────────────────────────────────


def _meta(**kw) -> sheet_svc.SheetMeta:
    base = dict(
        name="林夏",
        style="anime",
        visual_prompt="1girl, short black bob hair, ice blue eyes, grey raincoat",
        description="16 岁少女,雨夜独行",
    )
    base.update(kw)
    return sheet_svc.SheetMeta(**base)


def test_anchors_extraction_generic_tokens():
    anchors = asset_svc.default_identity_anchors(_meta())
    kinds = [a["kind"] for a in anchors]
    assert kinds[0] == "identity" and anchors[0]["desc"] == "林夏"
    assert "hair" in kinds and "eyes" in kinds
    hair = next(a for a in anchors if a["kind"] == "hair")
    assert "bob hair" in hair["desc"]
    eyes = next(a for a in anchors if a["kind"] == "eyes")
    assert "blue eyes" in eyes["desc"]
    # 去重 + 上限 10
    assert len({(a["kind"], a["desc"].lower()) for a in anchors}) == len(anchors)
    assert len(anchors) <= 10


def test_anchors_extraction_ancient_costume_spec():
    meta = _meta(
        style="ancient_realistic",
        description="月白色齐胸襦裙,金步摇,长直发,清冷仙气",
    )
    anchors = asset_svc.default_identity_anchors(meta)
    kinds = [a["kind"] for a in anchors]
    assert "costume" in kinds
    costume = next(a for a in anchors if a["kind"] == "costume")
    assert costume["desc"]  # spec 抽出的服装锚(含色)


def test_palette_norm_and_sampling():
    pal = asset_svc.build_palette(["#ABC", "AABBCC", "notacolor"])
    assert pal["primary"] == "#aabbcc"
    assert pal["secondary"] == "#aabbcc" or pal["secondary"] == ""
    # 采样兜底:纯色图
    img = Image.new("RGB", (64, 64), (200, 30, 40))
    buf = BytesIO()
    img.save(buf, format="PNG")
    pal2 = asset_svc.build_palette(None, portrait_bytes=buf.getvalue())
    assert pal2["primary"].startswith("#")


def test_coverage_defaults_gaps_and_plan():
    cov = asset_svc.default_coverage(["portrait", "front", "side", "back"])
    assert cov["angles"] == ["front", "side", "back"]
    assert cov["framings"] == ["full_body"]
    asset = {
        "identity_anchors": [{"kind": "hair", "desc": "bob hair", "enforce": "prompt+negative"}],
        "coverage": cov,
        "canonical_prompt": {"positive": "", "negative_constraints": ["long hair"]},
    }
    gaps = asset_svc.coverage_gaps(cov, None)
    assert "medium_closeup" in gaps["framings"]
    assert "night" in gaps["lightings"]
    plan = asset_svc.coverage_backfill_plan(asset, None)
    kinds = {(j["kind"], j["key"]) for j in plan}
    assert ("framing", "medium_closeup") in kinds
    assert ("lighting", "night") in kinds
    for job in plan:
        assert "bob hair" in job["positive"]
        assert "long hair" in job["negative"]


def test_style_variant_prompt_anchor_preserving():
    asset = {
        "identity_anchors": [{"kind": "hair", "desc": "bob hair", "enforce": "prompt+negative"}],
        "canonical_prompt": {"positive": "x", "negative_constraints": ["long hair"]},
    }
    out = asset_svc.build_style_variant_prompt(asset, "ink_wash")
    assert "bob hair" in out["positive"]
    assert "ink wash" in out["positive"]
    assert "long hair" in out["negative"]
    assert "vivid saturated colors" in out["negative"]  # 目标风格负向注入
    # 目标=anime 时负向压写实
    out2 = asset_svc.build_style_variant_prompt(asset, "anime")
    assert "photorealistic" in out2["negative"]
    with pytest.raises(ValueError):
        asset_svc.build_style_variant_prompt(asset, "no_such_style")


def test_validate_asset_rules():
    asset = asset_svc.new_asset(
        character_id="CHR_TEST_1", style="anime", meta=_meta()
    )
    assert asset_svc.validate_asset(asset) == []
    bad = json.loads(json.dumps(asset))
    bad["identity_anchors"] = [{"kind": "nope", "desc": "x", "enforce": "prompt"}]
    bad["color_palette"] = {"primary": "zzz"}
    errs = asset_svc.validate_asset(bad)
    assert any("kind" in e for e in errs)
    assert any("primary" in e for e in errs)
    bad2 = json.loads(json.dumps(asset))
    bad2["coverage"] = {"angles": ["upside_down"]}
    assert any("angles" in e for e in asset_svc.validate_asset(bad2))


def test_version_cascade_and_persistence(tmp_path, monkeypatch):
    monkeypatch.setattr(asset_svc, "drama_output_root", lambda: tmp_path)
    asset = asset_svc.new_asset(
        character_id="CHR_TEST_2", style="anime", meta=_meta()
    )
    asset_svc.save_asset(asset)
    loaded = asset_svc.load_asset("CHR_TEST_2", "anime")
    assert loaded is not None and loaded["version"] == 1

    asset_svc.record_regeneration(asset, reason="编辑底图缺陷重做", seed=42)
    assert asset["version"] == 2
    assert asset["derived_from"] == {"base_version": 1, "regen_reason": "编辑底图缺陷重做"}
    assert asset["provenance"]["regenerations"][-1]["seed"] == 42
    asset_svc.save_asset(asset)
    assert asset_svc.load_asset("CHR_TEST_2", "anime")["version"] == 2

    # 钩子:未物化角色 no-op;已物化角色级联
    assert asset_svc.note_sheet_generated("CHR_NONE", "anime", reason="x") is None
    assert asset_svc.note_sheet_generated("CHR_TEST_2", "anime", reason="面板重生成") is not None
    assert asset_svc.load_asset("CHR_TEST_2", "anime")["version"] == 3


def _panel_png(path: Path, color=(120, 130, 150), size=(512, 768)) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", size, color).save(path, format="PNG")


def test_ensure_asset_backfill_from_files(tmp_path, monkeypatch):
    monkeypatch.setattr(asset_svc, "drama_output_root", lambda: tmp_path)
    studio = tmp_path / "studio"
    cid = "chrback0001"
    for key in ("portrait", "front", "side", "back", "faces", "costume"):
        _panel_png(studio / f"char_panel_{cid[:8]}_anime_{key}_aaa.png")
    # 干扰项:别的角色/别的风格不得计入
    _panel_png(studio / f"char_panel_{cid[:8]}_ancient_realistic_front_aaa.png")
    asset = asset_svc.ensure_asset(
        character_id=cid,
        style="anime",
        name="林夏",
        description="雨夜",
        visual_prompt="1girl, short black bob hair",
    )
    assert asset["version"] == 1
    assert set(asset["panels"]) == {
        "portrait", "front", "side", "back", "faces", "costume",
    }
    assert asset["coverage"]["angles"] == ["front", "side", "back"]
    assert asset["provenance"]["base"]["source"] == "backfill"
    assert asset["color_palette"]["primary"]  # 采样兜底
    # 二次读取:同一文件,不重复物化
    again = asset_svc.ensure_asset(
        character_id=cid, style="anime", name="林夏"
    )
    assert again["created_at"] == asset["created_at"]


def test_card_render_full_and_missing_panels(tmp_path, monkeypatch):
    monkeypatch.setattr(asset_svc, "drama_output_root", lambda: tmp_path)
    asset = asset_svc.new_asset(
        character_id="CHR_CARD_1",
        style="anime",
        meta=_meta(),
        panel_keys=["portrait", "front", "side", "back", "faces", "costume"],
    )
    asset["color_palette"] = {
        "primary": "#334455",
        "secondary": "#8899aa",
        "accent": "#ccddee",
        "extras": [],
        "variants": {},
    }
    panels = {
        k: _png_bytes(Image.new("RGB", (512, 768), (110 + i * 8, 120, 140)))
        for i, k in enumerate(asset["panels"])
    }
    data = asset_svc.compose_asset_card(panels, asset)
    img = Image.open(BytesIO(data))
    assert img.size == (asset_svc.CARD_W, asset_svc.CARD_H)
    assert len(data) > 20000
    # 缺面板 → 占位格,不抛
    data2 = asset_svc.compose_asset_card({}, asset)
    assert len(data2) > 20000
    # 落盘命名
    url = asset_svc.save_card_png(data, character_id="CHR_CARD_1", style="anime")
    assert "/api/studio/files/char_card_" in url and url.endswith(".png")
    assert (tmp_path / "studio" / url.rsplit("/", 1)[-1]).is_file()


def _png_bytes(img: Image.Image) -> bytes:
    buf = BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


# ── 路由层 ────────────────────────────────────────────────────────────


@pytest.fixture()
def ctx(tmp_path, monkeypatch):
    monkeypatch.setattr(asset_svc, "drama_output_root", lambda: tmp_path)
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    SQLModel.metadata.create_all(engine)

    def override() -> Session:
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override
    with Session(engine) as s:
        tenant = Tenant(name="asset")
        s.add(tenant)
        s.commit()
        s.refresh(tenant)
        user = User(
            email="asset@toiv.ai",
            hashed_password=hash_password("password1"),
            tenant_id=tenant.id,
        )
        s.add(user)
        s.commit()
        s.refresh(user)
        uid = user.id
    yield TestClient(app), create_token(uid), tmp_path
    app.dependency_overrides.clear()


def _h(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def _mk_character(client: TestClient, H: dict, tmp_path: Path) -> str:
    r = client.post(
        "/api/studio/projects", headers=H, json={"title": "雨夜"}
    )
    pid = r.json()["id"]
    r = client.post(
        f"/api/studio/projects/{pid}/characters",
        headers=H,
        json={
            "name": "林夏",
            "visual_prompt": "1girl, short black bob hair, ice blue eyes, grey raincoat",
            "description": "16 岁少女,雨夜独行",
        },
    )
    cid = r.json()["id"]
    studio = tmp_path / "studio"
    for key in ("portrait", "front", "side", "back", "faces", "costume"):
        _panel_png(studio / f"char_panel_{cid[:8]}_anime_{key}_aaa.png")
    return cid


def test_asset_route_get_put_refresh_card_plan(ctx):
    client, token, tmp_path = ctx
    H = _h(token)
    cid = _mk_character(client, H, tmp_path)

    # GET:自动物化 v1(D3 回填)
    r = client.get(f"/api/studio/characters/{cid}/character-asset", headers=H, params={"style": "anime"})
    assert r.status_code == 200, r.text
    asset = r.json()
    assert asset["materialized_now"] is True
    assert asset["version"] == 1
    assert set(asset["panels"]) >= {"portrait", "front", "side", "back"}
    assert any(a["kind"] == "hair" for a in asset["identity_anchors"])

    # 二次 GET:不再标记物化
    r2 = client.get(f"/api/studio/characters/{cid}/character-asset", headers=H, params={"style": "anime"})
    assert r2.json()["materialized_now"] is False

    # PUT:合法锚点补丁
    r = client.put(
        f"/api/studio/characters/{cid}/character-asset",
        headers=H,
        json={
            "style": "anime",
            "identity_anchors": [
                {"kind": "hair", "desc": "齐下巴黑色短发", "enforce": "prompt+negative"},
                {"kind": "costume", "desc": "灰色连帽雨衣(无徽章)", "enforce": "gate"},
            ],
            "profile": {"role": "高中一年级", "speech_style": "短句、冷淡"},
            "canonical_prompt": {"positive": "1girl, bob hair", "negative_constraints": ["long hair", "emblem"]},
        },
    )
    assert r.status_code == 200, r.text
    assert [a["desc"] for a in r.json()["identity_anchors"]] == [
        "齐下巴黑色短发", "灰色连帽雨衣(无徽章)",
    ]

    # PUT:非法 kind → 422
    r = client.put(
        f"/api/studio/characters/{cid}/character-asset",
        headers=H,
        json={"style": "anime", "identity_anchors": [{"kind": "nope", "desc": "x", "enforce": "prompt"}]},
    )
    assert r.status_code == 422

    # refresh:版本级联
    r = client.post(
        f"/api/studio/characters/{cid}/character-asset/refresh",
        headers=H,
        json={"style": "anime", "reason": "编辑底图缺陷重做"},
    )
    assert r.status_code == 200
    assert r.json()["version"] == 2
    assert r.json()["derived_from"]["base_version"] == 1

    # card:展示卡渲染
    r = client.post(
        f"/api/studio/characters/{cid}/character-asset/card",
        headers=H,
        json={"style": "anime"},
    )
    assert r.status_code == 200, r.text
    card_url = r.json()["card_url"]
    assert "char_card_" in card_url
    assert (tmp_path / "studio" / card_url.rsplit("/", 1)[-1]).is_file()

    # coverage-plan:M2 缺口 + 补拍计划
    r = client.post(
        f"/api/studio/characters/{cid}/character-asset/coverage-plan",
        headers=H,
        json={"style": "anime"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert "night" in body["gaps"]["lightings"]
    assert any(j["kind"] == "lighting" and j["key"] == "night" for j in body["plan"])
    # 负向约束进入补拍 negative(PUT 写入的 negative_constraints 生效)
    night = next(j for j in body["plan"] if j["key"] == "night")
    assert "long hair" in night["negative"]


def test_asset_route_requires_auth_and_404(ctx):
    client, token, tmp_path = ctx
    assert client.get("/api/studio/characters/xxx/character-asset").status_code in (401, 403)
    # 有效 token + 不存在角色 → 404
    H = _h(token)
    r = client.get(f"/api/studio/characters/nosuch/character-asset", headers=H, params={"style": "anime"})
    assert r.status_code == 404


def test_asset_invalid_style_422(ctx):
    client, token, tmp_path = ctx
    H = _h(token)
    cid = _mk_character(client, H, tmp_path)
    r = client.get(
        f"/api/studio/characters/{cid}/character-asset",
        headers=H,
        params={"style": "cyberpunk"},
    )
    assert r.status_code == 422
