"""引擎注册插件化测试:EnginePlugin bootstrap 填充注册表 + profile 停用 + submit 绑定。

与 test_engine_registry.py 互补:
- test_engine_registry.py 验证注册表项业务语义(参数/探测/NSFW 过滤);
- 本文件验证插件化机制(注册表由 populate_registry 填充、profile 停用集、
  submit 绑定字段、字节级等价)。
"""
from __future__ import annotations

import pytest

from app.comfy.client import ComfyUIError
from app.comfy.pool import WorkerPool
from app.models import User
from app.nsfw_ctx import nsfw_intent_var
from app.services import engine_registry as er
from app.services.engine_registry import (
    _ensure_registry,
    _reset_registry_for_tests,
    get_disabled_engines,
    list_engines,
    populate_registry,
    set_disabled_engines,
)


def _by_id(engines: list[dict]) -> dict[str, dict]:
    return {e["id"]: e for e in engines}


@pytest.fixture(autouse=True)
def _reset_registry():
    """测试隔离:清空运行时注册表与停用集,用例结束恢复。"""
    _reset_registry_for_tests()
    yield
    _reset_registry_for_tests()


class _FakeClient:
    """worker 替身:queue_len 可达,不联网。"""

    def __init__(self, reachable: bool = True):
        self.base_url = "http://fake-worker"
        self._reachable = reachable

    async def queue_len(self) -> int:
        if not self._reachable:
            raise ComfyUIError("connection refused")
        return 0

    async def model_names(self) -> set[str]:
        return set()

    async def node_names(self) -> set[str]:
        return set()

    async def object_info(self, node: str) -> dict:
        return {}


@pytest.fixture()
def live_pool() -> WorkerPool:
    return WorkerPool([_FakeClient()])


@pytest.fixture()
def user() -> User:
    return User(id="u-1", email="tester", hashed_password="x", tenant_id="t-1")


# ---------------------------------------------------------------------------
# 注册表填充与等价
# ---------------------------------------------------------------------------


async def test_populate_registry_fills_entries(live_pool, user):
    """EnginePlugin bootstrap 填充后 list_engines 返回全部引擎条目。

    SFW 上下文 14 条(8 条 NSFW 引擎被过滤);R18 上下文 22 条全量(2026-08-26 +wan-transition)。
    """
    populate_registry()
    # SFW 上下文:NSFW 引擎(8 条)被过滤
    engines_sfw = await list_engines(live_pool, user)
    assert len(engines_sfw) == 14, f"SFW 引擎条目数应为 14,实得 {len(engines_sfw)}"

    # R18 上下文:全量 22 条
    token = nsfw_intent_var.set(True)
    try:
        engines_r18 = await list_engines(live_pool, user)
    finally:
        nsfw_intent_var.reset(token)
    assert len(engines_r18) == 22, f"R18 引擎条目数应为 22,实得 {len(engines_r18)}"

    # 含 submit 绑定(每条引擎都有)
    for e in engines_r18:
        assert "submit" in e, f"{e['id']} 缺 submit 字段"
        submit = e["submit"]
        assert "route" in submit and "kind" in submit
    # 代表性 submit 检查
    ids = _by_id(engines_r18)
    assert ids["txt2img"]["submit"] == {"route": "/api/generate/txt2img", "kind": "txt2img"}
    assert ids["h3-t2v"]["submit"] == {"route": "/api/h3/t2v", "kind": "h3-t2v"}
    assert ids["ace-music"]["submit"] == {"route": "/api/generate/audio", "kind": "audio"}


async def test_lazy_ensure_registry_no_double_fill(live_pool, user):
    """惰性填充不重复;多次 populate_registry 幂等(条目数不翻倍)。"""
    _ensure_registry()
    token = nsfw_intent_var.set(True)
    try:
        engines = await list_engines(live_pool, user)
    finally:
        nsfw_intent_var.reset(token)
    assert len(engines) == 22
    populate_registry()  # 再次调用不应重复
    token = nsfw_intent_var.set(True)
    try:
        engines2 = await list_engines(live_pool, user)
    finally:
        nsfw_intent_var.reset(token)
    assert len(engines2) == 22


# ---------------------------------------------------------------------------
# profile 停用引擎
# ---------------------------------------------------------------------------


async def test_disabled_engines_marked_unavailable(live_pool, user):
    """profile 停用的引擎 available=False,原因固定。"""
    populate_registry(disabled={"txt2img", "h3-t2v"})
    engines = await list_engines(live_pool, user)
    ids = _by_id(engines)
    assert ids["txt2img"]["available"] is False
    assert ids["txt2img"]["unavailable_reason"] == "disabled by profile"
    assert ids["h3-t2v"]["available"] is False
    assert ids["h3-t2v"]["unavailable_reason"] == "disabled by profile"
    # 未停用引擎仍正常
    assert ids["img2img"]["available"] is True


async def test_disabled_engines_set_and_get(live_pool, user):
    """set/get_disabled_engines 往返正确。"""
    populate_registry()
    assert get_disabled_engines() == set()
    set_disabled_engines({"ace-music"})
    assert get_disabled_engines() == {"ace-music"}


async def test_disabled_engines_skip_probe(live_pool, user, monkeypatch):
    """停用引擎直接标不可用,不触发探测(不新增探测调用)。"""
    calls = 0
    real = er._probe_pool

    async def _counting(pool, models, nodes):
        nonlocal calls
        calls += 1
        return await real(pool, models, nodes)

    monkeypatch.setattr(er, "_probe_pool", _counting)
    populate_registry(disabled={"txt2img", "img2img"})
    await list_engines(live_pool, user)
    # 仅 ace-music 走 _probe_pool 探测;txt2img/img2img 被停用不探
    assert calls == 1, f"停用引擎不应触发探测,实得 {calls} 次"


# ---------------------------------------------------------------------------
# submit 绑定在 R18 上下文也透传
# ---------------------------------------------------------------------------


async def test_submit_passthrough_in_r18_context(live_pool, user):
    """R18 上下文下 nsfw 引擎也带 submit 字段。"""
    populate_registry()
    token = nsfw_intent_var.set(True)
    try:
        engines = await list_engines(live_pool, user)
    finally:
        nsfw_intent_var.reset(token)
    ids = _by_id(engines)
    assert "submit" in ids["h3-nsfw-t2v"]
    assert ids["h3-nsfw-t2v"]["submit"]["route"].startswith("/api/")
