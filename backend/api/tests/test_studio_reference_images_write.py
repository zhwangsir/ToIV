"""12:01: reference_images 写入守卫 — char_panel_* 必须显式风格匹配。"""
from __future__ import annotations

import json

import pytest

from app.services.studio import character_sheet as sheet_svc


def test_panel_style_from_url_anime_and_ancient():
    assert (
        sheet_svc.panel_style_from_url(
            "/api/studio/files/char_panel_803fb69b_anime_portrait_abc.png"
        )
        == "anime"
    )
    assert (
        sheet_svc.panel_style_from_url(
            "/api/studio/files/char_panel_803fb69b_ancient_realistic_front_304.png"
        )
        == "ancient_realistic"
    )
    assert sheet_svc.panel_style_from_url("/api/studio/files/sample_linxia_front.png") is None


def test_reference_images_rejects_panel_without_style_match():
    refs = [
        "/api/studio/files/sample_linxia_front.png",
        "/api/studio/files/char_panel_803fb69b_anime_portrait_abc.png",
    ]
    with pytest.raises(sheet_svc.ReferenceImagesStyleError):
        sheet_svc.assert_reference_images_panel_style(refs, allowed_styles=None)
    with pytest.raises(sheet_svc.ReferenceImagesStyleError):
        sheet_svc.assert_reference_images_panel_style(refs, allowed_styles=set())
    with pytest.raises(sheet_svc.ReferenceImagesStyleError):
        # 古风角色不允许写入二次元格图
        sheet_svc.assert_reference_images_panel_style(
            refs, allowed_styles={"ancient_realistic"}
        )


def test_reference_images_allows_panel_with_explicit_style():
    refs = [
        "/api/studio/files/sample_linxia_front.png",
        "/api/studio/files/char_panel_803fb69b_anime_portrait_abc.png",
        "/api/studio/files/char_panel_803fb69b_anime_front_654.png",
    ]
    sheet_svc.assert_reference_images_panel_style(refs, allowed_styles={"anime"})


def test_reference_images_write_json_loads_and_keeps_sample():
    existing = [
        "/api/studio/files/sample_linxia_front.png",
        "/api/studio/files/sample_linxia_side.png",
        "/api/studio/files/sample_linxia_full.png",
    ]
    panels = {
        "portrait": "/api/studio/files/char_panel_803_portrait.png",
        "front": "/api/studio/files/char_panel_803_front.png",
        "side": "/api/studio/files/char_panel_803_side.png",
        "back": "/api/studio/files/char_panel_803_back.png",
    }
    refs = sheet_svc.merge_video_refs(existing, panel_urls=panels, sheet_url=None)
    raw = json.dumps(refs, ensure_ascii=False)
    loaded = json.loads(raw)
    assert isinstance(loaded, list)
    for s in existing:
        assert s in loaded, s
    # 整卡不进链
    assert not any("char_sheet_" in u for u in loaded)


def test_merge_does_not_imply_style_permission():
    """merge 只拼 URL;真正写入前必须再过 assert_reference_images_panel_style。"""
    existing = ["/api/studio/files/sample_linxia_front.png"]
    panels = {
        "portrait": "/api/studio/files/char_panel_803fb69b_anime_portrait_x.png",
        "front": "/api/studio/files/char_panel_803fb69b_anime_front_x.png",
        "side": "/api/studio/files/char_panel_803fb69b_anime_side_x.png",
        "back": "/api/studio/files/char_panel_803fb69b_anime_back_x.png",
    }
    merged = sheet_svc.merge_video_refs(existing, panel_urls=panels, sheet_url=None)
    with pytest.raises(sheet_svc.ReferenceImagesStyleError):
        sheet_svc.assert_reference_images_panel_style(merged, allowed_styles=None)
    sheet_svc.assert_reference_images_panel_style(merged, allowed_styles={"anime"})
