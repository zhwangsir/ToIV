import pytest

from app.comfy.pool import WorkerPool


class FakeClient:
    """鸭子类型替身：只需提供 queue_len()。"""

    def __init__(self, name: str, qlen: int, fail: bool = False):
        self.name = name
        self._qlen = qlen
        self._fail = fail

    async def queue_len(self) -> int:
        if self._fail:
            raise RuntimeError("unreachable")
        return self._qlen


def test_empty_pool_rejected():
    with pytest.raises(ValueError):
        WorkerPool([])


async def test_single_worker_returned_without_query():
    c = FakeClient("only", qlen=99)
    pool = WorkerPool([c])
    assert await pool.pick() is c


async def test_picks_least_busy_worker():
    busy = FakeClient("busy", qlen=9)
    idle = FakeClient("idle", qlen=1)
    mid = FakeClient("mid", qlen=4)
    pool = WorkerPool([busy, idle, mid])
    assert (await pool.pick()) is idle


async def test_round_robin_on_ties():
    a = FakeClient("a", qlen=0)
    b = FakeClient("b", qlen=0)
    c = FakeClient("c", qlen=0)
    pool = WorkerPool([a, b, c])
    picks = [await pool.pick() for _ in range(4)]
    assert picks == [a, b, c, a]  # 负载相同则轮询分散


async def test_unreachable_worker_deprioritized():
    dead = FakeClient("dead", qlen=0, fail=True)
    alive = FakeClient("alive", qlen=7)
    pool = WorkerPool([dead, alive])
    assert (await pool.pick()) is alive


def test_from_urls_builds_one_client_per_url():
    pool = WorkerPool.from_urls(
        ["http://a:8000", "http://b:8001/"], timeout=5.0
    )
    assert [c.base_url for c in pool.clients] == ["http://a:8000", "http://b:8001"]


class ModelClient:
    """带模型清单的替身,用于测试模型感知调度。"""

    def __init__(self, name: str, qlen: int, models):
        self.name = name
        self._q = qlen
        self._m = set(models)

    async def queue_len(self) -> int:
        return self._q

    async def model_names(self):
        return self._m


async def test_pick_routes_to_capable_worker():
    a = ModelClient("a", 0, {"other.safetensors"})       # 更闲但缺模型
    b = ModelClient("b", 9, {"target.safetensors"})      # 较忙但有模型
    pool = WorkerPool([a, b])
    assert (await pool.pick(required={"target.safetensors"})) is b


async def test_pick_raises_when_no_capable_worker():
    from app.comfy.client import ComfyUIError

    pool = WorkerPool([ModelClient("a", 0, {"x"})])
    with pytest.raises(ComfyUIError):
        await pool.pick(required={"missing.safetensors"})
