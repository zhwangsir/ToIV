"""RH H3 社区卡预设:目录结构校验 + 克隆 family 图机制 + 分类/跳过语义。

2026-09 语义演进:`app/data/rh_h3_presets.json` 已清空为 [](社区卡不再经
seed 内置应用入库,RH 应用走 re-seed 管线)。因此本文件不再断言 ≥1000 行,
而是:
  - 对真实目录(可为空)做结构不变量校验;
  - 用 monkeypatch 注入合成目录行,验证 expand 克隆/引用共享/timefreeze/
    未知 base 跳过/核心碰撞等机制与行数无关。
"""
from __future__ import annotations

import pytest

_CORE_IDS = {
    "h3-t2v", "h3-i2v", "h3-fl2v", "h3-r2v", "h3-multishot",
    "h3-t2v-15s-fast", "h3-i2v-15s-fast", "h3-r2v-voice",
    "h3-nsfw-t2v", "h3-nsfw-i2v", "h3-nsfw-fl2v", "h3-nsfw-r2v",
    "h3-nsfw-t2v-15s-fast", "h3-nsfw-i2v-15s-fast", "h3-nsfw-r2v-voice",
    "wan-animate-2", "qwen-image-edit",
}

# 合成目录行:覆盖各 family/base/nsfw/note/timefreeze 分支,不依赖真实数据。
_SYNTHETIC_ROWS = [
    {"id": "rh-test-sfw-i2v", "name": "合成 SFW 图生", "author": "tester",
     "family": "i2v", "base_id": "h3-i2v", "is_nsfw": False, "sort": 10,
     "note": "15s 高清版"},
    {"id": "rh-test-nsfw-i2v", "name": "合成 NSFW 图生", "author": "tester",
     "family": "i2v", "base_id": "h3-nsfw-i2v", "is_nsfw": True, "sort": 20},
    {"id": "rh-test-fl2v", "name": "合成首尾帧", "author": "tester",
     "family": "fl2v", "base_id": "h3-fl2v", "is_nsfw": False, "sort": 30},
    {"id": "rh-test-r2v", "name": "合成全能参考", "author": "tester",
     "family": "r2v", "base_id": "h3-r2v", "is_nsfw": False, "sort": 40},
    {"id": "rh-test-freeze", "name": "合成时间静止", "author": "tester",
     "family": "timefreeze", "base_id": "h3-i2v", "is_nsfw": False, "sort": 50},
    # 以下三行应被跳过:坏行 / id 碰撞 / 未知 base
    {"id": "", "name": "", "base_id": "h3-i2v"},
    {"id": "h3-i2v", "name": "撞核心 id", "base_id": "h3-i2v"},
    {"id": "rh-test-unknown-base", "name": "未知 base", "base_id": "no-such-base"},
]


def _load_seed_mod():
    from app.services import rh_h3_preset_seed as mod
    return mod


def _fake_bases(mod) -> dict:  # noqa: ANN001
    """最小 base 字典,足够 expand 克隆字段,不造 Comfy 图。"""
    bases = {}
    for bid, cat, kind in (
        ("h3-i2v", "video", "video"),
        ("h3-nsfw-i2v", "video", "video"),
        ("h3-fl2v", "video", "video"),
        ("h3-r2v", "video", "video"),
        ("qwen-image-edit", "edit", "image"),
    ):
        bases[bid] = {
            "id": bid,
            "name": bid,
            "description": f"core {bid}",
            "icon": "video",
            "category": cat,
            "output_kind": kind,
            "workflow_json": {"_shared": bid},  # sentinel, shared by ref
            "params_schema": [
                {"key": "positive", "label": "提示词", "type": "textarea", "default": ""},
            ],
            "bindings": {"positive": {"node": "104", "field": "inputs.prompt"}},
            "is_nsfw": bid.startswith("h3-nsfw"),
            "sort": 10,
        }
    return bases


def test_catalog_structure_invariants():
    """真实目录(2026-09 起可为空列表)必须满足结构不变量。"""
    mod = _load_seed_mod()
    rows = mod.load_preset_rows()
    assert isinstance(rows, list)
    ids = [r["id"] for r in rows]
    assert len(set(ids)) == len(ids)
    assert all(i.startswith("rh-") and len(i) <= 64 for i in ids)
    assert not (set(ids) & _CORE_IDS)


def test_expand_clones_base_graph_by_reference(monkeypatch):
    """注入合成行验证克隆机制:图/绑定按引用共享,timefreeze 只 deepcopy schema。"""
    mod = _load_seed_mod()
    monkeypatch.setattr(mod, "load_preset_rows", lambda: list(_SYNTHETIC_ROWS))
    bases = _fake_bases(mod)
    presets = mod.expand_rh_h3_presets(bases)

    ok = [p for p in presets if not p["id"].startswith("rh-test-unknown")]
    assert {p["id"] for p in ok} == {
        "rh-test-sfw-i2v", "rh-test-nsfw-i2v", "rh-test-fl2v",
        "rh-test-r2v", "rh-test-freeze",
    }
    assert len({p["id"] for p in presets}) == len(presets)

    sfw = next(p for p in presets if p["id"] == "rh-test-sfw-i2v")
    assert sfw["workflow_json"] is bases["h3-i2v"]["workflow_json"]
    assert sfw["bindings"] is bases["h3-i2v"]["bindings"]
    assert sfw["params_schema"] is bases["h3-i2v"]["params_schema"]
    assert sfw["category"] == bases["h3-i2v"]["category"]
    assert sfw["output_kind"] == bases["h3-i2v"]["output_kind"]
    assert sfw["is_nsfw"] is False
    assert "图生视频" in sfw["description"] and "tester" in sfw["description"]
    assert "15s" in sfw["description"]  # note 合入描述

    nsfw = next(p for p in presets if p["id"] == "rh-test-nsfw-i2v")
    assert nsfw["workflow_json"] is bases["h3-nsfw-i2v"]["workflow_json"]
    assert nsfw["is_nsfw"] is True

    fl = next(p for p in presets if p["id"] == "rh-test-fl2v")
    assert fl["workflow_json"] is bases["h3-fl2v"]["workflow_json"]

    freeze = next(p for p in presets if p["id"] == "rh-test-freeze")
    pos = next(p for p in freeze["params_schema"] if p["key"] == "positive")
    assert "时间静止" in pos["default"]
    # 未改写 base 的默认
    base_pos = next(p for p in bases["h3-i2v"]["params_schema"] if p["key"] == "positive")
    assert base_pos["default"] == ""

    stats = mod.rh_h3_seed_stats(presets)
    assert stats["count"] == 5
    assert stats["unique_ids"] == 5
    assert stats["nsfw"] + stats["sfw"] == 5
    assert stats["by_base_id"].get("h3-fl2v") == 1
    assert stats["by_base_id"].get("h3-r2v") == 1
    assert stats["by_base_id"].get("h3-nsfw-i2v") == 1
    # 坏行 / 核心碰撞 / 未知 base 全部被跳过
    assert any("bad-row" in s for s in stats["skipped"])
    assert any("id-collision" in s for s in stats["skipped"])
    assert any("rh-test-unknown-base" in s for s in stats["skipped"])


def test_expand_empty_catalog_returns_empty(monkeypatch):
    """目录清空(现网语义)→ expand 返回空,不抛错、无跳过项。"""
    mod = _load_seed_mod()
    monkeypatch.setattr(mod, "load_preset_rows", lambda: [])
    bases = _fake_bases(mod)
    assert mod.expand_rh_h3_presets(bases) == []
    assert mod.last_skipped() == []
    assert mod.rh_h3_seed_stats([])["count"] == 0


def test_core_ids_still_present_when_app_seed_wired():
    pytest.importorskip("app.services.app_seed")
    from app.services.app_seed import _build_specs, seed_builtin_apps
    from app.services.rh_h3_preset_seed import load_preset_rows, rh_h3_seed_stats

    specs = _build_specs()
    ids = {s["id"] for s in specs}
    core = {
        "h3-t2v", "h3-i2v", "h3-fl2v", "h3-r2v",
        "h3-t2v-15s-fast", "h3-i2v-15s-fast", "h3-r2v-voice",
        "h3-nsfw-t2v", "h3-nsfw-i2v", "wan-animate-2",
    }
    assert core <= ids
    # rh- 预设数 == 目录行数(现网目录为空 → 0;机制上行数即种子数)
    rh = [s for s in specs if s["id"].startswith("rh-")]
    catalog = load_preset_rows()
    assert len({s["id"] for s in rh}) == len(catalog)
    assert {s["id"] for s in rh}.isdisjoint(core)
    stats = rh_h3_seed_stats(specs)
    assert stats["count"] == len(catalog)
    # seed_builtin_apps 符号仍可导入(幂等由 test_app_seed 覆盖)
    assert callable(seed_builtin_apps)
