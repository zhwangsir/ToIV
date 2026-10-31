"""RH 参考默认注入:示例提示词 + 封面进 images default。"""
from __future__ import annotations

from app.services.rh_family_preset_seed import (
    demo_image_default,
    inject_rh_ref_defaults,
)


def test_inject_prompt_and_cover_into_empty_schema():
    base = [
        {"key": "images", "label": "参考图", "type": "images", "default": None, "required": True},
        {"key": "positive", "label": "提示词", "type": "textarea", "default": "", "required": True},
        {"key": "seed", "label": "种子", "type": "text", "default": ""},
    ]
    cover = "https://rh-hk-images.example/cover.jpg"
    out = inject_rh_ref_defaults(
        base,
        cover_url=cover,
        example_prompt="严格按照上传图片人物一致",
        family="flux2-i2i",
    )
    assert out is not base
    assert out[0]["default"] == demo_image_default(cover)
    assert out[1]["default"] == "严格按照上传图片人物一致"
    assert out[2]["default"] == ""
    # 不污染原 schema
    assert base[0]["default"] is None
    assert base[1]["default"] == ""


def test_inject_family_fallback_when_no_example_prompt():
    base = [
        {"key": "positive", "type": "textarea", "default": ""},
        {"key": "images", "type": "images", "default": []},
    ]
    out = inject_rh_ref_defaults(base, cover_url="", example_prompt="", family="qwen-edit")
    assert "保持人物" in out[0]["default"]
    assert out[1]["default"] == []  # 无 cover 不写图


def test_inject_skips_nonempty_defaults():
    base = [
        {"key": "positive", "type": "textarea", "default": "已有示例"},
        {"key": "images", "type": "images", "default": [{"filename": "a.png"}]},
    ]
    out = inject_rh_ref_defaults(
        base,
        cover_url="https://x/y.jpg",
        example_prompt="新提示",
        family="flux2-i2i",
    )
    assert out is base  # 无需变更 → 共享引用
    assert out[0]["default"] == "已有示例"


def test_demo_image_default_empty():
    assert demo_image_default("") == []
    assert demo_image_default("  ") == []
