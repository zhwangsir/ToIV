"""镜头级参考图验收门禁（VLM 四问 + 脸分 ≥0.75），2026-10-05 04:09 决策。

负例 = 被人工驳回的帽兜放下改图（v1 正面=hooddown_front_2509_31337：衬衫领+麻花辫；
v1 侧面=hooddown_side_20261005：铆钉高领皮夹克+耳环；其余 6 张帽兜仍在头上），
以及 shot0 原片帧（正面看不到马尾 → VLM 答披发）。答案为 :8262 Qwen3-VL-8B 实录（round1_vlm_answers.json）。
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from app.services.studio import outfit_state as ost

FIX = Path(__file__).parent / "fixtures" / "chybrid_ref_vlm_gate"
REC = json.loads((FIX / "round1_vlm_answers.json").read_text())
GOOD = {"hood_on_head": '[\n    "\\u5426"\n]', "same_jacket": "是", "accessories": "否", "hairstyle": "马尾"}


def test_questions_are_the_four_required():
    keys = [q[0] for q in ost.OUTFIT_VLM_QUESTIONS]
    assert keys == ["hood_on_head", "same_jacket", "accessories", "hairstyle"]
    assert ost.OUTFIT_VLM_QUESTIONS[0][1] == "图中人物的帽兜是否盖在头顶上？只答 是/否"
    assert dict((q[0], q[3]) for q in ost.OUTFIT_VLM_QUESTIONS) == {
        "hood_on_head": "否", "same_jacket": "是", "accessories": "否", "hairstyle": "马尾"}
    assert ost.REF_FACE_SIM_MIN == 0.75


@pytest.mark.parametrize("raw,want", [
    ('[\n    "\\u5426"\n]', "否"), ('[\n    "\\u662f"\n]', "是"), ("否。", "否"), ("不是", "否"),
    ("没有", "否"), ("是的", "是"), ("Yes", "是"), ("no", "否"), ("", None), ("不确定", None), ("看不清", None),
])
def test_parse_yes_no(raw, want):
    assert ost.parse_vlm_choice(raw, ("是", "否")) == want


@pytest.mark.parametrize("raw,want", [
    ('[\n    "\\u9ebb\\u82b1\\u8fab"\n]', "麻花辫"), ("马尾", "马尾"), ("低马尾", "马尾"), ("披发", "披发"),
    ("ponytail", "马尾"), ("a braid", "麻花辫"), ("短发", None),
])
def test_parse_hairstyle(raw, want):
    assert ost.parse_vlm_choice(raw, ("马尾", "麻花辫", "披发")) == want


@pytest.mark.parametrize("name", sorted(REC))
def test_recorded_round1_all_rejected(name):
    r = REC[name]
    v = ost.outfit_vlm_verdict(r["answers"], r["face_sim"])
    assert v["pass"] is False
    assert v["failed"] == r["failed_expected"]


def test_v1_rejections_match_human_review():
    f = ost.outfit_vlm_verdict(REC["neg_front_2509_31337"]["answers"], REC["neg_front_2509_31337"]["face_sim"])
    assert {"same_jacket", "hairstyle"} <= set(f["failed"])  # 衬衫领 / 麻花辫
    s = ost.outfit_vlm_verdict(REC["neg_side_20261005"]["answers"], REC["neg_side_20261005"]["face_sim"])
    assert {"same_jacket", "accessories"} <= set(s["failed"])  # 铆钉高领皮夹克 / 耳环
    for k in ("neg_front_20261005", "neg_side_777013"):  # 帽兜仍在头上
        assert "hood_on_head" in ost.outfit_vlm_verdict(REC[k]["answers"], REC[k]["face_sim"])["failed"]
    assert (FIX / "neg_front_2509_31337.jpg").is_file() and (FIX / "neg_side_20261005.jpg").is_file()


def test_positive_and_face_threshold():
    assert ost.outfit_vlm_verdict(GOOD, 0.80)["pass"] is True
    assert ost.outfit_vlm_verdict(GOOD, 0.75)["pass"] is True
    v = ost.outfit_vlm_verdict(GOOD, 0.7499)
    assert v["pass"] is False and v["failed"] == ["face_sim"]
    assert ost.outfit_vlm_verdict(GOOD, None)["failed"] == ["face_sim"]
    assert ost.outfit_vlm_verdict({**GOOD, "hairstyle": ""}, 0.9)["failed"] == ["hairstyle"]
    assert ost.outfit_vlm_verdict({**GOOD, "hood_on_head": "不确定"}, 0.9)["failed"] == ["hood_on_head"]


def test_scene_ref_gate_uses_vlm_not_clip(monkeypatch):
    pytest.importorskip("cv2")
    import cv2
    import numpy as np

    ok, enc = cv2.imencode(".png", np.zeros((8, 8, 3), np.uint8))
    img = enc.tobytes()
    monkeypatch.setattr(ost, "hood_up_prob", lambda *a, **k: pytest.fail("CLIP 不得参与验收"))
    calls = []

    async def ask(b):
        calls.append(len(b))
        return dict(GOOD)

    v = asyncio.run(ost.scene_ref_gate(img, img, ask_fn=ask, face_fn=lambda a, b: 0.81))
    assert v["pass"] is True and calls and v["answers"]["hairstyle"] == "马尾"
    v2 = asyncio.run(ost.scene_ref_gate(img, img, ask_fn=ask, face_fn=lambda a, b: 0.6))
    assert v2["pass"] is False and v2["failed"] == ["face_sim"]


def test_vlm_worker_port_whitelist():
    from app.services.studio.character_sheet import CharacterSheetError

    for bad in ("http://100.68.100.90:8195", "http://100.68.100.90:8196", "http://100.68.100.90:8263"):
        with pytest.raises(CharacterSheetError):
            asyncio.run(ost.ask_outfit_vlm(b"x", worker_url=bad))


def test_ref_overrides_gate_check_blocks_unapproved():
    rec = {
        "v1_front": {"image": "/x/hooddown_front_2509_31337.png", "url": "/api/studio/files/rainref_hooddown_front_v1.png",
                     "pass": False, "failed": ["same_jacket", "hairstyle"]},
        "good_side": {"image": "/x/r3_side_ok.png", "url": "/api/studio/files/rainref_side_r3.png", "pass": True, "failed": []},
    }
    ov = {"sample_linxia_front.png": "/api/studio/files/rainref_hooddown_front_v1.png",
          "sample_linxia_side.png": "/api/studio/files/rainref_side_r3.png"}
    c = ost.ref_overrides_gate_check(ov, rec)
    assert c["ok"] is False and c["failed"] == {"rainref_hooddown_front_v1.png": ["same_jacket", "hairstyle"]}
    assert c["passed"] == ["rainref_side_r3.png"]
    c2 = ost.ref_overrides_gate_check({"a.png": "/api/studio/files/unknown.png"}, rec)
    assert c2["ok"] is False and c2["missing"] == ["unknown.png"]
    assert ost.ref_overrides_gate_check({"sample_linxia_side.png": "/api/studio/files/rainref_side_r3.png"}, rec)["ok"] is True
    assert ost.ref_overrides_gate_check(None, None)["ok"] is True
    assert ost.ref_overrides_gate_check(ov, None)["ok"] is False
