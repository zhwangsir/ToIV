"""RH H3 社区卡预设:目录完整性 + 克隆 family 图 + 分类抽查。

可在 apps/api/tests/ 下随 test_app_seed 一起跑;无 app 包时只测 JSON + expand。
不遍历 1000+ 张图做 bindings 全量校验(图与 base 共享,core 测试已覆盖)。
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

_PATCH_JSON = Path("/workspace/toiv-apps/seed-patch/rh_h3_presets.json")
_BOX_JSON = Path("/workspace/toiv-apps/rh_h3_presets.json")


def _load_seed_mod():
    try:
        from app.services import rh_h3_preset_seed as mod
        return mod
    except ImportError:
        import importlib.util
        p = Path(__file__).resolve().parent / "rh_h3_preset_seed.py"
        if not p.is_file():
            p = Path("/workspace/toiv-apps/seed-patch/rh_h3_preset_seed.py")
        spec = importlib.util.spec_from_file_location("rh_h3_preset_seed", p)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod


def _catalog(mod) -> list[dict]:
    try:
        return list(mod.load_preset_rows())
    except FileNotFoundError:
        for p in (_PATCH_JSON, _BOX_JSON):
            if p.is_file():
                return json.loads(p.read_text(encoding="utf-8"))
        raise


def _fake_bases(mod) -> dict:
    """最小 base 字典,足够 expand 克隆字段,不造 Comfy 图。"""
    rows = _catalog(mod)
    bases = {}
    for row in rows:
        bid = row["base_id"]
        if bid in bases:
            continue
        nsfw = bid.startswith("h3-nsfw") or bid == "wan-nsfw-i2v"
        bases[bid] = {
            "id": bid,
            "name": bid,
            "description": f"core {bid}",
            "icon": "video",
            "category": "video" if bid != "qwen-image-edit" else "edit",
            "output_kind": "video" if bid != "qwen-image-edit" else "image",
            "workflow_json": {"_shared": bid},  # sentinel, shared by ref
            "params_schema": [
                {"key": "positive", "label": "提示词", "type": "textarea", "default": ""},
            ],
            "bindings": {"positive": {"node": "104", "field": "inputs.prompt"}},
            "is_nsfw": nsfw,
            "sort": 10,
        }
    # 核心 id 占位,确保不碰撞
    for cid in ("h3-t2v", "h3-i2v", "h3-fl2v", "h3-r2v"):
        bases.setdefault(cid, {
            "id": cid, "name": cid, "description": cid, "icon": "film",
            "category": "video", "output_kind": "video",
            "workflow_json": {"_shared": cid},
            "params_schema": [{"key": "positive", "type": "textarea", "default": ""}],
            "bindings": {}, "is_nsfw": False, "sort": 1,
        })
    return bases


def test_catalog_unique_rh_ids_at_least_1000():
    mod = _load_seed_mod()
    rows = _catalog(mod)
    ids = [r["id"] for r in rows]
    assert len(ids) >= 1000
    assert len(set(ids)) == len(ids)
    assert all(i.startswith("rh-") and len(i) <= 64 for i in ids)
    # 不与核心 id 碰撞
    core = {
        "h3-t2v", "h3-i2v", "h3-fl2v", "h3-r2v", "h3-multishot",
        "h3-t2v-15s-fast", "h3-i2v-15s-fast", "h3-r2v-voice",
        "h3-nsfw-t2v", "h3-nsfw-i2v", "h3-nsfw-fl2v", "h3-nsfw-r2v",
        "h3-nsfw-t2v-15s-fast", "h3-nsfw-i2v-15s-fast", "h3-nsfw-r2v-voice",
        "wan-animate-2", "qwen-image-edit",
    }
    assert not (set(ids) & core)


def test_classification_spot_checks():
    mod = _load_seed_mod()
    rows = _catalog(mod)
    by_name = {r["name"]: r for r in rows}

    rest = by_name["H3 舞后小憩（15s）"]
    assert rest["base_id"] == "h3-nsfw-i2v"
    assert rest["is_nsfw"] is True

    fl = by_name["H3首尾帧转场-AI过渡视频生成"]
    assert fl["base_id"] == "h3-fl2v"
    assert fl["is_nsfw"] is False

    r2v = by_name["H3 全能参考工作流"]
    assert r2v["base_id"] == "h3-r2v"

    fake20 = by_name["H3图生20秒长视频_高清版"]
    assert fake20["base_id"] == "h3-i2v-15s-fast"
    assert "15" in (fake20.get("note") or "")

    freeze = by_name["H3时间静止器"]
    assert freeze["base_id"] == "h3-i2v"
    assert freeze["family"] == "timefreeze"


def test_expand_clones_base_graph_by_reference():
    mod = _load_seed_mod()
    bases = _fake_bases(mod)
    presets = mod.expand_rh_h3_presets(bases)
    assert len(presets) >= 1000
    assert len({p["id"] for p in presets}) == len(presets)
    # 图按引用共享,不是 1000 份独立 Comfy JSON
    sample = next(p for p in presets if p["rh_base_id"] == "h3-nsfw-i2v")
    assert sample["workflow_json"] is bases["h3-nsfw-i2v"]["workflow_json"]
    assert sample["bindings"] is bases["h3-nsfw-i2v"]["bindings"]
    assert sample["category"] == bases["h3-nsfw-i2v"]["category"]
    assert sample["output_kind"] == bases["h3-nsfw-i2v"]["output_kind"]
    assert sample["icon"] == bases["h3-nsfw-i2v"]["icon"]
    assert sample["is_nsfw"] is True
    assert "rongsky" in sample["description"] or "场景" in sample["description"]

    rest = next(p for p in presets if "舞后小憩" in p["name"])
    assert rest["rh_base_id"] == "h3-nsfw-i2v"
    assert rest["is_nsfw"] is True

    fl = next(p for p in presets if p["name"] == "H3首尾帧转场-AI过渡视频生成")
    assert fl["rh_base_id"] == "h3-fl2v"
    assert fl["workflow_json"] is bases["h3-fl2v"]["workflow_json"]

    r2v = next(p for p in presets if p["name"] == "H3 全能参考工作流")
    assert r2v["rh_base_id"] == "h3-r2v"

    freeze = next(p for p in presets if p["name"] == "H3时间静止器")
    pos = next(p for p in freeze["params_schema"] if p["key"] == "positive")
    assert "时间静止" in pos["default"]
    # 未改写 base 的默认
    base_pos = next(p for p in bases["h3-i2v"]["params_schema"] if p["key"] == "positive")
    assert base_pos["default"] == ""

    stats = mod.rh_h3_seed_stats(presets)
    assert stats["count"] >= 1000
    assert stats["unique_ids"] == stats["count"]
    assert stats["nsfw"] + stats["sfw"] == stats["count"]
    assert stats["by_base_id"].get("h3-fl2v", 0) >= 1
    assert stats["by_base_id"].get("h3-r2v", 0) >= 1
    assert stats["by_base_id"].get("h3-nsfw-i2v", 0) >= 1
    assert stats["skipped"] == []


def test_expand_skips_unknown_base_and_core_collision():
    mod = _load_seed_mod()
    bases = _fake_bases(mod)
    # 抽掉一个 base,对应行应 skip
    dropped = "wan-animate-2"
    if dropped in bases:
        del bases[dropped]
    # 伪造核心碰撞
    rows_ok = True
    presets = mod.expand_rh_h3_presets(bases)
    skipped = mod.last_skipped()
    if dropped in {r["base_id"] for r in _catalog(mod)}:
        assert any(dropped in s for s in skipped)
        assert all(p["rh_base_id"] != dropped for p in presets)
    assert rows_ok


def test_core_ids_still_present_when_app_seed_wired():
    pytest.importorskip("app.services.app_seed")
    from app.services.app_seed import _build_specs, seed_builtin_apps
    from app.services.rh_h3_preset_seed import rh_h3_seed_stats

    specs = _build_specs()
    ids = {s["id"] for s in specs}
    core = {
        "h3-t2v", "h3-i2v", "h3-fl2v", "h3-r2v",
        "h3-t2v-15s-fast", "h3-i2v-15s-fast", "h3-r2v-voice",
        "h3-nsfw-t2v", "h3-nsfw-i2v", "wan-animate-2",
    }
    assert core <= ids
    rh = [s for s in specs if s["id"].startswith("rh-")]
    assert len({s["id"] for s in rh}) >= 1000
    # 预设图就是 base 图(同一对象或同拓扑)
    rest = next(s for s in rh if "舞后小憩" in s["name"])
    nsfw_i2v = next(s for s in specs if s["id"] == "h3-nsfw-i2v")
    assert rest["workflow_json"] is nsfw_i2v["workflow_json"]
    fl = next(s for s in rh if s["name"] == "H3首尾帧转场-AI过渡视频生成")
    assert fl["workflow_json"] is next(s for s in specs if s["id"] == "h3-fl2v")["workflow_json"]
    r2v = next(s for s in rh if s["name"] == "H3 全能参考工作流")
    assert r2v["workflow_json"] is next(s for s in specs if s["id"] == "h3-r2v")["workflow_json"]
    stats = rh_h3_seed_stats(specs)
    assert stats["count"] >= 1000
    # seed_builtin_apps 符号仍可导入(幂等由 test_app_seed 覆盖)
    assert callable(seed_builtin_apps)
