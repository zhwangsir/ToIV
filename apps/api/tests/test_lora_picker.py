"""策划卡 LoRA 选配:省略=auto / []=off / 非空=pin;禁止目录外文件名。

新契约(后端零审查 / 零过滤):内容分级(nsfw)只作卡面元数据,picker 不再接收
任何分级参数。候选池 = 引擎全部卡;R18 卡按关键词 / 触发词 / 角色规则入选,与账号
或作业分级无关;用户钉选原样生效(不再被静默剔除)。
"""
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


def test_pool_unfiltered_r18_selected_by_match_not_rating():
    """新契约:候选池 = 引擎全部卡(分级仅元数据);R18 卡按关键词/触发词命中入选,与分级无关。"""
    # cards_for 不再接收 nsfw:同一引擎返回全部卡(R18 与 SFW 混合),后端不按分级剔除
    h3 = cards_for("h3")
    assert len(h3) == 13
    assert any(c.nsfw for c in h3) and any(not c.nsfw for c in h3)
    # 关键词命中 → R18 概念卡 + R18 体位卡入选(picker 已无 nsfw 参数,选取与账号/作业分级无关)
    names = {p.name for p in pick_loras("h3", "nsfw sex aio riding")}
    assert "HMNSFW_AIO_V2.safetensors" in names            # R18 通用概念卡
    assert "riding_pose_H3_i2v_v1.0.safetensors" in names  # R18 体位卡
    # wan 引擎同理:触发词/关键词命中即入选,不因分级被静默剔除
    wan_names = {p.name for p in pick_loras("wan", "nsfwsks cowgirl cumshot")}
    assert "NSFW-22-H-e8.safetensors" in wan_names


def test_h3_emptyish_inserts_default_concept():
    """短提示(偏空)自动补通用概念卡,避免空跑;与账号/作业分级无关。"""
    picks = pick_loras("h3", "a girl")
    names = [p.name for p in picks]
    assert names[0] == "HMNSFW_AIO_V2.safetensors"
    assert any(p.reason.startswith("r18-") for p in picks if p.role == "concept")


def test_wan_auto_splits_high_low_sides():
    picks = pick_loras("wan", "cowgirl cumshot nsfwsks")
    high, low = split_wan_sides(picks)
    assert high  # NSFW-22 概念至少在 HIGH
    assert any(n == "NSFW-22-H-e8.safetensors" for n, _ in high)
    # 体位卡在 LOW
    if any("DR34ML4Y" in p.name for p in picks):
        assert any("DR34ML4Y" in n for n, _ in low)


def test_auto_never_picks_accel():
    picks = pick_loras("h3", "turbo 4step 加速 pruned")
    assert all(p.role != "accel" for p in picks)
    picks = pick_loras("wan", "v1030 4step turbo")
    assert all(p.role != "accel" for p in picks)


def test_exclusive_roles_cap_three():
    picks = pick_loras(
        "h3",
        "riding 骑乘 cowgirl deepthroat 深喉 footjob 足交 "
        "pussy vagina 私处 bulge 腹部 nsfw aio",
    )
    assert len(picks) <= 3
    roles = [p.role for p in picks]
    for role in ("pose", "anatomy", "concept"):
        assert roles.count(role) <= 1


def test_resolve_omitted_auto_empty_off_pin_wins():
    auto, mode, _ = resolve_submit_loras("h3", "a", raw=None)
    assert mode == "auto"
    assert auto and auto[0].name == "HMNSFW_AIO_V2.safetensors"

    off, mode, reason = resolve_submit_loras("h3", "a", raw=[])
    assert mode == "off" and off == [] and reason == "off"

    # 钉选 R18 体位卡:无分级门,原样生效并带回显式强度
    pin, mode, _ = resolve_submit_loras(
        "h3", "a",
        raw=[{"name": "riding_pose_H3_i2v_v1.0.safetensors", "strength": 0.9}],
    )
    assert mode == "pin"
    assert [p.name for p in pin] == ["riding_pose_H3_i2v_v1.0.safetensors"]
    assert pin[0].strength == 0.9


def test_pin_unknown_raises():
    with pytest.raises(ValueError, match="未知 H3 LoRA"):
        pick_loras("h3", "x", pinned=[{"name": "not-in-catalog.safetensors"}], mode="pin")


def test_inject_wan_triggers_prepend():
    picks = pick_loras("wan", "a")  # 偏空 → 默认概念卡 NSFW-22,触发词 nsfwsks
    text = inject_triggers("a couple", picks)
    assert text.lower().startswith("nsfwsks") or "nsfwsks" in text.split(",")[0]


def test_ltx_keyword_pick_lands_on_graph():
    picks = pick_loras("ltx", "dynamic motion dolly camera 运镜")
    assert picks
    g = build_ltx_t2v_graph(LtxT2VParams(positive="x", loras=to_specs(picks)))
    loaders = [n for n in g.values() if n.get("class_type") == "LoraLoader"]
    assert loaders
    names = {n["inputs"]["lora_name"] for n in loaders}
    assert names == {p.name for p in picks}
    snap = snapshot_loras(picks)
    assert {s["name"] for s in snap} == names


def test_ltx_emptyish_picks_dynamic_motion():
    """LTX 策划卡无 concept:短提示自动挂动态增强,避免空跑(与分级无关)。"""
    name = "ltx_2.3_22b_distilled_1.1_lora_dynamic_fro09_avg_rank_111_bf16.safetensors"
    picks = pick_loras("ltx", "a")
    assert picks
    assert picks[0].name == name
    assert picks[0].role == "motion"
    assert picks[0].reason == "r18-default-motion"
    g = build_ltx_t2v_graph(LtxT2VParams(positive="a", loras=to_specs(picks)))
    loaders = [n for n in g.values() if n.get("class_type") == "LoraLoader"]
    assert loaders and loaders[0]["inputs"]["lora_name"] == name
