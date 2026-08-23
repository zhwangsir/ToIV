"""Qwen-Image-Edit-2509 语义编辑链路测试。

覆盖:
  · 图构造:核心节点类型/接线、相机角度指令拼接、多角度 LoRA 挂载条件、
    fast(8 步 cfg 1.0)与标准档(20 步 cfg 2.5)参数、未知角度抛错
  · 端点:未认证 401 / 非法相机角度 422 / 源图读取失败 502 / 转存失败 502 /
    成功路径(Job kind=qwen_edit,图随 prompt 提交到专用实例)
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

import app.routes.generate as generate_route
from app.comfy.client import ComfyUIError
from app.db import get_session
from app.main import app
from app.models import Job, Tenant, User
from app.security import create_token, hash_password
from app.workflows.qwen_edit import (
    CAMERA_LORA,
    CAMERA_PRESETS,
    LIGHTNING_LORA,
    QWEN_EDIT_CLIP,
    QWEN_EDIT_UNET,
    QWEN_EDIT_VAE,
    QwenEditError,
    QwenEditParams,
    build_qwen_edit_graph,
)


def _classes(g: dict) -> set[str]:
    return {n["class_type"] for n in g.values()}


# --------------------------------------------------------------------------- #
# 图构造
# --------------------------------------------------------------------------- #


def test_graph_has_core_nodes():
    g = build_qwen_edit_graph(QwenEditParams(image="a.png", positive="把衣服换成红色"))
    assert {
        "UNETLoader", "CLIPLoader", "VAELoader", "LoadImage", "VAEEncode",
        "TextEncodeQwenImageEdit", "KSampler", "VAEDecode", "SaveImage",
    } <= _classes(g)


def test_loaders_use_qwen_edit_weights():
    g = build_qwen_edit_graph(QwenEditParams(image="a.png", positive="x"))
    assert g["1"]["inputs"]["unet_name"] == QWEN_EDIT_UNET
    assert g["3"]["inputs"]["clip_name"] == QWEN_EDIT_CLIP
    assert g["3"]["inputs"]["type"] == "qwen_image"
    assert g["9"]["inputs"]["vae_name"] == QWEN_EDIT_VAE


def test_wiring_positive_encode_takes_vae_and_image():
    """正向 TextEncodeQwenImageEdit 接 vae+image;负向同节点不接 image。"""
    g = build_qwen_edit_graph(QwenEditParams(image="a.png", positive="x"))
    pos = g["4"]["inputs"]
    assert pos["vae"] == ["9", 0]
    assert pos["image"] == ["7", 0]
    neg = g["5"]["inputs"]
    assert "image" not in neg and "vae" not in neg
    # 源图 → VAEEncode → KSampler.latent_image
    assert g["10"]["inputs"]["pixels"] == ["7", 0]
    assert g["8"]["inputs"]["latent_image"] == ["10", 0]


def test_fast_mode_params_and_lightning_lora_always_mounted():
    g = build_qwen_edit_graph(QwenEditParams(image="a.png", positive="x", fast=True))
    assert g["8"]["inputs"]["steps"] == 8
    assert g["8"]["inputs"]["cfg"] == 1.0
    assert g["8"]["inputs"]["sampler_name"] == "euler"
    assert g["8"]["inputs"]["scheduler"] == "simple"
    loras = [n["inputs"]["lora_name"] for n in g.values() if n["class_type"] == "LoraLoader"]
    assert loras == [LIGHTNING_LORA]  # 未选角度:仅加速 LoRA


def test_standard_mode_params():
    g = build_qwen_edit_graph(QwenEditParams(image="a.png", positive="x", fast=False))
    assert g["8"]["inputs"]["steps"] == 20
    assert g["8"]["inputs"]["cfg"] == 2.5


def test_camera_appends_instruction_and_mounts_camera_lora():
    g = build_qwen_edit_graph(
        QwenEditParams(image="a.png", positive="保持主体不变", camera="rotate_left")
    )
    # 中文运镜指令拼进正向 prompt
    assert CAMERA_PRESETS["rotate_left"] in g["4"]["inputs"]["prompt"]
    assert "保持主体不变" in g["4"]["inputs"]["prompt"]
    # 相机 LoRA 与加速 LoRA 串联(相机在前)
    loras = [n["inputs"]["lora_name"] for n in g.values() if n["class_type"] == "LoraLoader"]
    assert loras == [CAMERA_LORA, LIGHTNING_LORA]


def test_unknown_camera_raises():
    with pytest.raises(QwenEditError):
        build_qwen_edit_graph(QwenEditParams(image="a.png", positive="x", camera="bogus"))


def test_camera_presets_cover_author_readme():
    for key in (
        "forward", "left", "right", "up", "down",
        "rotate_left", "rotate_right", "top_down", "wide", "closeup",
    ):
        assert key in CAMERA_PRESETS


# --------------------------------------------------------------------------- #
# 端点
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
def client():
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    SQLModel.metadata.create_all(engine)

    def override() -> Session:
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override
    yield TestClient(app), engine
    app.dependency_overrides.clear()


class _FakeSourceClient:
    """源图所在 worker 替身:返回固定字节。"""

    base_url = "http://fake-worker"

    async def get_image_bytes(self, filename: str, subfolder: str, type_: str):
        return b"\x89PNG-fake", "image/png"


class _FakeEditClient:
    """Qwen-Image-Edit 专用实例替身:记录转存与提交图。"""

    def __init__(self) -> None:
        self.base_url = "http://fake-qwen-edit:8194"
        self.uploads: list[tuple[bytes, str]] = []
        self.graphs: list[dict] = []

    async def upload_image(self, content: bytes, filename: str) -> str:
        self.uploads.append((content, filename))
        return "qwen_edit_input.png"

    async def queue_prompt(self, graph: dict, client_id: str) -> str:
        self.graphs.append(graph)
        return "prompt-qwen-edit-1"


def _install_fakes(monkeypatch, edit: _FakeEditClient, source=None) -> None:
    monkeypatch.setattr(generate_route, "resolve_worker", lambda worker: source or _FakeSourceClient())
    monkeypatch.setattr(generate_route, "get_qwen_edit_client", lambda: edit)
    monkeypatch.setattr(generate_route, "spawn_tracker", lambda client, prompt_id: None)


def _post(c: TestClient, uid: str, **over):
    body = {"image": "in.png", "worker": "http://fake-worker", "positive": "把背景换成海边", **over}
    return c.post(
        "/api/generate/qwen-edit",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json=body,
    )


def test_requires_auth(client):
    c, _ = client
    r = c.post(
        "/api/generate/qwen-edit",
        json={"image": "in.png", "worker": "http://fake-worker", "positive": "x"},
    )
    assert r.status_code == 401


def test_rejects_unknown_camera_422(client, monkeypatch):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "qe-422")
    _install_fakes(monkeypatch, _FakeEditClient())
    r = _post(c, uid, camera="bogus")
    assert r.status_code == 422
    assert "相机角度" in r.json()["detail"]


def test_source_read_failure_502(client, monkeypatch):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "qe-502-src")

    class _DownSource(_FakeSourceClient):
        async def get_image_bytes(self, filename, subfolder, type_):
            raise ComfyUIError("worker 不可达")

    _install_fakes(monkeypatch, _FakeEditClient(), source=_DownSource())
    r = _post(c, uid)
    assert r.status_code == 502
    assert "读取源图失败" in r.json()["detail"]


def test_transfer_failure_502(client, monkeypatch):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "qe-502-up")

    class _DownEdit(_FakeEditClient):
        async def upload_image(self, content, filename):
            raise ComfyUIError("编辑实例不可达")

    _install_fakes(monkeypatch, _DownEdit())
    r = _post(c, uid)
    assert r.status_code == 502
    assert "转存源图" in r.json()["detail"]


def test_ok_creates_job(client, monkeypatch):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "qe-ok")
    edit = _FakeEditClient()
    _install_fakes(monkeypatch, edit)
    r = _post(c, uid, camera="top_down", seed=7)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["prompt_id"] == "prompt-qwen-edit-1"
    assert body["worker"] == "http://fake-qwen-edit:8194"
    assert body["seed"] == 7

    # 源图字节被转存到编辑实例,图中 LoadImage 用转存后的新文件名
    assert edit.uploads == [(b"\x89PNG-fake", "in.png")]
    graph = edit.graphs[0]
    assert graph["7"]["inputs"]["image"] == "qwen_edit_input.png"
    assert CAMERA_PRESETS["top_down"] in graph["4"]["inputs"]["prompt"]

    with Session(engine) as s:
        job = s.exec(select(Job).where(Job.user_id == uid)).first()
    assert job is not None
    assert job.kind == "qwen_edit"
    assert job.status == "queued"
    assert job.nsfw is False
    assert "把背景换成海边" in job.prompt
    assert "camera:top_down" in job.prompt
