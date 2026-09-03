"""WorkerPool 注册表动态跟随(ComfyUI-LB /admin/backends)单测。

覆盖场景:
1. 注册表新增成员 → 本轮 pick 即可被选中(探测/熔断照常管理)
2. 注册表移除成员 → 从池成员与内部状态清理
3. 拉取失败 → 记 warning 沿用现有成员(LB 挂不炸池)
4. 注册表返回空 backends → 沿用现有成员
5. TTL 内重复 pick 不重复拉取
6. 未配 registry_url → 零行为变化(不发起任何拉取)
7. deps.get_pool 透传 registry_url(空串 → None 不启用)
8. config 新字段默认值与 property 归一化
"""
from __future__ import annotations

from app.comfy.pool import WorkerPool

REG = "http://lb:8188/admin/backends"
A = "http://192.168.71.127:8196"
B = "http://192.168.71.116:8188"


class FakeClient:
    """鸭子类型替身:pick() 探测路径只需 base_url + queue_len()。"""

    def __init__(self, base_url: str, qlen: int = 0):
        self.base_url = base_url
        self._qlen = qlen

    async def queue_len(self) -> int:
        return self._qlen


def _make_pool(monkeypatch, clients, registry_result, *, ttl: float = 60.0):
    """构造启用注册表的池:拉取与 ComfyUIClient 构造函数均替身化(免真实 HTTP)。

    registry_result:list[str] 表示拉取成功;Exception 实例表示拉取失败。
    返回 (pool, fetch_calls) —— fetch_calls 记录拉取次数。
    """
    fetch_calls = {"n": 0}

    async def fake_fetch(self):
        fetch_calls["n"] += 1
        if isinstance(registry_result, Exception):
            raise registry_result
        return registry_result

    monkeypatch.setattr(WorkerPool, "_fetch_registry_urls", fake_fetch)
    # 注册表新增成员走 ComfyUIClient 构造,替身化避免真实 HTTP 探测
    monkeypatch.setattr(
        "app.comfy.pool.ComfyUIClient",
        lambda url, timeout=30.0: FakeClient(url),
    )
    pool = WorkerPool(clients, registry_url=REG, registry_ttl=ttl)
    return pool, fetch_calls


def _urls(pool: WorkerPool) -> list[str]:
    return [c.base_url for c in pool.clients]


async def test_registry_adds_new_member_pickable(monkeypatch):
    """注册表返回新后端 → 刷新后新成员进入池,且本轮 pick 即可被选中(最闲)。"""
    pool, calls = _make_pool(monkeypatch, [FakeClient(A, qlen=9)], [A, B])
    picked = await pool.pick()
    assert picked.base_url == B  # 新成员队列 0 < 老成员 9,最闲被选中
    assert _urls(pool) == [A, B]
    assert calls["n"] == 1


async def test_registry_removes_member(monkeypatch):
    """注册表不再返回某后端 → 该成员连同内部状态从池中清理。"""
    pool, _ = _make_pool(monkeypatch, [FakeClient(A), FakeClient(B)], [A])
    picked = await pool.pick()
    assert picked.base_url == A
    assert _urls(pool) == [A]


async def test_registry_fetch_failure_keeps_members(monkeypatch):
    """拉取失败(LB 挂)→ 沿用现有成员,pick 照常工作,不炸池。"""
    pool, calls = _make_pool(
        monkeypatch, [FakeClient(A), FakeClient(B)], RuntimeError("lb down")
    )
    picked = await pool.pick()
    assert picked.base_url in (A, B)
    assert _urls(pool) == [A, B]
    assert calls["n"] == 1


async def test_registry_empty_backends_keeps_members(monkeypatch):
    """注册表返回空 backends → 沿用现有成员(不清空池)。"""
    pool, _ = _make_pool(monkeypatch, [FakeClient(A), FakeClient(B)], [])
    await pool.pick()
    assert _urls(pool) == [A, B]


async def test_registry_ttl_caches_fetch(monkeypatch):
    """TTL 内重复 pick 不重复拉取注册表。"""
    pool, calls = _make_pool(monkeypatch, [FakeClient(A), FakeClient(B)], [A, B])
    await pool.pick()
    await pool.pick()
    assert calls["n"] == 1  # 第二次 pick 在 TTL(60s)内,未再拉取


async def test_no_registry_url_zero_behavior(monkeypatch):
    """未配 registry_url → 零行为变化:不发起任何拉取,成员进程内固定。"""
    async def forbidden_fetch(self):  # pragma: no cover - 被调用即失败
        raise AssertionError("未启用注册表时不应发起拉取")

    monkeypatch.setattr(WorkerPool, "_fetch_registry_urls", forbidden_fetch)
    c = FakeClient(A, qlen=99)
    pool = WorkerPool([c])  # 单 worker 快速路径
    assert (await pool.pick()) is c
    assert _urls(pool) == [A]
    assert pool.registry_url is None


def test_get_pool_passes_registry_url(monkeypatch):
    """deps.get_pool 把 settings.comfy_workers_registry_url 透传给 WorkerPool。"""
    from app import deps

    fake = type(
        "S",
        (),
        {
            "worker_urls": [A],
            "request_timeout": 5.0,
            "comfy_workers_registry_url": f" {REG} ",  # 带空白,应被 strip
        },
    )()
    monkeypatch.setattr("app.deps.get_settings", lambda: fake)
    deps.get_pool.cache_clear()
    try:
        pool = deps.get_pool()
        assert pool.registry_url == REG
    finally:
        deps.get_pool.cache_clear()


def test_get_pool_empty_registry_url_disabled(monkeypatch):
    """空串 registry_url → None(不启用),行为与现状完全一致。"""
    from app import deps

    fake = type(
        "S",
        (),
        {
            "worker_urls": [A],
            "request_timeout": 5.0,
            "comfy_workers_registry_url": "",
        },
    )()
    monkeypatch.setattr("app.deps.get_settings", lambda: fake)
    deps.get_pool.cache_clear()
    try:
        pool = deps.get_pool()
        assert pool.registry_url is None
    finally:
        deps.get_pool.cache_clear()


def test_config_new_fields_defaults():
    """config 新字段默认值:注册表默认空(不启用);InfiniteTalk 默认 :8201。

    经 model_fields 断言声明默认值,不受 .env/环境变量干扰。
    """
    from app.config import Settings

    assert Settings.model_fields["comfy_workers_registry_url"].default == ""
    assert (
        Settings.model_fields["infinitetalk_base_url"].default
        == "http://192.168.71.127:8201"
    )


def test_config_infinitetalk_base_property():
    """infinitetalk_base property 归一化(去空白与尾斜杠)。"""
    from app.config import Settings

    s = Settings(infinitetalk_base_url=" http://192.168.71.127:8201/ ")
    assert s.infinitetalk_base == "http://192.168.71.127:8201"


async def test_registry_loopback_urls_rewritten_to_registry_host(monkeypatch):
    """注册表里的 127.0.0.1/localhost 是 LB 本机视角;跨机消费方(core)必须改写到
    注册表主机,否则成员不可达白白熔断(2026-09-03 生产实证)。"""
    payload = {"backends": [
        {"url": "http://127.0.0.1:8196"},
        {"url": "http://localhost:8197/"},
        {"url": "http://192.168.71.116:8188"},
    ]}

    class FakeResp:
        def raise_for_status(self):
            pass

        def json(self):
            return payload

    class FakeHTTP:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def get(self, url):
            return FakeResp()

    monkeypatch.setattr("app.comfy.pool.httpx.AsyncClient", FakeHTTP)
    pool = WorkerPool(
        [FakeClient(A)], registry_url="http://192.168.71.127:8188/admin/backends"
    )
    urls = await pool._fetch_registry_urls()
    assert urls == [
        "http://192.168.71.127:8196",
        "http://192.168.71.127:8197",
        "http://192.168.71.116:8188",
    ]
