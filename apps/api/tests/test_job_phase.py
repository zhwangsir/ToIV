"""job_phase + worker_warmup 纯函数/图构造单测。"""
from __future__ import annotations

from app.services.job_phase import (
    PHASE_GENERATING,
    PHASE_HELD,
    PHASE_LOADING,
    PHASE_QUEUED,
    enrich_progress_snap,
    phase_label,
    resolve_phase,
)
from app.services.worker_warmup import _queue_busy, build_warmup_graph


def test_phase_label_known():
    assert "加载模型" in phase_label(PHASE_LOADING)
    assert phase_label(PHASE_GENERATING) == "生成中"
    assert phase_label(PHASE_QUEUED) == "排队中"
    assert phase_label(None) == "排队中"


def test_resolve_phase_priority():
    assert resolve_phase(status="held") == PHASE_HELD
    assert resolve_phase(status="running", has_step_progress=True) == PHASE_GENERATING
    assert resolve_phase(status="running", has_step_progress=False) == PHASE_LOADING
    assert resolve_phase(status="queued", saw_executing=True) == PHASE_LOADING
    assert resolve_phase(status="queued", queue_pos=2) == PHASE_QUEUED
    assert resolve_phase(status="queued", queue_pos=0) == PHASE_QUEUED


def test_enrich_progress_snap_derives_label():
    snap = enrich_progress_snap({"step": 3, "total": 20, "queue_pos": 0}, status="running")
    assert snap["phase"] == PHASE_GENERATING
    assert snap["phase_label"] == "生成中"
    snap2 = enrich_progress_snap({"saw_executing": True}, status="running")
    assert snap2["phase"] == PHASE_LOADING
    assert "加载模型" in snap2["phase_label"]


def test_queue_busy_helpers():
    assert _queue_busy(None) is True
    assert _queue_busy({"queue_running": [], "queue_pending": []}) is False
    assert _queue_busy({"queue_running": [1], "queue_pending": []}) is True
    assert _queue_busy({"queue_running": [], "queue_pending": [1]}) is True


def test_build_warmup_graphs_have_seed_and_prefix():
    g = build_warmup_graph("txt2img", 42)
    assert isinstance(g, dict) and g
    # KSampler seed
    seeds = []
    for node in g.values():
        if not isinstance(node, dict):
            continue
        inp = node.get("inputs") or {}
        for k in ("seed", "noise_seed"):
            if k in inp and not isinstance(inp[k], list):
                seeds.append(int(inp[k]))
    assert 42 in seeds
    prefixes = [
        (node.get("inputs") or {}).get("filename_prefix")
        for node in g.values()
        if isinstance(node, dict)
    ]
    assert any(isinstance(p, str) and p.startswith("ToIV_warmup/") for p in prefixes)

    g2 = build_warmup_graph("audio", 7)
    assert any(
        n.get("class_type") == "TextEncodeAceStepAudio1.5"
        for n in g2.values()
        if isinstance(n, dict)
    )

    g3 = build_warmup_graph("h3-t2v", 9)
    assert isinstance(g3, dict) and len(g3) >= 3
