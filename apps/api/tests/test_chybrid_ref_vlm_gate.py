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


# ---- :8262 批次规则（角色卡优先，每批 ≤8，上一批排空+间隔后再交） ----

def _q(num, pid, cid, prefix="x", image="a.png"):
    return [num, pid, {"1": {"class_type": "SaveImage", "inputs": {"filename_prefix": prefix, "image": image}}}, {"client_id": cid}, []]


def test_qe_census_counts_char_sheet_and_ours():
    q = {"queue_running": [_q(1, "r", "outfit_qa_aa")],
         "queue_pending": [_q(2, "p1", "outfit_qa_bb"), _q(3, "p2", "toiv-rain-ref-r3"),
                           _q(4, "cs", "6e44", prefix="ToIV_char_sheet_expr_3"),
                           _q(5, "cs2", "ba95", image="sheet_pose_1c_front.png"), _q(6, "o", "someone")]}
    c = ost.qe_queue_census(q)
    assert c["char_sheet"] == 2 and c["ours"] == 3 and c["ours_pending_ids"] == ["p1", "p2"]


class _FakeQ:
    def __init__(self, seq):
        self.seq, self.calls = list(seq), 0

    async def _get_json(self, path):
        assert path == "/queue"
        self.calls += 1
        return self.seq.pop(0) if len(self.seq) > 1 else self.seq[0]


def _run(coro):
    return asyncio.run(coro)


def test_wait_slot_rejects_batch_over_8():
    with pytest.raises(ValueError):
        _run(ost.wait_qe_batch_slot(_FakeQ([{}]), 9))


def test_wait_slot_waits_for_our_batch_and_char_sheet_then_gap():
    busy = {"queue_running": [_q(1, "r", "outfit_qa_a")], "queue_pending": []}
    cs = {"queue_running": [], "queue_pending": [_q(2, "c", "u", prefix="ToIV_char_sheet_front")]}
    empty = {"queue_running": [], "queue_pending": [_q(3, "o", "someone")]}
    slept = []

    async def sl(s):
        slept.append(s)

    fq = _FakeQ([busy, cs, empty, empty])
    c = _run(ost.wait_qe_batch_slot(fq, 4, gap_s=15, poll_s=5, sleep=sl))
    assert c["ours"] == 0 and c["char_sheet"] == 0
    assert slept == [5, 5, 15] and fq.calls == 4


def test_wait_slot_gap_rechecks_char_sheet_arrival():
    empty = {"queue_running": [], "queue_pending": []}
    cs = {"queue_running": [], "queue_pending": [_q(2, "c", "u", prefix="ToIV_char_sheet_front")]}
    slept = []

    async def sl(s):
        slept.append(s)

    fq = _FakeQ([empty, cs, empty, empty])
    _run(ost.wait_qe_batch_slot(fq, 8, gap_s=15, poll_s=5, sleep=sl))
    assert slept == [15, 5, 15]


def test_wait_slot_timeout():
    busy = {"queue_running": [_q(1, "r", "outfit_qa_a")], "queue_pending": []}

    async def sl(s):
        pass

    with pytest.raises(TimeoutError):
        _run(ost.wait_qe_batch_slot(_FakeQ([busy]), 4, poll_s=5, max_wait_s=20, sleep=sl))


def test_vlm_batch_timeout_deletes_our_leftover_pending(monkeypatch):
    class C:
        deleted = None
        n = 0

        async def upload_image(self, b, name):
            return name

        async def queue_prompt(self, g, client_id):
            assert client_id.startswith("outfit_qa_")
            C.n += 1
            return f"pid{C.n}"

        async def get_history(self, pid):
            return {"pid1": {"outputs": {"3": {"text": ["否"]}}, "status": {"status_str": "success"}}} if pid == "pid1" else {}

        async def delete_from_queue(self, ids):
            C.deleted = ids

    import app.services.studio.character_sheet as cs_mod
    monkeypatch.setattr(cs_mod, "_extract_history_text", lambda e: "否")

    async def fast_sleep(s):
        pass

    monkeypatch.setattr(asyncio, "sleep", fast_sleep)
    out = _run(ost._ask_outfit_vlm_batch(C(), b"x", model="m", seed=1, timeout_s=4))
    assert out["hood_on_head"] == "否"
    assert C.deleted == ["pid2", "pid3", "pid4"]
    assert sum(1 for v in out.values() if v == "") == 3


def test_gate_script_submits_sequentially():
    src = (Path(__file__).resolve().parents[1] / "scripts" / "chybrid_ref_gate.py").read_text()
    assert "asyncio.gather" not in src and "await one(s)" in src
