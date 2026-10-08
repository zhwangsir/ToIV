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
    assert c["char_sheet"] == 2 and c["char_sheet_pending"] == 2 and c["ours"] == 3 and c["ours_pending_ids"] == ["p1", "p2"]


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
    assert c["ours"] == 0 and c["char_sheet_pending"] == 0
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


# ---- 05:19 方案1：戴帽参考（第一问期望反转，其余不变） ----

def test_verdict_hood_up_q1_and_q4_change_only():
    # 05:48 方案D：Q1 期望「是」；Q4 改为「与镜0一致或被帽兜遮住」（是/否）；Q2/Q3/脸分不变
    ans = {"hood_on_head": "是", "same_jacket": "是", "accessories": "否", "hairstyle": "是"}
    v = ost.outfit_vlm_verdict(ans, 0.8, hood="up")
    assert v["pass"] and v["hood"] == "up"
    q4 = next(c for c in v["checks"] if c["key"] == "hairstyle")
    assert "被帽兜遮住" in q4["question"] and q4["want"] == "是"
    assert ost.outfit_vlm_verdict({**ans, "hairstyle": "否"}, 0.8, hood="up")["failed"] == ["hairstyle"]
    assert ost.outfit_vlm_verdict({**ans, "same_jacket": "否"}, 0.8, hood="up")["failed"] == ["same_jacket"]
    assert ost.outfit_vlm_verdict({**ans, "accessories": "是"}, 0.8, hood="up")["failed"] == ["accessories"]
    assert ost.outfit_vlm_verdict(ans, 0.74, hood="up")["failed"] == ["face_sim"]
    # hood=down 口径不变
    down = ost.outfit_vlm_verdict({"hood_on_head": "否", "same_jacket": "是", "accessories": "否", "hairstyle": "马尾"}, 0.8)
    assert down["pass"]
    assert [q[0] for q in ost.vlm_questions("up")] == [q[0] for q in ost.OUTFIT_VLM_QUESTIONS]
    assert ost.vlm_questions("down") is ost.OUTFIT_VLM_QUESTIONS


def test_verdict_hood_invalid():
    with pytest.raises(ValueError):
        ost.outfit_vlm_verdict({}, 0.8, hood="half")


def test_scene_ref_gate_passes_hood():
    import cv2
    import numpy as np
    ok, enc = cv2.imencode(".png", np.zeros((8, 8, 3), np.uint8))

    async def ask(b):
        return {"hood_on_head": "是", "same_jacket": "是", "accessories": "否", "hairstyle": "是"}

    v = asyncio.run(ost.scene_ref_gate(enc.tobytes(), enc.tobytes(), ask_fn=ask, face_fn=lambda a, b: 0.9, hood="up"))
    assert v["pass"] and v["hood"] == "up"


def test_wait_slot_running_char_sheet_does_not_starve():
    run_cs = {"queue_running": [_q(1, "c", "u", prefix="ToIV_char_sheet_front")], "queue_pending": []}
    slept = []

    async def sl(s):
        slept.append(s)

    c = asyncio.run(ost.wait_qe_batch_slot(_FakeQ([run_cs, run_cs]), 4, gap_s=15, poll_s=5, sleep=sl))
    assert slept == [15] and c["char_sheet"] == 1 and c["char_sheet_pending"] == 0


# ---- 05:48 视频级帽兜门禁 ----

def _mk_video(path, n=40):
    import cv2
    import numpy as np
    vw = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"mp4v"), 24, (64, 112))
    for i in range(n):
        vw.write(np.full((112, 64, 3), i * 5 % 255, np.uint8))
    vw.release()
    return path


def test_hood_frame_indices_le8_and_skip():
    idx = ost.hood_frame_indices(353, skip_until_frame=12)
    assert len(idx) == 8 and idx[0] == 12 and idx[-1] == 352
    assert len(ost.hood_frame_indices(353, samples=20)) == 8  # 一批 ≤8
    assert ost.hood_frame_indices(0) == []


def test_hood_video_gate_all_up_passes(tmp_path):
    v = _mk_video(tmp_path / "a.mp4")
    seen = {}

    def ask(pngs):
        seen["n"] = len(pngs)
        return ['[\n "\\u662f"\n]'] * len(pngs)  # PreviewAny 转义「是」

    g = ost.hood_video_gate(v, expect="up", skip_until_frame=3, ask_fn=ask)
    assert seen["n"] <= 8 and g["blocked"] is False and g["n_ok"] == len(g["frames"])


def test_hood_video_gate_hood_falls_off_blocked(tmp_path):
    v = _mk_video(tmp_path / "b.mp4")

    async def ask(pngs):  # 异步也支持；第 6 帧起帽兜放下
        return ["是"] * 5 + ["否"] * (len(pngs) - 5)

    g = ost.hood_video_gate(v, expect="up", ask_fn=ask)
    assert g["blocked"] is True and g["n_bad"] == len(g["frames"]) - 5


def test_hood_video_gate_unknown_or_error_fail_closed(tmp_path):
    v = _mk_video(tmp_path / "c.mp4")
    g = ost.hood_video_gate(v, ask_fn=lambda p: ["是"] * (len(p) - 1) + [""])
    assert g["blocked"] and g["n_unknown"] == 1

    def boom(p):
        raise RuntimeError("8262 down")

    g2 = ost.hood_video_gate(v, ask_fn=boom)
    assert g2["blocked"] and "8262 down" in g2["error"]
    assert ost.hood_video_gate(tmp_path / "missing.mp4", ask_fn=boom)["blocked"]


def test_pick_hood_gate_blocks_and_raises(monkeypatch, tmp_path):
    from app.services.studio import candidate_pick as cp
    from app.services.studio import hard_cut as hcm

    ref = tmp_path / "ref.png"
    ref.write_bytes(b"x")
    cands = []
    for k in ("fall", "keep"):
        p = tmp_path / f"{k}.mp4"
        p.write_bytes(b"v")
        cands.append({"id": k, "status": "done", "url": str(p), "first_frame": "ff.png"})
    faces = {"fall": 0.8, "keep": 0.6}
    monkeypatch.setattr(cp, "_try_import_face", lambda: True)
    monkeypatch.setattr(cp, "score_video_face", lambda path, ref_image_path, **kw: {
        "face_mean": faces[Path(path).stem], "facecrop_mean": faces[Path(path).stem],
        "burnin_penalty": 0.0, "ocr_penalty": 0.0, "error": "", "score_backend": "insightface"})
    monkeypatch.setattr(cp, "score_scene_continuity", lambda *a, **k: {"continuity": None, "regression": None, "error": "skip"})
    monkeypatch.setattr(cp, "garment_brand_ocr_hit", lambda path, **kw: {"hit": False, "kind": "", "text": "", "frames_checked": 1, "error": ""})
    monkeypatch.setattr(hcm, "detect_hard_cuts", lambda path: {"cuts": [], "fps": 24.0, "n_frames": 362, "error": ""})
    calls = []

    def hg(path, expect, skip_until_frame):
        calls.append((Path(path).stem, expect))
        bad = Path(path).stem == "fall"
        return {"blocked": bad, "n_bad": 3 if bad else 0, "n_unknown": 0, "frames": []}

    win, out = cp.pick_best_candidate([dict(c) for c in cands], ref_image_path=ref, hood_log=False,
                                      hood_expect="up", hood_gate_fn=hg)
    assert win == "keep" and ("fall", "up") in calls
    assert next(c for c in out if c["id"] == "fall")["hood_gate"]["blocked"]
    with pytest.raises(cp.CandidatePickError, match="帽兜中途滑落"):
        cp.pick_best_candidate([dict(c) for c in cands], ref_image_path=ref, hood_log=False,
                               hood_expect="up", hood_gate_fn=lambda p, expect, skip_until_frame: {"blocked": True, "n_bad": 1, "n_unknown": 0})
    # 默认不启用：不调用门禁
    calls.clear()
    monkeypatch.setattr(ost, "HOOD_GATE_EXPECT", None)
    cp.pick_best_candidate([dict(c) for c in cands], ref_image_path=ref, hood_log=False, hood_gate_fn=hg)
    assert calls == []
    # 驱动设置全局后生效
    monkeypatch.setattr(ost, "HOOD_GATE_EXPECT", "up")
    win2, _ = cp.pick_best_candidate([dict(c) for c in cands], ref_image_path=ref, hood_log=False, hood_gate_fn=hg)
    assert win2 == "keep"


def test_prompt_hood_up_has_no_hood_down_clause():
    from app.services.studio import prompt_c

    p = prompt_c.build_c_visual_prompt(
        shot_prompt="Lin Xia at the store entrance, black windbreaker hood UP covering the top of her head",
        outfit_desc="纯黑无 logo 无字的连帽风衣")
    body = p.split("Avoid:")[0]
    assert prompt_c.C_HOOD_STAYS_UP in body and "never lower or remove the hood" in body and "帽兜不滑落不放下" in body
    assert "单一连续镜头、无切镜" in body and body.count(prompt_c.C_HOOD_STAYS_UP) == 1
    p2 = prompt_c.build_c_visual_prompt(shot_prompt="aisle, hood down")
    assert prompt_c.C_HOOD_STAYS_UP not in p2


def test_driver_has_hood_and_first_frame_flags():
    src = (Path(__file__).resolve().parents[1] / "scripts" / "chybrid_rain_cmp_driver.py").read_text()
    for flag in ("--hood-expect", "--first-frame-override", "--rerender-from", "HOOD_GATE_EXPECT", "reset_backup"):
        assert flag in src
