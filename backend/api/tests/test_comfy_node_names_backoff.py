"""node_names 全量 /object_info:长超时 + 进程级缓存 + 单飞 + 失败退避。

回归 2026-10-05 :8197 被拖死:object_info 60–105s,30s 超时后每轮重发、实例主线程被扫描占满。
"""
import asyncio

import pytest

from app.comfy import client as cmod
from app.comfy.client import ComfyUIClient, ComfyUIError


@pytest.fixture(autouse=True)
def _reset():
    cmod._nodes_shared.clear()
    cmod._nodes_fail.clear()
    cmod._nodes_inflight.clear()
    yield
    cmod._nodes_shared.clear()
    cmod._nodes_fail.clear()
    cmod._nodes_inflight.clear()


def _patch(monkeypatch, behaviour):
    calls = []

    async def fake_get_json(self, path, timeout=None):
        calls.append((self.base_url, path, timeout))
        return await behaviour(path)

    monkeypatch.setattr(ComfyUIClient, "_get_json", fake_get_json)
    return calls


@pytest.mark.asyncio
async def test_full_object_info_uses_long_timeout_and_shared_cache(monkeypatch):
    async def ok(path):
        return {"KSampler": {}, "VHS_VideoCombine": {}}

    calls = _patch(monkeypatch, ok)
    a = await ComfyUIClient("http://w:8197").node_names()
    # 新实例(短命客户端)也命中进程级缓存
    b = await ComfyUIClient("http://w:8197").node_names()
    assert a == b == {"KSampler", "VHS_VideoCombine"}
    assert len(calls) == 1
    assert calls[0][1] == "/object_info" and calls[0][2] >= 180


@pytest.mark.asyncio
async def test_failure_backs_off_without_network(monkeypatch):
    async def boom(path):
        raise ComfyUIError("请求 /object_info 失败: ")

    calls = _patch(monkeypatch, boom)
    c = ComfyUIClient("http://w:8197")
    with pytest.raises(ComfyUIError):
        await c.node_names()
    for _ in range(20):  # 探测风暴:退避期内一次网络都不发
        with pytest.raises(ComfyUIError, match="退避"):
            await ComfyUIClient("http://w:8197").node_names()
    assert len(calls) == 1
    until, backoff = cmod._nodes_fail["http://w:8197"]
    assert backoff == cmod._NODES_FAIL_BACKOFF_MIN


@pytest.mark.asyncio
async def test_backoff_doubles_and_caps(monkeypatch):
    async def boom(path):
        raise ComfyUIError("x")

    _patch(monkeypatch, boom)
    url = "http://w:8197"
    seen = []
    for _ in range(6):
        cmod._nodes_fail[url] = (0.0, cmod._nodes_fail.get(url, (0, 0))[1]) if url in cmod._nodes_fail else None
        if cmod._nodes_fail[url] is None:
            del cmod._nodes_fail[url]
        with pytest.raises(ComfyUIError):
            await ComfyUIClient(url).node_names()
        seen.append(cmod._nodes_fail[url][1])
    assert seen[:3] == [300.0, 600.0, 1200.0]
    assert max(seen) == cmod._NODES_FAIL_BACKOFF_MAX


@pytest.mark.asyncio
async def test_stale_set_served_when_refresh_fails(monkeypatch):
    state = {"fail": False}

    async def maybe(path):
        if state["fail"]:
            raise ComfyUIError("timeout")
        return {"A": {}}

    calls = _patch(monkeypatch, maybe)
    url = "http://w:8197"
    assert await ComfyUIClient(url).node_names() == {"A"}
    # 过期 + 刷新失败 → 返回旧集合,不把路由打成"缺节点"
    ts, names = cmod._nodes_shared[url]
    cmod._nodes_shared[url] = (ts - cmod._NODES_TTL - 1, names)
    state["fail"] = True
    assert await ComfyUIClient(url).node_names() == {"A"}
    # 退避期内继续旧集合且不发请求
    assert await ComfyUIClient(url).node_names() == {"A"}
    assert len(calls) == 2


@pytest.mark.asyncio
async def test_concurrent_callers_single_flight(monkeypatch):
    gate = asyncio.Event()

    async def slow(path):
        await gate.wait()
        return {"N": {}}

    calls = _patch(monkeypatch, slow)
    tasks = [asyncio.create_task(ComfyUIClient("http://w:8197").node_names()) for _ in range(8)]
    await asyncio.sleep(0.01)
    gate.set()
    res = await asyncio.gather(*tasks)
    assert all(r == {"N"} for r in res)
    assert len(calls) == 1


@pytest.mark.asyncio
async def test_concurrent_callers_share_failure(monkeypatch):
    gate = asyncio.Event()

    async def slow_fail(path):
        await gate.wait()
        raise ComfyUIError("dead")

    calls = _patch(monkeypatch, slow_fail)
    tasks = [asyncio.create_task(ComfyUIClient("http://w:8197").node_names()) for _ in range(5)]
    await asyncio.sleep(0.01)
    gate.set()
    res = await asyncio.gather(*tasks, return_exceptions=True)
    assert all(isinstance(r, ComfyUIError) for r in res)
    assert len(calls) == 1
