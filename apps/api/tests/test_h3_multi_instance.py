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
        s.commit()
