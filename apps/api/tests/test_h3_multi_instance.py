"""H3 多实例 least-loaded 调度(pick_h3_client / h3_instances)单测。

覆盖(不联网,ComfyUIClient 打桩):
- h3_instances:h3_base_urls 空 → 单实例回退;逗号列表解析(去空白/尾斜杠)
- pick_h3_client:单实例零探测直返;多实例选队列最短;探测失败的实例跳过;
  全不可达回退首实例(get_h3_client)
- submit_h3_job 默认 client 走 pick(多实例配置下落 Job 的 worker 为选中实例)
"""
import asyncio

import pytest

from app.config import get_settings
from app.services import h3 as h3_service


class _FakeClient:
    def __init__(self, base_url: str, queue: int = 0, fail: bool = False):
        self.base_url = base_url
        self._queue = queue
        self._fail = fail

    async def queue_len(self) -> int:
        if self._fail:
            raise ConnectionError("down")
        await asyncio.sleep(0)
        return self._queue


def _patch_instances(monkeypatch, urls: str, base: str = "http://h3-a:8195"):
    class _S:
        h3_base_urls = urls
        h3_base_url = base
        h3_enabled = True
        h3_nsfw_unet = ""
        h3_min_free_vram_gb = 36.0
        h3_min_free_ram_gb = 25.0
        request_timeout = 5.0

        @property
        def h3_base(self):
            return base

    monkeypatch.setattr(h3_service, "get_settings", lambda: _S())


def test_h3_instances_single_fallback(monkeypatch):
    """h3_base_urls 空 → 单实例列表(h3_base_url),单实例部署零变化。"""
    _patch_instances(monkeypatch, "")
    assert h3_service.h3_instances() == ["http://h3-a:8195"]


def test_h3_instances_parses_list(monkeypatch):
    """逗号列表解析:去空白、去尾斜杠、空段剔除。"""
    _patch_instances(monkeypatch, " http://a:8195/ ,, http://b:8196 ,http://c:8197/")
    assert h3_service.h3_instances() == [
        "http://a:8195", "http://b:8196", "http://c:8197",
    ]


def test_pick_single_instance_short_circuits(monkeypatch):
    """单实例配置:直接构造首实例客户端,不触发任何 queue_len 探测(零行为变化)。"""
    _patch_instances(monkeypatch, "")
    probes = {"n": 0}

    class _NoProbeClient(_FakeClient):
        async def queue_len(self) -> int:
            probes["n"] += 1
            raise AssertionError("单实例不应触发探测")

    monkeypatch.setattr(
        h3_service, "ComfyUIClient",
        lambda url, timeout=None: _NoProbeClient(url),
    )
    c = asyncio.run(h3_service.pick_h3_client())
    assert c.base_url == "http://h3-a:8195"
    assert probes["n"] == 0


def test_pick_least_loaded_wins(monkeypatch):
    """多实例:队列最短的实例胜出(a=3, b=0, c=1 → b)。"""
    _patch_instances(monkeypatch, "http://a:8195,http://b:8196,http://c:8197")
    clients = {
        "http://a:8195": _FakeClient("http://a:8195", queue=3),
        "http://b:8196": _FakeClient("http://b:8196", queue=0),
        "http://c:8197": _FakeClient("http://c:8197", queue=1),
    }
    monkeypatch.setattr(
        h3_service, "ComfyUIClient",
        lambda url, timeout=None: clients[url],
    )
    c = asyncio.run(h3_service.pick_h3_client())
    assert c.base_url == "http://b:8196"


def test_pick_skips_dead_instances(monkeypatch):
    """探测失败的实例跳过,存活者中选队列最短(a 死, b=2, c=0 → c)。"""
    _patch_instances(monkeypatch, "http://a:8195,http://b:8196,http://c:8197")
    clients = {
        "http://a:8195": _FakeClient("http://a:8195", fail=True),
        "http://b:8196": _FakeClient("http://b:8196", queue=2),
        "http://c:8197": _FakeClient("http://c:8197", queue=0),
    }
    monkeypatch.setattr(
        h3_service, "ComfyUIClient",
        lambda url, timeout=None: clients[url],
    )
    c = asyncio.run(h3_service.pick_h3_client())
    assert c.base_url == "http://c:8197"


def test_pick_all_dead_falls_back_to_first(monkeypatch):
    """全不可达:回退首实例构造客户端,由 ensure_h3_ready 报 503。"""
    _patch_instances(monkeypatch, "http://a:8195,http://b:8196")
    clients = {
        "http://a:8195": _FakeClient("http://a:8195", fail=True),
        "http://b:8196": _FakeClient("http://b:8196", fail=True),
    }
    monkeypatch.setattr(
        h3_service, "ComfyUIClient",
        lambda url, timeout=None: clients[url],
    )
    c = asyncio.run(h3_service.pick_h3_client())
    assert c.base_url == "http://a:8195"


@pytest.mark.asyncio
async def test_submit_uses_picked_instance(monkeypatch):
    """submit_h3_job 默认 client 走 pick:多实例配置下 Job.worker 为选中实例。"""
    from app.comfy import tracker as tracker_mod
    from app.models import Job
    from app.db import engine, init_db
    from sqlmodel import Session
    from pydantic import BaseModel

    init_db()

    class _Req(BaseModel):
        positive: str = "x"

    class _SubmitClient:
        def __init__(self):
            self.base_url = "http://b:8196"

        async def object_info(self, node):
            return {node: {}}

        async def queue_len(self):
            return 0

        async def queue_counts(self):
            return (0, 0)

        async def get_system_stats(self) -> dict:
            return {"devices": [{"type": "cuda", "vram_free": 80 * 2**30}]}

        async def queue_prompt(self, graph, client_id):
            return "pid-multi-1"

    _patch_instances(monkeypatch, "http://a:8195,http://b:8196")

    async def _fake_pick():
        return _SubmitClient()

    monkeypatch.setattr(h3_service, "pick_h3_client", _fake_pick)
    monkeypatch.setattr(h3_service, "ensure_host_ram",
                        lambda *a, **k: asyncio.sleep(0))
    monkeypatch.setattr(tracker_mod, "spawn", lambda *a, **k: None)

    from app.models import User
    import uuid as _uuid
    with Session(engine) as s:
        uid = f"u-pick-{_uuid.uuid4().hex[:8]}"
        user = User(id=uid, tenant_id="t1", email=f"{uid}@t.com", hashed_password="x")
        s.add(user)
        s.commit()
        result = await h3_service.submit_h3_job(
            {}, kind="h3_t2v", positive="p", seed=1, req=_Req(),
            user=user, session=s,
        )
        assert result["worker"] == "http://b:8196"
        job = s.exec(
            __import__("sqlmodel").select(Job).where(Job.prompt_id == "pid-multi-1")
        ).first()
        assert job is not None and job.worker == "http://b:8196"
        # 清理
        s.delete(job)
        s.delete(user)
        s.commit


# ── h3_worker_status(:8198 未就绪优雅降级 + 队列深度暴露)──────────────────


class _StatusClient:
    def __init__(self, base_url: str, running: int = 0, pending: int = 0,
                 fail: bool = False, has_node: bool = True):
        self.base_url = base_url
        self._counts = (running, pending)
        self._fail = fail
        self._has_node = has_node

    async def queue_counts(self):
        if self._fail:
            raise ConnectionError("down")
        await asyncio.sleep(0)
        return self._counts

    async def object_info(self, node):
        if not self._has_node:
            raise ConnectionError("no node")
        await asyncio.sleep(0)
        return {node: {}}


def _patch_status_clients(monkeypatch, urls: str, clients: dict):
    _patch_instances(monkeypatch, urls)
    monkeypatch.setattr(
        h3_service, "ComfyUIClient",
        lambda url, timeout=None: clients[url],
    )
    return clients


def test_worker_status_single_instance_fallback(monkeypatch):
    """env 未配(空 h3_base_urls)→ 状态列表只有单实例(:8195),零行为变化。"""
    clients = _patch_status_clients(
        monkeypatch, "",
        {"http://h3-a:8195": _StatusClient("http://h3-a:8195", running=1, pending=2)},
    )
    rows = asyncio.run(h3_service.h3_worker_status())
    assert len(rows) == 1
    row = rows[0]
    assert row["url"] == "http://h3-a:8195" and row["healthy"] is True
    assert row["queue_running"] == 1 and row["queue_pending"] == 2
    assert row["queue_total"] == 3 and row["h3_node"] is True


def test_worker_status_dead_instance_marked_not_raised(monkeypatch):
    """双 worker 池::8198 探测失败 → healthy=false + error,不抛异常;:8195 正常。"""
    _patch_status_clients(
        monkeypatch,
        "http://h3-a:8195,http://h3-b:8198",
        {
            "http://h3-a:8195": _StatusClient("http://h3-a:8195", running=0, pending=1),
            "http://h3-b:8198": _StatusClient("http://h3-b:8198", fail=True),
        },
    )
    rows = asyncio.run(h3_service.h3_worker_status())
    assert len(rows) == 2
    by_url = {r["url"]: r for r in rows}
    assert by_url["http://h3-a:8195"]["healthy"] is True
    assert by_url["http://h3-a:8195"]["queue_total"] == 1
    dead = by_url["http://h3-b:8198"]
    assert dead["healthy"] is False and dead["queue_total"] is None
    assert dead["error"] and dead["h3_node"] is None


def test_worker_status_missing_h3_node_flagged(monkeypatch):
    """实例在线但缺 H3 节点(如 PC01 实例模型未挂完)→ h3_node=false,仍算 healthy。"""
    _patch_status_clients(
        monkeypatch,
        "http://h3-a:8195,http://h3-b:8198",
        {
            "http://h3-a:8195": _StatusClient("http://h3-a:8195"),
            "http://h3-b:8198": _StatusClient("http://h3-b:8198", has_node=False),
        },
    )
    rows = asyncio.run(h3_service.h3_worker_status())
    by_url = {r["url"]: r for r in rows}
    assert by_url["http://h3-b:8198"]["healthy"] is True
    assert by_url["http://h3-b:8198"]["h3_node"] is False


# ── resolve_worker:双池作业产物取回(第二实例 URL 必须在白名单)────────────


def _patch_deps_settings(monkeypatch):
    """deps.resolve_worker 用的 settings 桩:空 pool 白名单 + 短超时。"""
    from app import deps as deps_mod

    class _DS:
        worker_urls: list = []
        request_timeout = 5.0

    monkeypatch.setattr(deps_mod, "get_settings", lambda: _DS())
    return deps_mod


def test_resolve_worker_accepts_second_h3_instance(monkeypatch):
    """Job.worker=:8198(第二实例)时产物取回不被判「未知的 worker」(2026-09-13 双池)。"""
    deps_mod = _patch_deps_settings(monkeypatch)
    _patch_instances(monkeypatch, "http://h3-a:8195,http://h3-b:8198")
    c = deps_mod.resolve_worker("http://h3-b:8198")
    assert c.base_url == "http://h3-b:8198"
    c1 = deps_mod.resolve_worker("http://h3-a:8195/")
    assert c1.base_url == "http://h3-a:8195"


def test_resolve_worker_rejects_unknown_still(monkeypatch):
    """未知 worker 仍 400(SSRF 白名单不放宽)。"""
    import fastapi
    deps_mod = _patch_deps_settings(monkeypatch)
    _patch_instances(monkeypatch, "http://h3-a:8195,http://h3-b:8198")
    with pytest.raises(fastapi.HTTPException) as ei:
        deps_mod.resolve_worker("http://evil.example:9999")
    assert ei.value.status_code == 400


# ── upload 钉传跟 pick 一致(kind=h3_i2v)───────────────────────────────────


def test_upload_h3_i2v_follows_picked_worker(monkeypatch):
    """kind=h3_i2v 上传目标 = pick_h3_client()(least-loaded),不再钉死首实例。"""
    from app.routes import upload as upload_mod

    picked = _FakeClient("http://h3-b:8198")

    async def _fake_pick():
        return picked

    _patch_instances(monkeypatch, "http://h3-a:8195,http://h3-b:8198")
    monkeypatch.setattr(h3_service, "pick_h3_client", _fake_pick)
    got = asyncio.run(upload_mod._pick_dedicated_upload_client("h3_i2v"))
    assert got is picked
