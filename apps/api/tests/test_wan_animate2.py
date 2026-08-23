"""Wan-Animate-2(原生节点 :8199)—— 图构建 / 参数校验 / 端点 / 显存互斥预检 / 自动 caption 测试。

覆盖:
  · 图构建器:全原生节点类型与连线(UNETLoader 蒸馏版/CLIPLoader type=wan/LoadVideo→
    GetVideoComponents/WanAnimate2ToVideo/KSampler cfg=1 euler/TrimVideoLatent 接
    trim_latent 输出/CreateVideo 原声回打包/SaveVideo)、帧数 4k+1 取整、两次构建互不影响
  · 请求校验:帧数越界 422;宽高超界 422;参考图/驱动视频路径穿越 422;positive 可留空
  · POST /api/wan/animate2:参考图 + 驱动视频转运到 :8199 后提交,图内引用转运文件名,
    Job kind=wan_animate2;positive 留空 → 自动反推外观 caption 进图并进 Job;
    实例不可达/缺节点 → 503;X-NSFW 头 → Job 打标
  · ensure_animate2_vram 显存互斥预检:空闲充足放行;不足且队列空闲 → 驱逐自身缓存复查放行;
    不足且队列忙 → 503 错峰;stats 读取失败 → 跳过预检放行;阈值 0 → 关闭预检
"""
from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

import app.routes.wan_studio as wan_route
import app.services.hold_queue as hold_queue
import app.services.wan_animate2 as animate2_service
import app.services.wan_video as wan_service
from app.comfy.client import ComfyUIError
from app.db import get_session
from app.main import app
from app.models import Job, Tenant, User
from app.security import create_token, hash_password
from app.workflows.wan_animate2 import (
    DEFAULT_CLIP_VISION,
    DEFAULT_MODEL,
    DEFAULT_T5,
    DEFAULT_VAE,
    WanAnimate2Params,
    build_wan_animate2_graph,
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


class _FakeAnimate2Client:
    """:8199 实例替身:object_info/queue_prompt/upload_image/system_stats/queue_len/free_memory 可控。"""

    def __init__(
        self,
        *,
        reachable: bool = True,
        has_node: bool = True,
        free_vram_gib: float = 96.0,
        stats_fail: bool = False,
        self_queue: int = 0,
        on_self_free=None,
    ) -> None:
        self.base_url = "http://fake-animate2"
        self._reachable = reachable
        self._has_node = has_node
        self.free_gib = free_vram_gib  # 公开可变:模拟驱逐自身缓存后空闲回升
        self._stats_fail = stats_fail
        self._self_queue = self_queue
        self._on_self_free = on_self_free
        self.self_free_calls = 0
        self.graphs: list[dict] = []
        self.uploads: list[tuple[bytes, str]] = []

    async def object_info(self, node: str) -> dict:
        if not self._reachable:
            raise ComfyUIError("connection refused")  # 无 status_code = 网络层失败
        if not self._has_node:
            raise ComfyUIError(f"unknown node {node}", status_code=404)
        return {node: {}}

    async def queue_prompt(self, graph: dict, client_id: str) -> str:
        self.graphs.append(graph)
        return "prompt-animate2-1"

    async def upload_image(self, content: bytes, filename: str) -> str:
        self.uploads.append((content, filename))
        return f"a2-{filename}"

    async def queue_len(self) -> int:
        return self._self_queue

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
    """上传落点 pool worker 替身:get_image_bytes 可控。"""

    def __init__(self, content: bytes = b"media-bytes") -> None:
        self.base_url = "http://fake-worker"
        self._content = content

    async def get_image_bytes(self, filename: str, subfolder: str, type_: str) -> tuple[bytes, str]:
        return self._content, "application/octet-stream"


def _install_animate2(monkeypatch, fake: _FakeAnimate2Client) -> None:
    monkeypatch.setattr(animate2_service, "get_animate2_client", lambda: fake)
    monkeypatch.setattr(animate2_service, "spawn_tracker", lambda client, prompt_id: None)
    monkeypatch.setattr(wan_route, "resolve_worker", lambda worker: _FakeSourceWorker())
    # 驱动视频转运的补音轨步骤依赖真 ffmpeg,单测替换为直通
    monkeypatch.setattr(wan_service, "ensure_audio_track", lambda c, f: _identity(c))


async def _identity(content):
    return content


def _stub_animate2_settings(monkeypatch, threshold: float = 34.0) -> None:
    """替换 wan_animate2 服务层 settings:显存预检阈值可控。"""
    monkeypatch.setattr(
        animate2_service,
        "get_settings",
        # fake stats 无 system 段 → RAM 预检解析 None 放行(不占本文件用例语义)
        lambda: SimpleNamespace(
            wan_animate2_enabled=True,
            wan_animate2_base="http://fake-animate2",
            wan_animate2_min_free_vram_gb=threshold,
            wan_animate2_min_free_ram_gb=25.0,
            request_timeout=30.0,
        ),
    )


def _payload(**over) -> dict:
    body = {"positive": "女孩外观描述", "image": "in.png", "video": "d.mp4",
            "worker": "http://fake-worker"}
    body.update(over)
    return body


# --------------------------------------------------------------------------- #
# 图构建器
# --------------------------------------------------------------------------- #


def test_builder_structure_and_critical_inputs():
    """全原生节点;关键连线(WanAnimate2ToVideo 条件组装 / TrimVideoLatent / 原声回打包)锁定。"""
    g = build_wan_animate2_graph(WanAnimate2Params(
        positive="人物外观描述:…", image="ref.png", video="drive.mp4", seed=42,
    ))

    assert g["1"]["class_type"] == "UNETLoader"
    assert g["1"]["inputs"]["unet_name"] == DEFAULT_MODEL
    assert g["2"]["class_type"] == "CLIPLoader"
    assert g["2"]["inputs"]["clip_name"] == DEFAULT_T5
    assert g["2"]["inputs"]["type"] == "wan"
    assert g["3"]["class_type"] == "VAELoader"
    assert g["3"]["inputs"]["vae_name"] == DEFAULT_VAE
    assert g["4"]["inputs"]["clip"] == ["2", 0]
    assert g["4"]["inputs"]["text"] == "人物外观描述:…"

    # 参考图支路:LoadImage → CLIPVisionEncode
    assert g["6"]["class_type"] == "LoadImage"
    assert g["6"]["inputs"]["image"] == "ref.png"
    assert g["7"]["inputs"]["clip_name"] == DEFAULT_CLIP_VISION
    assert g["8"]["class_type"] == "CLIPVisionEncode"
    assert g["8"]["inputs"]["image"] == ["6", 0]

    # 驱动视频支路:原生 LoadVideo → GetVideoComponents(无 DWPose 中间件)
    assert g["9"]["class_type"] == "LoadVideo"
    assert g["9"]["inputs"]["file"] == "drive.mp4"
    assert g["10"]["class_type"] == "GetVideoComponents"
    assert g["10"]["inputs"]["video"] == ["9", 0]

    # Animate2 条件组装
    c = g["11"]
    assert c["class_type"] == "WanAnimate2ToVideo"
    assert c["inputs"]["positive"] == ["4", 0] and c["inputs"]["negative"] == ["5", 0]
    assert c["inputs"]["vae"] == ["3", 0]
    assert c["inputs"]["reference_image"] == ["6", 0]
    assert c["inputs"]["pose_video"] == ["10", 0]
    assert c["inputs"]["clip_vision_output"] == ["8", 0]

    # 采样器:蒸馏版 10 步 cfg=1 euler
    s = g["12"]["inputs"]
    assert g["12"]["class_type"] == "KSampler"
    assert s["model"] == ["1", 0]
    assert s["positive"] == ["11", 0] and s["negative"] == ["11", 1]
    assert s["latent_image"] == ["11", 2]
    assert s["steps"] == 10 and s["cfg"] == 1.0 and s["seed"] == 42
    assert s["sampler_name"] == "euler" and s["scheduler"] == "simple"

    # ref latent 帧裁掉 → 解码 → 打包(原声回打包)
    assert g["13"]["class_type"] == "TrimVideoLatent"
    assert g["13"]["inputs"]["samples"] == ["12", 0]
    assert g["13"]["inputs"]["trim_amount"] == ["11", 3]
    assert g["14"]["class_type"] == "VAEDecode"
    assert g["15"]["class_type"] == "CreateVideo"
    assert g["15"]["inputs"]["images"] == ["14", 0]
    assert g["15"]["inputs"]["audio"] == ["10", 1]
    assert g["16"]["class_type"] == "SaveVideo"
    assert g["16"]["inputs"]["video"] == ["15", 0]
    assert g["16"]["inputs"]["filename_prefix"] == "ToIV_wan/animate2"


def test_builder_injects_params():
    g = build_wan_animate2_graph(WanAnimate2Params(
        positive="猫外观", negative="模糊", image="a.png", video="b.mp4",
        width=640, height=640, num_frames=81, steps=8, fps=24, seed=7,
    ))
    assert g["4"]["inputs"]["text"] == "猫外观"
    assert g["5"]["inputs"]["text"] == "模糊"
    assert g["11"]["inputs"]["width"] == 640 and g["11"]["inputs"]["height"] == 640
    assert g["11"]["inputs"]["length"] == 81
    assert g["12"]["inputs"]["steps"] == 8 and g["12"]["inputs"]["seed"] == 7
    assert g["15"]["inputs"]["fps"] == 24.0


@pytest.mark.parametrize("given,snapped", [(17, 17), (120, 121), (122, 125), (500, 501)])
def test_frames_snap_4k1(given, snapped):
    """WanVideo 系时序网格 (T-1)%4==0:向上取整 4k+1(与 v1 同一约束)。"""
    g = build_wan_animate2_graph(WanAnimate2Params(
        positive="x", image="a.png", video="b.mp4", num_frames=given, seed=1,
    ))
    assert g["11"]["inputs"]["length"] == snapped


def test_two_builds_independent():
    g1 = build_wan_animate2_graph(WanAnimate2Params(
        positive="first", image="a.png", video="b.mp4", seed=1,
    ))
    g2 = build_wan_animate2_graph(WanAnimate2Params(
        positive="second", image="a.png", video="b.mp4", seed=2,
    ))
    assert g1["4"]["inputs"]["text"] == "first"
    assert g2["4"]["inputs"]["text"] == "second"
    assert g1["12"]["inputs"]["seed"] == 1


def test_default_seed_random():
    p1 = WanAnimate2Params(positive="x", image="a.png", video="b.mp4")
    p2 = WanAnimate2Params(positive="x", image="a.png", video="b.mp4")
    assert p1.seed >= 0 and p2.seed >= 0  # 随机种子(极低概率相等,不断言不等)


# --------------------------------------------------------------------------- #
# 请求校验(422 / 对齐取整)
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize("num_frames", [16, 502, 0])
def test_rejects_out_of_range_frames(client, num_frames):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, f"a2frames-{num_frames}")
    r = c.post(
        "/api/wan/animate2",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json=_payload(num_frames=num_frames),
    )
    assert r.status_code == 422


@pytest.mark.parametrize("field,value", [("width", 319), ("height", 1281)])
def test_rejects_out_of_range_size(client, field, value):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, f"a2size-{field}")
    r = c.post(
        "/api/wan/animate2",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json=_payload(**{field: value}),
    )
    assert r.status_code == 422


@pytest.mark.parametrize("field", ["image", "video"])
def test_rejects_path_traversal(client, field):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, f"a2trav-{field}")
    r = c.post(
        "/api/wan/animate2",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json=_payload(**{field: "../evil.png"}),
    )
    assert r.status_code == 422


# --------------------------------------------------------------------------- #
# POST /api/wan/animate2
# --------------------------------------------------------------------------- #


def test_ok_transfers_assets_and_submits(client, monkeypatch):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "a2ok")
    fake = _FakeAnimate2Client()
    _install_animate2(monkeypatch, fake)
    _stub_animate2_settings(monkeypatch)
    r = c.post(
        "/api/wan/animate2",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json=_payload(num_frames=121, seed=7),
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["prompt_id"] == "prompt-animate2-1"
    assert body["worker"] == "http://fake-animate2"
    assert body["seed"] == 7
    assert "auto_caption" not in body  # 显式给了 positive,不反推

    # 参考图 + 驱动视频都从源 worker 转运到实例
    assert fake.uploads == [(b"media-bytes", "in.png"), (b"media-bytes", "d.mp4")]
    graph = fake.graphs[0]
    assert graph["6"]["inputs"]["image"] == "a2-in.png"
    assert graph["9"]["inputs"]["file"] == "a2-d.mp4"
    assert graph["11"]["inputs"]["length"] == 121
    assert graph["12"]["inputs"]["seed"] == 7

    with Session(engine) as s:
        job = s.exec(select(Job).where(Job.user_id == uid)).first()
        assert job is not None
        assert job.kind == "wan_animate2"
        assert job.nsfw is False
        assert job.seed == 7
        assert job.worker == "http://fake-animate2"


def test_empty_positive_auto_captions(client, monkeypatch):
    """positive 留空 → VLM 反推外观 caption(官方提示词要求),进图 + 进 Job + 透出响应。"""
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "a2caption")
    fake = _FakeAnimate2Client()
    _install_animate2(monkeypatch, fake)
    _stub_animate2_settings(monkeypatch)

    calls: list[bytes] = []

    async def _fake_caption(content: bytes, content_type: str) -> str:
        calls.append(content)
        return "人物外观描述:自动反推。背景描述:纯白。"

    monkeypatch.setattr(animate2_service, "caption_reference_appearance", _fake_caption)
    r = c.post(
        "/api/wan/animate2",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json=_payload(positive=""),
    )
    assert r.status_code == 200, r.text
    assert calls == [b"media-bytes"]  # 反推喂的是参考图字节
    graph = fake.graphs[0]
    assert graph["4"]["inputs"]["text"] == "人物外观描述:自动反推。背景描述:纯白。"
    assert r.json()["auto_caption"] == "人物外观描述:自动反推。背景描述:纯白。"
    # 自动 caption 路径同样把参考图上传到实例
    assert (b"media-bytes", "in.png") in fake.uploads
    with Session(engine) as s:
        job = s.exec(select(Job).where(Job.user_id == uid)).first()
        assert job.prompt == "人物外观描述:自动反推。背景描述:纯白。"


def test_snaps_non_aligned_size(client, monkeypatch):
    """宽高非 16 对齐:向下取整进图(833→832),而非 422。"""
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "a2snap")
    fake = _FakeAnimate2Client()
    _install_animate2(monkeypatch, fake)
    _stub_animate2_settings(monkeypatch)
    r = c.post(
        "/api/wan/animate2",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json=_payload(width=833, height=485),
    )
    assert r.status_code == 200, r.text
    cond = fake.graphs[0]["11"]["inputs"]
    assert cond["width"] == 832 and cond["height"] == 480


def test_instance_unreachable_503(client, monkeypatch):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "a2down")
    _install_animate2(monkeypatch, _FakeAnimate2Client(reachable=False))
    _stub_animate2_settings(monkeypatch)
    r = c.post(
        "/api/wan/animate2",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json=_payload(),
    )
    assert r.status_code == 503
    assert "不可达" in r.json()["detail"]


def test_missing_animate2_node_503(client, monkeypatch):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "a2nonode")
    _install_animate2(monkeypatch, _FakeAnimate2Client(has_node=False))
    _stub_animate2_settings(monkeypatch)
    r = c.post(
        "/api/wan/animate2",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json=_payload(),
    )
    assert r.status_code == 503
    assert "WanAnimate2ToVideo" in r.json()["detail"]


def test_requires_auth(client):
    c, _ = client
    r = c.post("/api/wan/animate2", json=_payload())
    assert r.status_code == 401


def test_marks_job_nsfw_with_x_nsfw_header(client, monkeypatch):
    """/nsfw 专区(X-NSFW: 1)提交 animate2:Job 打 nsfw 标,主站作品库不可见。"""
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "a2nsfw")
    fake = _FakeAnimate2Client()
    _install_animate2(monkeypatch, fake)
    _stub_animate2_settings(monkeypatch)
    r = c.post(
        "/api/wan/animate2",
        headers={"Authorization": f"Bearer {create_token(uid)}", "X-NSFW": "1"},
        json=_payload(),
    )
    assert r.status_code == 200, r.text
    with Session(engine) as s:
        job = s.exec(select(Job).where(Job.user_id == uid)).first()
        assert job is not None
        assert job.kind == "wan_animate2" and job.nsfw is True


# --------------------------------------------------------------------------- #
# 显存互斥预检(ensure_animate2_vram):GPU3 与 FlashTalk 共卡,绝不驱逐 FlashTalk
# --------------------------------------------------------------------------- #


def test_vram_enough_passes_without_evict(client, monkeypatch):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "a2vram-ok")
    fake = _FakeAnimate2Client(free_vram_gib=60.0)
    _install_animate2(monkeypatch, fake)
    _stub_animate2_settings(monkeypatch, threshold=34.0)
    r = c.post("/api/wan/animate2",
               headers={"Authorization": f"Bearer {create_token(uid)}"},
               json=_payload())
    assert r.status_code == 200, r.text
    assert fake.self_free_calls == 0  # 充足:不驱逐


def test_vram_low_evicts_self_cache_then_passes(client, monkeypatch):
    """空闲不足 + :8199 队列空闲 → 驱逐自身模型缓存后复查放行。"""
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "a2vram-evict")
    fake = _FakeAnimate2Client(
        free_vram_gib=10.0, self_queue=0,
        on_self_free=lambda: setattr(fake, "free_gib", 40.0),
    )
    _install_animate2(monkeypatch, fake)
    _stub_animate2_settings(monkeypatch, threshold=34.0)
    r = c.post("/api/wan/animate2",
               headers={"Authorization": f"Bearer {create_token(uid)}"},
               json=_payload())
    assert r.status_code == 200, r.text
    assert fake.self_free_calls == 1


def test_vram_low_and_queue_busy_503(client, monkeypatch):
    monkeypatch.setattr(hold_queue, "holdable", lambda exc: False)  # 关 hold 保 503 语义
    """空闲不足 + 实例队列非空闲:不驱逐,直接 503 错峰。"""
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "a2vram-busy")
    fake = _FakeAnimate2Client(free_vram_gib=10.0, self_queue=2)
    _install_animate2(monkeypatch, fake)
    _stub_animate2_settings(monkeypatch, threshold=34.0)
    r = c.post("/api/wan/animate2",
               headers={"Authorization": f"Bearer {create_token(uid)}"},
               json=_payload())
    assert r.status_code == 503
    assert "错峰" in r.json()["detail"]
    assert fake.self_free_calls == 0  # 队列忙:绝不驱逐
    assert fake.graphs == []  # 未提交


def test_vram_stats_failure_skips_precheck(client, monkeypatch):
    """/system_stats 读取失败:降级为不预检放行,由 ComfyUI 自身错误兜底。"""
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "a2vram-statsfail")
    fake = _FakeAnimate2Client(stats_fail=True)
    _install_animate2(monkeypatch, fake)
    _stub_animate2_settings(monkeypatch, threshold=34.0)
    r = c.post("/api/wan/animate2",
               headers={"Authorization": f"Bearer {create_token(uid)}"},
               json=_payload())
    assert r.status_code == 200, r.text


def test_vram_precheck_disabled_with_zero_threshold(client, monkeypatch):
    """TOIV_WAN_ANIMATE2_MIN_FREE_VRAM_GB=0:显式关闭预检,低显存也放行。"""
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "a2vram-off")
    fake = _FakeAnimate2Client(free_vram_gib=1.0)
    _install_animate2(monkeypatch, fake)
    _stub_animate2_settings(monkeypatch, threshold=0.0)
    r = c.post("/api/wan/animate2",
               headers={"Authorization": f"Bearer {create_token(uid)}"},
               json=_payload())
    assert r.status_code == 200, r.text
    assert fake.self_free_calls == 0
