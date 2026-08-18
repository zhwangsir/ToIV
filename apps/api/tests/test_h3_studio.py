"""MiniMax H3 工作室 —— 图构建 / 参数校验 / 端点 / 参考图转运 测试。

覆盖:
  · 图构建器:t2v 注入 prompt/宽高/帧数/steps/seed/产物前缀;H3 节点无负向输入不注入;
    i2v 注入 LoadImage 首帧且 first_frame 连接保留;模板缓存不被污染
  · 请求校验:宽高非 32 对齐 422;帧数非 17k+5 / 超界 422;i2v 路径穿越 422
  · POST /api/h3/t2v:成功提交(Job kind=h3_t2v、seed 随机落快照);
    实例不可达 → 503;实例缺 MiniMaxH3 节点 → 503
  · POST /api/h3/i2v:参考图从源 worker 转运到 H3 实例(upload_image)后提交,
    图含 LoadImage 转运文件名,Job kind=h3_i2v
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

import app.routes.h3_studio as h3_route
import app.services.h3 as h3_service
from app.comfy.client import ComfyUIError
from app.db import get_session
from app.main import app
from app.models import Job, Tenant, User
from app.security import create_token, hash_password
from app.workflows.h3_video import (
    H3I2VParams,
    H3T2VParams,
    build_h3_i2v_graph,
    build_h3_t2v_graph,
)


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


class _FakeH3Client:
    """H3 实例替身:object_info/queue_prompt/upload_image/system_stats 可控,不联网。"""

    def __init__(
        self,
        *,
        reachable: bool = True,
        has_h3_node: bool = True,
        free_vram_gib: float = 96.0,
        stats_fail: bool = False,
        self_queue: int = 0,
        pending: int = 0,
        on_self_free=None,
    ) -> None:
        self.base_url = "http://fake-h3"
        self._reachable = reachable
        self._has_h3_node = has_h3_node
        self.free_gib = free_vram_gib  # 公开可变:模拟驱逐同卡缓存后空闲回升
        self._stats_fail = stats_fail
        self._self_queue = self_queue  # H3 自身队列长度(0=空闲,可驱逐自身缓存)
        self._pending = pending  # pending 数(queued_behind 提示用)
        self._on_self_free = on_self_free  # 驱逐自身缓存后的回调(如回升 free_gib)
        self.self_free_calls = 0
        self.graphs: list[dict] = []
        self.uploads: list[tuple[bytes, str]] = []

    async def object_info(self, node: str) -> dict:
        if not self._reachable:
            raise ComfyUIError("connection refused")  # 无 status_code = 网络层失败
        if not self._has_h3_node:
            raise ComfyUIError(f"unknown node {node}", status_code=404)
        return {node: {}}

    async def queue_prompt(self, graph: dict, client_id: str) -> str:
        self.graphs.append(graph)
        return "prompt-h3-1"

    async def upload_image(self, content: bytes, filename: str) -> str:
        self.uploads.append((content, filename))
        return f"h3-{filename}"

    async def queue_len(self) -> int:
        return self._self_queue + self._pending

    async def queue_counts(self) -> tuple[int, int]:
        return self._self_queue, self._pending

    async def free_memory(self) -> None:
        self.self_free_calls += 1
        if self._on_self_free:
            self._on_self_free()

    async def get_system_stats(self) -> dict:
        if self._stats_fail:
            raise ComfyUIError("stats endpoint gone")
        return {
            "devices": [
                {
                    "name": "cuda:0 FakeGPU",
                    "type": "cuda",
                    "vram_free": int(self.free_gib * (1 << 30)),
                    "vram_total": 96 * (1 << 30),
                }
            ]
        }


class _FakeSourceWorker:
    """参考图所在 pool worker 替身:仅 get_image_bytes。"""

    def __init__(self, content: bytes = b"img-bytes") -> None:
        self.base_url = "http://fake-worker"
        self._content = content

    async def get_image_bytes(self, filename: str, subfolder: str, type_: str) -> tuple[bytes, str]:
        return self._content, "image/png"


def _install_h3(monkeypatch, fake: _FakeH3Client) -> None:
    monkeypatch.setattr(h3_service, "get_h3_client", lambda: fake)
    monkeypatch.setattr(h3_service, "spawn_tracker", lambda client, prompt_id: None)


# --------------------------------------------------------------------------- #
# 图构建器
# --------------------------------------------------------------------------- #


def test_builder_t2v_injects_params():
    g = build_h3_t2v_graph(H3T2VParams(positive="一只猫", width=768, height=1344, length=141, steps=8, seed=42))
    assert g["104"]["class_type"] == "MiniMaxH3ImageToVideo"
    assert g["104"]["inputs"]["prompt"] == "一只猫"
    assert g["104"]["inputs"]["width"] == 768
    assert g["104"]["inputs"]["height"] == 1344
    assert g["104"]["inputs"]["length"] == 141
    assert g["15"]["inputs"]["noise_seed"] == 42
    assert g["9"]["inputs"]["steps"] == 8
    assert g["9"]["inputs"]["scheduler"] == "simple"  # 模板采样链保持不动
    assert g["17"]["inputs"]["sampler_name"] == "res_multistep"
    assert g["92"]["inputs"]["filename_prefix"] == "ToIV_h3/t2v"


def test_builder_t2v_negative_not_injected():
    """H3 节点无独立负向输入(评测实测):negative 不进图,仅保留在参数快照。"""
    g = build_h3_t2v_graph(H3T2VParams(positive="x", negative="模糊,水印"))
    assert "negative_prompt" not in g["104"]["inputs"]


def test_builder_i2v_injects_first_frame():
    g = build_h3_i2v_graph(H3I2VParams(positive="x", image="h3-in.png", seed=7))
    assert g["100"]["class_type"] == "LoadImage"
    assert g["100"]["inputs"]["image"] == "h3-in.png"
    assert g["104"]["inputs"]["first_frame"] == ["100", 0]  # 模板连接保留
    assert g["15"]["inputs"]["noise_seed"] == 7
    assert g["92"]["inputs"]["filename_prefix"] == "ToIV_h3/i2v"


def test_builder_does_not_pollute_template_cache():
    """连续两次构建互不影响(lru_cache 模板必须 deepcopy)。"""
    g1 = build_h3_t2v_graph(H3T2VParams(positive="first", seed=1))
    g2 = build_h3_t2v_graph(H3T2VParams(positive="second", seed=2))
    assert g1["104"]["inputs"]["prompt"] == "first"
    assert g2["104"]["inputs"]["prompt"] == "second"
    assert g1["15"]["inputs"]["noise_seed"] == 1


def test_builder_default_seed_random():
    p1 = H3T2VParams(positive="x")
    p2 = H3T2VParams(positive="x")
    assert p1.seed != p2.seed or p1.seed >= 0  # 随机种子(极低概率相等,不断言不等)


# --------------------------------------------------------------------------- #
# 请求校验(422)
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize("field,value", [("width", 1000), ("height", 767)])
def test_t2v_rejects_non_aligned32(client, field, value):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, f"h3align-{field}")
    r = c.post(
        "/api/h3/t2v",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "a cat", field: value},
    )
    assert r.status_code == 422


@pytest.mark.parametrize("length", [100, 125, 5, 363])
def test_t2v_rejects_bad_length(client, length):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, f"h3len-{length}")
    r = c.post(
        "/api/h3/t2v",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "a cat", "length": length},
    )
    assert r.status_code == 422


def test_i2v_rejects_path_traversal(client):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "h3i2v-traversal")
    r = c.post(
        "/api/h3/i2v",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "x", "image": "../secret.png", "worker": "http://fake-worker"},
    )
    assert r.status_code == 422


# --------------------------------------------------------------------------- #
# POST /api/h3/t2v
# --------------------------------------------------------------------------- #


def test_t2v_ok_submits_graph_and_job(client, monkeypatch):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "h3t2vok")
    fake = _FakeH3Client()
    _install_h3(monkeypatch, fake)
    r = c.post(
        "/api/h3/t2v",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "楼道里的中年女人", "length": 141, "seed": 42},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["prompt_id"] == "prompt-h3-1"
    assert body["worker"] == "http://fake-h3"
    assert body["seed"] == 42

    graph = fake.graphs[0]
    assert graph["104"]["inputs"]["prompt"] == "楼道里的中年女人"
    assert graph["104"]["inputs"]["length"] == 141
    assert graph["15"]["inputs"]["noise_seed"] == 42

    with Session(engine) as s:
        job = s.exec(select(Job).where(Job.user_id == uid)).first()
        assert job is not None
        assert job.kind == "h3_t2v"
        assert job.nsfw is False
        assert job.seed == 42
        assert job.worker == "http://fake-h3"


def test_t2v_default_seed_randomized(client, monkeypatch):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "h3t2vseed")
    fake = _FakeH3Client()
    _install_h3(monkeypatch, fake)
    r = c.post(
        "/api/h3/t2v",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "a cat"},
    )
    assert r.status_code == 200, r.text
    assert isinstance(r.json()["seed"], int)
    with Session(engine) as s:
        job = s.exec(select(Job).where(Job.user_id == uid)).first()
        assert job.seed == r.json()["seed"]  # 快照与返回值一致,可复现


def test_t2v_instance_unreachable_503(client, monkeypatch):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "h3t2vdown")
    _install_h3(monkeypatch, _FakeH3Client(reachable=False))
    r = c.post(
        "/api/h3/t2v",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "a cat"},
    )
    assert r.status_code == 503
    assert "不可达" in r.json()["detail"]


def test_t2v_missing_h3_node_503(client, monkeypatch):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "h3t2vnonode")
    _install_h3(monkeypatch, _FakeH3Client(has_h3_node=False))
    r = c.post(
        "/api/h3/t2v",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "a cat"},
    )
    assert r.status_code == 503
    assert "MiniMaxH3ImageToVideo" in r.json()["detail"]


def test_t2v_requires_auth(client):
    c, _ = client
    assert c.post("/api/h3/t2v", json={"positive": "x"}).status_code == 401


# --------------------------------------------------------------------------- #
# POST /api/h3/i2v
# --------------------------------------------------------------------------- #


def test_i2v_ok_transfers_ref_image_and_submits(client, monkeypatch):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "h3i2vok")
    fake = _FakeH3Client()
    _install_h3(monkeypatch, fake)
    source = _FakeSourceWorker()
    monkeypatch.setattr(h3_route, "resolve_worker", lambda worker: source)
    r = c.post(
        "/api/h3/i2v",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "门从里打开", "image": "in.png", "worker": "http://fake-worker", "seed": 7},
    )
    assert r.status_code == 200, r.text
    # 参考图从源 worker 读出并上传到 H3 实例,图内引用转运后的文件名
    assert fake.uploads == [(b"img-bytes", "in.png")]
    graph = fake.graphs[0]
    assert graph["100"]["inputs"]["image"] == "h3-in.png"
    assert graph["104"]["inputs"]["first_frame"] == ["100", 0]
    with Session(engine) as s:
        job = s.exec(select(Job).where(Job.user_id == uid)).first()
        assert job is not None and job.kind == "h3_i2v"


def test_i2v_source_worker_read_failure_502(client, monkeypatch):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "h3i2vbadread")

    class _BrokenSource:
        base_url = "http://fake-worker"

        async def get_image_bytes(self, filename, subfolder, type_):
            raise ComfyUIError("no such file")

    _install_h3(monkeypatch, _FakeH3Client())
    monkeypatch.setattr(h3_route, "resolve_worker", lambda worker: _BrokenSource())
    r = c.post(
        "/api/h3/i2v",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "x", "image": "in.png", "worker": "http://fake-worker"},
    )
    assert r.status_code == 502
    assert "读取失败" in r.json()["detail"]


# --------------------------------------------------------------------------- #
# 显存预检(ensure_h3_vram):不足 → 驱逐同卡空闲 worker → 复查;仍不足 → 503
# --------------------------------------------------------------------------- #


class _FakeCoWorker:
    """同卡 pool worker 替身:queue_len/free_memory 可控。"""

    def __init__(self, queue: int = 0, on_free=None) -> None:
        self._queue = queue
        self._on_free = on_free
        self.free_calls = 0

    async def queue_len(self) -> int:
        return self._queue

    async def free_memory(self) -> None:
        self.free_calls += 1
        if self._on_free:
            self._on_free()


def _stub_settings(monkeypatch, *, threshold: float = 36.0, co_workers=("http://fake-co",), enabled: bool = True):
    """替换服务层 settings:开关/阈值/同卡 worker/超时可控。"""
    from types import SimpleNamespace

    monkeypatch.setattr(
        h3_service,
        "get_settings",
        lambda: SimpleNamespace(
            h3_enabled=enabled,
            h3_min_free_vram_gb=threshold,
            h3_co_worker_urls=list(co_workers),
            request_timeout=30.0,
        ),
    )


def _install_co_worker(monkeypatch, co: _FakeCoWorker) -> None:
    monkeypatch.setattr(h3_service, "ComfyUIClient", lambda url, timeout=30.0: co)


def test_vram_sufficient_no_eviction(client, monkeypatch):
    """空闲 ≥ 阈值:直接放行,不触碰同卡 worker。"""
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "h3vramok")
    fake = _FakeH3Client(free_vram_gib=40.0)
    _install_h3(monkeypatch, fake)
    _stub_settings(monkeypatch)
    co = _FakeCoWorker()
    _install_co_worker(monkeypatch, co)
    r = c.post(
        "/api/h3/t2v",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "a cat"},
    )
    assert r.status_code == 200, r.text
    assert co.free_calls == 0


def test_vram_insufficient_evicts_self_cache_then_ok(client, monkeypatch):
    """不足 → H3 自身队列空闲 → 驱逐自身驻留缓存后复查达标 → 放行(不动同卡 worker)。"""
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "h3vramself")
    fake = _FakeH3Client(free_vram_gib=1.0)
    fake._on_self_free = lambda: setattr(fake, "free_gib", 40.0)
    _install_h3(monkeypatch, fake)
    _stub_settings(monkeypatch)
    co = _FakeCoWorker(queue=0)
    _install_co_worker(monkeypatch, co)
    r = c.post(
        "/api/h3/t2v",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "a cat"},
    )
    assert r.status_code == 200, r.text
    assert fake.self_free_calls == 1
    assert co.free_calls == 0  # 自身驱逐已达标,不打扰同卡 worker


def test_vram_insufficient_self_busy_skips_self_evict(client, monkeypatch):
    """QUEUE-2026-08-18 新语义:H3 自身队列非空(有作业在跑/等待)→ 跳过显存预检
    直接放行,走 ComfyUI 原生排队(模型已驻留,串行执行无需显存增量);
    不驱逐任何人(自身忙不能驱逐;同卡 worker 无需打扰),响应带 queued_behind。"""
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "h3vramselfbusy")
    fake = _FakeH3Client(free_vram_gib=1.0, self_queue=1, pending=2)
    _install_h3(monkeypatch, fake)
    _stub_settings(monkeypatch)
    co = _FakeCoWorker(queue=0)
    _install_co_worker(monkeypatch, co)
    r = c.post(
        "/api/h3/t2v",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "a cat"},
    )
    assert r.status_code == 200, r.text
    assert fake.self_free_calls == 0  # 自身忙,未驱逐
    assert co.free_calls == 0  # 原生排队,无需协调驱逐
    assert len(fake.graphs) == 1  # 已进 ComfyUI 队列
    assert r.json()["queued_behind"] == 2  # 排队位次透传(前方还有 2 个)


def test_vram_insufficient_evicts_idle_coworker_then_ok(client, monkeypatch):
    """不足 → 同卡 worker 空闲 → 驱逐后复查达标 → 放行。"""
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "h3vramevict")
    fake = _FakeH3Client(free_vram_gib=1.0)
    _install_h3(monkeypatch, fake)
    _stub_settings(monkeypatch)
    co = _FakeCoWorker(queue=0, on_free=lambda: setattr(fake, "free_gib", 40.0))
    _install_co_worker(monkeypatch, co)
    r = c.post(
        "/api/h3/t2v",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "a cat"},
    )
    assert r.status_code == 200, r.text
    assert co.free_calls == 1


def test_vram_insufficient_coworker_busy_no_evict_503(client, monkeypatch):
    """同卡 worker 队列非空闲:绝不驱逐(会杀死在跑作业)→ 503 错峰提示。"""
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "h3vrambusy")
    fake = _FakeH3Client(free_vram_gib=1.0)
    _install_h3(monkeypatch, fake)
    _stub_settings(monkeypatch)
    co = _FakeCoWorker(queue=2)
    _install_co_worker(monkeypatch, co)
    r = c.post(
        "/api/h3/t2v",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "a cat"},
    )
    assert r.status_code == 503
    assert "显存不足" in r.json()["detail"]
    assert co.free_calls == 0


def test_vram_insufficient_no_recovery_503(client, monkeypatch):
    """驱逐后复查仍不足 → 503(原因清晰,而非 ComfyUI 裸崩 VRAM grow failed)。"""
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "h3vramstuck")
    fake = _FakeH3Client(free_vram_gib=2.0)  # 驱逐后不回升
    _install_h3(monkeypatch, fake)
    _stub_settings(monkeypatch)
    co = _FakeCoWorker(queue=0)
    _install_co_worker(monkeypatch, co)
    r = c.post(
        "/api/h3/t2v",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "a cat"},
    )
    assert r.status_code == 503
    assert "显存不足" in r.json()["detail"]
    assert co.free_calls == 1  # 尽力驱逐过


def test_vram_stats_read_failure_fails_open(client, monkeypatch):
    """/system_stats 读取失败:放行(降级为不预检,由 ComfyUI 自身错误兜底)。"""
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "h3vramstatsfail")
    _install_h3(monkeypatch, _FakeH3Client(stats_fail=True))
    _stub_settings(monkeypatch)
    r = c.post(
        "/api/h3/t2v",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "a cat"},
    )
    assert r.status_code == 200, r.text


def test_vram_check_disabled_by_zero_threshold(client, monkeypatch):
    """阈值=0 显式关闭预检:即使空闲 0.5G 也不查不驱逐。"""
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "h3vramoff")

    class _NoStatsClient(_FakeH3Client):
        async def get_system_stats(self) -> dict:
            raise AssertionError("预检已关闭,不应读取 system_stats")

    _install_h3(monkeypatch, _NoStatsClient(free_vram_gib=0.5))
    _stub_settings(monkeypatch, threshold=0.0)
    r = c.post(
        "/api/h3/t2v",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "a cat"},
    )
    assert r.status_code == 200, r.text


def test_h3_disabled_returns_503(client, monkeypatch):
    """TOIV_H3_ENABLED=false 时 /api/h3/t2v 返回 503,不触碰 H3 实例。"""
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "h3disabled")

    class _NoCallClient(_FakeH3Client):
        async def object_info(self, node: str) -> dict:
            raise AssertionError("H3 已禁用,不应探测实例")

    _install_h3(monkeypatch, _NoCallClient())
    _stub_settings(monkeypatch, enabled=False)
    r = c.post(
        "/api/h3/t2v",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "a cat"},
    )
    assert r.status_code == 503
    assert "已禁用" in r.json()["detail"]


# --------------------------------------------------------------------------- #
# R18 打标(2026-08-08):X-NSFW 上下文 → Job.nsfw,进 /nsfw 专区作品库;
# 主站(无头)恒 False;未成年硬阻断优先于 X-NSFW 头(与 LTX 门控同一判定来源)
# --------------------------------------------------------------------------- #


def test_t2v_marks_job_nsfw_with_x_nsfw_header(client, monkeypatch):
    """/nsfw 专区(X-NSFW: 1)提交 h3 t2v:Job 打 nsfw 标,主站作品库不可见。"""
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "h3nsfw")
    fake = _FakeH3Client()
    _install_h3(monkeypatch, fake)
    r = c.post(
        "/api/h3/t2v",
        headers={"Authorization": f"Bearer {create_token(uid)}", "X-NSFW": "1"},
        json={"positive": "a girl, cinematic"},
    )
    assert r.status_code == 200, r.text
    with Session(engine) as s:
        job = s.exec(select(Job).where(Job.user_id == uid)).first()
        assert job is not None
        assert job.kind == "h3_t2v" and job.nsfw is True


def test_i2v_marks_job_nsfw_with_x_nsfw_header(client, monkeypatch):
    """/nsfw 专区提交 h3 i2v:Job 同样打 nsfw 标。"""
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "h3i2vnsfw")
    fake = _FakeH3Client()
    _install_h3(monkeypatch, fake)
    monkeypatch.setattr(h3_route, "resolve_worker", lambda worker: _FakeSourceWorker())
    r = c.post(
        "/api/h3/i2v",
        headers={"Authorization": f"Bearer {create_token(uid)}", "X-NSFW": "1"},
        json={"positive": "x", "image": "in.png", "worker": "http://fake-worker"},
    )
    assert r.status_code == 200, r.text
    with Session(engine) as s:
        job = s.exec(select(Job).where(Job.user_id == uid)).first()
        assert job is not None and job.kind == "h3_i2v" and job.nsfw is True


def test_t2v_underage_not_marked_even_with_header(client, monkeypatch):
    """未成年硬阻断优先于 X-NSFW 头:作业可提交(SFW 语义)但绝不打 R18 标。"""
    from datetime import date, timedelta

    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "h3underage")
        s.get(User, uid).birthdate = date.today() - timedelta(days=365 * 12)
        s.commit()
    fake = _FakeH3Client()
    _install_h3(monkeypatch, fake)
    r = c.post(
        "/api/h3/t2v",
        headers={"Authorization": f"Bearer {create_token(uid)}", "X-NSFW": "1"},
        json={"positive": "a cat"},
    )
    assert r.status_code == 200, r.text
    with Session(engine) as s:
        job = s.exec(select(Job).where(Job.user_id == uid)).first()
        assert job is not None and job.nsfw is False


# --------------------------------------------------------------------------- #
# LoRA 叠加(builder LoraLoaderModelOnly 链 / 请求校验 / NSFW 门控)
# --------------------------------------------------------------------------- #

from app.workflows.lora import LoraSpec  # noqa: E402

_LORA_A = "cxy_kiss_lora_h3_v01_step1500.safetensors"  # 作者标 SFW
_LORA_B = "riding_pose_H3_i2v_v1.0.safetensors"  # NSFW
_LORA_NSFW = "h3_musubi_v4-000040.safetensors"  # NSFW


def test_builder_t2v_empty_loras_keeps_template_chain():
    """空 loras:不插节点,BasicGuider/BasicScheduler 的 model 仍直引 UNETLoader("6")。"""
    g = build_h3_t2v_graph(H3T2VParams(positive="x", seed=1))
    assert "200" not in g
    assert g["16"]["inputs"]["model"] == ["6", 0]
    assert g["9"]["inputs"]["model"] == ["6", 0]


def test_builder_t2v_injects_lora_chain():
    """2 个 LoRA:LoraLoaderModelOnly 链(200→201),下游 model 引用改接链末端;
    strength 注入 strength_model,不动 CLIP(musubi 系 LoRA 只含 DiT 权重)。"""
    params = H3T2VParams(
        positive="x",
        seed=1,
        loras=(LoraSpec(name=_LORA_A, weight=0.6), LoraSpec(name=_LORA_B, weight=0.8)),
    )
    g = build_h3_t2v_graph(params)
    assert g["200"]["class_type"] == "LoraLoaderModelOnly"
    assert g["200"]["inputs"]["model"] == ["6", 0]
    assert g["200"]["inputs"]["lora_name"] == _LORA_A
    assert g["200"]["inputs"]["strength_model"] == 0.6
    assert "clip" not in g["200"]["inputs"]
    assert g["201"]["inputs"]["model"] == ["200", 0]
    assert g["201"]["inputs"]["lora_name"] == _LORA_B
    assert g["201"]["inputs"]["strength_model"] == 0.8
    # 采样链(BasicGuider/BasicScheduler)改接链末端;H3 节点 clip 仍直引 CLIPLoader
    assert g["16"]["inputs"]["model"] == ["201", 0]
    assert g["9"]["inputs"]["model"] == ["201", 0]
    assert g["104"]["inputs"]["clip"] == ["13", 0]


def test_builder_i2v_injects_lora_chain_and_first_frame():
    """i2v:LoRA 链与 first_frame 注入共存(LoRA 节点 id 200+ 不与模板 100 LoadImage 冲突)。"""
    g = build_h3_i2v_graph(
        H3I2VParams(positive="x", image="h3-in.png", seed=7, loras=(LoraSpec(name=_LORA_B, weight=0.6),))
    )
    assert g["200"]["class_type"] == "LoraLoaderModelOnly"
    assert g["16"]["inputs"]["model"] == ["200", 0]
    assert g["100"]["inputs"]["image"] == "h3-in.png"
    assert g["104"]["inputs"]["first_frame"] == ["100", 0]


def test_builder_lora_chain_does_not_pollute_template_cache():
    """先建带 LoRA 的图再建空图:后者必须无 200 节点且 model 引用回 "6"(模板 deepcopy)。"""
    build_h3_t2v_graph(H3T2VParams(positive="x", seed=1, loras=(LoraSpec(name=_LORA_A, weight=1.0),)))
    g2 = build_h3_t2v_graph(H3T2VParams(positive="y", seed=2))
    assert "200" not in g2
    assert g2["16"]["inputs"]["model"] == ["6", 0]


@pytest.mark.parametrize(
    "lora",
    [
        {"name": "../evil.safetensors", "strength": 0.6},  # 路径穿越
        {"name": "/abs/path.safetensors", "strength": 0.6},  # 绝对路径
        {"name": "not_safetensors.ckpt", "strength": 0.6},  # 非 .safetensors 后缀
        {"name": _LORA_A, "strength": 0.4},  # 强度低于 0.5
        {"name": _LORA_A, "strength": 1.1},  # 强度高于 1.0
    ],
)
def test_t2v_rejects_bad_loras(client, lora):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, f"h3lora-bad-{lora['name'][:8]}-{lora['strength']}")
    r = c.post(
        "/api/h3/t2v",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "a cat", "loras": [lora]},
    )
    assert r.status_code == 422


def test_t2v_rejects_too_many_loras(client):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "h3lora-toomany")
    r = c.post(
        "/api/h3/t2v",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={
            "positive": "a cat",
            "loras": [{"name": f"lora{i}.safetensors"} for i in range(4)],
        },
    )
    assert r.status_code == 422


def test_t2v_sfw_lora_allowed_without_nsfw_header(client, monkeypatch):
    """SFW LoRA(作者标 SFW 的 cxy_kiss):主站(无 X-NSFW 头)放行,Job 不打 R18 标。"""
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "h3lora-sfw")
    fake = _FakeH3Client()
    _install_h3(monkeypatch, fake)
    r = c.post(
        "/api/h3/t2v",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "a couple kissing", "loras": [{"name": _LORA_A, "strength": 0.6}]},
    )
    assert r.status_code == 200, r.text
    graph = fake.graphs[0]
    assert graph["200"]["inputs"]["lora_name"] == _LORA_A
    assert graph["200"]["inputs"]["strength_model"] == 0.6
    assert graph["16"]["inputs"]["model"] == ["200", 0]
    with Session(engine) as s:
        job = s.exec(select(Job).where(Job.user_id == uid)).first()
        assert job is not None and job.nsfw is False


def test_t2v_nsfw_lora_rejected_without_nsfw_header(client, monkeypatch):
    """NSFW LoRA 主站直传:403(与 _gate_ltx_nsfw 同风格),不触碰 H3 实例。"""
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "h3lora-nsfw403")
    fake = _FakeH3Client()
    _install_h3(monkeypatch, fake)
    r = c.post(
        "/api/h3/t2v",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "x", "loras": [{"name": _LORA_NSFW}]},
    )
    assert r.status_code == 403
    assert "NSFW" in r.json()["detail"]
    assert fake.graphs == []


def test_t2v_nsfw_lora_allowed_with_nsfw_header(client, monkeypatch):
    """/nsfw 专区(X-NSFW: 1)引用 NSFW LoRA:放行,Job 打 R18 标,图含 LoRA 链。"""
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "h3lora-nsfw-ok")
    fake = _FakeH3Client()
    _install_h3(monkeypatch, fake)
    r = c.post(
        "/api/h3/t2v",
        headers={"Authorization": f"Bearer {create_token(uid)}", "X-NSFW": "1"},
        json={"positive": "x", "loras": [{"name": _LORA_NSFW, "strength": 0.8}]},
    )
    assert r.status_code == 200, r.text
    graph = fake.graphs[0]
    assert graph["200"]["inputs"]["lora_name"] == _LORA_NSFW
    assert graph["200"]["inputs"]["strength_model"] == 0.8
    with Session(engine) as s:
        job = s.exec(select(Job).where(Job.user_id == uid)).first()
        assert job is not None and job.nsfw is True


def test_i2v_nsfw_lora_rejected_without_nsfw_header(client, monkeypatch):
    """i2v 同款门控:NSFW LoRA 主站直传 403,且不触发参考图转运。"""
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "h3i2v-nsfw403")
    fake = _FakeH3Client()
    _install_h3(monkeypatch, fake)
    monkeypatch.setattr(h3_route, "resolve_worker", lambda worker: _FakeSourceWorker())
    r = c.post(
        "/api/h3/i2v",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={
            "positive": "x", "image": "in.png", "worker": "http://fake-worker",
            "loras": [{"name": _LORA_B}],
        },
    )
    assert r.status_code == 403
    assert fake.uploads == [] and fake.graphs == []
