"""Studio 多参考图收集与 H3 引用行。"""
from __future__ import annotations

from app.models import StudioCharacter
from app.services.studio.shot_refs import (
    collect_cast_ref_images,
    h3_ref_prefix,
    ref_urls,
    resolve_scene_images_for_shot,
)


def test_collect_cast_ref_images_front_side_full_and_scene():
    c = StudioCharacter(
        project_id="p",
        name="林夏",
        reference_images='["/a/front.png","/a/side.png","/a/full.png"]',
    )
    refs = collect_cast_ref_images([c], scene_images=["/s/store.png"])
    urls = ref_urls(refs)
    assert urls == ["/a/front.png", "/a/side.png", "/a/full.png", "/s/store.png"]
    assert "正面" in refs[0].label and "林夏" in refs[0].label
    assert "场景" in refs[3].label


def test_h3_ref_prefix_only_for_h3():
    c = StudioCharacter(
        project_id="p", name="林夏", reference_images='["/a/f.png"]'
    )
    prefix, urls = h3_ref_prefix([c], engine="h3")
    assert prefix.startswith("@图片1作为") and urls == ["/a/f.png"]
    prefix2, urls2 = h3_ref_prefix([c], engine="ltx")
    assert prefix2 == "" and urls2 == []


def test_resolve_scene_images_per_shot_index():
    scenes = ["/s/door.png", "/s/aisle.png", "/s/checkout.png", "/s/exit.png"]
    assert resolve_scene_images_for_shot(scenes, 0) == ["/s/door.png"]
    assert resolve_scene_images_for_shot(scenes, 1) == ["/s/aisle.png"]
    assert resolve_scene_images_for_shot(scenes, 2) == ["/s/checkout.png"]
    assert resolve_scene_images_for_shot(scenes, 3) == ["/s/exit.png"]
    assert resolve_scene_images_for_shot(scenes, 99) == ["/s/exit.png"]
    # 单图兼容：全集共用
    assert resolve_scene_images_for_shot(["/s/only.png"], 2) == ["/s/only.png"]
    assert resolve_scene_images_for_shot([], 0) == []
