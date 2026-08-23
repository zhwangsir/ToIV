"""资源预算预检(services/resource_budget)单元测试 + h3/wan/longcat 接线回归。

背景:2026-08-21 多引擎并跑耗尽 workstation 183G RAM,OOM killer 杀 H3、
14 作业 error。此前只有显存预检,宿主机 RAM 无护栏;resource_budget 把
「RAM/通用 VRAM 预检 → 队列空闲驱逐自身缓存 → 落定复查 → 仍不足 503」制度化。

覆盖:
  · ram_free_gib / vram_free_gib 解析:正常 / 缺 system 段 / 非数值 → None
  · ensure_host_ram:充足放行(不驱逐);不足驱逐后回升放行;仍不足 503
    (detail 含当前值与阈值);队列忙不驱逐直接 503;stats 读取失败降级放行;
    阈值 0 关闭预检(不读 stats)
  · ensure_vram:通用显存预检同语义(充足放行 / 驱逐回升放行 / 仍不足 503)
  · 接线:POST /api/h3/t2v、/api/wan/animate、/api/longcat/t2v 在低 RAM 下
    一律 503(显存充足也不行——RAM 是独立护栏)
"""
from __future__ import annotations

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

import app.routes.wan_studio as wan_route
import app.services.h3 as h3_service
import app.services.longcat as longcat_service
import app.services.resource_budget as rb
from app.comfy.client import ComfyUIError
from app.db import get_session
from app.main import app
from app.models import Tenant, User
from app.security import create_token, hash_password

_GIB = 1 << 30


@pytest.fixture(autouse=True)
def _fast_settle(monkeypatch):
    """驱逐后的落定等待压到 0(生产 5s):否则驱逐路径用例各拖 5s+。"""
    monkeypatch.setattr(rb, "_SETTLE_SEC", 0.0)
    monkeypatch.setattr(h3_service, "_VRAM_SETTLE_SEC", 0.0)


# --------------------------------------------------------------------------- #
# 公共 fixtures / fakes
# --------------------------------------------------------------------------- #


def _seed_user(session: Session, email: str) -> str:
    tenant = Tenant(name=email)
    session.add(tenant)
    session.commit()
    session.refresh(tenant)
    user = User(
        email=email,
        hashed_password=hash_password("password1"),
        tenant_id=tenant.id,
    )
    session.add(user)
    session.commit()
    session.refresh(user)
    return user.id


@pytest.fixture
def engine():
    eng = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(eng)
    yield eng


@pytest.fixture
def client(engine):
    def override() -> Session:
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override
    yield TestClient(app), engine
    app.dependency_overrides.clear()


class _FakeClient:
    """ComfyUI 实例替身:system_stats(显存/内存)/queue_len/free_memory 可控。"""

    def __init__(
        self,
        *,
        free_vram_gib: float = 96.0,
        free_ram_gib: float = 128.0,
        stats_fail: bool = False,
        queue: int = 0,
        on_free=None,
    ) -> None:
        self.base_url = "http://fake-inst"
        self.free_vram = free_vram_gib  # 公开可变:模拟驱逐后空闲回升
        self.free_ram = free_ram_gib
        self._stats_fail = stats_fail
        self._queue = queue
        self._on_free = on_free
        self.free_calls = 0
        self.graphs: list[dict] = []
        self.uploads: list[tuple[bytes, str]] = []

    async def object_info(self, node: str) -> dict:
        return {node: {}}

    async def queue_prompt(self, graph: dict, client_id: str) -> str:
        self.graphs.append(graph)
        return "prompt-rb-1"

    async def upload_image(self, content: bytes, filename: str) -> str:
        self.uploads.append((content, filename))
        return f"rb-{filename}"

    async def queue_len(self) -> int:
        return self._queue

    async def queue_counts(self) -> tuple[int, int]:
        return self._queue, 0

    async def free_memory(self) -> None:
        self.free_calls += 1
        if self._on_free:
            self._on_free()

    async def get_system_stats(self) -> dict:
        if self._stats_fail:
            raise ComfyUIError("stats endpoint gone")
        return {
            "devices": [{
                "name": "cuda:0 FakeGPU", "type": "cuda",
                "vram_free": int(self.free_vram * _GIB), "vram_total": 96 * _GIB,
            }],
            "system": {"ram_free": int(self.free_ram * _GIB), "ram_total": 183 * _GIB},
        }


class _FakeSourceWorker:
    """上传落点 pool worker 替身:get_image_bytes 可控(wan 接线用)。"""

    base_url = "http://fake-worker"

    async def get_image_bytes(self, filename, subfolder, type_):
        return b"media-bytes", "application/octet-stream"


# --------------------------------------------------------------------------- #
# 解析函数
# --------------------------------------------------------------------------- #


def test_ram_free_gib_parse():
    assert rb.ram_free_gib({"system": {"ram_free": 8 * _GIB}}) == 8.0
    assert rb.ram_free_gib({"system": {}}) is None  # 无 ram_free 字段
    assert rb.ram_free_gib({}) is None  # 无 system 段(旧 ComfyUI)
    assert rb.ram_free_gib({"system": {"ram_free": "lots"}}) is None  # 非数值容错
    assert rb.ram_free_gib({"system": None}) is None


def test_vram_free_gib_parse():
    stats = {"devices": [{"name": "cuda:0 X", "type": "cuda", "vram_free": 12 * _GIB}]}
    assert rb.vram_free_gib(stats) == 12.0
    assert rb.vram_free_gib({"devices": []}) is None
    assert rb.vram_free_gib({}) is None
    # name 以 cuda 开头但无 type 字段也能识别(同 h3._cuda_free_gib)
    assert rb.vram_free_gib({"devices": [{"name": "cuda:1", "vram_free": 3 * _GIB}]}) == 3.0


# --------------------------------------------------------------------------- #
# ensure_host_ram
# --------------------------------------------------------------------------- #


async def test_host_ram_enough_passes_without_evict():
    fake = _FakeClient(free_ram_gib=80.0)
    await rb.ensure_host_ram(fake, 25.0, "H3")
    assert fake.free_calls == 0


async def test_host_ram_low_evicts_then_passes():
    """不足 + 队列空闲 → 驱逐自身模型缓存,落定复查回升 → 放行。"""
    fake = _FakeClient(free_ram_gib=3.0, on_free=lambda: setattr(fake, "free_ram", 40.0))
    await rb.ensure_host_ram(fake, 25.0, "H3")
    assert fake.free_calls == 1


async def test_host_ram_still_low_503_with_values():
    """驱逐后仍不足 → 503,detail 含当前可用值与阈值。"""
    fake = _FakeClient(free_ram_gib=3.0, on_free=lambda: setattr(fake, "free_ram", 4.5))
    with pytest.raises(HTTPException) as exc:
        await rb.ensure_host_ram(fake, 25.0, "H3")
    assert exc.value.status_code == 503
    detail = exc.value.detail
    assert "H3 宿主机内存不足" in detail
    assert "4.5GiB" in detail  # 复查后的当前值
    assert "≥25GiB" in detail
    assert fake.free_calls == 1


async def test_host_ram_queue_busy_no_evict_503():
    """队列非空闲:绝不驱逐(会杀死在跑作业),直接 503。"""
    fake = _FakeClient(free_ram_gib=3.0, queue=1)
    with pytest.raises(HTTPException) as exc:
        await rb.ensure_host_ram(fake, 25.0, "Wan")
    assert exc.value.status_code == 503
    assert fake.free_calls == 0


async def test_host_ram_stats_failure_degrades():
    """/system_stats 读取失败:降级为不预检放行(与显存预检同一原则)。"""
    fake = _FakeClient(free_ram_gib=0.0, stats_fail=True)
    await rb.ensure_host_ram(fake, 25.0, "H3")  # 不抛
    assert fake.free_calls == 0


async def test_host_ram_disabled_with_zero_threshold():
    """阈值 0 = 显式关闭预检:连 stats 都不读。"""

    class _NoStats(_FakeClient):
        async def get_system_stats(self) -> dict:
            raise AssertionError("预检已关闭,不应读取 system_stats")

    await rb.ensure_host_ram(_NoStats(free_ram_gib=0.0), 0.0, "H3")


# --------------------------------------------------------------------------- #
# ensure_vram(通用显存预检,LongCat 接线用)
# --------------------------------------------------------------------------- #


async def test_vram_enough_passes_without_evict():
    fake = _FakeClient(free_vram_gib=60.0)
    await rb.ensure_vram(fake, 26.0, "LongCat")
    assert fake.free_calls == 0


async def test_vram_low_evicts_then_passes():
    fake = _FakeClient(free_vram_gib=10.0, on_free=lambda: setattr(fake, "free_vram", 40.0))
    await rb.ensure_vram(fake, 26.0, "LongCat")
    assert fake.free_calls == 1


async def test_vram_still_low_503():
    fake = _FakeClient(free_vram_gib=10.0, on_free=lambda: setattr(fake, "free_vram", 12.0))
    with pytest.raises(HTTPException) as exc:
        await rb.ensure_vram(fake, 26.0, "LongCat")
    assert exc.value.status_code == 503
    assert "LongCat 显卡空闲显存不足" in exc.value.detail
    assert "12.0GiB" in exc.value.detail
    assert "≥26GiB" in exc.value.detail


# --------------------------------------------------------------------------- #
# 接线回归:三处提交链路在低 RAM 下一律 503(显存充足也拦)
# --------------------------------------------------------------------------- #


def test_h3_wiring_low_ram_503(client, monkeypatch):
    """h3.ensure_h3_vram 尾部已接 RAM 预检:显存 96G 充足、RAM 3G → 503,不提交。"""
    c, eng = client
    with Session(eng) as s:
        uid = _seed_user(s, "rb-h3")
    fake = _FakeClient(free_vram_gib=96.0, free_ram_gib=3.0)
    monkeypatch.setattr(h3_service, "get_h3_client", lambda: fake)
    monkeypatch.setattr(h3_service, "spawn_tracker", lambda client, prompt_id: None)
    r = c.post(
        "/api/h3/t2v",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "a cat"},
    )
    assert r.status_code == 503, r.text
    assert "H3 宿主机内存不足" in r.json()["detail"]
    assert fake.graphs == []  # 未提交


def test_wan_wiring_low_ram_503(client, monkeypatch):
    """wan_video.ensure_wan_vram 尾部已接 RAM 预检:显存充足、RAM 3G → 503。"""
    c, eng = client
    with Session(eng) as s:
        uid = _seed_user(s, "rb-wan")
    fake = _FakeClient(free_vram_gib=96.0, free_ram_gib=3.0)
    monkeypatch.setattr(longcat_service, "get_longcat_client", lambda: fake)
    monkeypatch.setattr(longcat_service, "spawn_tracker", lambda client, prompt_id: None)
    monkeypatch.setattr(wan_route, "resolve_worker", lambda worker: _FakeSourceWorker())
    r = c.post(
        "/api/wan/animate",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "a", "image": "in.png", "video": "d.mp4",
              "worker": "http://fake-worker"},
    )
    assert r.status_code == 503, r.text
    assert "Wan 宿主机内存不足" in r.json()["detail"]
    assert fake.graphs == []


def test_longcat_wiring_low_ram_503(client, monkeypatch):
    """submit_longcat_job 已接 VRAM+RAM 双预检:显存充足、RAM 3G → 503。"""
    c, eng = client
    with Session(eng) as s:
        uid = _seed_user(s, "rb-longcat")
    fake = _FakeClient(free_vram_gib=96.0, free_ram_gib=3.0)
    monkeypatch.setattr(longcat_service, "get_longcat_client", lambda: fake)
    monkeypatch.setattr(longcat_service, "spawn_tracker", lambda client, prompt_id: None)
    r = c.post(
        "/api/longcat/t2v",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "a cat"},
    )
    assert r.status_code == 503, r.text
    assert "LongCat 宿主机内存不足" in r.json()["detail"]
    assert fake.graphs == []


def test_longcat_wiring_low_vram_503(client, monkeypatch):
    """LongCat 新增显存预检(此前完全没有):显存 10G < 26G 阈值 → 503。"""
    c, eng = client
    with Session(eng) as s:
        uid = _seed_user(s, "rb-longcat-vram")
    fake = _FakeClient(free_vram_gib=10.0, free_ram_gib=128.0, queue=1)  # 队列忙不驱逐
    monkeypatch.setattr(longcat_service, "get_longcat_client", lambda: fake)
    monkeypatch.setattr(longcat_service, "spawn_tracker", lambda client, prompt_id: None)
    r = c.post(
        "/api/longcat/t2v",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "a cat"},
    )
    assert r.status_code == 503, r.text
    assert "LongCat 显卡空闲显存不足" in r.json()["detail"]
    assert fake.free_calls == 0
    assert fake.graphs == []
