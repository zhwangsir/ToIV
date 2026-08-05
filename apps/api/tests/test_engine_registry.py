"""引擎注册表端点(GET /api/models/engines)测试。

覆盖:
  · 结构:四个首批引擎(txt2img/img2img/ltx2-t2v/ltx2-i2v)+ h3-t2v/h3-i2v 条目,
    每项含 id/label/kind/available/nsfw/params;params 元素 type 在允许集合内
  · NSFW 过滤:SFW 上下文无 nsfw 引擎、ltx2 unet 选项剔除 10eros;
    R18 上下文(nsfw_intent_var 置位)nsfw 引擎出现、10eros 选项保留
  · 可用性:fake pool 可达且模型/节点齐 → available=True;
    全不可达 → available=False + unavailable_reason;
    h3 走独立实例探测(h3_stub 替身),与 pool 死活无关
"""
from __future__ import annotations

from types import SimpleNamespace

import pytest

from app.comfy.client import ComfyUIError
from app.comfy.pool import WorkerPool
from app.models import User
from app.nsfw_ctx import nsfw_intent_var
from app.services import engine_registry
from app.services.engine_registry import list_engines

_GEMMA = "gemma3_12b_it_bf16/model.safetensors"
_VAE = "LTX23_video_vae_bf16.safetensors"
_DISTILLED = "ltx-2.3-distilled.safetensors"
_EROS = "10eros_v14.safetensors"

_ALLOWED_TYPES = {"text", "textarea", "number", "select", "switch", "images"}


class _FakeClient:
    """worker 替身:queue_len/model_names/node_names 可控,不联网。"""

    def __init__(self, models: set[str], nodes: set[str], reachable: bool = True):
        self.base_url = "http://fake-worker"
        self._models = models
        self._nodes = nodes
        self._reachable = reachable

    async def queue_len(self) -> int:
        if not self._reachable:
            raise ComfyUIError("connection refused")
        return 0

    async def model_names(self) -> set[str]:
        if not self._reachable:
            raise ComfyUIError("connection refused")
        return set(self._models)

    async def node_names(self) -> set[str]:
        if not self._reachable:
            raise ComfyUIError("connection refused")
        return set(self._nodes)


def _ltx_nodes() -> set[str]:
    from app.capabilities import required_nodes

    return required_nodes("ltx_t2v") | required_nodes("ltx_i2v")


@pytest.fixture
def user() -> User:
    return User(id="u-1", email="tester", hashed_password="x", tenant_id="t-1")


@pytest.fixture
def live_pool() -> WorkerPool:
    """持有全部 LTX 模型 + 节点的 worker。"""
    models = {_DISTILLED, _EROS, _GEMMA, _VAE}
    return WorkerPool([_FakeClient(models, _ltx_nodes())])


@pytest.fixture
def dead_pool() -> WorkerPool:
    return WorkerPool([_FakeClient(set(), set(), reachable=False)])


def _by_id(engines: list[dict]) -> dict[str, dict]:
    return {e["id"]: e for e in engines}


@pytest.fixture(autouse=True)
def h3_stub(monkeypatch):
    """H3 实例探测替身:默认在线且含 H3 节点;置 .nodes=None 模拟实例不可达。

    无此替身时 _probe_h3 会向真实 TOIV_H3_BASE_URL(默认 workstation :8195)发 HTTP,
    单元测试不允许依赖局域网真实实例。
    """
    state = SimpleNamespace(nodes={"MiniMaxH3ImageToVideo"})

    async def _fake() -> set[str]:
        if state.nodes is None:
            raise ComfyUIError("connection refused")
        return set(state.nodes)

    monkeypatch.setattr(engine_registry, "_fetch_h3_nodes", _fake)
    return state


async def test_structure_four_engines_plus_h3(live_pool, user):
    engines = await list_engines(live_pool, user)
    ids = _by_id(engines)
    for eid in ("txt2img", "img2img", "ltx2-t2v", "ltx2-i2v", "h3-t2v", "h3-i2v"):
        assert eid in ids, f"缺引擎 {eid}"
    for e in engines:
        for key in ("id", "label", "kind", "available", "nsfw", "description", "params"):
            assert key in e, f"{e.get('id')} 缺字段 {key}"
        assert e["kind"] in ("image", "video", "audio")
        assert isinstance(e["params"], list) and e["params"], f"{e['id']} params 为空"
        for p in e["params"]:
            assert p["type"] in _ALLOWED_TYPES, f"{e['id']}.{p['key']} 非法 type {p['type']}"
            assert "key" in p and "label" in p and "default" in p
    # 图像引擎 kind 正确;h3 两引擎是视频
    assert ids["txt2img"]["kind"] == "image"
    assert ids["h3-t2v"]["kind"] == "video"
    assert ids["h3-i2v"]["kind"] == "video"


async def test_sfw_context_filters_nsfw_engines_and_options(live_pool, user):
    """SFW 上下文(默认):无 nsfw 引擎,ltx2 unet 选项剔除 10eros。"""
    token = nsfw_intent_var.set(False)
    try:
        engines = await list_engines(live_pool, user)
    finally:
        nsfw_intent_var.reset(token)
    assert all(not e["nsfw"] for e in engines)
    assert "ltx-nsfw-t2v" not in _by_id(engines)
    unet = next(p for p in _by_id(engines)["ltx2-t2v"]["params"] if p["key"] == "unet_name")
    values = [o["value"] for o in unet["options"]]
    assert _EROS not in values
    assert _DISTILLED in values


async def test_r18_context_exposes_nsfw_engines_and_options(live_pool, user):
    """R18 上下文(X-NSFW 头置位 ContextVar):nsfw 引擎出现,10eros 选项保留。"""
    token = nsfw_intent_var.set(True)
    try:
        engines = await list_engines(live_pool, user)
    finally:
        nsfw_intent_var.reset(token)
    ids = _by_id(engines)
    assert "ltx-nsfw-t2v" in ids and "ltx-nsfw-i2v" in ids
    assert ids["ltx-nsfw-t2v"]["nsfw"] is True
    unet = next(p for p in ids["ltx2-t2v"]["params"] if p["key"] == "unet_name")
    assert _EROS in [o["value"] for o in unet["options"]]


async def test_available_when_pool_has_ltx_assets(live_pool, user):
    engines = await list_engines(live_pool, user)
    ids = _by_id(engines)
    for eid in ("txt2img", "ltx2-t2v", "ltx2-i2v", "h3-t2v", "h3-i2v"):
        assert ids[eid]["available"] is True, f"{eid} 应可用"
        assert "unavailable_reason" not in ids[eid]


async def test_unavailable_reason_when_pool_dead(dead_pool, user):
    engines = await list_engines(dead_pool, user)
    ids = _by_id(engines)
    for eid in ("txt2img", "ltx2-t2v"):
        assert ids[eid]["available"] is False
        assert ids[eid]["unavailable_reason"], f"{eid} 缺不可用原因"
    # h3 走独立实例探测(h3_stub 默认在线),与 pool 死活无关
    assert ids["h3-t2v"]["available"] is True
    assert ids["h3-i2v"]["available"] is True


async def test_h3_unavailable_when_instance_down_even_with_live_pool(live_pool, user, h3_stub):
    """H3 实例不可达 → h3 两引擎不可用 + 原因;pool 引擎不受影响。"""
    h3_stub.nodes = None
    ids = _by_id(await list_engines(live_pool, user))
    for eid in ("h3-t2v", "h3-i2v"):
        assert ids[eid]["available"] is False
        assert "不可达" in ids[eid]["unavailable_reason"]
    assert ids["ltx2-t2v"]["available"] is True


async def test_h3_unavailable_when_node_missing(live_pool, user, h3_stub):
    """实例在线但缺 MiniMaxH3 节点(ComfyUI < 0.30)→ 不可用 + 原因指明节点。"""
    h3_stub.nodes = set()
    ids = _by_id(await list_engines(live_pool, user))
    assert ids["h3-t2v"]["available"] is False
    assert "MiniMaxH3ImageToVideo" in ids["h3-t2v"]["unavailable_reason"]


async def test_h3_unavailable_when_disabled(live_pool, user, monkeypatch):
    """TOIV_H3_ENABLED=false 时 h3 引擎标不可用 + 原因,不探测实例。"""
    from types import SimpleNamespace

    monkeypatch.setattr(
        engine_registry,
        "get_settings",
        lambda: SimpleNamespace(
            h3_enabled=False,
            nsfw_default_gemma=_GEMMA,
            nsfw_default_vae=_VAE,
        ),
    )
    ids = _by_id(await list_engines(live_pool, user))
    assert ids["h3-t2v"]["available"] is False
    assert ids["h3-i2v"]["available"] is False
    assert "已禁用" in ids["h3-t2v"]["unavailable_reason"]


async def test_endpoint_shape_via_app(live_pool, user):
    """路由级冒烟:GET /api/models/engines 经依赖覆盖返回 200 + engines 数组。"""
    from fastapi.testclient import TestClient

    from app.deps import get_current_user, get_pool
    from app.main import app

    app.dependency_overrides[get_pool] = lambda: live_pool
    app.dependency_overrides[get_current_user] = lambda: user
    try:
        res = TestClient(app).get("/api/models/engines")
    finally:
        app.dependency_overrides.clear()
    assert res.status_code == 200
    data = res.json()
    assert data["count"] == len(data["engines"])
    assert "ltx-nsfw-t2v" not in _by_id(data["engines"])  # 无 X-NSFW 头 → SFW

    # R18 头 → nsfw 引擎出现(中间件置位 ContextVar)
    app.dependency_overrides[get_pool] = lambda: live_pool
    app.dependency_overrides[get_current_user] = lambda: user
    try:
        res2 = TestClient(app).get("/api/models/engines", headers={"X-NSFW": "1"})
    finally:
        app.dependency_overrides.clear()
    assert res2.status_code == 200
    assert "ltx-nsfw-t2v" in _by_id(res2.json()["engines"])
