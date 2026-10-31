"""首尾帧转场(POST /api/generate/transition)—— 请求校验 / 转运提交 / 工作流构造 测试。

覆盖:
  · 校验:缺首帧/尾帧 422(必填);路径穿越 422;空 prompt 422;帧数越界 422(17-241)
  · 正常链路:首帧/尾帧从源 worker 转运到 :8197 实例(qwen_edit 同款转存),
    图内首帧兼作参考图锚点(ref_images,单张不 concat)+ 首尾帧支路
    (WanVideoVACEStartToEndFrame → input_frames/input_masks),Job kind=transition
  · R18 上下文(X-NSFW: 1):Job 打 nsfw 标
  · 故障:实例不可达 503;源 worker 读取失败 502;显存不足且队列忙(hold 关)→ 503 错峰
"""
from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

import app.routes.wan_studio as wan_route
import app.services.longcat as longcat_service
import app.services.hold_queue as hold_queue
import app.services.wan_video as wan_service
from app.comfy.client import ComfyUIError
from app.db import get_session
from app.main import app
from app.models import Job, Tenant, User
from app.security import create_token, hash_password


# --------------------------------------------------------------------------- #
# 公共 fixtures / fakes(与 test_wan_studio.py 同型,本文件自足)
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


class _FakeWanClient:
    """:8197 实例替身:object_info/queue_prompt/upload_image/system_stats/queue_len/free_memory 可控。"""

    def __init__(
        self,
        *,
        reachable: bool = True,
        free_vram_gib: float = 96.0,
        self_queue: int = 0,
    ) -> None:
        self.base_url = "http://fake-wan"
        self._reachable = reachable
        self.free_gib = free_vram_gib
        self._self_queue = self_queue
        self.graphs: list[dict] = []
        self.uploads: list[tuple[bytes, str]] = []

    async def object_info(self, node: str) -> dict:
        if not self._reachable:
            raise ComfyUIError("connection refused")  # 无 status_code = 网络层失败
        return {node: {}}

    async def queue_prompt(self, graph: dict, client_id: str) -> str:
        self.graphs.append(graph)
        return "prompt-transition-1"

    async def upload_image(self, content: bytes, filename: str) -> str:
        self.uploads.append((content, filename))
        return f"wan-{filename}"

    async def queue_len(self) -> int:
        return self._self_queue

    async def free_memory(self) -> None:
        return None

    async def get_system_stats(self) -> dict:
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
    """上传落点 pool worker 替身:get_image_bytes 可控。"""

    def __init__(self, content: bytes = b"frame-bytes") -> None:
        self.base_url = "http://fake-worker"
        self._content = content

    async def get_image_bytes(self, filename: str, subfolder: str, type_: str) -> tuple[bytes, str]:
        return self._content, "application/octet-stream"


def _install_wan(monkeypatch, fake: _FakeWanClient) -> None:
    monkeypatch.setattr(longcat_service, "get_longcat_client", lambda: fake)
    monkeypatch.setattr(longcat_service, "spawn_tracker", lambda client, prompt_id: None)
    monkeypatch.setattr(wan_route, "resolve_worker", lambda worker: _FakeSourceWorker())
    monkeypatch.setattr(
        wan_service,
        "get_settings",
        # fake stats 无 system 段 → RAM 预检解析 None 放行(不占本文件用例语义)
        lambda: SimpleNamespace(wan_min_free_vram_gb=26.0, wan_min_free_ram_gb=15.0),
    )


def _payload(**over) -> dict:
    body = {
        "positive": "镜头从白天过渡到夜晚",
        "first_frame": "first.png",
        "last_frame": "last.png",
        "worker": "http://fake-worker",
    }
    body.update(over)
    return body


# --------------------------------------------------------------------------- #
# 请求校验(422)
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize("field", ["first_frame", "last_frame"])
def test_transition_requires_both_frames(client, field):
    """缺首帧/尾帧任一张 → 422(两者均必填)。"""
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, f"tr-missing-{field}")
    body = _payload()
    del body[field]
    r = c.post(
        "/api/generate/transition",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json=body,
    )
    assert r.status_code == 422


@pytest.mark.parametrize("field", ["first_frame", "last_frame"])
def test_transition_rejects_path_traversal(client, field):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, f"tr-trav-{field}")
    r = c.post(
        "/api/generate/transition",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json=_payload(**{field: "../evil.png"}),
    )
    assert r.status_code == 422


def test_transition_rejects_empty_prompt(client):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "tr-empty-prompt")
    r = c.post(
        "/api/generate/transition",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json=_payload(positive=""),
    )
    assert r.status_code == 422


@pytest.mark.parametrize("num_frames", [16, 242])
def test_transition_rejects_out_of_range_frames(client, num_frames):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, f"tr-frames-{num_frames}")
    r = c.post(
        "/api/generate/transition",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json=_payload(num_frames=num_frames),
    )
    assert r.status_code == 422


def test_transition_requires_auth(client):
    c, _ = client
    r = c.post("/api/generate/transition", json=_payload())
    assert r.status_code == 401


# --------------------------------------------------------------------------- #
# 正常链路:转运 + 工作流构造 + Job 落库
# --------------------------------------------------------------------------- #


def test_transition_ok_transfers_frames_and_builds_s2e_graph(client, monkeypatch):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "tr-ok")
    fake = _FakeWanClient()
    _install_wan(monkeypatch, fake)
    r = c.post(
        "/api/generate/transition",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json=_payload(num_frames=81, seed=11, cfg=4.5),
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["prompt_id"] == "prompt-transition-1"
    assert body["worker"] == "http://fake-wan"
    assert body["seed"] == 11

    # 首帧/尾帧都从源 worker 转运到 :8197 实例
    assert [name for _, name in fake.uploads] == ["first.png", "last.png"]
    graph = fake.graphs[0]
    # 首帧兼作参考图锚点:单张直连 ref_images,不走 ImageConcatMulti
    assert "30" not in graph
    assert graph["20"]["inputs"]["image"] == "wan-first.png"
    assert graph["10"]["inputs"]["ref_images"] == ["21", 0]
    # 首尾帧支路:StartToEndFrame → VACEEncode.input_frames/input_masks
    assert graph["40"]["inputs"]["image"] == "wan-first.png"
    assert graph["42"]["inputs"]["image"] == "wan-last.png"
    s2e = graph["44"]
    assert s2e["class_type"] == "WanVideoVACEStartToEndFrame"
    assert s2e["inputs"]["start_image"] == ["41", 0]
    assert s2e["inputs"]["end_image"] == ["43", 0]
    assert graph["10"]["inputs"]["input_frames"] == ["44", 0]
    assert graph["10"]["inputs"]["input_masks"] == ["44", 1]
    # 采样参数透传
    assert graph["13"]["inputs"]["seed"] == 11
    assert graph["13"]["inputs"]["cfg"] == 4.5

    with Session(engine) as s:
        job = s.exec(select(Job).where(Job.user_id == uid)).first()
        assert job is not None
        assert job.kind == "transition"
        assert job.nsfw is False
        assert job.seed == 11
        assert job.worker == "http://fake-wan"


def test_transition_marks_job_nsfw_with_x_nsfw_header(client, monkeypatch):
    """/nsfw 专区(X-NSFW: 1)提交转场:Job 打 nsfw 标,主站作品库不可见。"""
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "tr-nsfw")
    fake = _FakeWanClient()
    _install_wan(monkeypatch, fake)
    r = c.post(
        "/api/generate/transition",
        headers={"Authorization": f"Bearer {create_token(uid)}", "X-NSFW": "1"},
        json=_payload(),
    )
    assert r.status_code == 200, r.text
    with Session(engine) as s:
        job = s.exec(select(Job).where(Job.user_id == uid)).first()
        assert job is not None
        assert job.kind == "transition" and job.nsfw is False


def test_transition_snaps_non_aligned_size(client, monkeypatch):
    """宽高非 16 对齐:向下取整进图(833→832),而非 422。"""
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "tr-snap")
    fake = _FakeWanClient()
    _install_wan(monkeypatch, fake)
    r = c.post(
        "/api/generate/transition",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json=_payload(width=833, height=485),
    )
    assert r.status_code == 200, r.text
    vace = fake.graphs[0]["10"]["inputs"]
    assert vace["width"] == 832 and vace["height"] == 480


# --------------------------------------------------------------------------- #
# 故障路径
# --------------------------------------------------------------------------- #


def test_transition_instance_unreachable_503(client, monkeypatch):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "tr-down")
    _install_wan(monkeypatch, _FakeWanClient(reachable=False))
    r = c.post(
        "/api/generate/transition",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json=_payload(),
    )
    assert r.status_code == 503
    assert "不可达" in r.json()["detail"]


def test_transition_source_worker_read_failure_502(client, monkeypatch):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "tr-badread")

    class _BrokenSource:
        base_url = "http://fake-worker"

        async def get_image_bytes(self, filename, subfolder, type_):
            raise ComfyUIError("no such file")

    _install_wan(monkeypatch, _FakeWanClient())
    monkeypatch.setattr(wan_route, "resolve_worker", lambda worker: _BrokenSource())
    r = c.post(
        "/api/generate/transition",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json=_payload(),
    )
    assert r.status_code == 502
    assert "读取失败" in r.json()["detail"]


def test_transition_vram_low_and_queue_busy_503(client, monkeypatch):
    """显存互斥预检同 vace:空闲不足 + 实例队列忙(hold 关)→ 503 错峰,不提交。"""
    monkeypatch.setattr(hold_queue, "holdable", lambda exc: False)  # 关 hold 保一期 503 语义
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "tr-vram-busy")
    fake = _FakeWanClient(free_vram_gib=10.0, self_queue=2)
    _install_wan(monkeypatch, fake)
    r = c.post(
        "/api/generate/transition",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json=_payload(),
    )
    assert r.status_code == 503
    assert "错峰" in r.json()["detail"]
    assert fake.graphs == []  # 未提交
