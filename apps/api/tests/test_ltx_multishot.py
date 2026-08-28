"""LTX-2.5 Multishot —— builder 结构与路由行为测试。

覆盖:
  · prompt 组装:shots → 单 prompt 分镜文本(镜头号+时长标注+global_style 首行)
  · builder 结构:官方模板同构(加载器/两阶段采样/音画链/输出)、半分辨一阶段、
    8n+1 帧网格、多镜 prompt 注入点、audio 开关(挂轨与否,采样链不变)
  · 校验:镜头数 2-4 / 总时长 ≤20s / 单镜 1-10s / 分辨率 32 倍数 / 帧网格
  · 路由:401 未认证;422 各类非法;503 worker 缺模型/缺节点;200 提交 + Job 建档
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

import app.routes.ltx as ltx_route
from app.capabilities import required_nodes
from app.db import get_session
from app.main import app
from app.models import Job, Tenant, User
from app.security import create_token, hash_password
from app.workflows.ltx_multishot import (
    DEFAULT_LTX25_AUDIO_VAE,
    DEFAULT_LTX25_GEMMA,
    DEFAULT_LTX25_NEGATIVE,
    DEFAULT_LTX25_UNET,
    DEFAULT_LTX25_UPSCALER,
    DEFAULT_LTX25_VIDEO_VAE,
    LtxMultishotParams,
    LtxShot,
    build_ltx_multishot_graph,
    compose_multishot_prompt,
    total_frames,
    validate_multishot,
)

_SHOTS_2 = (LtxShot(prompt="wide shot, a girl in red coat enters a snowy station", seconds=5),
            LtxShot(prompt="close-up, the same girl in red coat checks her ticket", seconds=4))


# --------------------------------------------------------------------------- #
# prompt 组装与帧网格
# --------------------------------------------------------------------------- #


def test_compose_prompt_shot_numbering_and_seconds():
    text = compose_multishot_prompt(_SHOTS_2)
    lines = text.split("\n")
    assert lines[0].startswith("Shot 1 (5 seconds): ")
    assert lines[1].startswith("Shot 2 (4 seconds): ")
    assert "snowy station" in lines[0]
    assert "same girl in red coat" in lines[1]


def test_compose_prompt_global_style_first_line():
    text = compose_multishot_prompt(_SHOTS_2, " cinematic, consistent warm lighting ")
    lines = text.split("\n")
    assert lines[0] == "cinematic, consistent warm lighting"
    assert len(lines) == 3


def test_total_frames_grid():
    # (5+4)s × 24fps + 1 = 217 = 8×27+1 ✅
    assert total_frames(_SHOTS_2, 24) == 217
    # fps=25 时 9s → 225 ≠ 8n → 非法
    with pytest.raises(ValueError, match="8n\\+1"):
        total_frames(_SHOTS_2, 25)


# --------------------------------------------------------------------------- #
# builder 结构
# --------------------------------------------------------------------------- #


def _params(**kw) -> LtxMultishotParams:
    base = dict(shots=_SHOTS_2, global_style="cinematic", seed=42)
    base.update(kw)
    return LtxMultishotParams(**base)


def test_graph_loaders_and_multishot_prompt_injection():
    g = build_ltx_multishot_graph(_params())
    assert g["1"]["class_type"] == "UNETLoader"
    assert g["1"]["inputs"]["unet_name"] == DEFAULT_LTX25_UNET
    assert "nvfp4" in g["1"]["inputs"]["unet_name"]
    assert g["2"]["class_type"] == "CLIPLoader"
    assert g["2"]["inputs"]["clip_name"] == DEFAULT_LTX25_GEMMA
    assert g["2"]["inputs"]["type"] == "ltxv"
    assert g["3"]["inputs"]["vae_name"] == DEFAULT_LTX25_VIDEO_VAE
    assert g["4"]["inputs"]["vae_name"] == DEFAULT_LTX25_AUDIO_VAE
    assert g["5"]["inputs"]["model_name"] == DEFAULT_LTX25_UPSCALER
    # 多镜 prompt 注入正向编码器
    text = g["6"]["inputs"]["text"]
    assert "Shot 1 (5 seconds):" in text and "Shot 2 (4 seconds):" in text
    assert text.startswith("cinematic")
    assert g["6"]["inputs"]["clip"] == ["2", 0]
    assert g["7"]["inputs"]["text"] == DEFAULT_LTX25_NEGATIVE


def test_graph_half_resolution_stage1_and_frame_count():
    g = build_ltx_multishot_graph(_params(width=1280, height=720, fps=24))
    latent = g["9"]["inputs"]
    # 一阶段半分辨(官方 DFR:结构 640×360 → latent 2× → 1280×720)
    assert (latent["width"], latent["height"]) == (640, 360)
    assert latent["length"] == 217
    assert g["10"]["inputs"]["frames_number"] == 217
    assert g["10"]["inputs"]["frame_rate"] == 24.0


def test_graph_two_stage_sampling_chain():
    g = build_ltx_multishot_graph(_params())
    # 一阶段:空 latent 合流 → SamplerCustomAdvanced(8 步 sigma 串)
    assert g["15"]["inputs"]["sigmas"].startswith("1.0, 0.99375")
    assert len(g["15"]["inputs"]["sigmas"].split(",")) == 9
    assert g["16"]["inputs"]["latent_image"] == ["11", 0]
    assert g["16"]["inputs"]["sigmas"] == ["15", 0]
    # latent 2× 上采样:视频路经 LTXVLatentUpsampler,音频路直通
    assert g["18"]["class_type"] == "LTXVLatentUpsampler"
    assert g["18"]["inputs"]["samples"] == ["17", 0]
    assert g["18"]["inputs"]["upscale_model"] == ["5", 0]
    assert g["19"]["inputs"]["audio_latent"] == ["17", 1]
    # 二阶段:0.85 起点 3 步,新噪声 seed+1,CFG=1(distilled)
    assert g["23"]["inputs"]["sigmas"].startswith("0.85")
    assert g["24"]["inputs"]["latent_image"] == ["19", 0]
    assert g["21"]["inputs"]["noise_seed"] == 43
    assert g["12"]["inputs"]["video_cfg"] == 1.0
    assert g["20"]["inputs"]["audio_cfg"] == 1.0


def test_graph_audio_on_full_chain():
    g = build_ltx_multishot_graph(_params(audio=True))
    assert g["27"]["class_type"] == "LTXVAudioVAEDecode"
    assert g["27"]["inputs"]["samples"] == ["25", 1]  # slot1=audio_latent
    assert g["28"]["class_type"] == "CreateVideo"
    assert g["28"]["inputs"]["audio"] == ["27", 0]
    assert g["28"]["inputs"]["images"] == ["26", 0]
    assert g["29"]["class_type"] == "SaveVideo"
    assert g["29"]["inputs"]["video"] == ["28", 0]


def test_graph_audio_off_skips_track_but_keeps_sampling_chain():
    g = build_ltx_multishot_graph(_params(audio=False))
    # 音画联合 transformer:音频 latent 仍参与采样(空音频)
    assert "LTXVEmptyLatentAudio" in {n["class_type"] for n in g.values()}
    assert g["11"]["inputs"]["audio_latent"] == ["10", 0]
    # 仅不解码/不挂轨
    assert "LTXVAudioVAEDecode" not in {n["class_type"] for n in g.values()}
    assert "audio" not in g["28"]["inputs"]


# --------------------------------------------------------------------------- #
# builder 校验
# --------------------------------------------------------------------------- #


def test_validate_shot_count_window():
    with pytest.raises(ValueError, match="镜头数"):
        validate_multishot(LtxMultishotParams(shots=(LtxShot(prompt="only one"),)))
    with pytest.raises(ValueError, match="镜头数"):
        validate_multishot(
            LtxMultishotParams(shots=tuple(LtxShot(prompt=f"s{i}") for i in range(5)))
        )


def test_validate_total_seconds_cap():
    with pytest.raises(ValueError, match="超上限"):
        validate_multishot(
            LtxMultishotParams(shots=tuple(LtxShot(prompt=f"s{i}", seconds=6) for i in range(4)))
        )


def test_validate_resolution_multiple_of_16():
    with pytest.raises(ValueError, match="16 倍数"):
        validate_multishot(LtxMultishotParams(shots=_SHOTS_2, width=1000))


def test_validate_empty_shot_prompt():
    with pytest.raises(ValueError, match="prompt 为空"):
        validate_multishot(
            LtxMultishotParams(shots=(LtxShot(prompt="ok"), LtxShot(prompt="   ")))
        )


# --------------------------------------------------------------------------- #
# 路由测试 fixtures / fakes
# --------------------------------------------------------------------------- #


def _seed_user(session: Session, email: str) -> str:
    tenant = Tenant(name=email)
    session.add(tenant)
    session.commit()
    session.refresh(tenant)
    user = User(email=email, hashed_password=hash_password("password1"), tenant_id=tenant.id)
    session.add(user)
    session.commit()
    session.refresh(user)
    return user.id


@pytest.fixture
def engine():
    eng = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
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
    """最小化 ComfyUIClient 替身:model/node_names 返回固定集合,queue_prompt 记录图。"""

    def __init__(self, models: set[str] | None = None, nodes: set[str] | None = None) -> None:
        self.base_url = "http://fake-ltx25"
        self._models = set(models or set())
        self._nodes = set(nodes or set())
        self.graphs: list[dict] = []

    async def model_names(self) -> set[str]:
        return set(self._models)

    async def node_names(self) -> set[str]:
        return set(self._nodes)

    async def queue_prompt(self, graph: dict, client_id: str) -> str:
        self.graphs.append(graph)
        return "prompt-ltx25-1"


def _ltx25_models() -> set[str]:
    return {
        DEFAULT_LTX25_UNET,
        DEFAULT_LTX25_GEMMA,
        DEFAULT_LTX25_VIDEO_VAE,
        DEFAULT_LTX25_AUDIO_VAE,
        DEFAULT_LTX25_UPSCALER,
    }


def _payload(**kw) -> dict:
    body = {
        "shots": [
            {"prompt": "wide shot, a girl in red coat enters a snowy station", "seconds": 5},
            {"prompt": "close-up, the same girl in red coat checks her ticket", "seconds": 4},
            {"prompt": "medium shot, the same girl boards the train, steam on platform", "seconds": 3},
        ],
        "global_style": "cinematic, consistent warm lighting, same character throughout",
        "seed": 42,
    }
    body.update(kw)
    return body


# --------------------------------------------------------------------------- #
# 路由:认证与 422
# --------------------------------------------------------------------------- #


def test_multishot_requires_auth(client):
    c, _ = client
    assert c.post("/api/ltx/multishot", json=_payload()).status_code == 401


def test_multishot_rejects_single_shot(client):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "ltxms1shot")
    r = c.post(
        "/api/ltx/multishot",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json=_payload(shots=[{"prompt": "solo", "seconds": 4}]),
    )
    assert r.status_code == 422


def test_multishot_rejects_five_shots(client):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "ltxms5shot")
    r = c.post(
        "/api/ltx/multishot",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json=_payload(shots=[{"prompt": f"s{i}", "seconds": 2} for i in range(5)]),
    )
    assert r.status_code == 422


def test_multishot_rejects_bad_frame_grid(client):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "ltxmsgrid")
    r = c.post(
        "/api/ltx/multishot",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json=_payload(fps=25),  # 12s × 25 = 300 ≠ 8n
    )
    assert r.status_code == 422


def test_multishot_rejects_odd_resolution(client):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "ltxmsres")
    r = c.post(
        "/api/ltx/multishot",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json=_payload(width=1000),
    )
    assert r.status_code == 422


# --------------------------------------------------------------------------- #
# 路由:worker 校验与提交
# --------------------------------------------------------------------------- #


def test_multishot_worker_missing_models_503(client, monkeypatch):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "ltxmsnomodel")
    fake = _FakeClient(models={DEFAULT_LTX25_UNET}, nodes=required_nodes("ltx_multishot"))
    monkeypatch.setattr(ltx_route, "resolve_worker", lambda worker: fake)
    r = c.post(
        "/api/ltx/multishot",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json=_payload(),
    )
    assert r.status_code == 503
    assert "缺少 LTX-2.5 模型" in r.json()["detail"]


def test_multishot_worker_missing_nodes_503(client, monkeypatch):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "ltxmsnonode")
    fake = _FakeClient(models=_ltx25_models(), nodes={"UNETLoader"})
    monkeypatch.setattr(ltx_route, "resolve_worker", lambda worker: fake)
    r = c.post(
        "/api/ltx/multishot",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json=_payload(),
    )
    assert r.status_code == 503
    assert "缺少 LTX-2.5 节点" in r.json()["detail"]


def test_multishot_submit_ok(client, monkeypatch):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "ltxmsok")
    fake = _FakeClient(models=_ltx25_models(), nodes=required_nodes("ltx_multishot"))
    seen_workers: list[str] = []

    def _resolve(worker: str):
        seen_workers.append(worker)
        return fake

    monkeypatch.setattr(ltx_route, "resolve_worker", _resolve)
    monkeypatch.setattr(ltx_route, "spawn_tracker", lambda client, prompt_id: None)
    r = c.post(
        "/api/ltx/multishot",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json=_payload(),
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["prompt_id"] == "prompt-ltx25-1"
    assert body["shots"] == 3
    assert body["seconds"] == 12
    assert body["audio"] is True
    assert body["seed"] == 42
    # 默认 worker 走 settings.ltx25_worker
    assert seen_workers and seen_workers[0].endswith(":8188")
    # 提交图:多镜 prompt 注入 + 两阶段链
    assert len(fake.graphs) == 1
    g = fake.graphs[0]
    text = g["6"]["inputs"]["text"]
    assert "Shot 1 (5 seconds):" in text
    assert "Shot 3 (3 seconds):" in text
    assert text.startswith("cinematic, consistent warm lighting")
    assert g["9"]["inputs"]["length"] == 12 * 24 + 1
    # Job 建档
    with Session(engine) as s:
        job = s.exec(select(Job).where(Job.prompt_id == "prompt-ltx25-1")).one()
    assert job.kind == "ltx_multishot"
    assert job.nsfw is False
    assert job.status == "queued"
    assert "Shot 1" in job.prompt


def test_multishot_audio_off_request_and_graph(client, monkeypatch):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "ltxmsmute")
    fake = _FakeClient(models=_ltx25_models(), nodes=required_nodes("ltx_multishot"))
    monkeypatch.setattr(ltx_route, "resolve_worker", lambda worker: fake)
    monkeypatch.setattr(ltx_route, "spawn_tracker", lambda client, prompt_id: None)
    r = c.post(
        "/api/ltx/multishot",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json=_payload(audio=False),
    )
    assert r.status_code == 200, r.text
    assert r.json()["audio"] is False
    g = fake.graphs[0]
    assert "audio" not in g["28"]["inputs"]
    # 音频 VAE 不在必需模型集时仍须具备(audio_vae 节点在图里)——此处 audio=False 仍加载
    # LTXVEmptyLatentAudio(采样链必需),故 audio_vae 模型要求保留
    assert "LTXVEmptyLatentAudio" in {n["class_type"] for n in g.values()}
