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

# 图像表单动态选项测试用底模:SFW 写实 + NSFW 动漫(pony 族)+ 次世代(UNETLoader)
_SFW_CKPT = "majicMIX realistic 麦橘写实_v7.safetensors"
_NSFW_CKPT = "ponyDiffusionV6XL_v6StartWithThisOne.safetensors"
_NEXTGEN_UNET = "z_image_turbo_bf16.safetensors"
_SAMPLERS = ["euler", "euler_ancestral", "dpmpp_2m"]
_SCHEDULERS = ["normal", "simple", "karras"]

_ALLOWED_TYPES = {"text", "textarea", "number", "select", "switch", "images"}


def _obj_info(node: str, field: str, values: list[str]) -> dict:
    return {node: {"input": {"required": {field: [values]}}}}


class _FakeClient:
    """worker 替身:queue_len/model_names/node_names/object_info 可控,不联网。"""

    def __init__(self, models: set[str], nodes: set[str], reachable: bool = True,
                 ckpts: list[str] | None = None, unets: list[str] | None = None):
        self.base_url = "http://fake-worker"
        self._models = models
        self._nodes = nodes
        self._reachable = reachable
        self._ckpts = ckpts if ckpts is not None else [_SFW_CKPT, _NSFW_CKPT]
        self._unets = unets if unets is not None else [_NEXTGEN_UNET]

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

    async def object_info(self, node: str) -> dict:
        if not self._reachable:
            raise ComfyUIError("connection refused")
        if node == "CheckpointLoaderSimple":
            return _obj_info(node, "ckpt_name", self._ckpts)
        if node == "UNETLoader":
            return _obj_info(node, "unet_name", self._unets)
        if node == "KSampler":
            return {
                node: {"input": {"required": {
                    "sampler_name": [list(_SAMPLERS)],
                    "scheduler": [list(_SCHEDULERS)],
                }}}
            }
        return {}


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


@pytest.fixture(autouse=True)
def longcat_stub(monkeypatch):
    """LongCat 实例探测替身:默认在线且含 WanVideoModelLoader 节点;置 .nodes=None 模拟不可达。

    无此替身时 _probe_longcat 会向真实 TOIV_LONGCAT_BASE_URL(默认 workstation :8197)发 HTTP,
    单元测试不允许依赖局域网真实实例。
    """
    state = SimpleNamespace(nodes={"WanVideoModelLoader"})

    async def _fake() -> set[str]:
        if state.nodes is None:
            raise ComfyUIError("connection refused")
        return set(state.nodes)

    monkeypatch.setattr(engine_registry, "_fetch_longcat_nodes", _fake)
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


async def test_longcat_engine_entry(live_pool, user, longcat_stub):
    """longcat-t2v 条目:视频 kind + 参数表(帧数/宽高/steps/fps/seed),实例在线即可用。"""
    ids = _by_id(await list_engines(live_pool, user))
    e = ids["longcat-t2v"]
    assert e["kind"] == "video" and e["nsfw"] is False
    assert e["available"] is True and "unavailable_reason" not in e
    frames = _param(e, "num_frames")
    assert (frames["min"], frames["max"], frames["default"]) == (17, 961, 121)
    assert "60s" in frames["hint"]
    steps = _param(e, "steps")
    assert (steps["min"], steps["max"], steps["default"]) == (1, 50, 10)
    fps = _param(e, "fps")
    assert (fps["min"], fps["max"], fps["default"]) == (8, 30, 16)
    for key in ("width", "height", "seed"):
        _param(e, key)


async def test_longcat_unavailable_when_instance_down(live_pool, user, longcat_stub):
    """LongCat 实例不可达 → 引擎不可用 + 原因;pool/H3 引擎不受影响。"""
    longcat_stub.nodes = None
    ids = _by_id(await list_engines(live_pool, user))
    assert ids["longcat-t2v"]["available"] is False
    assert "不可达" in ids["longcat-t2v"]["unavailable_reason"]
    assert ids["ltx2-t2v"]["available"] is True
    assert ids["h3-t2v"]["available"] is True


async def test_longcat_unavailable_when_node_missing(live_pool, user, longcat_stub):
    """实例在线但缺 WanVideoModelLoader 节点 → 不可用 + 原因指明节点。"""
    longcat_stub.nodes = set()
    ids = _by_id(await list_engines(live_pool, user))
    assert ids["longcat-t2v"]["available"] is False
    assert "WanVideoModelLoader" in ids["longcat-t2v"]["unavailable_reason"]


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


def _param(engine: dict, key: str) -> dict:
    return next(p for p in engine["params"] if p["key"] == key)


async def test_image_engines_dynamic_model_params(live_pool, user):
    """txt2img/img2img 补齐底模/采样器/调度器/风格预设参数,选项动态来自 worker object_info。"""
    ids = _by_id(await list_engines(live_pool, user))
    for eid in ("txt2img", "img2img"):
        e = ids[eid]
        for key in ("ckpt_name", "sampler", "scheduler", "style_preset"):
            p = _param(e, key)
            assert p["type"] == "select", f"{eid}.{key} 应为 select"
            assert "options_source" not in p, f"{eid}.{key} 不应泄漏 options_source 标记"
        ckpt = _param(e, "ckpt_name")
        values = [o["value"] for o in ckpt["options"]]
        # 平台默认空值选项在首位;次世代 UNET 并入;SFW 底模在列
        assert values[0] == ""
        assert _NEXTGEN_UNET in values
        assert _SFW_CKPT in values
        sampler = _param(e, "sampler")
        assert [o["value"] for o in sampler["options"]] == _SAMPLERS
        assert sampler["default"] == "euler"
        scheduler = _param(e, "scheduler")
        assert [o["value"] for o in scheduler["options"]] == _SCHEDULERS
        assert scheduler["default"] == "normal"
        # 风格预设:空值「不使用」+ 静态清单
        preset = _param(e, "style_preset")
        assert preset["options"][0]["value"] == ""
        assert len(preset["options"]) > 1


async def test_sfw_context_strips_nsfw_ckpt_options(live_pool, user):
    """SFW 上下文:txt2img 底模选项剔除 NSFW ckpt,风格预设剔除指向 R18 底模的项。"""
    token = nsfw_intent_var.set(False)
    try:
        ids = _by_id(await list_engines(live_pool, user))
    finally:
        nsfw_intent_var.reset(token)
    assert "nsfw-txt2img" not in ids
    assert "nsfw-img2img" not in ids
    values = [o["value"] for o in _param(ids["txt2img"], "ckpt_name")["options"]]
    assert _NSFW_CKPT not in values
    assert _SFW_CKPT in values
    preset_labels = [o["label"] for o in _param(ids["txt2img"], "style_preset")["options"]]
    assert not any("NSFW" in label for label in preset_labels)


async def test_sfw_context_keeps_sfw_intent_presets(live_pool, user):
    """sfw_intent 预设回归(2026-08-08):底模命中 is_nsfw hints(wai/hassaku/pony)
    但预设定位主站通用风格,SFW 上下文不得连带隐藏;真 NSFW 预设仍剔除。"""
    token = nsfw_intent_var.set(False)
    try:
        ids = _by_id(await list_engines(live_pool, user))
    finally:
        nsfw_intent_var.reset(token)
    values = [o["value"] for o in _param(ids["txt2img"], "style_preset")["options"]]
    # SFW 意图预设(底模 waiIllustrious/hassakuXL/ponyDiffusion/noobai)主站可见
    for pid in ("anime", "anime_soft", "fantasy", "campus", "history_war",
                "anime_high_quality"):
        assert pid in values, f"SFW 意图预设 {pid} 被 hints 误伤隐藏"
    # 真 NSFW 意图预设仍隐藏;hints 认定成人向底模的预设也不放出
    for pid in ("nsfw_realistic", "nsfw_anime", "nsfw_pony",
                "chibi", "portrait"):
        assert pid not in values, f"{pid} 不应在主站可见"


async def test_r18_context_keeps_all_style_presets(live_pool, user):
    """R18 上下文:风格预设全量保留(含 nsfw_* 与 sfw_intent 两类)。"""
    token = nsfw_intent_var.set(True)
    try:
        ids = _by_id(await list_engines(live_pool, user))
    finally:
        nsfw_intent_var.reset(token)
    values = [o["value"] for o in _param(ids["txt2img"], "style_preset")["options"]]
    for pid in ("anime", "fantasy", "nsfw_realistic", "nsfw_anime", "nsfw_pony"):
        assert pid in values, f"R18 上下文缺预设 {pid}"


async def test_r18_context_exposes_nsfw_image_engines(live_pool, user):
    """R18 上下文:nsfw-txt2img/nsfw-img2img 出现,底模选项只含 R18 ckpt,默认落第一个。"""
    token = nsfw_intent_var.set(True)
    try:
        ids = _by_id(await list_engines(live_pool, user))
    finally:
        nsfw_intent_var.reset(token)
    for eid in ("nsfw-txt2img", "nsfw-img2img"):
        assert eid in ids, f"缺 {eid}"
        assert ids[eid]["nsfw"] is True
        assert ids[eid]["kind"] == "image"
        ckpt = _param(ids[eid], "ckpt_name")
        values = [o["value"] for o in ckpt["options"]]
        assert values == [_NSFW_CKPT], f"{eid} 底模选项应只含 R18 ckpt,实得 {values}"
        assert ckpt["default"] == _NSFW_CKPT
        assert all(o.get("nsfw") for o in ckpt["options"])
    # nsfw-img2img 需要参考图
    assert _param(ids["nsfw-img2img"], "images")["type"] == "images"
    # R18 上下文 txt2img 保留全部底模(含 NSFW 标项)
    values = [o["value"] for o in _param(ids["txt2img"], "ckpt_name")["options"]]
    assert _NSFW_CKPT in values


async def test_dynamic_options_fallback_when_pool_dead(dead_pool, user):
    """worker 全不可达:动态注入回退声明态兜底(平台默认/euler/normal),不拖垮端点。"""
    ids = _by_id(await list_engines(dead_pool, user))
    ckpt = _param(ids["txt2img"], "ckpt_name")
    assert ckpt["options"] == [{"value": "", "label": "平台默认底模"}]
    assert ckpt["default"] == ""
    assert _param(ids["txt2img"], "sampler")["options"] == [{"value": "euler", "label": "euler"}]
    assert _param(ids["txt2img"], "scheduler")["options"] == [{"value": "normal", "label": "normal"}]
    # 风格预设是静态清单,worker 死活不影响
    assert len(_param(ids["txt2img"], "style_preset")["options"]) > 1


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
