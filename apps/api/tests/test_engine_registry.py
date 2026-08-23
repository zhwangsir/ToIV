"""引擎注册表端点(GET /api/models/engines)测试。

覆盖:
  · 结构:首批引擎(txt2img/img2img)+ h3-t2v/h3-i2v 条目,
    每项含 id/label/kind/available/nsfw/params;params 元素 type 在允许集合内
  · NSFW 过滤:SFW 上下文无 nsfw 引擎(LTX-2.3 10Eros / h3-nsfw 全部隐藏);
    R18 上下文(nsfw_intent_var 置位)nsfw 引擎出现
  · 可用性:fake pool 可达 → 图像引擎 available=True;全不可达 → False + 原因;
    h3/longcat/wan 走独立实例探测(各自 stub 替身),与 pool 死活无关
"""
from __future__ import annotations

import asyncio
import time
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
_DISTILLED = "ltx-2.3-22b-distilled-1.1.safetensors"
_EROS = "10eros_v14.safetensors"

# 图像表单动态选项测试用底模:SFW 写实 + NSFW 动漫(pony 族)+ 次世代(UNETLoader)
_SFW_CKPT = "majicMIX realistic 麦橘写实_v7.safetensors"
_NSFW_CKPT = "ponyDiffusionV6XL_v6StartWithThisOne.safetensors"
_NEXTGEN_UNET = "z_image_turbo_bf16.safetensors"
_SAMPLERS = ["euler", "euler_ancestral", "dpmpp_2m"]
_SCHEDULERS = ["normal", "simple", "karras"]

_ALLOWED_TYPES = {"text", "textarea", "number", "select", "switch", "images", "audio", "video", "loras"}


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


@pytest.fixture(autouse=True)
def h3_lora_stub(monkeypatch):
    """H3 LoRA 枚举替身:默认空列表;置 .loras=None 模拟实例不可达(声明态空 options)。

    无此替身时 _fetch_h3_loras 会向真实 H3 实例(:8195)发 HTTP,单元测试不允许依赖局域网。
    """
    state = SimpleNamespace(loras=[])

    async def _fake() -> list[str] | None:
        return None if state.loras is None else list(state.loras)

    monkeypatch.setattr(engine_registry, "_fetch_h3_loras", _fake)
    return state


@pytest.fixture(autouse=True)
def qwen_edit_stub(monkeypatch):
    """Qwen-Image-Edit 实例探测替身:默认在线且含编辑节点+UNET;置 .nodes/.models=None 模拟不可达。

    无此替身时 _probe_qwen_edit 会向真实 TOIV_QWEN_EDIT_BASE_URL(默认 pc02 :8194)发 HTTP,
    单元测试不允许依赖局域网真实实例。
    """
    from app.workflows.qwen_edit import QWEN_EDIT_UNET

    state = SimpleNamespace(nodes={"TextEncodeQwenImageEdit"}, models={QWEN_EDIT_UNET})

    async def _fake() -> tuple[set[str], set[str]]:
        if state.nodes is None or state.models is None:
            raise ComfyUIError("connection refused")
        return set(state.nodes), set(state.models)

    monkeypatch.setattr(engine_registry, "_fetch_qwen_edit_meta", _fake)
    return state


async def test_structure_four_engines_plus_h3(live_pool, user):
    engines = await list_engines(live_pool, user)
    ids = _by_id(engines)
    for eid in ("txt2img", "img2img", "h3-t2v", "h3-i2v"):
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


async def test_qwen_image_edit_engine_registered(live_pool, user, qwen_edit_stub):
    """qwen-image-edit 引擎注册:kind=image、stub 在线时可用、含 camera/fast 参数。"""
    ids = _by_id(await list_engines(live_pool, user))
    e = ids["qwen-image-edit"]
    assert e["kind"] == "image"
    assert e["available"] is True
    keys = [p["key"] for p in e["params"]]
    assert "camera" in keys and "fast" in keys and "images" in keys
    assert e["submit"] == {"route": "/api/generate/qwen-edit", "kind": "qwen_edit"}


async def test_qwen_image_edit_unavailable_without_unet(live_pool, user, qwen_edit_stub):
    """实例缺编辑 UNET → 不可用并透出缺的文件名。"""
    qwen_edit_stub.models = set()
    ids = _by_id(await list_engines(live_pool, user))
    e = ids["qwen-image-edit"]
    assert e["available"] is False
    assert "qwen_image_edit_2509" in e["unavailable_reason"]


async def test_sfw_context_filters_nsfw_engines_and_options(live_pool, user):
    """SFW 上下文(默认):无 nsfw 引擎,ltx-nsfw 三条(10Eros)整条目隐藏;SFW 视频主力为 h3。"""
    token = nsfw_intent_var.set(False)
    try:
        engines = await list_engines(live_pool, user)
    finally:
        nsfw_intent_var.reset(token)
    assert all(not e["nsfw"] for e in engines)
    ids = _by_id(engines)
    for eid in ("ltx-nsfw-t2v", "ltx-nsfw-i2v", "ltx-nsfw-lipsync"):
        assert eid not in ids
    assert "h3-t2v" in ids and "h3-i2v" in ids


async def test_r18_context_exposes_nsfw_engines_and_options(live_pool, user):
    """R18 上下文(X-NSFW 头置位 ContextVar):ltx-nsfw 三条引擎出现并带 nsfw 标。"""
    token = nsfw_intent_var.set(True)
    try:
        engines = await list_engines(live_pool, user)
    finally:
        nsfw_intent_var.reset(token)
    ids = _by_id(engines)
    assert "ltx-nsfw-t2v" in ids and "ltx-nsfw-i2v" in ids
    assert ids["ltx-nsfw-t2v"]["nsfw"] is True
    # 10Eros 已内置为 R18 链路默认 UNET(分辨率/时长预设下拉,不再外露 unet 选项)
    assert "ltx-nsfw-lipsync" in ids


async def test_available_when_pool_has_ltx_assets(live_pool, user):
    engines = await list_engines(live_pool, user)
    ids = _by_id(engines)
    for eid in ("txt2img", "h3-t2v", "h3-i2v"):
        assert ids[eid]["available"] is True, f"{eid} 应可用"
        assert "unavailable_reason" not in ids[eid]


async def test_unavailable_reason_when_pool_dead(dead_pool, user):
    engines = await list_engines(dead_pool, user)
    ids = _by_id(engines)
    assert ids["txt2img"]["available"] is False
    assert ids["txt2img"]["unavailable_reason"], "txt2img 缺不可用原因"
    # h3 走独立实例探测(stub 默认在线),与 pool 死活无关
    assert ids["h3-t2v"]["available"] is True
    assert ids["h3-i2v"]["available"] is True


async def test_h3_unavailable_when_instance_down_even_with_live_pool(live_pool, user, h3_stub):
    """H3 实例不可达 → h3 两引擎不可用 + 原因;pool 引擎不受影响。"""
    h3_stub.nodes = None
    ids = _by_id(await list_engines(live_pool, user))
    for eid in ("h3-t2v", "h3-i2v"):
        assert ids[eid]["available"] is False
        assert "不可达" in ids[eid]["unavailable_reason"]
    assert ids["longcat-t2v"]["available"] is True


async def test_h3_unavailable_when_node_missing(live_pool, user, h3_stub):
    """实例在线但缺 MiniMaxH3 节点(ComfyUI < 0.30)→ 不可用 + 原因指明节点。"""
    h3_stub.nodes = set()
    ids = _by_id(await list_engines(live_pool, user))
    assert ids["h3-t2v"]["available"] is False
    assert "MiniMaxH3ImageToVideo" in ids["h3-t2v"]["unavailable_reason"]


async def test_longcat_engine_entry(live_pool, user, longcat_stub):
    """longcat-t2v 条目:视频 kind + 参数表(时长秒/宽高/steps/fps/seed),实例在线即可用。"""
    ids = _by_id(await list_engines(live_pool, user))
    e = ids["longcat-t2v"]
    assert e["kind"] == "video" and e["nsfw"] is False
    assert e["available"] is True and "unavailable_reason" not in e
    dur = _param(e, "duration")
    assert (dur["min"], dur["max"], dur["default"]) == (0.5, 60, 7.5)
    assert "961" in dur["hint"]
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
            default_video_ckpt=_DISTILLED,
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


# --------------------------------------------------------------------------- #
# H3 LoRA 参数(loras 类型,options 来自 H3 实例 LoraLoaderModelOnly 枚举)
# --------------------------------------------------------------------------- #

_SFW_H3_LORA = "cxy_kiss_lora_h3_v01_step1500.safetensors"
_NSFW_H3_LORA = "h3_musubi_v4-000040.safetensors"


async def test_h3_loras_param_schema(live_pool, user, h3_lora_stub):
    """h3-t2v/h3-i2v 带 loras 参数:类型 loras、强度范围 0.5-1.0、默认空、不泄漏 options_source。"""
    h3_lora_stub.loras = [_SFW_H3_LORA]
    ids = _by_id(await list_engines(live_pool, user))
    for eid in ("h3-t2v", "h3-i2v"):
        p = _param(ids[eid], "loras")
        assert p["type"] == "loras"
        assert p["default"] == []
        assert (p["min"], p["max"]) == (0.5, 1.0)
        assert "options_source" not in p


async def test_h3_loras_options_injected_and_nsfw_tagged(live_pool, user, h3_lora_stub):
    """LoRA 选项来自 H3 实例枚举;已知 R18 LoRA 打 nsfw 标。

    SFW 上下文剔除 R18 项;R18 上下文全量保留(与 ckpt/unet 选项同一过滤链路)。
    """
    h3_lora_stub.loras = [_SFW_H3_LORA, _NSFW_H3_LORA]

    token = nsfw_intent_var.set(False)
    try:
        ids = _by_id(await list_engines(live_pool, user))
    finally:
        nsfw_intent_var.reset(token)
    sfw_values = [o["value"] for o in _param(ids["h3-t2v"], "loras")["options"]]
    assert _SFW_H3_LORA in sfw_values
    assert _NSFW_H3_LORA not in sfw_values

    token = nsfw_intent_var.set(True)
    try:
        ids = _by_id(await list_engines(live_pool, user))
    finally:
        nsfw_intent_var.reset(token)
    opts = _param(ids["h3-t2v"], "loras")["options"]
    by_value = {o["value"]: o for o in opts}
    assert by_value[_NSFW_H3_LORA].get("nsfw") is True
    assert not by_value[_SFW_H3_LORA].get("nsfw")


async def test_h3_loras_options_fallback_when_instance_down(live_pool, user, h3_lora_stub):
    """H3 实例不可达(_fetch_h3_loras → None):loras 参数回退声明态空 options,不拖垮端点。"""
    h3_lora_stub.loras = None
    ids = _by_id(await list_engines(live_pool, user))
    p = _param(ids["h3-t2v"], "loras")
    assert p["options"] == []
    assert "options_source" not in p


# --------------------------------------------------------------------------- #
# 可用性探测并行化 + 短 TTL 缓存(QA-FULL-2026-08-11 P1:串行探测 0.55-3.37s)
# --------------------------------------------------------------------------- #

async def test_probes_run_parallel_and_cached(live_pool, user, monkeypatch):
    """① 多引擎 probe 经 gather 并行(总耗时 < 串行累加);
    ② TTL 内二次调用零新探测;③ reset_avail_cache 后重新探测。

    计数口径(2026-08-23 LTX-2.5 退役后):SFW 上下文 _probe_pool 仅剩 ace-music 一路
    (ltx2 旧链路曾贡献 2 路),单路探针无法区分串/并行(45ms 界 < 50ms 单程),
    故与 h3-t2v/i2v 的 _fetch_h3_nodes(经 h3_stub 替身,2 路)合并计数 = 3 路。
    """
    calls = 0
    real_probe = engine_registry._probe_pool
    real_fetch = engine_registry._fetch_h3_nodes  # h3_stub 替身

    async def _counting_probe(pool, models, nodes):
        nonlocal calls
        calls += 1
        await asyncio.sleep(0.05)  # 模拟 probe 网络延迟
        return await real_probe(pool, models, nodes)

    async def _counting_fetch():
        nonlocal calls
        calls += 1
        await asyncio.sleep(0.05)
        return await real_fetch()

    monkeypatch.setattr(engine_registry, "_probe_pool", _counting_probe)
    monkeypatch.setattr(engine_registry, "_fetch_h3_nodes", _counting_fetch)

    t0 = time.monotonic()
    await list_engines(live_pool, user)
    elapsed = time.monotonic() - t0
    first = calls
    assert first >= 2, "SFW 上下文至少 ace + h3 两路 probe"
    assert elapsed < first * 0.05 * 0.9, f"疑似串行: {elapsed:.3f}s ≥ {first}×50ms"

    await list_engines(live_pool, user)
    assert calls == first, "TTL 内第二次调用不应再探测"

    engine_registry.reset_avail_cache()
    await list_engines(live_pool, user)
    assert calls == first * 2, "缓存重置后应重新探测"


# --------------------------------------------------------------------------- #
# R18 H3 引擎(h3-nsfw-t2v / h3-nsfw-i2v,2026-08-12 NSFW 双引擎)
# 与 SFW h3-t2v/h3-i2v 同一提交链路与 probe;仅 R18 上下文可见。
# --------------------------------------------------------------------------- #

async def test_h3_nsfw_engines_hidden_in_sfw_context(live_pool, user):
    """SFW 上下文:h3-nsfw 双引擎不可见(与 ltx-nsfw 同一过滤链路)。"""
    token = nsfw_intent_var.set(False)
    try:
        ids = _by_id(await list_engines(live_pool, user))
    finally:
        nsfw_intent_var.reset(token)
    assert "h3-nsfw-t2v" not in ids
    assert "h3-nsfw-i2v" not in ids


async def test_h3_nsfw_engines_exposed_in_r18_context(live_pool, user, h3_lora_stub):
    """R18 上下文:双引擎出现 + nsfw 标记;可用性与 h3-t2v 同步(共用 _probe_h3)。"""
    h3_lora_stub.loras = [_SFW_H3_LORA, _NSFW_H3_LORA]
    token = nsfw_intent_var.set(True)
    try:
        ids = _by_id(await list_engines(live_pool, user))
    finally:
        nsfw_intent_var.reset(token)
    for eid in ("h3-nsfw-t2v", "h3-nsfw-i2v"):
        assert eid in ids, f"缺引擎 {eid}"
        assert ids[eid]["nsfw"] is True
        assert ids[eid]["kind"] == "video"
        assert ids[eid]["available"] is True
    # i2v 需参考图参数;t2v 不需要
    assert _param(ids["h3-nsfw-i2v"], "images")["type"] == "images"
    assert all(p["key"] != "images" for p in ids["h3-nsfw-t2v"]["params"])


async def test_h3_nsfw_params_presets_match_h3_validation(live_pool, user):
    """resolution 预设全部 32 对齐且 ≤1344;duration 预设全部 17k+5 ∈ [22,362](后端硬校验)。"""
    token = nsfw_intent_var.set(True)
    try:
        ids = _by_id(await list_engines(live_pool, user))
    finally:
        nsfw_intent_var.reset(token)
    res = _param(ids["h3-nsfw-t2v"], "resolution")
    assert res["type"] == "select" and res["default"] == "1280x736"
    for o in res["options"]:
        w, h = map(int, o["value"].split("x"))
        assert w % 32 == 0 and h % 32 == 0, f"{o['value']} 非 32 对齐"
        assert 256 <= w <= 1344 and 256 <= h <= 1344
    dur = _param(ids["h3-nsfw-t2v"], "duration")
    # 2026-08-16 时长按秒选择:新增 4s/8s 档;帧数为统一策略层 up 吸附实证值
    # (4s→107 / 6s→158 / 8s→192 恰在网格 / 10s→243 / 15s→362)
    frames = {"4": 107, "6": 158, "8": 192, "10": 243, "15": 362}
    assert [o["value"] for o in dur["options"]] == list(frames)
    for n in frames.values():
        assert (n - 5) % 17 == 0 and 22 <= n <= 362, f"{n} 不在 17k+5 网格"
    # loras 参数复用 SFW 同一 schema(R18 上下文注入含 NSFW 选项)
    loras = _param(ids["h3-nsfw-t2v"], "loras")
    assert loras["type"] == "loras" and (loras["min"], loras["max"]) == (0.5, 1.0)


async def test_h3_nsfw_unavailable_mirrors_h3_instance(live_pool, user, h3_stub):
    """H3 实例不可达:R18 版与 SFW 版同步不可用(同一 probe)。"""
    h3_stub.nodes = None
    token = nsfw_intent_var.set(True)
    try:
        ids = _by_id(await list_engines(live_pool, user))
    finally:
        nsfw_intent_var.reset(token)
    for eid in ("h3-t2v", "h3-nsfw-t2v", "h3-nsfw-i2v"):
        assert ids[eid]["available"] is False
        assert "不可达" in ids[eid]["unavailable_reason"]


# --------------------------------------------------------------------------- #
# M9:模型出处(source 字段)—— 所有引擎必须有介绍与出处(2026-08-12 NSFW 整合主站)
# --------------------------------------------------------------------------- #

async def test_every_engine_has_source(live_pool, user):
    """每个引擎(含 R18 上下文)都透传 source:name/url(http 前缀)/author 必填。"""
    token = nsfw_intent_var.set(True)  # R18 上下文拿全量引擎,一次覆盖 SFW+R18
    try:
        engines = await list_engines(live_pool, user)
    finally:
        nsfw_intent_var.reset(token)
    assert len(engines) >= 18, f"引擎总数 {len(engines)} < 18,疑似条目丢失"
    for e in engines:
        src = e.get("source")
        assert src is not None, f"{e['id']} 缺 source 出处字段"
        assert src.get("name"), f"{e['id']} source.name 为空"
        assert src.get("url", "").startswith("http"), f"{e['id']} source.url 非法: {src.get('url')}"
        assert src.get("author"), f"{e['id']} source.author 为空"


async def test_source_passthrough_via_endpoint(live_pool, user):
    """路由级:GET /api/models/engines 响应条目含 source 字段(注册表 → HTTP 透传)。"""
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
    for e in res.json()["engines"]:
        assert "source" in e, f"{e['id']} 端点响应缺 source"
        assert e["source"]["url"].startswith("http")


# --------------------------------------------------------------------------- #
# M9:POST /api/models/engines/refresh —— 前端「重新检测」按钮
# --------------------------------------------------------------------------- #

async def test_engines_refresh_forces_reprobe(live_pool, user, monkeypatch):
    """refresh 端点:清可用性缓存后重新探测(probe 调用计数翻倍),返回全量引擎。"""
    from fastapi.testclient import TestClient

    from app.deps import get_current_user, get_pool
    from app.main import app

    calls = 0
    real = engine_registry._probe_pool

    async def _counting(pool, models, nodes):
        nonlocal calls
        calls += 1
        return await real(pool, models, nodes)

    monkeypatch.setattr(engine_registry, "_probe_pool", _counting)
    engine_registry.reset_avail_cache()

    app.dependency_overrides[get_pool] = lambda: live_pool
    app.dependency_overrides[get_current_user] = lambda: user
    try:
        client = TestClient(app)
        r1 = client.post("/api/models/engines/refresh")
        assert r1.status_code == 200
        first = calls
        assert first >= 1, "首次 refresh 应触发 pool probe"
        assert r1.json()["count"] == len(r1.json()["engines"])

        # 紧接着 GET 走缓存:不新增探测
        client.get("/api/models/engines")
        assert calls == first, "refresh 后 GET 应命中缓存不再探测"

        # 再次 refresh:强制重探测
        client.post("/api/models/engines/refresh")
        assert calls == first * 2, "二次 refresh 应重新探测"
    finally:
        app.dependency_overrides.clear()
        engine_registry.reset_avail_cache()


# --------------------------------------------------------------------------- #
# Wan2.2 I2V NSFW 引擎(wan-nsfw-i2v,2026-08-17 Civitai 爆款配方复刻)
# pool worker 执行;probe 校验 capabilities 主链模型/节点 + 6 配方 LoRA 全量
# --------------------------------------------------------------------------- #


def _wan_i2v_requirements() -> tuple[set[str], set[str]]:
    """Wan2.2 I2V 能力要求:capabilities 主链模型/节点 + WAN_I2V_NSFW_LORAS 全量。"""
    from app.capabilities import required_models, required_nodes
    from app.workflows.wan_i2v import WAN_I2V_NSFW_LORAS

    return set(required_models("video")) | set(WAN_I2V_NSFW_LORAS), required_nodes("video")


@pytest.fixture
def wan_pool() -> WorkerPool:
    """持有 Wan2.2 全套模型 + 6 配方 LoRA + 视频节点链的 worker。"""
    models, nodes = _wan_i2v_requirements()
    return WorkerPool([_FakeClient(models, nodes)])


async def test_wan_nsfw_i2v_hidden_in_sfw_context(wan_pool, user):
    """SFW 上下文:wan-nsfw-i2v 不可见(与 ltx-nsfw/h3-nsfw 同一过滤链路)。"""
    ids = _by_id(await list_engines(wan_pool, user))
    assert "wan-nsfw-i2v" not in ids


async def test_wan_nsfw_i2v_exposed_and_available_in_r18(wan_pool, user):
    """R18 上下文:引擎出现且可用;loras 静态清单与后端注册表全等,全部打 R18 标。"""
    from app.workflows.wan_i2v import WAN_I2V_NSFW_LORAS

    token = nsfw_intent_var.set(True)
    try:
        ids = _by_id(await list_engines(wan_pool, user))
    finally:
        nsfw_intent_var.reset(token)
    e = ids["wan-nsfw-i2v"]
    assert e["nsfw"] is True and e["kind"] == "video"
    assert e["available"] is True
    assert _param(e, "images")["type"] == "images"  # i2v 必传参考图
    loras = _param(e, "loras")
    assert loras["type"] == "loras"
    assert {o["value"] for o in loras["options"]} == set(WAN_I2V_NSFW_LORAS)  # 不多不漏
    assert all(o.get("nsfw") for o in loras["options"])
    # 分辨率预设全部在请求模型钳位范围内(128-1280)
    res = _param(e, "resolution")
    assert res["default"] == "832x480"
    for o in res["options"]:
        w, h = map(int, o["value"].split("x"))
        assert 128 <= w <= 1280 and 128 <= h <= 1280, f"{o['value']} 越界"
    # 时长预设:3/5/7.5s(16fps → 就近吸附 4n+1 = 49/81/121 帧,与前端换算/标签一致)
    dur = _param(e, "duration")
    assert [o["value"] for o in dur["options"]] == ["3", "5", "7.5"]
    for sec, want in (("3", 49), ("5", 81), ("7.5", 121)):
        n = round(float(sec) * 16)
        n = round((n - 1) / 4) * 4 + 1  # 前端 engines.ts 同一就近吸附
        assert n == want, f"{sec}s → {n} 帧 ≠ 标签承诺 {want}"
        assert (n - 1) % 4 == 0 and 9 <= n <= 121, f"{sec}s → {n} 帧不在 4n+1 网格"


async def test_wan_nsfw_i2v_unavailable_when_recipe_lora_missing(user):
    """配方 LoRA 缺一个 → 引擎标不可用并给原因(比生成期 ComfyUI 400 更早透出)。"""
    models, nodes = _wan_i2v_requirements()
    models -= {"NSFW-22-H-e8.safetensors"}
    pool = WorkerPool([_FakeClient(models, nodes)])
    token = nsfw_intent_var.set(True)
    try:
        ids = _by_id(await list_engines(pool, user))
    finally:
        nsfw_intent_var.reset(token)
    e = ids["wan-nsfw-i2v"]
    assert e["available"] is False
    assert e["unavailable_reason"]


def test_engines_refresh_requires_login(live_pool):
    """refresh 端点未登录 → 401(与 GET  engines 同一鉴权口径)。"""
    from fastapi.testclient import TestClient

    from app.deps import get_pool
    from app.main import app

    app.dependency_overrides[get_pool] = lambda: live_pool
    try:
        res = TestClient(app).post("/api/models/engines/refresh")
    finally:
        app.dependency_overrides.clear()
    assert res.status_code == 401


# --------------------------------------------------------------------------- #
# R2.2:Wan2.2-Animate / Wan2.1-VACE 引擎(与 LongCat 同实例 :8197,
# probe 在 longcat 基础上追加引擎关键节点检查)
# --------------------------------------------------------------------------- #

_WAN_NODES = {"WanVideoModelLoader", "WanVideoAnimateEmbeds", "WanVideoVACEEncode"}


async def test_wan_engines_available_with_wrapper_nodes(live_pool, user, longcat_stub):
    """实例节点齐全(含 Animate/VACE 关键节点)→ 双引擎可用 + 参数表/出处完整。"""
    longcat_stub.nodes = set(_WAN_NODES)
    ids = _by_id(await list_engines(live_pool, user))
    for eid in ("wan-animate", "wan-vace"):
        e = ids[eid]
        assert e["kind"] == "video" and e["nsfw"] is False
        assert e["available"] is True and "unavailable_reason" not in e
        assert e["source"]["url"].startswith("http")
        _param(e, "duration")
        _param(e, "width")
        _param(e, "height")
        _param(e, "seed")
    # animate:参考图 + 驱动视频;vace:多参考图(images 类型,上限 4 张)
    assert _param(ids["wan-animate"], "video")["type"] == "video"
    assert _param(ids["wan-animate"], "images")["type"] == "images"
    vace_images = _param(ids["wan-vace"], "images")
    assert vace_images["type"] == "images" and vace_images["max"] == 4
    # 时长按秒(与 routes/wan_studio.py 请求模型同源;内部 4k+1 网格由统一策略层吸附)
    a_dur = _param(ids["wan-animate"], "duration")
    assert (a_dur["min"], a_dur["max"], a_dur["default"]) == (0.5, 31, 7.5)
    v_dur = _param(ids["wan-vace"], "duration")
    assert (v_dur["min"], v_dur["max"], v_dur["default"]) == (0.5, 15, 5)


async def test_wan_engines_unavailable_when_wrapper_nodes_missing(live_pool, user, longcat_stub):
    """实例只有 WanVideoModelLoader(wrapper 过旧)→ 双引擎不可用 + 原因指明缺节点;
    longcat 自身引擎不受影响。"""
    longcat_stub.nodes = {"WanVideoModelLoader"}
    ids = _by_id(await list_engines(live_pool, user))
    assert ids["wan-animate"]["available"] is False
    assert "WanVideoAnimateEmbeds" in ids["wan-animate"]["unavailable_reason"]
    assert ids["wan-vace"]["available"] is False
    assert "WanVideoVACEEncode" in ids["wan-vace"]["unavailable_reason"]
    assert ids["longcat-t2v"]["available"] is True


async def test_wan_engines_unavailable_when_instance_down(live_pool, user, longcat_stub):
    """实例不可达 → 双引擎不可用 + 原因;pool 引擎不受影响。"""
    longcat_stub.nodes = None
    ids = _by_id(await list_engines(live_pool, user))
    for eid in ("wan-animate", "wan-vace"):
        assert ids[eid]["available"] is False
        assert "不可达" in ids[eid]["unavailable_reason"]
    assert ids["txt2img"]["available"] is True
