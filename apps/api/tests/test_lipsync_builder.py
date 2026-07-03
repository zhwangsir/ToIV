"""LatentSync 对口型建图:seed 必须 uint32(≤2^32-1),否则 worker 拒→每段回退。"""
from app.workflows.lipsync import LatentSyncParams, build_latentsync_graph, MAX_SEED


def test_seed_within_uint32():
    # 真 bug 回归:MAX_SEED 曾是 2^63-1,LatentSyncNode 只收 uint32,导致对口型从不生效。
    assert MAX_SEED == 2**32 - 1
    for _ in range(50):
        p = LatentSyncParams(video="v.mp4", audio="a.wav")
        assert 0 <= p.seed <= 2**32 - 1


def test_graph_structure():
    g = build_latentsync_graph(LatentSyncParams(video="v.mp4", audio="a.wav", seed=123))
    types = {n["class_type"] for n in g.values()}
    assert {"VHS_LoadVideo", "LoadAudio", "LatentSyncNode", "VHS_VideoCombine"} <= types
    ks = next(n for n in g.values() if n["class_type"] == "LatentSyncNode")
    assert ks["inputs"]["seed"] == 123
