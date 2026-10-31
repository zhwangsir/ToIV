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
    return User(id="u-1", email="tester", hashed_password="x", tenant_id="t-1", content_mode="ordinary")


# ---------------------------------------------------------------------------
# 注册表填充与等价
# ---------------------------------------------------------------------------


async def test_populate_registry_fills_entries(live_pool, user):
    """EnginePlugin bootstrap 填充后 list_engines 返回全部引擎条目。

    新契约:后端不按账号内容态过滤引擎——普通账号与成人态返回同一份全量清单
    (34 条;ltx25-multishot 2026-09-19 退役);nsfw 只作条目元数据透出,
    可见性/灰化交由前端可插拔策略锁。
    """
    populate_registry()
    # 普通账号(未切成人态、无 X-NSFW):仍返回全量,后端不剔除 NSFW 引擎
    engines_sfw = await list_engines(live_pool, user)
    assert len(engines_sfw) == 34, f"引擎条目应全量 34,实得 {len(engines_sfw)}"
    # NSFW 引擎作为元数据透出(nsfw=True),不被隐藏
    assert any(e.get("nsfw") for e in engines_sfw)

    # 成人态 + X-NSFW(仅审计):清单与普通账号完全一致(后端不按账号态过滤)
    user.content_mode = "adult"
    token = nsfw_intent_var.set(True)
    try:
        engines_r18 = await list_engines(live_pool, user)
    finally:
        nsfw_intent_var.reset(token)
    assert len(engines_r18) == 34, f"R18 引擎条目数应为 34,实得 {len(engines_r18)}"
    assert {e["id"] for e in engines_r18} == {e["id"] for e in engines_sfw}

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
    user.content_mode = "adult"
    token = nsfw_intent_var.set(True)
    try:
        engines = await list_engines(live_pool, user)
    finally:
        nsfw_intent_var.reset(token)
    assert len(engines) == 34
    populate_registry()  # 再次调用不应重复
    user.content_mode = "adult"
    token = nsfw_intent_var.set(True)
    try:
        engines2 = await list_engines(live_pool, user)
    finally:
        nsfw_intent_var.reset(token)
    assert len(engines2) == 34


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
    """停用引擎直接标不可用,不触发探测(与分级无关的停用语义)。

    新契约下引擎清单不再按账号内容态过滤,故普通账号也会探测到 NSFW 引擎;
    本用例断言:停用引擎不出现在探测列表,未停用引擎(含 NSFW)照常探测。
    """
    probed: list[str] = []
    real_timed = er._probe_timed

    async def _capture(spec_id, probe, pool):
        probed.append(spec_id)
        return await real_timed(spec_id, probe, pool)

    monkeypatch.setattr(er, "_probe_timed", _capture)
    populate_registry(disabled={"txt2img", "img2img"})
    await list_engines(live_pool, user)  # user 为 ordinary 账号
    # 停用引擎不触发探测
    assert "txt2img" not in probed and "img2img" not in probed
    # 未停用引擎照常探测:普通账号也探测 NSFW 引擎(清单不再按分级过滤)
    assert "h3-t2v" in probed and "wan-nsfw-i2v" in probed


# ---------------------------------------------------------------------------
# submit 绑定在 R18 上下文也透传
# ---------------------------------------------------------------------------


async def test_submit_passthrough_in_r18_context(live_pool, user):
    """R18 上下文下 nsfw 引擎也带 submit 字段。"""
    populate_registry()
    user.content_mode = "adult"
    token = nsfw_intent_var.set(True)
    try:
        engines = await list_engines(live_pool, user)
    finally:
        nsfw_intent_var.reset(token)
    ids = _by_id(engines)
    assert "submit" in ids["h3-nsfw-t2v"]
    assert ids["h3-nsfw-t2v"]["submit"]["route"].startswith("/api/")


def test_upload_handle_params_have_upload_types():
    """参数 hint 指 /api/upload 上传句柄的,type 必须是 audio/video/images。

    前端 engineNeedsAudio/Video/Image 按 type 找上传槽;误标 text 会让 UI 不渲染
    上传(avatar-talk audio 2026-09-19 实证:矩阵 submit_fail 暴露的真产品 bug)。
    longcat-continue 的 video 是产物 URL(text 合法,hint 不含 /api/upload)。
    """
    er.populate_registry()
    bad = []
    for spec in er._REGISTRY:
        for p in spec.get("params") or []:
            hint = str(p.get("hint") or "")
            t = p.get("type")
            if "/api/upload" in hint and t not in ("audio", "video", "image", "images"):
                bad.append(f"{spec['id']}.{p.get('key')}: type={t}")
    assert bad == [], f"上传句柄参数 type 错位: {bad}"
