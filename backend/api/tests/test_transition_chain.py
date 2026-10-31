"""quality.transition_chain 转场链评估测试。

覆盖:确定性 anchor_overlap_score(全匹配/部分/无锚点/硬切不计分)、
score_transition_chain 聚合与锚点匹配率、mock judge 注入(score/reason 透传、
硬切不调用、judge 故障回退确定性)、judge prompt 模板三维评估与 JSON 输出契约。
"""
from __future__ import annotations

import pytest

from app.quality.transition_chain import (
    ANCHOR_PASS_THRESHOLD,
    TRANSITION_JUDGE_PROMPT,
    anchor_overlap_score,
    score_transition_chain,
)


# ── anchor_overlap_score:确定性预检 ─────────────────────────────────────
def test_anchor_overlap_full_match():
    prev = {"seam_to_next": "matchcut", "seam_anchor": "猩红刀痕横贯画面中央"}
    nxt = {"prompt": "完全相同的猩红刀痕横贯画面中央,随后向上下分离"}
    score = anchor_overlap_score(prev, nxt)
    assert score is not None
    assert score >= ANCHOR_PASS_THRESHOLD


def test_anchor_overlap_partial():
    prev = {"seam_to_next": "overlap", "seam_anchor": "女主瞳孔中的弦月高光"}
    nxt = {"prompt": "瞳孔中的高光拉长变成刀光,斜线二维放大"}
    score = anchor_overlap_score(prev, nxt)
    assert score is not None
    assert 0.0 < score < 1.0


def test_anchor_overlap_no_anchor_scores_zero():
    """声明了软转场却没有 seam_anchor:计 0 分(不达标),不是 None。"""
    prev = {"seam_to_next": "matchcut"}
    nxt = {"prompt": "任何开头"}
    assert anchor_overlap_score(prev, nxt) == 0.0


def test_anchor_overlap_hard_cut_not_scored():
    """硬切/未声明软转场:返回 None 不计分。"""
    nxt = {"prompt": "猩红刀痕横贯画面中央"}
    assert anchor_overlap_score({"seam_to_next": "cut", "seam_anchor": "猩红刀痕"}, nxt) is None
    assert anchor_overlap_score({"seam_anchor": "猩红刀痕"}, nxt) is None  # 缺 seam_to_next


def test_anchor_overlap_uses_next_anchor_field():
    """next.anchor 字段(锚点词)与 prompt 开头合并参与重合计算。"""
    prev = {"seam_to_next": "matchcut", "seam_anchor": "断裂圆环"}
    nxt = {"anchor": "断裂圆环", "prompt": "完全无关的画面描述"}
    assert anchor_overlap_score(prev, nxt) > 0.0


# ── score_transition_chain:聚合 ─────────────────────────────────────────
_CHAIN = [
    {"prompt": "拔刀,刀光横扫", "seam_to_next": "matchcut", "seam_anchor": "猩红刀痕横贯画面中央"},
    {"prompt": "完全相同的猩红刀痕横贯画面中央,随后分离", "seam_to_next": "matchcut", "seam_anchor": "断裂圆环"},
    {"prompt": "一只机械蝴蝶落在窗台"},
]


def test_chain_deterministic_aggregation():
    r = score_transition_chain(_CHAIN)
    assert r["total_seams"] == 2
    assert r["scored_seams"] == 2
    assert r["passed_seams"] == 1  # 缝0 达标;缝1(断裂圆环 vs 机械蝴蝶)无重合
    assert r["anchor_match_rate"] == pytest.approx(0.5)
    assert r["threshold"] == ANCHOR_PASS_THRESHOLD
    assert r["seams"][0]["score"] >= ANCHOR_PASS_THRESHOLD
    assert r["seams"][1]["score"] == 0.0


def test_chain_hard_cut_excluded_from_scoring():
    shots = [
        {"prompt": "拔刀", "seam_to_next": "matchcut", "seam_anchor": "猩红刀痕横贯画面中央"},
        {"prompt": "完全相同的猩红刀痕横贯画面中央", "seam_to_next": "cut"},
        {"prompt": "黑场后全新场景"},
    ]
    r = score_transition_chain(shots)
    assert r["total_seams"] == 2
    assert r["scored_seams"] == 1
    assert r["seams"][1]["scored"] is False
    assert r["seams"][1]["score"] is None
    assert r["anchor_match_rate"] == pytest.approx(0.5)  # 达标接缝/总接缝


def test_chain_single_shot_vacuous_pass():
    r = score_transition_chain([{"prompt": "孤镜"}])
    assert r["total_seams"] == 0
    assert r["anchor_match_rate"] == 1.0


# ── judge 注入(LLM-as-judge)────────────────────────────────────────────
def test_chain_mock_judge_score_and_reason_passthrough():
    calls: list[tuple[dict, dict]] = []

    def fake_judge(prev, nxt):
        calls.append((prev, nxt))
        return {"score": 0.9, "reason": "锚点/运动/主体三连继承"}

    r = score_transition_chain(_CHAIN, judge=fake_judge)
    assert len(calls) == 2  # 两条计分接缝都走 judge
    assert r["seams"][0]["score"] == 0.9
    assert r["seams"][0]["reason"] == "锚点/运动/主体三连继承"
    assert r["passed_seams"] == 2
    assert r["anchor_match_rate"] == 1.0


def test_chain_judge_not_called_for_hard_cut():
    calls: list = []

    def fake_judge(prev, nxt):
        calls.append(1)
        return {"score": 1.0, "reason": "不应出现"}

    shots = [
        {"prompt": "a", "seam_to_next": "cut"},
        {"prompt": "b"},
    ]
    r = score_transition_chain(shots, judge=fake_judge)
    assert calls == []  # 硬切不调用 judge
    assert r["scored_seams"] == 0


def test_chain_judge_failure_falls_back_to_deterministic():
    def broken_judge(prev, nxt):
        raise RuntimeError("LLM 超时")

    r = score_transition_chain(_CHAIN, judge=broken_judge)
    assert r["seams"][0]["score"] >= ANCHOR_PASS_THRESHOLD  # 回退确定性预检
    assert "回退" in r["seams"][0]["reason"]
    assert r["seams"][1]["score"] == 0.0


def test_chain_judge_score_clamped():
    def wild_judge(prev, nxt):
        return {"score": 7.5, "reason": "越界"}

    r = score_transition_chain(_CHAIN[:2], judge=wild_judge)
    assert r["seams"][0]["score"] == 1.0


# ── judge prompt 模板契约 ───────────────────────────────────────────────
def test_judge_prompt_contract():
    for key in ("锚点连续性", "运动方向继承", "主体一致性", "JSON", "score", "reason"):
        assert key in TRANSITION_JUDGE_PROMPT
    out = TRANSITION_JUDGE_PROMPT.format(
        prev_anchor="猩红刀痕", prev_tail="刀痕静止", next_head="刀痕分离"
    )
    assert "猩红刀痕" in out
    assert '{"score"' in out  # 转义双括号渲染为 JSON 示例


# ── R5.1:gateway 接线(advisory)─────────────────────────────────────────
def test_gateway_report_includes_transitions():
    """R5.1:run_quality_checks 报告携带 transitions 转场链评估(advisory 字段)。"""
    from app.quality.gateway import run_quality_checks

    shots = [
        {
            "scene": "巷口", "description": "阿明拔刀冲出巷口,镜头急推",
            "prompt": "拔刀,刀光横扫,动态模糊", "camera": "急推",
            "dialogue": "看招!", "motion": "拔刀冲刺", "duration_sec": 6,
            "seam_to_next": "matchcut", "seam_anchor": "猩红刀痕横贯画面中央",
        },
        {
            "scene": "院中", "description": "刀痕分离,敌人现身",
            "prompt": "完全相同的猩红刀痕横贯画面中央,随后分离", "camera": "环绕",
            "dialogue": "", "motion": "刀光散去", "duration_sec": 7,
        },
    ]
    report = run_quality_checks(shots)
    body = report.to_dict()
    assert "transitions" in body
    t = body["transitions"]
    assert t["total_seams"] == 1
    assert t["scored_seams"] == 1
    assert t["seams"][0]["score"] >= ANCHOR_PASS_THRESHOLD
    # advisory:转场链得分不参与阻断(passed 只看三重防线)
    assert report.passed == (not report.blocking_reason)


def test_gateway_transitions_advisory_no_seam_declared():
    """无 seam 声明的分镜(如 manju):全链不计分,不影响 passed/blocking_reason。"""
    from app.quality.gateway import run_quality_checks

    shots = [
        {
            "scene": "街头", "description": "楚生奔跑穿过街道,人群惊呼",
            "prompt": "楚生 running fast on street", "camera": "跟拍特写",
            "dialogue": "站住!", "motion": "快速奔跑", "duration_sec": 6,
        },
        {
            "scene": "仓库", "description": "两人对峙,剑拔弩张",
            "prompt": "楚生 confronts the stranger in warehouse", "camera": "全景环绕",
            "dialogue": "你逃不掉。", "motion": "拔枪", "duration_sec": 8,
        },
    ]
    report = run_quality_checks(shots)
    t = report.to_dict()["transitions"]
    assert t["total_seams"] == 1
    assert t["scored_seams"] == 0  # 硬切/未声明不计分
    assert t["anchor_match_rate"] == 0.0  # 达标接缝/总接缝,无达标 → 0
    assert report.passed  # advisory 不阻断
