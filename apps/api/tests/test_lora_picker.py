"""策划卡 LoRA 选配:省略=auto / []=off / 非空=pin;禁止目录外文件名。"""
from __future__ import annotations

import pytest

from app.services.lora_catalog import CATALOG, cards_for
from app.services.lora_picker import (
    inject_triggers,
    pick_loras,
    resolve_submit_loras,
    snapshot_loras,
    split_wan_sides,
    to_specs,
)
from app.workflows.ltx_video import LtxT2VParams, build_ltx_t2v_graph


def test_catalog_sizes_and_engine_split():
    wan = cards_for("wan")
    h3 = cards_for("h3")
    ltx = cards_for("ltx")
    assert len(wan) == 6 and all(c.nsfw for c in wan)
    assert len(h3) == 13
    assert len(ltx) == 2 and all(not c.nsfw for c in ltx)
    assert len(CATALOG) == 6 + 13 + 2


def test_sfw_never_gets_nsfw_cards():
    picks = pick_loras("h3", "nsfw sex aio riding 骑乘 深喉", nsfw=False)
    nsfw_names = {c.name for c in CATALOG if c.nsfw}
    assert nsfw_names.isdisjoint({p.name for p in picks})
    names = {p.name for p in picks}
    assert "HMNSFW_AIO_V2.safetensors" not in names
    assert "riding_pose_H3_i2v_v1.0.safetensors" not in names
    wan = pick_loras("wan", "nsfwsks cowgirl cumshot", nsfw=False)
    assert wan == []


def test_h3_r18_emptyish_inserts_aio_concept():
    picks = pick_loras("h3", "a girl", nsfw=True)
    names = [p.name for p in picks]
    assert names[0] == "HMNSFW_AIO_V2.safetensors"
    assert any(p.reason.startswith("r18-") for p in picks if p.role == "concept")


def test_wan_auto_splits_high_low_sides():
    picks = pick_loras("wan", "cowgirl cumshot nsfwsks", nsfw=True)
    high, low = split_wan_sides(picks)
    assert high  # NSFW-22 概念至少在 HIGH
    assert any(n == "NSFW-22-H-e8.safetensors" for n, _ in high)
    # 体位卡在 LOW
    if any("DR34ML4Y" in p.name for p in picks):
        assert any("DR34ML4Y" in n for n, _ in low)


def test_auto_never_picks_accel():
    picks = pick_loras("h3", "turbo 4step 加速 pruned", nsfw=False)
    assert all(p.role != "accel" for p in picks)
    picks = pick_loras("wan", "v1030 4step turbo", nsfw=True)
    assert all(p.role != "accel" for p in picks)


def test_exclusive_roles_cap_three():
    picks = pick_loras(
        "h3",
        "riding 骑乘 cowgirl deepthroat 深喉 footjob 足交 "
        "pussy vagina 私处 bulge 腹部 nsfw aio",
        nsfw=True,
    )
    assert len(picks) <= 3
    roles = [p.role for p in picks]
    for role in ("pose", "anatomy", "concept"):
        assert roles.count(role) <= 1


def test_resolve_omitted_auto_empty_off_pin_wins():
    auto, mode, _ = resolve_submit_loras("h3", "a", nsfw=True, raw=None)
    assert mode == "auto"
    assert auto and auto[0].name == "HMNSFW_AIO_V2.safetensors"

    off, mode, reason = resolve_submit_loras("h3", "a", nsfw=True, raw=[])
    assert mode == "off" and off == [] and reason == "off"

    pin, mode, _ = resolve_submit_loras(
        "h3", "a", nsfw=True,
        raw=[{"name": "riding_pose_H3_i2v_v1.0.safetensors", "strength": 0.9}],
    )
    assert mode == "pin"
    assert [p.name for p in pin] == ["riding_pose_H3_i2v_v1.0.safetensors"]
    assert pin[0].strength == 0.9


def test_pin_unknown_raises():
    with pytest.raises(ValueError, match="未知 H3 LoRA"):
        pick_loras("h3", "x", nsfw=True, pinned=[{"name": "not-in-catalog.safetensors"}], mode="pin")


def test_inject_wan_triggers_prepend():
    picks = pick_loras("wan", "a", nsfw=True)  # emptyish → NSFW-22, trigger nsfwsks
    text = inject_triggers("a couple", picks)
    assert text.lower().startswith("nsfwsks") or "nsfwsks" in text.split(",")[0]


def test_ltx_keyword_pick_lands_on_graph():
    picks = pick_loras("ltx", "dynamic motion dolly camera 运镜", nsfw=True)
    assert picks
    g = build_ltx_t2v_graph(LtxT2VParams(positive="x", loras=to_specs(picks)))
    loaders = [n for n in g.values() if n.get("class_type") == "LoraLoader"]
    assert loaders
    names = {n["inputs"]["lora_name"] for n in loaders}
    assert names == {p.name for p in picks}
    snap = snapshot_loras(picks)
    assert {s["name"] for s in snap} == names


def test_ltx_generic_r18_picks_nothing():
    picks = pick_loras("ltx", "a", nsfw=True)
    assert picks == []
    g = build_ltx_t2v_graph(LtxT2VParams(positive="a", loras=to_specs(picks)))
    assert not any(n.get("class_type") == "LoraLoader" for n in g.values())
