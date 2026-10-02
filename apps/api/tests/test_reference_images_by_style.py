"""Batch7 收线后:参考图按风格分存,互不覆盖。"""
from __future__ import annotations

import json

import pytest

from app.services.studio import character_sheet as sheet_svc
from app.services.studio.shot_refs import collect_cast_ref_images


def test_merge_by_style_keeps_other_style():
    anime_panels = {
        "portrait": "/api/studio/files/char_panel_aaaaaaaa_anime_portrait_1.png",
        "front": "/api/studio/files/char_panel_aaaaaaaa_anime_front_1.png",
        "side": "/api/studio/files/char_panel_aaaaaaaa_anime_side_1.png",
        "back": "/api/studio/files/char_panel_aaaaaaaa_anime_back_1.png",
    }
    ancient_panels = {
        "portrait": "/api/studio/files/char_panel_aaaaaaaa_ancient_realistic_portrait_2.png",
        "front": "/api/studio/files/char_panel_aaaaaaaa_ancient_realistic_front_2.png",
        "side": "/api/studio/files/char_panel_aaaaaaaa_ancient_realistic_side_2.png",
        "back": "/api/studio/files/char_panel_aaaaaaaa_ancient_realistic_back_2.png",
    }
    by = sheet_svc.merge_video_refs_by_style(
        {}, style="anime", panel_urls=anime_panels
    )
    by = sheet_svc.merge_video_refs_by_style(
        by, style="ancient_realistic", panel_urls=ancient_panels
    )
    assert len(by["anime"]) == 4
    assert len(by["ancient_realistic"]) == 4
    assert all("anime" in u for u in by["anime"])
    assert all("ancient_realistic" in u for u in by["ancient_realistic"])
    # 再写 anime 不掉古风
    by2 = sheet_svc.merge_video_refs_by_style(
        by,
        style="anime",
        panel_urls={
            **anime_panels,
            "portrait": "/api/studio/files/char_panel_aaaaaaaa_anime_portrait_9.png",
        },
    )
    assert "ancient_realistic" in by2
    assert len(by2["ancient_realistic"]) == 4
    assert by2["anime"][0].endswith("portrait_9.png")


def test_flatten_refs_for_style_keeps_samples():
    by = {
        "anime": [
            "/api/studio/files/char_panel_aaaaaaaa_anime_portrait_1.png",
            "/api/studio/files/char_panel_aaaaaaaa_anime_front_1.png",
        ]
    }
    samples = [
        "/api/studio/files/sample_linxia_front.png",
        "/api/studio/files/sample_linxia_side.png",
    ]
    flat = sheet_svc.flatten_refs_for_style(by, style="anime", samples=samples)
    assert flat[0].endswith("portrait_1.png")
    assert "sample_linxia_front.png" in flat[-2] or any("sample_linxia" in u for u in flat)
    samples_only = sheet_svc.samples_from_refs(
        flat + ["/api/studio/files/char_sheet_aaaaaaaa_anime_xxx.png"]
    )
    assert samples_only == samples


def test_collect_cast_prefers_by_style():
    class C:
        name = "林夏"
        reference_images = json.dumps(
            [
                "/api/studio/files/char_panel_aaaaaaaa_anime_portrait_old.png",
                "/api/studio/files/sample_linxia_front.png",
            ]
        )
        reference_images_by_style = {
            "ancient_realistic": [
                "/api/studio/files/char_panel_aaaaaaaa_ancient_realistic_portrait_2.png",
                "/api/studio/files/char_panel_aaaaaaaa_ancient_realistic_front_2.png",
            ]
        }

    refs = collect_cast_ref_images([C()], style="ancient_realistic")
    urls = [r.image_url for r in refs]
    assert any("ancient_realistic_portrait" in u for u in urls)
    assert any("sample_linxia_front" in u for u in urls)
    assert not any("anime_portrait_old" in u for u in urls)


def test_parse_refs_by_style_ignores_unknown():
    raw = json.dumps(
        {
            "anime": ["/api/studio/files/char_panel_aaaaaaaa_anime_front_1.png"],
            "foo": ["/x.png"],
        }
    )
    parsed = sheet_svc.parse_refs_by_style(raw)
    assert list(parsed.keys()) == ["anime"]
