"""LongCat-Video 工作室 —— 图构建 / 参数校验 / 端点提交链路 测试。

覆盖:
  · 图构建器:节点类型与连线(照搬 longcat_smoke.py)、rope_function="comfy"、
    scheduler=longcat_distill_euler、cfg=1.0/shift=12.0、模型文件名、参数注入、
    蒸馏 LoRA 置空 → 无 LoraSelect 节点且 ModelLoader.lora=None、两次构建互不影响
  · 请求校验:num_frames 越界(16/962)422;宽高超界 422;宽高非 16 对齐自动向下取整
  · POST /api/longcat/t2v:成功提交(Job kind=longcat_t2v、seed 落快照);
    实例不可达 → 503;缺 WanVideoModelLoader 节点 → 503;TOIV_LONGCAT_ENABLED=false → 503
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

import app.services.longcat as longcat_service
import app.routes.longcat_studio as longcat_route
from app.comfy.client import ComfyUIError
from app.db import get_session
from app.main import app
from app.models import Job, Tenant, User
from app.security import create_token, hash_password
from app.workflows.longcat_video import (
    DEFAULT_DISTILL_LORA,
    DEFAULT_MODEL,
    DEFAULT_T5,
    DEFAULT_VAE,
    LongCatI2VParams,
    LongCatT2VParams,
    build_longcat_i2v_graph,
    build_longcat_t2v_graph,
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


class _FakeLongCatClient:
    """LongCat 实例替身:object_info/queue_prompt 可控,不联网。"""

    def __init__(self, *, reachable: bool = True, has_node: bool = True) -> None:
        self.base_url = "http://fake-longcat"
        self._reachable = reachable
        self._has_node = has_node
        self.graphs: list[dict] = []

    async def object_info(self, node: str) -> dict:
        if not self._reachable:
            raise ComfyUIError("connection refused")  # 无 status_code = 网络层失败
        if not self._has_node:
            raise ComfyUIError(f"unknown node {node}", status_code=404)
        return {node: {}}

    async def queue_prompt(self, graph: dict, client_id: str) -> str:
        self.graphs.append(graph)
        return "prompt-longcat-1"


def _install_longcat(monkeypatch, fake: _FakeLongCatClient) -> None:
    monkeypatch.setattr(longcat_service, "get_longcat_client", lambda: fake)
    monkeypatch.setattr(longcat_service, "spawn_tracker", lambda client, prompt_id: None)


# --------------------------------------------------------------------------- #
# 图构建器
# --------------------------------------------------------------------------- #


def test_builder_graph_structure_and_critical_inputs():
    """节点类型/连线照搬 longcat_smoke.py;关键输入(rope/scheduler/cfg/shift)锁定。"""
    g = build_longcat_t2v_graph(LongCatT2VParams(positive="雪山湖泊", seed=42))

    assert g["1"]["class_type"] == "WanVideoLoraSelect"
    assert g["1"]["inputs"]["lora"] == DEFAULT_DISTILL_LORA
    assert g["2"]["class_type"] == "WanVideoBlockSwap"
    assert g["2"]["inputs"]["blocks_to_swap"] == 10
    assert g["3"]["class_type"] == "WanVideoModelLoader"
    assert g["3"]["inputs"]["model"] == DEFAULT_MODEL
    assert g["3"]["inputs"]["lora"] == ["1", 0]
    assert g["3"]["inputs"]["block_swap_args"] == ["2", 0]
    assert g["3"]["inputs"]["base_precision"] == "bf16"
    assert g["3"]["inputs"]["load_device"] == "offload_device"
    assert g["3"]["inputs"]["attention_mode"] == "sdpa"
    assert g["4"]["class_type"] == "LoadWanVideoT5TextEncoder"
    assert g["4"]["inputs"]["model_name"] == DEFAULT_T5
    assert g["5"]["class_type"] == "WanVideoTextEncode"
    assert g["5"]["inputs"]["t5"] == ["4", 0]
    assert g["6"]["class_type"] == "WanVideoEmptyEmbeds"
    assert g["8"]["class_type"] == "WanVideoVAELoader"
    assert g["8"]["inputs"]["model_name"] == DEFAULT_VAE
    assert g["9"]["class_type"] == "WanVideoDecode"
    assert g["9"]["inputs"]["vae"] == ["8", 0]
    assert g["9"]["inputs"]["samples"] == ["7", 0]
    assert g["10"]["class_type"] == "VHS_VideoCombine"
    assert g["10"]["inputs"]["images"] == ["9", 0]

    # 采样器:真机踩坑约束(rope_function 必须 comfy,否则 4096 vs 128 维度错)
    s = g["7"]["inputs"]
    assert s["rope_function"] == "comfy"
    assert s["scheduler"] == "longcat_distill_euler"
    assert s["cfg"] == 1.0 and s["shift"] == 12.0
    assert s["model"] == ["3", 0] and s["image_embeds"] == ["6", 0] and s["text_embeds"] == ["5", 0]


def test_builder_injects_params():
    g = build_longcat_t2v_graph(LongCatT2VParams(
        positive="一只猫", negative="模糊", width=480, height=832,
        num_frames=49, steps=8, fps=24, seed=7,
    ))
    assert g["5"]["inputs"]["positive_prompt"] == "一只猫"
    assert g["5"]["inputs"]["negative_prompt"] == "模糊"
    assert g["6"]["inputs"] == {"width": 480, "height": 832, "num_frames": 49}
    assert g["7"]["inputs"]["steps"] == 8
    assert g["7"]["inputs"]["seed"] == 7
    assert g["10"]["inputs"]["frame_rate"] == 24
    assert g["10"]["inputs"]["filename_prefix"] == "ToIV_longcat/t2v"


def test_builder_without_distill_lora():
    """distill_lora 置空:无 WanVideoLoraSelect 节点,ModelLoader.lora=None。"""
    g = build_longcat_t2v_graph(LongCatT2VParams(positive="x", distill_lora="", seed=1))
    assert "1" not in g
    assert g["3"]["inputs"]["lora"] is None


def test_builder_two_builds_independent():
    g1 = build_longcat_t2v_graph(LongCatT2VParams(positive="first", seed=1))
    g2 = build_longcat_t2v_graph(LongCatT2VParams(positive="second", seed=2))
    assert g1["5"]["inputs"]["positive_prompt"] == "first"
    assert g2["5"]["inputs"]["positive_prompt"] == "second"
    assert g1["7"]["inputs"]["seed"] == 1


def test_builder_default_seed_random():
    p1 = LongCatT2VParams(positive="x")
    p2 = LongCatT2VParams(positive="x")
    assert p1.seed >= 0 and p2.seed >= 0  # 随机种子(极低概率相等,不断言不等)


# --------------------------------------------------------------------------- #
# 请求校验(422 / 对齐取整)
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize("num_frames", [16, 962, 0])
def test_t2v_rejects_out_of_range_frames(client, num_frames):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, f"lcframes-{num_frames}")
    r = c.post(
        "/api/longcat/t2v",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "a cat", "num_frames": num_frames},
    )
    assert r.status_code == 422


@pytest.mark.parametrize("field,value", [("width", 319), ("height", 1281)])
def test_t2v_rejects_out_of_range_size(client, field, value):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, f"lcsize-{field}")
    r = c.post(
        "/api/longcat/t2v",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "a cat", field: value},
    )
    assert r.status_code == 422


def test_t2v_snaps_non_aligned_size(client, monkeypatch):
    """宽高非 16 对齐:向下取整进图(833→832、485→480),而非 422。"""
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "lcsnap")
    fake = _FakeLongCatClient()
    _install_longcat(monkeypatch, fake)
    r = c.post(
        "/api/longcat/t2v",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "a cat", "width": 833, "height": 485},
    )
    assert r.status_code == 200, r.text
    embeds = fake.graphs[0]["6"]["inputs"]
    assert embeds["width"] == 832 and embeds["height"] == 480


# --------------------------------------------------------------------------- #
# POST /api/longcat/t2v
# --------------------------------------------------------------------------- #


def test_t2v_ok_submits_graph_and_job(client, monkeypatch):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "lct2vok")
    fake = _FakeLongCatClient()
    _install_longcat(monkeypatch, fake)
    r = c.post(
        "/api/longcat/t2v",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "楼道里的中年女人", "num_frames": 121, "seed": 42},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["prompt_id"] == "prompt-longcat-1"
    assert body["worker"] == "http://fake-longcat"
    assert body["seed"] == 42

    graph = fake.graphs[0]
    assert graph["5"]["inputs"]["positive_prompt"] == "楼道里的中年女人"
    assert graph["6"]["inputs"]["num_frames"] == 121
    assert graph["7"]["inputs"]["seed"] == 42

    with Session(engine) as s:
        job = s.exec(select(Job).where(Job.user_id == uid)).first()
        assert job is not None
        assert job.kind == "longcat_t2v"
        assert job.nsfw is False
        assert job.seed == 42
        assert job.worker == "http://fake-longcat"


def test_t2v_default_seed_randomized(client, monkeypatch):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "lct2vseed")
    fake = _FakeLongCatClient()
    _install_longcat(monkeypatch, fake)
    r = c.post(
        "/api/longcat/t2v",
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
        uid = _seed_user(s, "lct2vdown")
    _install_longcat(monkeypatch, _FakeLongCatClient(reachable=False))
    r = c.post(
        "/api/longcat/t2v",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "a cat"},
    )
    assert r.status_code == 503
    assert "不可达" in r.json()["detail"]


def test_t2v_missing_wanvideo_node_503(client, monkeypatch):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "lct2vnonode")
    _install_longcat(monkeypatch, _FakeLongCatClient(has_node=False))
    r = c.post(
        "/api/longcat/t2v",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "a cat"},
    )
    assert r.status_code == 503
    assert "WanVideoModelLoader" in r.json()["detail"]


def test_t2v_disabled_returns_503(client, monkeypatch):
    """TOIV_LONGCAT_ENABLED=false 时返回 503,不触碰实例。"""
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "lcdisabled")
    from types import SimpleNamespace

    monkeypatch.setattr(
        longcat_service, "get_settings", lambda: SimpleNamespace(longcat_enabled=False)
    )

    def _no_client():
        raise AssertionError("LongCat 已禁用,不应创建实例客户端")

    monkeypatch.setattr(longcat_service, "get_longcat_client", _no_client)
    r = c.post(
        "/api/longcat/t2v",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "a cat"},
    )
    assert r.status_code == 503
    assert "已禁用" in r.json()["detail"]


def test_t2v_requires_auth(client):
    c, _ = client
    assert c.post("/api/longcat/t2v", json={"positive": "x"}).status_code == 401


# --------------------------------------------------------------------------- #
# i2v 图构建器(首帧支路照搬官方示例 LongCat_TI2V_example_01.json)
# --------------------------------------------------------------------------- #


def test_i2v_builder_adds_first_frame_branch():
    g = build_longcat_i2v_graph(LongCatI2VParams(positive="猫抬头", image="first.png", seed=9))
    assert g["11"]["class_type"] == "LoadImage"
    assert g["11"]["inputs"]["image"] == "first.png"
    assert g["12"]["class_type"] == "ImageResizeKJv2"
    assert g["12"]["inputs"]["image"] == ["11", 0]
    assert g["12"]["inputs"]["width"] == 832 and g["12"]["inputs"]["height"] == 480
    assert g["12"]["inputs"]["keep_proportion"] == "crop"
    assert g["12"]["inputs"]["divisible_by"] == 16
    assert g["13"]["class_type"] == "WanVideoEncode"
    assert g["13"]["inputs"]["vae"] == ["8", 0]
    assert g["13"]["inputs"]["image"] == ["12", 0]
    # 首帧经 extra_latents 进 EmptyEmbeds(示例 note:T2V 不接 extra_latents)
    assert g["6"]["inputs"]["extra_latents"] == ["13", 0]
    # t2v 骨架不变(rope/scheduler 等关键输入仍在)
    assert g["7"]["inputs"]["rope_function"] == "comfy"
    assert g["10"]["inputs"]["filename_prefix"] == "ToIV_longcat/i2v"


def test_t2v_builder_has_no_extra_latents():
    g = build_longcat_t2v_graph(LongCatT2VParams(positive="x", seed=1))
    assert "extra_latents" not in g["6"]["inputs"]
    for nid in ("11", "12", "13"):
        assert nid not in g


# --------------------------------------------------------------------------- #
# 长帧数自动上下文窗口(>241 帧:WanVideoContextOptions 81/overlap16 + 块交换 30)
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize("num_frames", [17, 121, 241])
def test_short_video_no_context_window(num_frames):
    g = build_longcat_t2v_graph(LongCatT2VParams(positive="x", num_frames=num_frames, seed=1))
    assert "14" not in g
    assert "context_options" not in g["7"]["inputs"]
    assert g["2"]["inputs"]["blocks_to_swap"] == 10


@pytest.mark.parametrize("num_frames", [242, 481, 961])
def test_long_video_auto_context_window(num_frames):
    g = build_longcat_t2v_graph(LongCatT2VParams(positive="x", num_frames=num_frames, seed=1))
    assert g["14"]["class_type"] == "WanVideoContextOptions"
    assert g["14"]["inputs"]["context_frames"] == 81
    assert g["14"]["inputs"]["context_overlap"] == 16
    assert g["14"]["inputs"]["context_schedule"] == "uniform_standard"
    assert g["7"]["inputs"]["context_options"] == ["14", 0]
    assert g["2"]["inputs"]["blocks_to_swap"] == 30


def test_i2v_long_video_also_auto_context_window():
    """自动开窗对 i2v/续写(复用 i2v 图)同样生效。"""
    g = build_longcat_i2v_graph(LongCatI2VParams(
        positive="x", image="f.png", num_frames=961, seed=1,
    ))
    assert "14" in g
    assert g["7"]["inputs"]["context_options"] == ["14", 0]
    assert g["2"]["inputs"]["blocks_to_swap"] == 30
    assert g["6"]["inputs"]["extra_latents"] == ["13", 0]


# --------------------------------------------------------------------------- #
# POST /api/longcat/i2v
# --------------------------------------------------------------------------- #


class _FakeSourceWorker:
    """上传落点 pool worker 替身:get_image_bytes 可控。"""

    base_url = "http://fake-worker"

    async def get_image_bytes(self, filename, subfolder, type_):
        return b"img-bytes", "image/png"


class _FakeLongCatI2VClient(_FakeLongCatClient):
    """加 upload_image 的 LongCat 实例替身(记录上传字节/文件名)。"""

    def __init__(self, **kw) -> None:
        super().__init__(**kw)
        self.uploads: list[tuple[bytes, str]] = []

    async def upload_image(self, content: bytes, filename: str) -> str:
        self.uploads.append((content, filename))
        return f"lc-{filename}"


def test_i2v_ok_transfers_ref_image_and_submits(client, monkeypatch):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "lci2vok")
    fake = _FakeLongCatI2VClient()
    _install_longcat(monkeypatch, fake)
    monkeypatch.setattr(longcat_route, "resolve_worker", lambda worker: _FakeSourceWorker())
    r = c.post(
        "/api/longcat/i2v",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "猫抬头", "image": "in.png", "worker": "http://fake-worker",
              "num_frames": 121, "seed": 7},
    )
    assert r.status_code == 200, r.text
    # 参考图从源 worker 读出并上传到 LongCat 实例,图内引用转运后的文件名
    assert fake.uploads == [(b"img-bytes", "in.png")]
    graph = fake.graphs[0]
    assert graph["11"]["inputs"]["image"] == "lc-in.png"
    assert graph["6"]["inputs"]["extra_latents"] == ["13", 0]
    with Session(engine) as s:
        job = s.exec(select(Job).where(Job.user_id == uid)).first()
        assert job is not None and job.kind == "longcat_i2v"
        assert job.seed == 7


def test_i2v_source_worker_read_failure_502(client, monkeypatch):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "lci2vbadread")

    class _BrokenSource:
        base_url = "http://fake-worker"

        async def get_image_bytes(self, filename, subfolder, type_):
            raise ComfyUIError("no such file")

    _install_longcat(monkeypatch, _FakeLongCatI2VClient())
    monkeypatch.setattr(longcat_route, "resolve_worker", lambda worker: _BrokenSource())
    r = c.post(
        "/api/longcat/i2v",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "x", "image": "in.png", "worker": "http://fake-worker"},
    )
    assert r.status_code == 502
    assert "读取失败" in r.json()["detail"]


def test_i2v_rejects_path_traversal(client):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "lci2vtrav")
    r = c.post(
        "/api/longcat/i2v",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "x", "image": "../evil.png", "worker": "http://fake-worker"},
    )
    assert r.status_code == 422


# --------------------------------------------------------------------------- #
# POST /api/longcat/continue(抽末帧 → i2v 续写)
# --------------------------------------------------------------------------- #


def _fake_prepare_continue(frame="last.jpg", meta=(832, 480, 16)):
    async def _run(client, video, worker):
        return frame, meta
    return _run


def test_continue_ok_submits_i2v_graph(client, monkeypatch):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "lccontok")
    fake = _FakeLongCatClient()
    _install_longcat(monkeypatch, fake)
    monkeypatch.setattr(
        longcat_service, "prepare_continue_first_frame", _fake_prepare_continue()
    )
    r = c.post(
        "/api/longcat/continue",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={
            "positive": "镜头继续",
            "video": "/api/images?filename=a.mp4&worker=http%3A%2F%2Ffake-worker",
            "num_frames": 121, "seed": 11,
        },
    )
    assert r.status_code == 200, r.text
    graph = fake.graphs[0]
    # 末帧作 i2v 首帧;分辨率/帧率缺省向源视频实测值(832×480@16)对齐
    assert graph["11"]["inputs"]["image"] == "last.jpg"
    assert graph["6"]["inputs"]["extra_latents"] == ["13", 0]
    assert graph["6"]["inputs"]["width"] == 832 and graph["6"]["inputs"]["height"] == 480
    assert graph["10"]["inputs"]["frame_rate"] == 16
    assert graph["10"]["inputs"]["filename_prefix"] == "ToIV_longcat/continue"
    with Session(engine) as s:
        job = s.exec(select(Job).where(Job.user_id == uid)).first()
        assert job is not None and job.kind == "longcat_continue"


def test_continue_explicit_params_override_source_meta(client, monkeypatch):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "lccontovr")
    fake = _FakeLongCatClient()
    _install_longcat(monkeypatch, fake)
    monkeypatch.setattr(
        longcat_service, "prepare_continue_first_frame", _fake_prepare_continue()
    )
    r = c.post(
        "/api/longcat/continue",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={
            "positive": "镜头继续", "video": "up.mp4", "worker": "http://fake-worker",
            "width": 1280, "height": 720, "fps": 24, "seed": 1,
        },
    )
    assert r.status_code == 200, r.text
    graph = fake.graphs[0]
    assert graph["6"]["inputs"]["width"] == 1280 and graph["6"]["inputs"]["height"] == 720
    assert graph["10"]["inputs"]["frame_rate"] == 24


def test_continue_requires_video(client):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "lccontmiss")
    r = c.post(
        "/api/longcat/continue",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "x"},
    )
    assert r.status_code == 422


# --------------------------------------------------------------------------- #
# 续写源视频字节解析(_fetch_source_video_bytes:产物 URL / 上传文件名)
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_fetch_source_video_from_artifact_url(monkeypatch):
    captured = {}

    class _Src:
        base_url = "http://fake-worker"

        async def get_image_bytes(self, filename, subfolder, type_):
            captured.update(filename=filename, subfolder=subfolder, type_=type_)
            return b"mp4-bytes", "video/mp4"

    monkeypatch.setattr(longcat_service, "resolve_worker", lambda w: _Src())
    content = await longcat_service._fetch_source_video_bytes(
        "/api/images?filename=a.mp4&subfolder=ToIV_longcat&type=output&worker=http%3A%2F%2Ffake-worker",
        None,
    )
    assert content == b"mp4-bytes"
    assert captured == {"filename": "a.mp4", "subfolder": "ToIV_longcat", "type_": "output"}


@pytest.mark.asyncio
async def test_fetch_source_video_upload_requires_worker():
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as exc:
        await longcat_service._fetch_source_video_bytes("up.mp4", None)
    assert exc.value.status_code == 422


@pytest.mark.asyncio
async def test_fetch_source_video_rejects_traversal():
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as exc:
        await longcat_service._fetch_source_video_bytes("../evil.mp4", "http://fake-worker")
    assert exc.value.status_code == 422


# --------------------------------------------------------------------------- #
# R18 打标(2026-08-08):X-NSFW 上下文 → Job.nsfw,进 /nsfw 专区作品库;
# 主站(无头)恒 False(与 LTX 门控同一判定来源 nsfw_allowed)
# --------------------------------------------------------------------------- #


def test_t2v_marks_job_nsfw_with_x_nsfw_header(client, monkeypatch):
    """/nsfw 专区(X-NSFW: 1)提交 longcat t2v:Job 打 nsfw 标,主站作品库不可见。"""
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "lcnsfw")
    fake = _FakeLongCatClient()
    _install_longcat(monkeypatch, fake)
    r = c.post(
        "/api/longcat/t2v",
        headers={"Authorization": f"Bearer {create_token(uid)}", "X-NSFW": "1"},
        json={"positive": "a girl, cinematic"},
    )
    assert r.status_code == 200, r.text
    with Session(engine) as s:
        job = s.exec(select(Job).where(Job.user_id == uid)).first()
        assert job is not None
        assert job.kind == "longcat_t2v" and job.nsfw is True


def test_continue_marks_job_nsfw_with_x_nsfw_header(client, monkeypatch):
    """/nsfw 专区提交 longcat 续写:续写段 Job 打 nsfw 标(R18 长镜头不漏进主站)。"""
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "lccontnsfw")
    fake = _FakeLongCatClient()
    _install_longcat(monkeypatch, fake)
    monkeypatch.setattr(
        longcat_service, "prepare_continue_first_frame", _fake_prepare_continue()
    )
    r = c.post(
        "/api/longcat/continue",
        headers={"Authorization": f"Bearer {create_token(uid)}", "X-NSFW": "1"},
        json={
            "positive": "镜头继续",
            "video": "/api/images?filename=a.mp4&worker=http%3A%2F%2Ffake-worker",
        },
    )
    assert r.status_code == 200, r.text
    with Session(engine) as s:
        job = s.exec(select(Job).where(Job.user_id == uid)).first()
        assert job is not None
        assert job.kind == "longcat_continue" and job.nsfw is True


def test_t2v_main_site_job_not_nsfw(client, monkeypatch):
    """主站(无 X-NSFW 头)行为不变:Job 不打 nsfw 标。"""
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "lcsfw")
    fake = _FakeLongCatClient()
    _install_longcat(monkeypatch, fake)
    r = c.post(
        "/api/longcat/t2v",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "a cat"},
    )
    assert r.status_code == 200, r.text
    with Session(engine) as s:
        job = s.exec(select(Job).where(Job.user_id == uid)).first()
        assert job is not None and job.nsfw is False
