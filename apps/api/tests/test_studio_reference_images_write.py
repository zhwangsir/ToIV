"""06:55: reference_images 写入后 json.loads 必须成功且不得删除 sample 参考。"""
from __future__ import annotations

import json

import pytest

from app.services.studio import character_sheet as sheet_svc


def _write_refs(existing: list[str], panel_urls: dict[str, str]) -> str:
    """模拟 routes/studio.py 设定卡回写:merge 后 json.dumps。"""
    refs = sheet_svc.merge_video_refs(existing, panel_urls=panel_urls, sheet_url=None)
    return json.dumps(refs, ensure_ascii=False)


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
    raw = _write_refs(existing, panels)
    loaded = json.loads(raw)
    assert isinstance(loaded, list)
    assert all(isinstance(u, str) for u in loaded)
    for s in existing:
        assert s in loaded, s
    for u in panels.values():
        assert u in loaded
    # 禁止把整卡写进链
    assert not any("char_sheet_" in u for u in loaded)


def test_reference_images_rejects_non_json_array_literal_shape():
    """复现 06:55 事故形态:psql 数组字面量不可被 json.loads。"""
    bad = "{/api/studio/files/char_panel_x.png}"
    with pytest.raises(json.JSONDecodeError):
        json.loads(bad)
    good = json.dumps(["/api/studio/files/sample_linxia_front.png"], ensure_ascii=False)
    assert json.loads(good) == ["/api/studio/files/sample_linxia_front.png"]
