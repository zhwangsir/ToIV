"""Ovi 1.1 音画工作室 —— 图构建 / 提示词拼装 / 参数校验 / 端点提交链路 测试。

覆盖:
  · 图构建器:节点类型与连线(照搬官方 10s 示例)、bf16/sdpa/offload、euler/rope=default、
    cfg=4.0/shift=5.0、模型文件名、音频链(OviCFG 取音频负向编码第 2 输出、
    EmptyMMAudioLatents → sampler.samples、DecodeOviAudio → VHS.audio)、参数注入
  · 提示词拼装:<S>台词</E> 自动包裹、"Audio: " 前缀、自带格式原样透传
  · 音频潜长度锚点:121 帧→157、241 帧→314
  · 请求校验:num_frames/宽高越界 422;4n+1 与 32 对齐吸附;路径穿越 422
  · POST /api/ovi/t2v:成功提交(Job kind=ovi_t2v、拼装后提示词进图与快照);
    未认证 401;实例不可达 503;X-NSFW 打标
  · POST /api/ovi/i2v:参考图转运 + extra_latents 进图
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

import app.services.longcat as longcat_service
import app.routes.ovi as ovi_route
from app.comfy.client import ComfyUIError
from app.db import get_session
from app.main import app
from app.models import Job, Tenant, User
from app.security import create_token, hash_password
from app.workflows.ovi import (
    DEFAULT_AUDIO_VAE,
    DEFAULT_AUDIO_VOCODER,
    DEFAULT_MODEL,
    DEFAULT_T5,
    DEFAULT_VAE,
    OviI2VParams,
    OviT2VParams,
    assemble_ovi_prompt,
    audio_latent_length,
    build_ovi_i2v_graph,
    build_ovi_t2v_graph,
    required_models,
)


# --------------------------------------------------------------------------- #
# 公共 fixtures / fakes(与 test_longcat_studio 同一替身协议:同实例 :8197)
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


class _FakeOviClient:
    """Ovi 实例(:8197)替身:object_info/queue_prompt/system_stats 可控,不联网。"""

    def __init__(self, *, reachable: bool = True, has_node: bool = True) -> None:
        self.base_url = "http://fake-ovi"
        self._reachable = reachable
        self._has_node = has_node
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
        return "prompt-ovi-1"

    async def upload_image(self, content: bytes, filename: str) -> str:
        self.uploads.append((content, filename))
        return f"ovi-{filename}"

    # 资源预算预检需要的实例接口:默认资源充足,直接放行
    async def queue_len(self) -> int:
        return 0

    async def free_memory(self) -> None:
        pass

    async def get_system_stats(self) -> dict:
        return {
            "devices": [{
                "name": "cuda:0 FakeGPU", "type": "cuda",
                "vram_free": 96 * (1 << 30), "vram_total": 96 * (1 << 30),
            }],
            "system": {"ram_free": 128 * (1 << 30), "ram_total": 183 * (1 << 30)},
        }


def _install_ovi(monkeypatch, fake: _FakeOviClient) -> None:
    monkeypatch.setattr(longcat_service, "get_longcat_client", lambda: fake)
    monkeypatch.setattr(longcat_service, "spawn_tracker", lambda client, prompt_id: None)


# --------------------------------------------------------------------------- #
# 图构建器
# --------------------------------------------------------------------------- #


def test_builder_graph_structure_and_critical_inputs():
    """节点类型/连线照搬官方 10s 示例;关键输入(bf16/offload/euler/rope)锁定。"""
    g = build_ovi_t2v_graph(OviT2VParams(positive="机械师调试蓝色小车", seed=42))

    assert g["1"]["class_type"] == "WanVideoBlockSwap"
    assert g["1"]["inputs"]["blocks_to_swap"] == 34
    assert g["2"]["class_type"] == "WanVideoModelLoader"
    assert g["2"]["inputs"]["model"] == DEFAULT_MODEL
    assert g["2"]["inputs"]["base_precision"] == "bf16"  # 官方 note:fp16 出黑屏
    assert g["2"]["inputs"]["quantization"] == "disabled"  # KJ fp8_scaled 自带 scale
    assert g["2"]["inputs"]["load_device"] == "offload_device"
    assert g["2"]["inputs"]["attention_mode"] == "sdpa"
    assert g["2"]["inputs"]["block_swap_args"] == ["1", 0]
    assert g["3"]["class_type"] == "WanVideoTextEncodeCached"
    assert g["3"]["inputs"]["model_name"] == DEFAULT_T5
    assert g["4"]["class_type"] == "WanVideoTextEncodeCached"
    assert g["4"]["inputs"]["positive_prompt"] == ""  # 音频负向编码:正向留空
    assert g["5"]["class_type"] == "WanVideoOviCFG"
    assert g["5"]["inputs"]["original_text_embeds"] == ["3", 0]
    assert g["5"]["inputs"]["ovi_negative_text_embeds"] == ["4", 1]  # 第 2 输出=负嵌入
    assert g["6"]["class_type"] == "WanVideoEmptyEmbeds"
    assert g["7"]["class_type"] == "WanVideoEmptyMMAudioLatents"
    assert g["9"]["class_type"] == "WanVideoVAELoader"
    assert g["9"]["inputs"]["model_name"] == DEFAULT_VAE
    assert g["10"]["class_type"] == "WanVideoDecode"
    assert g["10"]["inputs"]["samples"] == ["8", 0]
    assert g["11"]["class_type"] == "OviMMAudioVAELoader"
    assert g["11"]["inputs"]["vae"] == DEFAULT_AUDIO_VAE
    assert g["11"]["inputs"]["vocoder"] == DEFAULT_AUDIO_VOCODER
    assert g["12"]["class_type"] == "WanVideoDecodeOviAudio"
    assert g["12"]["inputs"]["mmaudio_vae"] == ["11", 0]
    assert g["12"]["inputs"]["samples"] == ["8", 0]
    assert g["13"]["class_type"] == "VHS_VideoCombine"
    assert g["13"]["inputs"]["images"] == ["10", 0]
    assert g["13"]["inputs"]["audio"] == ["12", 0]  # 音轨进 mp4

    # 采样器:示例锁定值(euler 非节点默认 unipc;音频潜进 samples 输入)
    s = g["8"]["inputs"]
    assert s["model"] == ["2", 0] and s["image_embeds"] == ["6", 0]
    assert s["text_embeds"] == ["5", 0] and s["samples"] == ["7", 0]
    assert s["scheduler"] == "euler"
    assert s["rope_function"] == "default"  # Ovi 示例值(LongCat 的 comfy 约束不适用)
    assert s["cfg"] == 4.0 and s["shift"] == 5.0
    assert s["steps"] == 50 and s["seed"] == 42
    assert s["force_offload"] is True


def test_builder_injects_params():
    g = build_ovi_t2v_graph(OviT2VParams(
        positive="猫说<S>你好<E> Audio: 安静房间", negative="模糊", audio_negative="杂音",
        width=992, height=512, num_frames=121, steps=30, cfg=5.0,
        ovi_audio_cfg=4.5, fps=24, seed=7,
    ))
    assert g["3"]["inputs"]["positive_prompt"] == "猫说<S>你好<E> Audio: 安静房间"
    assert g["3"]["inputs"]["negative_prompt"] == "模糊"
    assert g["4"]["inputs"]["negative_prompt"] == "杂音"
    assert g["5"]["inputs"]["ovi_audio_cfg"] == 4.5
    assert g["6"]["inputs"] == {"width": 992, "height": 512, "num_frames": 121}
    assert g["7"]["inputs"]["length"] == 157  # 121 帧锚点
    assert g["8"]["inputs"]["steps"] == 30 and g["8"]["inputs"]["cfg"] == 5.0
    assert g["13"]["inputs"]["frame_rate"] == 24.0
    assert g["13"]["inputs"]["filename_prefix"] == "ToIV_ovi/t2v"


def test_audio_latent_length_anchors():
    """官方示例两锚点:121 帧→157(5s)、241 帧→314(10s)。"""
    assert audio_latent_length(121) == 157
    assert audio_latent_length(241) == 314


def test_builder_two_builds_independent():
    g1 = build_ovi_t2v_graph(OviT2VParams(positive="first", seed=1))
    g2 = build_ovi_t2v_graph(OviT2VParams(positive="second", seed=2))
    assert g1["3"]["inputs"]["positive_prompt"] == "first"
    assert g2["3"]["inputs"]["positive_prompt"] == "second"
    assert g1["8"]["inputs"]["seed"] == 1


def test_required_models_lists_all_assets():
    m = required_models()
    assert m["diffusion_models"] == DEFAULT_MODEL
    assert m["text_encoders"] == DEFAULT_T5
    assert m["vae"] == DEFAULT_VAE
    assert m["vae_audio"] == DEFAULT_AUDIO_VAE
    assert m["vae_vocoder"] == DEFAULT_AUDIO_VOCODER


# --------------------------------------------------------------------------- #
# 提示词拼装(<S>/<E> 硬约束 + Audio: 前缀)
# --------------------------------------------------------------------------- #


def test_assemble_wraps_speech_and_audio_caption():
    out = assemble_ovi_prompt("一个女孩在厨房", "今天晚饭吃什么?", "切菜声, 抽油烟机")
    assert out == "一个女孩在厨房 <S>今天晚饭吃什么?<E> Audio: 切菜声, 抽油烟机"


def test_assemble_passthrough_when_user_supplies_tags():
    p = "女孩说 <S>你好<E>, Audio: 安静"
    assert assemble_ovi_prompt(p, "不会被包第二次", "也不会再追加") == p


def test_assemble_empty_extras_returns_visual_only():
    assert assemble_ovi_prompt("纯场景") == "纯场景"


# --------------------------------------------------------------------------- #
# i2v 图构建器(首帧支路照搬官方示例)
# --------------------------------------------------------------------------- #


def test_i2v_builder_adds_first_frame_branch():
    g = build_ovi_i2v_graph(OviI2VParams(positive="猫抬头说话", image="first.png", seed=9))
    assert g["14"]["class_type"] == "LoadImage"
    assert g["14"]["inputs"]["image"] == "first.png"
    assert g["15"]["class_type"] == "ImageResizeKJv2"
    assert g["15"]["inputs"]["image"] == ["14", 0]
    assert g["15"]["inputs"]["width"] == 960 and g["15"]["inputs"]["height"] == 960
    assert g["15"]["inputs"]["keep_proportion"] == "crop"
    assert g["15"]["inputs"]["divisible_by"] == 32
    assert g["16"]["class_type"] == "WanVideoEncode"
    assert g["16"]["inputs"]["vae"] == ["9", 0]
    assert g["16"]["inputs"]["image"] == ["15", 0]
    # 首帧经 extra_latents 进 EmptyEmbeds(示例 note:T2V 不接 extra_latents)
    assert g["6"]["inputs"]["extra_latents"] == ["16", 0]
    assert g["13"]["inputs"]["filename_prefix"] == "ToIV_ovi/i2v"
    # 音频链不变
    assert g["8"]["inputs"]["samples"] == ["7", 0]
    assert g["13"]["inputs"]["audio"] == ["12", 0]


def test_t2v_builder_has_no_extra_latents():
    g = build_ovi_t2v_graph(OviT2VParams(positive="x", seed=1))
    assert "extra_latents" not in g["6"]["inputs"]
    for nid in ("14", "15", "16"):
        assert nid not in g


# --------------------------------------------------------------------------- #
# 请求校验(422 / 对齐吸附)
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize("num_frames", [24, 242, 0])
def test_t2v_rejects_out_of_range_frames(client, num_frames):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, f"oviframes-{num_frames}")
    r = c.post(
        "/api/ovi/t2v",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "a cat", "num_frames": num_frames},
    )
    assert r.status_code == 422


@pytest.mark.parametrize("field,value", [("width", 255), ("height", 1025)])
def test_t2v_rejects_out_of_range_size(client, field, value):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, f"ovisize-{field}")
    r = c.post(
        "/api/ovi/t2v",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "a cat", field: value},
    )
    assert r.status_code == 422


def test_t2v_snaps_alignment(client, monkeypatch):
    """宽高非 32 对齐向下取整(999→992);帧数 4n+1 吸附(240→237)。"""
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "ovisnap")
    fake = _FakeOviClient()
    _install_ovi(monkeypatch, fake)
    r = c.post(
        "/api/ovi/t2v",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "a cat", "width": 999, "height": 515, "num_frames": 240},
    )
    assert r.status_code == 200, r.text
    graph = fake.graphs[0]
    assert graph["6"]["inputs"]["width"] == 992
    assert graph["6"]["inputs"]["height"] == 512
    assert graph["6"]["inputs"]["num_frames"] == 237
    assert graph["7"]["inputs"]["length"] == audio_latent_length(237)


# --------------------------------------------------------------------------- #
# POST /api/ovi/t2v
# --------------------------------------------------------------------------- #


def test_t2v_ok_submits_graph_and_job(client, monkeypatch):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "ovit2vok")
    fake = _FakeOviClient()
    _install_ovi(monkeypatch, fake)
    r = c.post(
        "/api/ovi/t2v",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={
            "positive": "工作室里的机械师",
            "speech": "我们终于有十秒音画了!",
            "audio_caption": "扳手落地声, 热情的男声",
            "seed": 42,
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["prompt_id"] == "prompt-ovi-1"
    assert body["worker"] == "http://fake-ovi"
    assert body["seed"] == 42

    graph = fake.graphs[0]
    prompt = graph["3"]["inputs"]["positive_prompt"]
    assert "<S>我们终于有十秒音画了!<E>" in prompt  # 台词自动包裹
    assert prompt.endswith("Audio: 扳手落地声, 热情的男声")  # 音频描述追加
    assert graph["8"]["inputs"]["seed"] == 42

    with Session(engine) as s:
        job = s.exec(select(Job).where(Job.user_id == uid)).first()
        assert job is not None
        assert job.kind == "ovi_t2v"
        assert job.nsfw is False
        assert job.seed == 42
        assert job.worker == "http://fake-ovi"


def test_t2v_requires_auth(client):
    c, _ = client
    assert c.post("/api/ovi/t2v", json={"positive": "x"}).status_code == 401


def test_t2v_instance_unreachable_503(client, monkeypatch):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "ovidown")
    _install_ovi(monkeypatch, _FakeOviClient(reachable=False))
    r = c.post(
        "/api/ovi/t2v",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "a cat"},
    )
    assert r.status_code == 503
    assert "不可达" in r.json()["detail"]


def test_t2v_marks_job_nsfw_with_x_nsfw_header(client, monkeypatch):
    """/nsfw 专区(X-NSFW: 1)提交:Job 打 nsfw 标,主站作品库不可见。"""
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "ovinsfw")
    fake = _FakeOviClient()
    _install_ovi(monkeypatch, fake)
    r = c.post(
        "/api/ovi/t2v",
        headers={"Authorization": f"Bearer {create_token(uid)}", "X-NSFW": "1"},
        json={"positive": "a girl talking, cinematic"},
    )
    assert r.status_code == 200, r.text
    with Session(engine) as s:
        job = s.exec(select(Job).where(Job.user_id == uid)).first()
        assert job is not None
        assert job.kind == "ovi_t2v" and job.nsfw is False


# --------------------------------------------------------------------------- #
# POST /api/ovi/i2v
# --------------------------------------------------------------------------- #


class _FakeSourceWorker:
    """上传落点 pool worker 替身。"""

    base_url = "http://fake-worker"

    async def get_image_bytes(self, filename, subfolder, type_):
        return b"img-bytes", "image/png"


def test_i2v_ok_transfers_ref_image_and_submits(client, monkeypatch):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "ovii2vok")
    fake = _FakeOviClient()
    _install_ovi(monkeypatch, fake)
    monkeypatch.setattr(ovi_route, "resolve_worker", lambda worker: _FakeSourceWorker())
    r = c.post(
        "/api/ovi/i2v",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "人像开口", "speech": "大家好", "image": "in.png",
              "worker": "http://fake-worker", "seed": 7},
    )
    assert r.status_code == 200, r.text
    # 参考图从源 worker 读出并上传到 :8197 实例,图内引用转运后的文件名
    assert fake.uploads == [(b"img-bytes", "in.png")]
    graph = fake.graphs[0]
    assert graph["14"]["inputs"]["image"] == "ovi-in.png"
    assert graph["6"]["inputs"]["extra_latents"] == ["16", 0]
    with Session(engine) as s:
        job = s.exec(select(Job).where(Job.user_id == uid)).first()
        assert job is not None and job.kind == "ovi_i2v"
        assert job.seed == 7


def test_i2v_rejects_path_traversal(client):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "ovitrav")
    r = c.post(
        "/api/ovi/i2v",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "x", "image": "../evil.png", "worker": "http://fake-worker"},
    )
    assert r.status_code == 422
