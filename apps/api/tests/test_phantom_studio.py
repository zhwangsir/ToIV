"""Phantom-Wan-14B 角色一致性视频 —— 图构建 / 参数校验 / 端点提交链路 测试。

覆盖:
  · 图构建器:节点类型与连线(照搬官方示例 phantom_subject2vid_example_02)、
    rope_function="comfy"、参考图 pad 白边缩放、phantom_latent_N 按图数连线、
    turbo/off 档采样参数、蒸馏 LoRA 挂/不挂、模型文件名、参数注入、非法图数抛错
  · 请求校验:无参考图 422;合计 >4 张 422;filename 路径穿越 422;
    num_frames 非 4n+1 向下吸附;宽高非 16 对齐向下取整
  · POST /api/phantom/s2v:成功提交(Job kind=phantom_s2v、seed 落快照、参考图转运);
    实例不可达 → 503;缺 WanVideoPhantomEmbeds 节点 → 503;
    entity_ids 联动(句柄注入参考图链;他人主体 404;无句柄主体 422)
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

import app.routes.phantom_studio as phantom_route
import app.services.longcat as longcat_service
from app.comfy.client import ComfyUIError
from app.db import get_session
from app.main import app
from app.models import Entity, Job, Tenant, User
from app.security import create_token, hash_password
from app.workflows.phantom_s2v import (
    DEFAULT_DISTILL_LORA,
    DEFAULT_MODEL,
    DEFAULT_T5,
    DEFAULT_VAE,
    PhantomS2VParams,
    build_phantom_s2v_graph,
    snap_frames,
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


class _FakePhantomClient:
    """Phantom 实例替身:object_info/queue_prompt/system_stats 可控,不联网。"""

    def __init__(self, *, reachable: bool = True, has_node: bool = True) -> None:
        self.base_url = "http://fake-phantom"
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
        return "prompt-phantom-1"

    async def upload_image(self, content: bytes, name: str) -> str:
        self.uploads.append((content, name))
        return name

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


class _FakeSourceWorker:
    """参考图上传落点 worker 替身(resolve_worker 返回值)。"""

    base_url = "http://fake-pool-worker"

    async def get_image_bytes(self, filename: str, subfolder: str, type_: str):
        return b"fake-image-bytes", "image/png"


def _install_phantom(monkeypatch, fake: _FakePhantomClient) -> None:
    monkeypatch.setattr(longcat_service, "get_longcat_client", lambda: fake)
    monkeypatch.setattr(longcat_service, "spawn_tracker", lambda client, prompt_id: None)
    monkeypatch.setattr(phantom_route, "resolve_worker", lambda w: _FakeSourceWorker())


def _auth_headers(user_id: str) -> dict:
    return {"Authorization": f"Bearer {create_token(user_id)}"}


def _payload(**over) -> dict:
    body = {
        "positive": "红裙少女在樱花树下回头微笑",
        "images": [{"filename": "ref1.png", "worker": "http://fake-pool-worker"}],
    }
    body.update(over)
    return body


# --------------------------------------------------------------------------- #
# 图构建器
# --------------------------------------------------------------------------- #


def test_builder_graph_structure_and_critical_inputs():
    """节点类型/连线照搬官方示例;关键输入(rope/scheduler/pad 白边/模型文件名)锁定。"""
    g = build_phantom_s2v_graph(PhantomS2VParams(
        positive="红裙少女", images=("a.png", "b.png"), seed=42,
    ))

    # 模型链:蒸馏 LoRA(turbo 默认)→ ModelLoader ← BlockSwap(20,官方示例值)
    assert g["1"]["class_type"] == "WanVideoLoraSelect"
    assert g["1"]["inputs"]["lora"] == DEFAULT_DISTILL_LORA
    assert g["1"]["inputs"]["strength"] == 0.8
    assert g["2"]["class_type"] == "WanVideoBlockSwap"
    assert g["2"]["inputs"]["blocks_to_swap"] == 20
    assert g["3"]["class_type"] == "WanVideoModelLoader"
    assert g["3"]["inputs"]["model"] == DEFAULT_MODEL
    assert g["3"]["inputs"]["lora"] == ["1", 0]
    assert g["3"]["inputs"]["block_swap_args"] == ["2", 0]
    assert g["3"]["inputs"]["load_device"] == "offload_device"

    # 文本链
    assert g["4"]["class_type"] == "LoadWanVideoT5TextEncoder"
    assert g["4"]["inputs"]["model_name"] == DEFAULT_T5
    assert g["5"]["class_type"] == "WanVideoTextEncode"
    assert g["5"]["inputs"]["positive_prompt"] == "红裙少女"
    assert g["5"]["inputs"]["t5"] == ["4", 0]

    # Phantom embeds:两张参考图 → phantom_latent_1/2,num_frames/cfg 注入
    assert g["6"]["class_type"] == "WanVideoPhantomEmbeds"
    assert set(g["6"]["inputs"]) == {
        "num_frames", "phantom_cfg_scale",
        "phantom_start_percent", "phantom_end_percent",
        "phantom_latent_1", "phantom_latent_2",
    }
    assert g["6"]["inputs"]["num_frames"] == 81
    assert g["6"]["inputs"]["phantom_cfg_scale"] == 2.0  # turbo 档示例值
    assert g["6"]["inputs"]["phantom_start_percent"] == 0.0
    assert g["6"]["inputs"]["phantom_end_percent"] == 1.0
    assert g["6"]["inputs"]["phantom_latent_1"] == ["22", 0]
    assert g["6"]["inputs"]["phantom_latent_2"] == ["25", 0]

    # 采样器:turbo 档 8 步/cfg1/dpm++_sde;rope_function 硬锁 comfy(E-2)
    assert g["7"]["class_type"] == "WanVideoSampler"
    assert g["7"]["inputs"]["model"] == ["3", 0]
    assert g["7"]["inputs"]["image_embeds"] == ["6", 0]
    assert g["7"]["inputs"]["text_embeds"] == ["5", 0]
    assert g["7"]["inputs"]["steps"] == 8
    assert g["7"]["inputs"]["cfg"] == 1.0
    assert g["7"]["inputs"]["shift"] == 5.0
    assert g["7"]["inputs"]["seed"] == 42
    assert g["7"]["inputs"]["scheduler"] == "dpm++_sde"
    assert g["7"]["inputs"]["rope_function"] == "comfy"

    # VAE/解码/打包
    assert g["8"]["class_type"] == "WanVideoVAELoader"
    assert g["8"]["inputs"]["model_name"] == DEFAULT_VAE
    assert g["9"]["class_type"] == "WanVideoDecode"
    assert g["9"]["inputs"]["vae"] == ["8", 0]
    assert g["10"]["class_type"] == "VHS_VideoCombine"
    assert g["10"]["inputs"]["images"] == ["9", 0]
    assert g["10"]["inputs"]["format"] == "video/h264-mp4"

    # 参考图链:LoadImage → pad 白边缩放(官方示例,crop 会裁掉主体)→ VAE 编码
    assert g["20"]["class_type"] == "LoadImage"
    assert g["20"]["inputs"]["image"] == "a.png"
    assert g["21"]["class_type"] == "ImageResizeKJv2"
    assert g["21"]["inputs"]["image"] == ["20", 0]
    assert g["21"]["inputs"]["width"] == 832
    assert g["21"]["inputs"]["height"] == 480
    assert g["21"]["inputs"]["keep_proportion"] == "pad"
    assert g["21"]["inputs"]["pad_color"] == "255, 255, 255"
    assert g["21"]["inputs"]["divisible_by"] == 16
    assert g["22"]["class_type"] == "WanVideoEncode"
    assert g["22"]["inputs"]["vae"] == ["8", 0]
    assert g["22"]["inputs"]["image"] == ["21", 0]
    assert g["23"]["inputs"]["image"] == "b.png"
    assert g["25"]["class_type"] == "WanVideoEncode"


def test_builder_single_image_only_latent_1():
    """单参考图:只连 phantom_latent_1,不出现 2/3/4。"""
    g = build_phantom_s2v_graph(PhantomS2VParams(positive="x", images=("only.png",)))
    ins = g["6"]["inputs"]
    assert "phantom_latent_1" in ins
    assert "phantom_latent_2" not in ins
    assert "phantom_latent_3" not in ins
    assert "phantom_latent_4" not in ins


def test_builder_off_profile_full_blood():
    """满血档:不挂蒸馏 LoRA、30 步、cfg5、unipc、phantom_cfg 5.0。"""
    g = build_phantom_s2v_graph(PhantomS2VParams(
        positive="x", images=("a.png",), accel="off",
    ))
    assert "1" not in g  # 无 WanVideoLoraSelect
    assert g["3"]["inputs"]["lora"] is None
    assert g["7"]["inputs"]["steps"] == 30
    assert g["7"]["inputs"]["cfg"] == 5.0
    assert g["7"]["inputs"]["scheduler"] == "unipc"
    assert g["6"]["inputs"]["phantom_cfg_scale"] == 5.0


def test_builder_explicit_overrides_and_param_injection():
    """显式 steps/cfg/phantom_cfg_scale 覆盖档位默认;尺寸/帧数/前缀注入。"""
    g = build_phantom_s2v_graph(PhantomS2VParams(
        positive="x", images=("a.png",),
        width=1280, height=720, num_frames=121, fps=24,
        steps=12, cfg=3.5, phantom_cfg_scale=4.0, shift=6.0,
        filename_prefix="ToIV_phantom/test",
    ))
    assert g["7"]["inputs"]["steps"] == 12
    assert g["7"]["inputs"]["cfg"] == 3.5
    assert g["7"]["inputs"]["shift"] == 6.0
    assert g["6"]["inputs"]["phantom_cfg_scale"] == 4.0
    assert g["6"]["inputs"]["num_frames"] == 121
    assert g["21"]["inputs"]["width"] == 1280
    assert g["21"]["inputs"]["height"] == 720
    assert g["10"]["inputs"]["frame_rate"] == 24
    assert g["10"]["inputs"]["filename_prefix"] == "ToIV_phantom/test"


def test_builder_rejects_bad_image_count_and_accel():
    """0 张 / 5 张参考图、未知加速档 → ValueError。"""
    with pytest.raises(ValueError):
        PhantomS2VParams(positive="x", images=())
    with pytest.raises(ValueError):
        PhantomS2VParams(positive="x", images=("1", "2", "3", "4", "5"))
    with pytest.raises(ValueError):
        PhantomS2VParams(positive="x", images=("1",), accel="warp")


def test_snap_frames_grid():
    """4n+1 吸附:81→81,82→81,80→77,16→17(下限)。"""
    assert snap_frames(81) == 81
    assert snap_frames(82) == 81
    assert snap_frames(80) == 77
    assert snap_frames(16) == 17


# --------------------------------------------------------------------------- #
# 端点
# --------------------------------------------------------------------------- #


def test_s2v_submit_success(client, monkeypatch):
    """成功提交:参考图转运到实例、Job kind=phantom_s2v、seed/参数落快照。"""
    fake = _FakePhantomClient()
    _install_phantom(monkeypatch, fake)
    tc, eng = client
    with Session(eng) as s:
        uid = _seed_user(s, "phantom-ok@example.com")

    r = tc.post("/api/phantom/s2v", json=_payload(
        images=[
            {"filename": "ref1.png", "worker": "http://fake-pool-worker"},
            {"filename": "ref2.png", "worker": "http://fake-pool-worker"},
        ],
        seed=123,
    ), headers=_auth_headers(uid))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["prompt_id"] == "prompt-phantom-1"
    assert body["seed"] == 123
    # 两张参考图都经 /view → /upload 转运到 Phantom 实例
    assert [name for _, name in fake.uploads] == ["ref1.png", "ref2.png"]
    # 提交图里的 LoadImage 用实例侧文件名
    g = fake.graphs[0]
    assert g["20"]["inputs"]["image"] == "ref1.png"
    assert g["23"]["inputs"]["image"] == "ref2.png"
    with Session(eng) as s:
        job = s.exec(select(Job).where(Job.prompt_id == "prompt-phantom-1")).first()
        assert job is not None
        assert job.kind == "phantom_s2v"
        assert job.seed == 123
        assert job.status == "queued"


def test_s2v_instance_unreachable_503(client, monkeypatch):
    fake = _FakePhantomClient(reachable=False)
    _install_phantom(monkeypatch, fake)
    tc, eng = client
    with Session(eng) as s:
        uid = _seed_user(s, "phantom-down@example.com")
    r = tc.post("/api/phantom/s2v", json=_payload(), headers=_auth_headers(uid))
    assert r.status_code == 503
    assert "不可达" in r.json()["detail"]


def test_s2v_missing_phantom_node_503(client, monkeypatch):
    fake = _FakePhantomClient(has_node=False)
    _install_phantom(monkeypatch, fake)
    tc, eng = client
    with Session(eng) as s:
        uid = _seed_user(s, "phantom-nonode@example.com")
    r = tc.post("/api/phantom/s2v", json=_payload(), headers=_auth_headers(uid))
    assert r.status_code == 503
    assert "WanVideoPhantomEmbeds" in r.json()["detail"]


def test_s2v_validation_errors(client, monkeypatch):
    """无参考图 422;合计 >4 张 422;filename 路径穿越 422。"""
    fake = _FakePhantomClient()
    _install_phantom(monkeypatch, fake)
    tc, eng = client
    with Session(eng) as s:
        uid = _seed_user(s, "phantom-422@example.com")
    h = _auth_headers(uid)

    r = tc.post("/api/phantom/s2v", json=_payload(images=[]), headers=h)
    assert r.status_code == 422

    five = [{"filename": f"r{i}.png", "worker": "http://fake-pool-worker"} for i in range(5)]
    r = tc.post("/api/phantom/s2v", json=_payload(images=five), headers=h)
    assert r.status_code == 422

    r = tc.post("/api/phantom/s2v", json=_payload(
        images=[{"filename": "../evil.png", "worker": "http://fake-pool-worker"}],
    ), headers=h)
    assert r.status_code == 422


def test_s2v_frame_and_size_snapping(client, monkeypatch):
    """num_frames 非 4n+1 向下吸附;宽高非 16 对齐向下取整(而非 422)。"""
    fake = _FakePhantomClient()
    _install_phantom(monkeypatch, fake)
    tc, eng = client
    with Session(eng) as s:
        uid = _seed_user(s, "phantom-snap@example.com")
    r = tc.post("/api/phantom/s2v", json=_payload(
        num_frames=83, width=830, height=479,
    ), headers=_auth_headers(uid))
    assert r.status_code == 200, r.text
    g = fake.graphs[0]
    assert g["6"]["inputs"]["num_frames"] == 81
    assert g["21"]["inputs"]["width"] == 816  # 830//16*16
    assert g["21"]["inputs"]["height"] == 464  # 479//16*16 → 464;再经宽高比守卫仍 16 对齐


def test_s2v_entity_ids_injected(client, monkeypatch):
    """形象库联动:entity_ids 每主体取最优图句柄注入参考图链(显式 images 在前)。"""
    fake = _FakePhantomClient()
    _install_phantom(monkeypatch, fake)
    tc, eng = client
    with Session(eng) as s:
        uid = _seed_user(s, "phantom-entity@example.com")
        s.add(Entity(
            tenant_id="t", user_id=uid, kind="character", name="女主",
            ref_image='{"filename": "heroine_front.png", "worker": "http://fake-pool-worker"}',
        ))
        s.commit()
        eid = s.exec(select(Entity).where(Entity.name == "女主")).first().id

    r = tc.post("/api/phantom/s2v", json=_payload(
        images=[{"filename": "prop.png", "worker": "http://fake-pool-worker"}],
        entity_ids=[eid],
    ), headers=_auth_headers(uid))
    assert r.status_code == 200, r.text
    # 显式图在前、主体图在后,两路 phantom latent
    g = fake.graphs[0]
    assert g["20"]["inputs"]["image"] == "prop.png"
    assert g["23"]["inputs"]["image"] == "heroine_front.png"
    assert "phantom_latent_2" in g["6"]["inputs"]


def test_s2v_entity_not_found_404_and_handleless_422(client, monkeypatch):
    """他人/不存在主体 → 404;主体无上传句柄参考图 → 422。"""
    fake = _FakePhantomClient()
    _install_phantom(monkeypatch, fake)
    tc, eng = client
    with Session(eng) as s:
        uid = _seed_user(s, "phantom-e404@example.com")
        s.add(Entity(
            tenant_id="t", user_id=uid, kind="character", name="无图角色",
            ref_image="https://example.com/external.png",  # URL 形态,无句柄
        ))
        s.commit()
        handleless_id = s.exec(select(Entity).where(Entity.name == "无图角色")).first().id
    h = _auth_headers(uid)

    r = tc.post("/api/phantom/s2v", json=_payload(
        images=[], entity_ids=["nonexistent-id"],
    ), headers=h)
    assert r.status_code == 404

    r = tc.post("/api/phantom/s2v", json=_payload(
        images=[], entity_ids=[handleless_id],
    ), headers=h)
    assert r.status_code == 422
