"""seed_policy: 未指定随机 / 指定可复现 / 连线不改。"""
from __future__ import annotations

from app.services.seed_policy import apply_seed_policy, collect_seed_leaves, parse_user_seed


def _music_like_graph(ksampler_seed: int = 42, encode_seed: int = 99) -> dict:
    return {
        "3": {
            "class_type": "TextEncodeAceStepAudio1.5",
            "inputs": {"tags": "lofi", "lyrics": "", "seed": encode_seed},
        },
        "6": {
            "class_type": "KSampler",
            "inputs": {
                "seed": ksampler_seed,
                "steps": 8,
                "model": ["2", 0],
            },
        },
        "25": {
            "class_type": "RandomNoise",
            "inputs": {"noise_seed": 7},
        },
        "linked": {
            "class_type": "KSampler",
            "inputs": {"seed": ["99", 0], "steps": 10},
        },
    }


def test_parse_user_seed_empty_and_int():
    assert parse_user_seed({}) is None
    assert parse_user_seed({"seed": ""}) is None
    assert parse_user_seed({"seed": "123"}) == 123
    assert parse_user_seed({"seed": 456}) == 456


def test_unspecified_randomizes_all_numeric_seed_leaves():
    g1 = _music_like_graph()
    g2 = _music_like_graph()
    s1 = apply_seed_policy(g1, {})
    s2 = apply_seed_policy(g2, {})
    assert s1 != s2
    assert g1["3"]["inputs"]["seed"] == s1
    assert g1["6"]["inputs"]["seed"] == s1
    assert g1["25"]["inputs"]["noise_seed"] == s1
    assert g1["linked"]["inputs"]["seed"] == ["99", 0]


def test_two_builds_differ_without_user_seed():
    """同卡连提两次种子不同(父代理 02:17 单测口径)。"""
    seeds = [apply_seed_policy(_music_like_graph(), {}) for _ in range(5)]
    assert len(set(seeds)) >= 2


def test_user_seed_reproducible_everywhere():
    g = _music_like_graph(1, 2)
    used = apply_seed_policy(g, {"seed": 424242})
    assert used == 424242
    assert g["3"]["inputs"]["seed"] == 424242
    assert g["6"]["inputs"]["seed"] == 424242
    assert g["25"]["inputs"]["noise_seed"] == 424242
    assert g["linked"]["inputs"]["seed"] == ["99", 0]


def test_collect_seed_leaves():
    g = _music_like_graph()
    leaves = collect_seed_leaves(g)
    keys = {(n, f) for n, f, _ in leaves}
    assert ("3", "seed") in keys
    assert ("25", "noise_seed") in keys
