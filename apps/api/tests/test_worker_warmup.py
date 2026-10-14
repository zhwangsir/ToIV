"""预热提交的模型可见性门(worker_warmup)。

真机实证(2026-10-15):`ace_step_1.5_turbo_aio.safetensors` 只在 :8262/:8196 可见,
:8195/:8264 的 ckpt 列表是空的(H3 口只挂 h3/ 树)。旧实现取「第一个空闲候选」,
于是音乐预热图被打到 :8264,提交必 400 prompt_outputs_failed_validation,
每轮预热白刷一条 warning 且该口这一轮不再暖别的。
"""
from __future__ import annotations

from app.services import worker_warmup as ww

CKPT = "ace_step_1.5_turbo_aio.safetensors"
H3_URL = "http://100.68.100.90:8264"
UPSCALE_URL = "http://100.68.100.90:8262"

GRAPH = {
    "1": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": CKPT}},
    "2": {"class_type": "KSampler", "inputs": {"model": ["1", 0], "seed": 7}},
}


def _idle(monkeypatch):
    monkeypatch.setattr(ww, "fetch_queue", lambda url, timeout=5.0: _aq({"queue_running": [], "queue_pending": []}))
    monkeypatch.setattr(ww, "build_warmup_graph", lambda kind, seed: GRAPH)


async def _aq(value):
    return value


def test_required_ckpts_reads_graph_not_a_name_list():
    """按图里的字面值取,不硬编模型名清单(P-14)。"""
    assert ww._required_ckpts(GRAPH) == {CKPT}
    assert ww._required_ckpts({}) == set()
    # 非 CheckpointLoaderSimple / 非字面值(连线引用)都不算
    assert ww._required_ckpts(
        {
            "1": {"class_type": "LoraLoader", "inputs": {"ckpt_name": "x.safetensors"}},
            "2": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": ["9", 0]}},
        }
    ) == set()


async def test_visible_ckpts_empty_body_means_nothing_visible(monkeypatch):
    """/object_info/<未知类> 回 200+空体(P-16):按「一个都不可见」处理,不能当放行。"""

    class _Client:
        def __init__(self, base_url, timeout=30.0):
            pass

        async def object_info(self, node):
            return {}

    import app.comfy.client as comfy_client

    monkeypatch.setattr(comfy_client, "ComfyUIClient", _Client)
    assert await ww._visible_ckpts(H3_URL) == set()


async def test_visible_ckpts_probe_failure_is_undecidable(monkeypatch):
    """探测失败=None(不可判定),放行让提交端自己报错,别把网络抖动当成缺模型。"""

    class _Client:
        def __init__(self, base_url, timeout=30.0):
            pass

        async def object_info(self, node):
            raise RuntimeError("boom")

    import app.comfy.client as comfy_client

    monkeypatch.setattr(comfy_client, "ComfyUIClient", _Client)
    assert await ww._visible_ckpts(H3_URL) is None


async def test_warm_one_skips_worker_that_cannot_see_ckpt(monkeypatch):
    _idle(monkeypatch)
    monkeypatch.setattr(ww, "_visible_ckpts", lambda url, timeout=15.0: _aq(set()))

    async def _boom(*a, **k):  # 不该被调用
        raise AssertionError("不应向看不到 ckpt 的实例提交")

    monkeypatch.setattr(ww, "submit_prompt", _boom)
    out = await ww.warm_one(H3_URL, "audio", 1)
    assert out["status"] == "skipped_ckpt_not_visible"
    assert out["missing"] == [CKPT]


async def test_warm_one_submits_when_ckpt_visible(monkeypatch):
    _idle(monkeypatch)
    monkeypatch.setattr(ww, "_visible_ckpts", lambda url, timeout=15.0: _aq({CKPT}))
    sent = {}

    async def _submit(worker_url, graph, client_id):
        sent.update(worker_url=worker_url, graph=graph)
        return "pid-1"

    monkeypatch.setattr(ww, "submit_prompt", _submit)
    out = await ww.warm_one(UPSCALE_URL, "audio", 1)
    assert out["status"] == "submitted"
    assert sent["worker_url"] == UPSCALE_URL


async def test_warm_idle_capable_falls_through_to_capable_worker(monkeypatch):
    """第一个空闲但看不到 ckpt → 换下一个候选,而不是就此放弃这一轮。"""
    calls: list[str] = []

    async def _pick(candidates):
        return candidates[0] if candidates else None

    async def _warm_one(url, kind, seed):
        calls.append(url)
        if url == H3_URL:
            return {"worker": url, "kind": kind, "status": "skipped_ckpt_not_visible", "missing": [CKPT]}
        return {"worker": url, "kind": kind, "status": "submitted"}

    monkeypatch.setattr(ww, "pick_idle_warmup_worker", _pick)
    monkeypatch.setattr(ww, "warm_one", _warm_one)
    out = await ww._warm_idle_capable([H3_URL, UPSCALE_URL], "audio", 3)
    assert out["status"] == "submitted"
    assert calls == [H3_URL, UPSCALE_URL]


async def test_warm_idle_capable_reports_when_none_capable(monkeypatch):
    async def _pick(candidates):
        return candidates[0] if candidates else None

    async def _warm_one(url, kind, seed):
        return {"worker": url, "kind": kind, "status": "skipped_ckpt_not_visible", "missing": [CKPT]}

    monkeypatch.setattr(ww, "pick_idle_warmup_worker", _pick)
    monkeypatch.setattr(ww, "warm_one", _warm_one)
    out = await ww._warm_idle_capable([H3_URL], "audio", 3)
    assert out["status"] == "skipped_no_capable_worker"
    assert out["incapable"] == [H3_URL]
