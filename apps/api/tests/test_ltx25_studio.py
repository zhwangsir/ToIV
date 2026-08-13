"""LTX-2.5 工作室(文生/图生视频,音画同出)—— 图构建 / 参数校验 / 端点 / 服务单测。

覆盖:
  · T2V 图构建器:节点类型与连线(官方单阶段蒸馏模板 LTX-2.5_T2V_I2V_Single_Stage_Distilled)、
    nvfp4 transformer + gemma4 with-proj 文本编码器(ckpt_name 从 checkpoints 软链抽
    embeddings_connector 键)、双 VAE 分载、LTXVConditioning 注入 frame_rate、
    AV latent 拼接(EmptyLTXVLatentVideo + LTXVEmptyLatentAudio → LTXVConcatAVLatent)、
    cfg=1 固定 + euler_ancestral + 8 步蒸馏 sigma 原表、LTXVSeparateAVLatent 分离解码、
    VAEDecodeTiled 官方 tiling 参数、CreateVideo 音画同出打包、两次构建互不影响
  · I2V 图构建器:LoadImage → LTXVPreprocess(img_compression=18)
    → LTXVImgToVideoInplace(strength/bypass=False) 首帧引导支路,采样输出链与 t2v 共用
  · 请求校验:帧数 8k+1 网格吸附(120→113)、宽高 32 对齐取整(833→832/545→544)、
    帧数/宽高/帧率/步数/强度越界 422、i2v 参考图路径穿越 422、空提示词 422
  · POST /api/ltx25/t2v:提交落 Job(kind=ltx25_t2v,nsfw=False,worker=实例基址);
    实例不可达 / 缺 LTXAVTextEncoderLoader 节点 / TOIV_LTX25_ENABLED=false → 503;
    未登录 401;X-NSFW 头不打 nsfw 标(SFW 专线,NSFW 视频走 LTX-2.3 10Eros 链路)
  · POST /api/ltx25/i2v:参考图从上传落点 pool worker 转运到 :8198 实例后提交,
    图内引用转运文件名,Job kind=ltx25_i2v;源读取失败 502
  · transfer_ref_image / ensure_ltx25_ready / ensure_ltx25_enabled 服务单测
"""
from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

import app.routes.ltx25_studio as ltx25_route
import app.services.ltx25 as ltx25_service
from app.comfy.client import ComfyUIError
from app.db import get_session
from app.main import app
from app.models import Job, Tenant, User
from app.security import create_token, hash_password
from app.workflows.ltx25_video import (
    DEFAULT_LTX25_AUDIO_VAE,
    DEFAULT_LTX25_TEXT_ENCODER,
    DEFAULT_LTX25_UNET,
    DEFAULT_LTX25_VIDEO_VAE,
    Ltx25I2VParams,
    Ltx25T2VParams,
    build_ltx25_i2v_graph,
    build_ltx25_t2v_graph,
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


class _FakeLtx25Client:
    """:8198 实例替身:object_info/queue_prompt/upload_image 可控,不联网。"""

    def __init__(self, *, reachable: bool = True, has_node: bool = True) -> None:
        self.base_url = "http://fake-ltx25"
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
        return "prompt-ltx25-1"

    async def upload_image(self, content: bytes, filename: str) -> str:
        self.uploads.append((content, filename))
        return f"ltx25-{filename}"


class _FakeSourceWorker:
    """上传落点 pool worker 替身:get_image_bytes 可控。"""

    def __init__(self, content: bytes = b"media-bytes") -> None:
        self.base_url = "http://fake-worker"
        self._content = content

    async def get_image_bytes(self, filename: str, subfolder: str, type_: str) -> tuple[bytes, str]:
        return self._content, "application/octet-stream"


def _install_ltx25(monkeypatch, fake: _FakeLtx25Client) -> None:
    monkeypatch.setattr(ltx25_service, "get_ltx25_client", lambda: fake)
    monkeypatch.setattr(ltx25_service, "spawn_tracker", lambda client, prompt_id: None)
    monkeypatch.setattr(ltx25_route, "resolve_worker", lambda worker: _FakeSourceWorker())


# --------------------------------------------------------------------------- #
# T2V 图构建器
# --------------------------------------------------------------------------- #


def test_t2v_builder_structure_and_critical_inputs():
    """节点类型/连线照搬官方单阶段蒸馏模板;关键输入(模型文件/cfg/采样器/tiling)锁定。"""
    g = build_ltx25_t2v_graph(Ltx25T2VParams(positive="海边日落", seed=42))

    # 模型加载:nvfp4 蒸馏 transformer + gemma4 with-proj 文本编码器 + 双 VAE
    assert g["1"]["class_type"] == "UNETLoader"
    assert g["1"]["inputs"]["unet_name"] == DEFAULT_LTX25_UNET
    assert g["1"]["inputs"]["weight_dtype"] == "default"
    te = g["2"]
    assert te["class_type"] == "LTXAVTextEncoderLoader"
    assert te["inputs"]["text_encoder"] == DEFAULT_LTX25_TEXT_ENCODER
    # ckpt_name 指向 transformer(checkpoints 类目软链),抽 embeddings_connector 键
    assert te["inputs"]["ckpt_name"] == DEFAULT_LTX25_UNET
    assert g["3"]["class_type"] == "VAELoader"
    assert g["3"]["inputs"]["vae_name"] == DEFAULT_LTX25_VIDEO_VAE
    assert g["4"]["class_type"] == "VAELoader"
    assert g["4"]["inputs"]["vae_name"] == DEFAULT_LTX25_AUDIO_VAE

    # 文本编码 + LTXV 条件化(frame_rate 注入)
    assert g["7"]["class_type"] == "CLIPTextEncode"
    assert g["7"]["inputs"]["text"] == "海边日落"
    assert g["7"]["inputs"]["clip"] == ["2", 0]
    assert g["8"]["inputs"]["clip"] == ["2", 0]
    cond = g["9"]
    assert cond["class_type"] == "LTXVConditioning"
    assert cond["inputs"]["positive"] == ["7", 0]
    assert cond["inputs"]["negative"] == ["8", 0]
    assert cond["inputs"]["frame_rate"] == 24.0

    # 空视频/音频 latent → AV 拼接(音画同构采样)
    assert g["10"]["class_type"] == "EmptyLTXVLatentVideo"
    assert g["10"]["inputs"]["length"] == 121
    assert g["10"]["inputs"]["batch_size"] == 1
    audio = g["11"]
    assert audio["class_type"] == "LTXVEmptyLatentAudio"
    assert audio["inputs"]["frames_number"] == 121
    assert audio["inputs"]["frame_rate"] == 24.0
    assert audio["inputs"]["audio_vae"] == ["4", 0]
    concat = g["12"]
    assert concat["class_type"] == "LTXVConcatAVLatent"
    assert concat["inputs"]["video_latent"] == ["10", 0]  # t2v 直用空 latent
    assert concat["inputs"]["audio_latent"] == ["11", 0]

    # 蒸馏采样:cfg=1 固定 + euler_ancestral + 官方 8 步 sigma 原表
    assert g["13"]["class_type"] == "RandomNoise"
    assert g["13"]["inputs"]["noise_seed"] == 42
    assert g["14"]["class_type"] == "KSamplerSelect"
    assert g["14"]["inputs"]["sampler_name"] == "euler_ancestral"
    sigmas = g["15"]["inputs"]["sigmas"].split(", ")
    assert sigmas == ["1", "0.99375", "0.9875", "0.98125", "0.975",
                      "0.909375", "0.725", "0.421875", "0"]
    guider = g["16"]
    assert guider["class_type"] == "CFGGuider"
    assert guider["inputs"]["cfg"] == 1.0
    assert guider["inputs"]["model"] == ["1", 0]
    assert guider["inputs"]["positive"] == ["9", 0]
    assert guider["inputs"]["negative"] == ["9", 1]
    sampler = g["17"]
    assert sampler["class_type"] == "SamplerCustomAdvanced"
    assert sampler["inputs"]["noise"] == ["13", 0]
    assert sampler["inputs"]["guider"] == ["16", 0]
    assert sampler["inputs"]["sampler"] == ["14", 0]
    assert sampler["inputs"]["sigmas"] == ["15", 0]
    assert sampler["inputs"]["latent_image"] == ["12", 0]

    # 分离解码 + 音画同出打包
    assert g["18"]["class_type"] == "LTXVSeparateAVLatent"
    assert g["18"]["inputs"]["av_latent"] == ["17", 0]
    dec = g["19"]
    assert dec["class_type"] == "VAEDecodeTiled"
    assert dec["inputs"]["samples"] == ["18", 0]
    assert dec["inputs"]["vae"] == ["3", 0]
    assert (dec["inputs"]["tile_size"], dec["inputs"]["overlap"]) == (512, 64)
    assert (dec["inputs"]["temporal_size"], dec["inputs"]["temporal_overlap"]) == (64, 8)
    adec = g["20"]
    assert adec["class_type"] == "LTXVAudioVAEDecode"
    assert adec["inputs"]["samples"] == ["18", 1]
    assert adec["inputs"]["audio_vae"] == ["4", 0]
    video = g["21"]
    assert video["class_type"] == "CreateVideo"
    assert video["inputs"]["images"] == ["19", 0]
    assert video["inputs"]["audio"] == ["20", 0]
    assert video["inputs"]["fps"] == 24.0
    assert g["22"]["class_type"] == "SaveVideo"
    assert g["22"]["inputs"]["video"] == ["21", 0]
    assert g["22"]["inputs"]["filename_prefix"] == "ToIV_ltx25_vid"

    # t2v 无 i2v 首帧支路节点
    for nid in ("5", "6", "30"):
        assert nid not in g


def test_t2v_builder_injects_params():
    """自定义提示词/尺寸/帧数/帧率/步数/种子全部进图对应节点。"""
    g = build_ltx25_t2v_graph(Ltx25T2VParams(
        positive="机器人跳舞", negative="模糊", width=1280, height=704,
        length=201, fps=30, steps=4, seed=7,
    ))
    assert g["7"]["inputs"]["text"] == "机器人跳舞"
    assert g["8"]["inputs"]["text"] == "模糊"
    assert g["10"]["inputs"]["width"] == 1280
    assert g["10"]["inputs"]["height"] == 704
    assert g["10"]["inputs"]["length"] == 201
    assert g["9"]["inputs"]["frame_rate"] == 30.0
    assert g["11"]["inputs"]["frames_number"] == 201
    assert g["11"]["inputs"]["frame_rate"] == 30.0
    assert g["13"]["inputs"]["noise_seed"] == 7
    # steps=4 → sigma 重采样为 5 点,首 1 尾 0 且单调递减
    pts = [float(x) for x in g["15"]["inputs"]["sigmas"].split(", ")]
    assert len(pts) == 5
    assert pts[0] == 1.0 and pts[-1] == 0.0
    assert all(a >= b for a, b in zip(pts, pts[1:]))
    assert g["21"]["inputs"]["fps"] == 30.0


def test_t2v_two_builds_independent():
    g1 = build_ltx25_t2v_graph(Ltx25T2VParams(positive="first", seed=1))
    g2 = build_ltx25_t2v_graph(Ltx25T2VParams(positive="second", seed=2))
    assert g1["7"]["inputs"]["text"] == "first"
    assert g2["7"]["inputs"]["text"] == "second"
    assert g1["13"]["inputs"]["noise_seed"] == 1
    assert g2["13"]["inputs"]["noise_seed"] == 2


def test_t2v_default_seed_random():
    p1 = Ltx25T2VParams(positive="x")
    p2 = Ltx25T2VParams(positive="x")
    assert p1.seed >= 0 and p2.seed >= 0  # 随机种子(极低概率相等,不断言不等)


# --------------------------------------------------------------------------- #
# I2V 图构建器
# --------------------------------------------------------------------------- #


def test_i2v_builder_adds_first_frame_branch():
    """i2v 在 t2v 共用段上增加首帧引导支路,采样 latent 改接 LTXVImgToVideoInplace。"""
    g = build_ltx25_i2v_graph(Ltx25I2VParams(
        positive="女孩转身", image="ref.png", strength=0.85, seed=42,
    ))
    assert g["5"]["class_type"] == "LoadImage"
    assert g["5"]["inputs"]["image"] == "ref.png"
    pre = g["6"]
    assert pre["class_type"] == "LTXVPreprocess"
    assert pre["inputs"]["image"] == ["5", 0]
    assert pre["inputs"]["img_compression"] == 18  # 官方模板值
    i2v = g["30"]
    assert i2v["class_type"] == "LTXVImgToVideoInplace"
    assert i2v["inputs"]["vae"] == ["3", 0]
    assert i2v["inputs"]["image"] == ["6", 0]
    assert i2v["inputs"]["latent"] == ["10", 0]
    assert i2v["inputs"]["strength"] == 0.85
    assert i2v["inputs"]["bypass"] is False
    # AV 拼接的视频 latent 改接首帧引导输出
    assert g["12"]["inputs"]["video_latent"] == ["30", 0]
    # 采样/解码/输出链与 t2v 一致
    assert g["16"]["inputs"]["cfg"] == 1.0
    assert g["22"]["class_type"] == "SaveVideo"


def test_i2v_default_strength_070():
    g = build_ltx25_i2v_graph(Ltx25I2VParams(positive="x", image="a.png", seed=1))
    assert g["30"]["inputs"]["strength"] == 0.7


# --------------------------------------------------------------------------- #
# 请求校验(422 / 对齐取整)
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize("length", [8, 602, 0])
def test_t2v_rejects_out_of_range_length(client, length):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, f"l25len-{length}")
    r = c.post(
        "/api/ltx25/t2v",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "a", "length": length},
    )
    assert r.status_code == 422


@pytest.mark.parametrize("field,value", [("width", 255), ("width", 1921), ("height", 1089)])
def test_t2v_rejects_out_of_range_size(client, field, value):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, f"l25size-{field}-{value}")
    r = c.post(
        "/api/ltx25/t2v",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "a", field: value},
    )
    assert r.status_code == 422


@pytest.mark.parametrize("field,value", [("fps", 7), ("fps", 61), ("steps", 0), ("steps", 51)])
def test_t2v_rejects_out_of_range_sampling(client, field, value):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, f"l25smp-{field}-{value}")
    r = c.post(
        "/api/ltx25/t2v",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "a", field: value},
    )
    assert r.status_code == 422


def test_t2v_rejects_empty_positive(client):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "l25empty")
    r = c.post(
        "/api/ltx25/t2v",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": ""},
    )
    assert r.status_code == 422


def test_i2v_rejects_path_traversal(client):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "l25trav")
    r = c.post(
        "/api/ltx25/i2v",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "a", "image": "../evil.png", "worker": "http://fake-worker"},
    )
    assert r.status_code == 422


def test_i2v_rejects_out_of_range_strength(client):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "l25str")
    r = c.post(
        "/api/ltx25/i2v",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "a", "image": "in.png", "worker": "http://fake-worker",
              "strength": 1.5},
    )
    assert r.status_code == 422


# --------------------------------------------------------------------------- #
# POST /api/ltx25/t2v
# --------------------------------------------------------------------------- #


def test_t2v_ok_submits_and_creates_job(client, monkeypatch):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "l25ok")
    fake = _FakeLtx25Client()
    _install_ltx25(monkeypatch, fake)
    r = c.post(
        "/api/ltx25/t2v",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "海上风暴", "negative": "低质量", "seed": 7},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["prompt_id"] == "prompt-ltx25-1"
    assert body["worker"] == "http://fake-ltx25"
    assert body["seed"] == 7

    graph = fake.graphs[0]
    assert graph["7"]["inputs"]["text"] == "海上风暴"
    assert graph["8"]["inputs"]["text"] == "低质量"
    assert graph["13"]["inputs"]["noise_seed"] == 7
    assert graph["12"]["inputs"]["video_latent"] == ["10", 0]  # t2v 无首帧支路

    with Session(engine) as s:
        job = s.exec(select(Job).where(Job.user_id == uid)).first()
        assert job is not None
        assert job.kind == "ltx25_t2v"
        assert job.nsfw is False  # SFW 专线
        assert job.seed == 7
        assert job.worker == "http://fake-ltx25"


def test_t2v_snaps_non_aligned_size_and_length(client, monkeypatch):
    """宽高非 32 对齐向下取整(833→832/545→544),帧数吸附 8k+1 网格(120→113),而非 422。"""
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "l25snap")
    fake = _FakeLtx25Client()
    _install_ltx25(monkeypatch, fake)
    r = c.post(
        "/api/ltx25/t2v",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "a", "width": 833, "height": 545, "length": 120},
    )
    assert r.status_code == 200, r.text
    latent = fake.graphs[0]["10"]["inputs"]
    assert latent["width"] == 832 and latent["height"] == 544
    assert latent["length"] == 113
    assert fake.graphs[0]["11"]["inputs"]["frames_number"] == 113


def test_t2v_instance_unreachable_503(client, monkeypatch):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "l25down")
    _install_ltx25(monkeypatch, _FakeLtx25Client(reachable=False))
    r = c.post(
        "/api/ltx25/t2v",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "a"},
    )
    assert r.status_code == 503
    assert "不可达" in r.json()["detail"]


def test_t2v_missing_ltx25_node_503(client, monkeypatch):
    """实例在线但缺 LTXAVTextEncoderLoader(ComfyUI < 0.32)→ 503 + 原因指明节点。"""
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "l25nonode")
    _install_ltx25(monkeypatch, _FakeLtx25Client(has_node=False))
    r = c.post(
        "/api/ltx25/t2v",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "a"},
    )
    assert r.status_code == 503
    assert "LTXAVTextEncoderLoader" in r.json()["detail"]


def test_t2v_disabled_503(client, monkeypatch):
    """TOIV_LTX25_ENABLED=false → 503 + 已禁用原因,不提交作业。"""
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "l25disabled")
    fake = _FakeLtx25Client()
    _install_ltx25(monkeypatch, fake)
    monkeypatch.setattr(
        ltx25_service, "get_settings", lambda: SimpleNamespace(ltx25_enabled=False)
    )
    r = c.post(
        "/api/ltx25/t2v",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "a"},
    )
    assert r.status_code == 503
    assert "已禁用" in r.json()["detail"]
    assert fake.graphs == []


def test_t2v_requires_auth(client):
    c, _ = client
    r = c.post("/api/ltx25/t2v", json={"positive": "a"})
    assert r.status_code == 401


def test_t2v_x_nsfw_header_does_not_tag_job(client, monkeypatch):
    """LTX-2.5 为 SFW 专线:即使带 X-NSFW 头,Job 也不打 nsfw 标(NSFW 走 2.3 10Eros)。"""
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "l25sfw")
    fake = _FakeLtx25Client()
    _install_ltx25(monkeypatch, fake)
    r = c.post(
        "/api/ltx25/t2v",
        headers={"Authorization": f"Bearer {create_token(uid)}", "X-NSFW": "1"},
        json={"positive": "a girl on the beach"},
    )
    assert r.status_code == 200, r.text
    with Session(engine) as s:
        job = s.exec(select(Job).where(Job.user_id == uid)).first()
        assert job is not None
        assert job.kind == "ltx25_t2v" and job.nsfw is False


# --------------------------------------------------------------------------- #
# POST /api/ltx25/i2v
# --------------------------------------------------------------------------- #


def test_i2v_ok_transfers_ref_and_submits(client, monkeypatch):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "l25i2vok")
    fake = _FakeLtx25Client()
    _install_ltx25(monkeypatch, fake)
    r = c.post(
        "/api/ltx25/i2v",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "角色微笑", "image": "in.png", "worker": "http://fake-worker",
              "strength": 0.9, "seed": 11},
    )
    assert r.status_code == 200, r.text
    assert r.json()["seed"] == 11

    # 参考图从源 worker 转运到 :8198 实例,图内引用转运文件名
    assert fake.uploads == [(b"media-bytes", "in.png")]
    graph = fake.graphs[0]
    assert graph["5"]["inputs"]["image"] == "ltx25-in.png"
    assert graph["30"]["inputs"]["strength"] == 0.9
    assert graph["12"]["inputs"]["video_latent"] == ["30", 0]
    assert graph["13"]["inputs"]["noise_seed"] == 11

    with Session(engine) as s:
        job = s.exec(select(Job).where(Job.user_id == uid)).first()
        assert job is not None
        assert job.kind == "ltx25_i2v"
        assert job.nsfw is False


def test_i2v_source_worker_read_failure_502(client, monkeypatch):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "l25badread")

    class _BrokenSource:
        base_url = "http://fake-worker"

        async def get_image_bytes(self, filename, subfolder, type_):
            raise ComfyUIError("no such file")

    _install_ltx25(monkeypatch, _FakeLtx25Client())
    monkeypatch.setattr(ltx25_route, "resolve_worker", lambda worker: _BrokenSource())
    r = c.post(
        "/api/ltx25/i2v",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "a", "image": "in.png", "worker": "http://fake-worker"},
    )
    assert r.status_code == 502
    assert "读取失败" in r.json()["detail"]


def test_i2v_instance_unreachable_503(client, monkeypatch):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "l25i2vdown")
    _install_ltx25(monkeypatch, _FakeLtx25Client(reachable=False))
    r = c.post(
        "/api/ltx25/i2v",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "a", "image": "in.png", "worker": "http://fake-worker"},
    )
    assert r.status_code == 503
    assert "不可达" in r.json()["detail"]


def test_i2v_requires_auth(client):
    c, _ = client
    r = c.post("/api/ltx25/i2v", json={
        "positive": "a", "image": "in.png", "worker": "http://fake-worker",
    })
    assert r.status_code == 401


# --------------------------------------------------------------------------- #
# 服务单测:transfer_ref_image / ensure_ltx25_ready / ensure_ltx25_enabled
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_transfer_ref_image_ok():
    fake = _FakeLtx25Client()
    source = _FakeSourceWorker(content=b"png-bytes")
    name = await ltx25_service.transfer_ref_image(fake, source, "ref.png")
    assert name == "ltx25-ref.png"
    assert fake.uploads == [(b"png-bytes", "ref.png")]


@pytest.mark.asyncio
async def test_transfer_ref_image_read_failure_502():
    from fastapi import HTTPException

    class _BrokenSource:
        base_url = "http://fake-worker"

        async def get_image_bytes(self, filename, subfolder, type_):
            raise ComfyUIError("gone")

    with pytest.raises(HTTPException) as exc:
        await ltx25_service.transfer_ref_image(_FakeLtx25Client(), _BrokenSource(), "r.png")
    assert exc.value.status_code == 502
    assert "读取失败" in exc.value.detail


@pytest.mark.asyncio
async def test_transfer_ref_image_upload_failure_502():
    from fastapi import HTTPException

    class _BrokenUpload(_FakeLtx25Client):
        async def upload_image(self, content, filename):
            raise ComfyUIError("disk full")

    with pytest.raises(HTTPException) as exc:
        await ltx25_service.transfer_ref_image(_BrokenUpload(), _FakeSourceWorker(), "r.png")
    assert exc.value.status_code == 502
    assert "上传到 LTX-2.5 实例失败" in exc.value.detail


@pytest.mark.asyncio
async def test_ensure_ltx25_ready_ok():
    await ltx25_service.ensure_ltx25_ready(_FakeLtx25Client())  # 不抛异常即就绪


@pytest.mark.asyncio
async def test_ensure_ltx25_ready_unreachable_503():
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as exc:
        await ltx25_service.ensure_ltx25_ready(_FakeLtx25Client(reachable=False))
    assert exc.value.status_code == 503
    assert "不可达" in exc.value.detail


@pytest.mark.asyncio
async def test_ensure_ltx25_ready_missing_node_503():
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as exc:
        await ltx25_service.ensure_ltx25_ready(_FakeLtx25Client(has_node=False))
    assert exc.value.status_code == 503
    assert "LTXAVTextEncoderLoader" in exc.value.detail


@pytest.mark.asyncio
async def test_ensure_ltx25_enabled_disabled_503(monkeypatch):
    from fastapi import HTTPException

    monkeypatch.setattr(
        ltx25_service, "get_settings", lambda: SimpleNamespace(ltx25_enabled=False)
    )
    with pytest.raises(HTTPException) as exc:
        ltx25_service.ensure_ltx25_enabled()
    assert exc.value.status_code == 503
    assert "已禁用" in exc.value.detail
