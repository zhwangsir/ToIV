"""/queue 单飞 + 短缓存：worker 挂起时同一 base_url 只保留 1 条在途请求。"""
from __future__ import annotations

import asyncio

import pytest

from app.comfy import client as cc
from app.comfy.client import ComfyUIClient, ComfyUIError


def _mk(url="http://w:1"):
    return ComfyUIClient(url)


def test_concurrent_callers_share_one_request(monkeypatch):
    calls = {"n": 0}

    async def fake_get_json(self, path, timeout=None):
        calls["n"] += 1
        await asyncio.sleep(0.05)
        return {"queue_running": [[0, "a"]], "queue_pending": [[1, "b"], [2, "c"]]}

    monkeypatch.setattr(ComfyUIClient, "_get_json", fake_get_json)

    async def run():
        c = _mk()
        return await asyncio.gather(
            *[c.queue_len() for _ in range(6)], c.queue_counts(), c.get_queue(), c.get_queue_detail()
        )

    res = asyncio.run(run())
    assert calls["n"] == 1
    assert res[:6] == [3] * 6
    assert res[6] == (1, 2)
    assert res[7] == {"a", "b", "c"}
    assert res[8] == ({"a"}, {"b": 1, "c": 2})


def test_failure_shared_and_cached_then_expires(monkeypatch):
    calls = {"n": 0}
    state = {"fail": True}

    async def fake_get_json(self, path, timeout=None):
        calls["n"] += 1
        await asyncio.sleep(0.02)
        if state["fail"]:
            raise ComfyUIError("请求 /queue 失败: timeout")
        return {"queue_running": [], "queue_pending": []}

    monkeypatch.setattr(ComfyUIClient, "_get_json", fake_get_json)
    monkeypatch.setattr(cc, "_QUEUE_TTL", 0.2)

    async def run():
        c = _mk()
        r = await asyncio.gather(*[c.queue_len() for _ in range(5)], return_exceptions=True)
        assert all(isinstance(x, ComfyUIError) for x in r)
        assert calls["n"] == 1
        with pytest.raises(ComfyUIError):  # 缓存期内失败直接复用，不再打 worker
            await c.queue_len()
        assert calls["n"] == 1
        state["fail"] = False
        await asyncio.sleep(0.25)
        assert await c.queue_len() == 0
        assert calls["n"] == 2

    asyncio.run(run())


def test_different_workers_not_shared(monkeypatch):
    seen = []

    async def fake_get_json(self, path, timeout=None):
        seen.append(self.base_url)
        return {"queue_running": [], "queue_pending": []}

    monkeypatch.setattr(ComfyUIClient, "_get_json", fake_get_json)

    async def run():
        await asyncio.gather(_mk("http://a:1").queue_len(), _mk("http://b:1").queue_len())

    asyncio.run(run())
    assert sorted(seen) == ["http://a:1", "http://b:1"]


def test_cache_expires_and_refetches(monkeypatch):
    n = {"v": 0}

    async def fake_get_json(self, path, timeout=None):
        n["v"] += 1
        return {"queue_running": [], "queue_pending": [[i, str(i)] for i in range(n["v"])]}

    monkeypatch.setattr(ComfyUIClient, "_get_json", fake_get_json)
    monkeypatch.setattr(cc, "_QUEUE_TTL", 0.05)

    async def run():
        c = _mk()
        assert await c.queue_len() == 1
        assert await c.queue_len() == 1
        await asyncio.sleep(0.08)
        assert await c.queue_len() == 2

    asyncio.run(run())


def test_leader_cancel_does_not_wedge(monkeypatch):
    async def slow(self, path, timeout=None):
        await asyncio.sleep(10)

    monkeypatch.setattr(ComfyUIClient, "_get_json", slow)

    async def run():
        c = _mk()
        t = asyncio.create_task(c.queue_len())
        await asyncio.sleep(0.01)
        t.cancel()
        with pytest.raises(asyncio.CancelledError):
            await t
        assert not cc._queue_inflight

        async def ok(self, path, timeout=None):
            return {"queue_running": [], "queue_pending": []}

        monkeypatch.setattr(ComfyUIClient, "_get_json", ok)
        assert await c.queue_len() == 0

    asyncio.run(run())
