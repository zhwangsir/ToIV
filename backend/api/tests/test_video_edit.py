"""VACE 视频到视频编辑(Runway Aleph 式 in-context)—— 图构建 / 参数校验 / 端点 测试。

覆盖:
  · 编辑图构建器:骨架节点与多参考图链路同构(rope=comfy/scheduler=unipc/fp8 量化/
    vace_blocks_to_swap 防 TypeError)、源视频 VHS_LoadVideo → VACEEncode.input_frames
    (frame_load_cap 与 num_frames 同步截断)、源视频原声回打包(audio=[50,2])、
    无关键帧/区域 mask 时不接 input_masks(wrapper 缺省全 1 兜底)、
    关键帧锚点 mask 批(SolidMask 0=保留锚点/1=重生成,RepeatImageBatch+ImageBatch
    段组装 → ImageToMask)、preserve_mask 区域支路(LoadImage→ImageToMask→InvertMask
    →MaskToImage→ImageScale 归一)、帧数 4k+1 取整、edit_prompt 回退 positive
  · 构建器校验:缺源视频/未知编辑模式/>5 关键帧/关键帧越界/空指令 ValueError
  · 请求校验:edit_mode 枚举 422;keyframe_indices 负数/超 5 个 422;
    关键帧索引 ≥ 输出帧数 422;时长 >10s 422;源视频路径穿越 422
  · POST /api/generate/video-edit:源视频转运到 :8197 后提交,图内引用转运文件名,
    Job kind=video_edit;实例不可达 → 503;X-NSFW 头 → Job 打标
"""
from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

import app.routes.wan_studio as wan_route
import app.services.longcat as longcat_service
import app.services.wan_video as wan_service
from app.comfy.client import ComfyUIError
from app.db import get_session
from app.main import app
from app.models import Job, Tenant, User
from app.security import create_token, hash_password
from app.workflows.wan_vace import (
    BLOCK_SWAP as VACE_BLOCK_SWAP,
    DEFAULT_MODEL as VACE_MODEL,
    EDIT_MODES,
    MAX_KEYFRAMES,
    WanVaceEditParams,
    build_wan_vace_edit_graph,
)


# --------------------------------------------------------------------------- #
# 公共 fixtures / fakes(与 test_wan_studio 同模式)
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
    """:8197 实例替身:object_info/queue_prompt/upload_image/system_stats 可控。"""

    def __init__(self, *, reachable: bool = True, free_vram_gib: float = 96.0) -> None:
        self.base_url = "http://fake-wan"
        self._reachable = reachable
        self.free_gib = free_vram_gib
        self.graphs: list[dict] = []
        self.uploads: list[tuple[bytes, str]] = []

    async def object_info(self, node: str) -> dict:
        if not self._reachable:
            raise ComfyUIError("connection refused")
        return {node: {}}

    async def queue_prompt(self, graph: dict, client_id: str) -> str:
        self.graphs.append(graph)
        return "prompt-edit-1"

    async def upload_image(self, content: bytes, filename: str) -> str:
        self.uploads.append((content, filename))
        return f"wan-{filename}"

    async def queue_len(self) -> int:
        return 0

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

    def __init__(self, content: bytes = b"media-bytes") -> None:
        self.base_url = "http://fake-worker"
        self._content = content

    async def get_image_bytes(self, filename: str, subfolder: str, type_: str) -> tuple[bytes, str]:
        return self._content, "application/octet-stream"


def _install_wan(monkeypatch, fake: _FakeWanClient) -> None:
    monkeypatch.setattr(longcat_service, "get_longcat_client", lambda: fake)
    monkeypatch.setattr(longcat_service, "spawn_tracker", lambda client, prompt_id: None)
    monkeypatch.setattr(wan_route, "resolve_worker", lambda worker: _FakeSourceWorker())


def _stub_wan_settings(monkeypatch, threshold: float = 26.0) -> None:
    """替换 wan_video 服务层 settings:显存预检阈值可控(fake stats 无 system 段 → RAM 放行)。"""
    monkeypatch.setattr(
        wan_service,
        "get_settings",
        lambda: SimpleNamespace(wan_min_free_vram_gb=threshold, wan_min_free_ram_gb=15.0),
    )


def _edit_params(**over) -> WanVaceEditParams:
    base = dict(
        positive="replace the car with a bicycle",
        ref_images=(),
        source_video="src.mp4",
        edit_prompt="replace the car with a bicycle",
        edit_mode="object_replace",
        num_frames=81,
        seed=42,
    )
    base.update(over)
    return WanVaceEditParams(**base)


# --------------------------------------------------------------------------- #
# 编辑图构建器
# --------------------------------------------------------------------------- #


def test_edit_builder_structure_and_critical_inputs():
    """骨架与多参考图链路同构;源视频帧 → input_frames;无 mask 支路不接 input_masks。"""
    g = build_wan_vace_edit_graph(_edit_params())

    assert g["1"]["class_type"] == "WanVideoModelLoader"
    assert g["1"]["inputs"]["model"] == VACE_MODEL
    assert g["1"]["inputs"]["quantization"] == "fp8_e4m3fn"
    assert g["2"]["inputs"]["blocks_to_swap"] == VACE_BLOCK_SWAP
    # vace_blocks_to_swap 缺省会炸 TypeError(同多参考图链路踩坑)
    assert g["2"]["inputs"]["vace_blocks_to_swap"] == 8

    # 编辑指令进文本编码;采样器关键输入锁定
    assert g["5"]["inputs"]["positive_prompt"] == "replace the car with a bicycle"
    s = g["13"]["inputs"]
    assert s["rope_function"] == "comfy"
    assert s["scheduler"] == "unipc"
    assert s["cfg"] == 5.0 and s["shift"] == 8.0 and s["steps"] == 20
    assert s["model"] == ["1", 0] and s["image_embeds"] == ["10", 0]

    # 源视频支路:VHS_LoadVideo(帧数截断与 num_frames 同步)→ input_frames
    assert g["50"]["class_type"] == "VHS_LoadVideo"
    assert g["50"]["inputs"]["video"] == "src.mp4"
    # custom_width/height 为 VHS 必填(2026-08-26 真机 /prompt 400 冒烟实证)
    assert g["50"]["inputs"]["custom_width"] == 832
    assert g["50"]["inputs"]["custom_height"] == 480
    assert g["50"]["inputs"]["frame_load_cap"] == g["10"]["inputs"]["num_frames"]
    assert g["50"]["inputs"]["force_rate"] == 16

    # 帧数对齐:StartToEndFrame.control_images(灰帧补齐/截断到 num_frames)→ input_frames
    # (VACEEncode 帧数硬约束,2026-08-26 冒烟实证;masks 输出弃用,编辑 mask 独立供给)
    assert g["51"]["class_type"] == "WanVideoVACEStartToEndFrame"
    assert g["51"]["inputs"]["control_images"] == ["50", 0]
    assert g["51"]["inputs"]["num_frames"] == g["10"]["inputs"]["num_frames"]

    v = g["10"]
    assert v["class_type"] == "WanVideoVACEEncode"
    assert v["inputs"]["vae"] == ["3", 0]
    assert v["inputs"]["input_frames"] == ["51", 0]
    assert v["inputs"]["strength"] == 1.0
    # 无关键帧/区域 mask:不接 input_masks(wrapper 缺省全 1 重生成)
    assert "input_masks" not in v["inputs"]
    # 编辑链路不走参考图支路
    assert "ref_images" not in v["inputs"]
    assert "30" not in g  # 无 concat

    # 源视频原声回打包 + 独立产物前缀
    assert g["15"]["inputs"]["audio"] == ["50", 2]
    assert g["15"]["inputs"]["filename_prefix"] == "ToIV_wan/vace_edit"


def test_edit_builder_frames_snap_4k1():
    """WanVideo 系时序网格 (T-1)%4==0:80 → 81,条件与视频截断同步。"""
    g = build_wan_vace_edit_graph(_edit_params(num_frames=80))
    assert g["10"]["inputs"]["num_frames"] == 81
    assert g["50"]["inputs"]["frame_load_cap"] == 81


def test_edit_builder_keyframe_mask_single_anchor():
    """单锚点(帧 0):黑帧(保留) + Repeat(fill, N-1) 段组装 → ImageToMask。"""
    g = build_wan_vace_edit_graph(_edit_params(keyframe_indices=(0,), num_frames=81))

    # 锚点帧:SolidMask(0.0) 全黑保留
    assert g["60"]["class_type"] == "SolidMask"
    assert g["60"]["inputs"]["value"] == 0.0
    assert g["61"]["class_type"] == "MaskToImage"
    # fill:SolidMask(1.0) 全白重生成
    assert g["62"]["class_type"] == "SolidMask"
    assert g["62"]["inputs"]["value"] == 1.0
    # 段:黑帧 + Repeat(fill, 80),一次 ImageBatch 链接
    assert g["70"]["class_type"] == "RepeatImageBatch"
    assert g["70"]["inputs"]["amount"] == 80
    assert g["71"]["class_type"] == "ImageBatch"
    assert g["71"]["inputs"]["image1"] == ["61", 0]
    assert g["71"]["inputs"]["image2"] == ["70", 0]
    assert g["90"]["class_type"] == "ImageToMask"
    assert g["90"]["inputs"]["image"] == ["71", 0]
    assert g["90"]["inputs"]["channel"] == "red"
    assert g["10"]["inputs"]["input_masks"] == ["90", 0]


def test_edit_builder_keyframe_mask_multi_anchors():
    """多锚点(帧 2/5,共 9 帧):段 Repeat 量 {2,2,3},锚点帧引用 2 次,4 次 ImageBatch。"""
    g = build_wan_vace_edit_graph(_edit_params(keyframe_indices=(2, 5), num_frames=9))

    repeats = {
        nid: n["inputs"]["amount"]
        for nid, n in g.items()
        if n["class_type"] == "RepeatImageBatch"
    }
    assert sorted(repeats.values()) == [2, 2, 3]
    batches = [n for n in g.values() if n["class_type"] == "ImageBatch"]
    assert len(batches) == 4
    anchor_refs = [
        tuple(n["inputs"][k])
        for n in batches
        for k in ("image1", "image2")
        if n["inputs"][k] == ["61", 0]
    ]
    assert anchor_refs == [("61", 0), ("61", 0)]
    assert g["10"]["inputs"]["input_masks"] == ["90", 0]


def test_edit_builder_preserve_mask_branch():
    """区域保留 mask:LoadImage→ImageToMask(red)→InvertMask(白=保留→0)→MaskToImage
    →ImageScale 归一(ImageBatch 拼接同尺寸约束)→ Repeat 整条 → ImageToMask。"""
    g = build_wan_vace_edit_graph(_edit_params(preserve_mask="mask.png", num_frames=81))

    assert g["62"]["class_type"] == "LoadImage"
    assert g["62"]["inputs"]["image"] == "mask.png"
    assert g["63"]["class_type"] == "ImageToMask"
    assert g["63"]["inputs"]["channel"] == "red"
    assert g["64"]["class_type"] == "InvertMask"
    assert g["64"]["inputs"]["mask"] == ["63", 0]
    assert g["65"]["class_type"] == "MaskToImage"
    assert g["66"]["class_type"] == "ImageScale"
    assert g["66"]["inputs"]["upscale_method"] == "nearest-exact"
    assert g["66"]["inputs"]["width"] == 832 and g["66"]["inputs"]["height"] == 480
    # 无锚点:整条 fill Repeat(num_frames)
    assert "60" not in g and "61" not in g
    assert g["70"]["inputs"]["image"] == ["66", 0]
    assert g["70"]["inputs"]["amount"] == 81
    assert g["10"]["inputs"]["input_masks"] == ["90", 0]


def test_edit_builder_keyframes_compose_with_preserve_mask():
    """锚点 × 区域 mask 并存:锚点帧全黑(整帧保留),其余帧走区域控制 fill。"""
    g = build_wan_vace_edit_graph(
        _edit_params(keyframe_indices=(0,), preserve_mask="mask.png", num_frames=81)
    )
    assert g["66"]["class_type"] == "ImageScale"  # 区域 fill 归一
    assert g["61"]["class_type"] == "MaskToImage"  # 锚点黑帧
    assert g["70"]["inputs"]["image"] == ["66", 0]
    assert g["10"]["inputs"]["input_masks"] == ["90", 0]


def test_edit_builder_edit_prompt_falls_back_to_positive():
    """edit_prompt 置空回退 positive(dataclass 双字段的兼容语义)。"""
    g = build_wan_vace_edit_graph(_edit_params(edit_prompt="", positive="make it anime style"))
    assert g["5"]["inputs"]["positive_prompt"] == "make it anime style"


def test_edit_builder_accel_off_default_no_cache_node():
    """默认 off:不建 cache 节点,采样器不接 cache_args(旧行为零变化)。"""
    g = build_wan_vace_edit_graph(_edit_params())
    assert "17" not in g
    assert "cache_args" not in g["13"]["inputs"]


def test_edit_builder_accel_magcache_wires_cache_node():
    """magcache 档:WanVideoMagCache 串在 model loader 与采样器之间(cache_args 口);
    官方 Wan2.1 校准默认 thresh=0.06/K=2,retention 0.2 × 20 步 → start_step=4。"""
    g = build_wan_vace_edit_graph(_edit_params(accel="magcache"))
    cache = g["17"]
    assert cache["class_type"] == "WanVideoMagCache"
    assert cache["inputs"]["magcache_thresh"] == 0.06
    assert cache["inputs"]["magcache_K"] == 2
    assert cache["inputs"]["start_step"] == 4
    assert cache["inputs"]["end_step"] == -1
    assert g["13"]["inputs"]["cache_args"] == ["17", 0]


def test_edit_builder_accel_unknown_rejected():
    with pytest.raises(ValueError, match="未知 VACE 加速档"):
        build_wan_vace_edit_graph(_edit_params(accel="turbo"))


def test_edit_builder_requires_source_video():
    with pytest.raises(ValueError, match="源视频"):
        build_wan_vace_edit_graph(_edit_params(source_video=""))


def test_edit_builder_rejects_unknown_mode():
    with pytest.raises(ValueError, match="未知编辑模式"):
        build_wan_vace_edit_graph(_edit_params(edit_mode="teleport"))


def test_edit_builder_rejects_too_many_keyframes():
    kfs = tuple(range(MAX_KEYFRAMES + 1))
    with pytest.raises(ValueError, match="最多"):
        build_wan_vace_edit_graph(_edit_params(keyframe_indices=kfs))


def test_edit_builder_rejects_out_of_range_keyframe():
    with pytest.raises(ValueError, match="0-80"):
        build_wan_vace_edit_graph(_edit_params(keyframe_indices=(81,)))
    with pytest.raises(ValueError, match="0-80"):
        build_wan_vace_edit_graph(_edit_params(keyframe_indices=(-1,)))


def test_edit_builder_requires_prompt():
    with pytest.raises(ValueError, match="编辑指令不能为空"):
        build_wan_vace_edit_graph(_edit_params(edit_prompt="", positive=""))


def test_edit_modes_enum_complete():
    """编辑模式五枚举固定(对象替换/移除/风格迁移/重打光/相机变换)。"""
    assert EDIT_MODES == (
        "object_replace", "object_remove", "style_transfer", "relight", "camera_change",
    )
    for mode in EDIT_MODES:
        g = build_wan_vace_edit_graph(_edit_params(edit_mode=mode))
        assert g["10"]["class_type"] == "WanVideoVACEEncode"


# --------------------------------------------------------------------------- #
# 请求校验(422)
# --------------------------------------------------------------------------- #


def _edit_payload(**over) -> dict:
    payload = {
        "source_video": "src.mp4",
        "edit_prompt": "replace the car with a bicycle",
        "edit_mode": "object_replace",
        "worker": "http://fake-worker",
    }
    payload.update(over)
    return payload


def test_edit_rejects_unknown_edit_mode(client):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "vemode")
    r = c.post(
        "/api/generate/video-edit",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json=_edit_payload(edit_mode="teleport"),
    )
    assert r.status_code == 422


@pytest.mark.parametrize("mode", EDIT_MODES)
def test_edit_accepts_all_modes(client, monkeypatch, mode):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, f"vemode-{mode}")
    fake = _FakeWanClient()
    _install_wan(monkeypatch, fake)
    _stub_wan_settings(monkeypatch)
    r = c.post(
        "/api/generate/video-edit",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json=_edit_payload(edit_mode=mode),
    )
    assert r.status_code == 200, r.text


def test_edit_rejects_missing_source_video(client):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "venovid")
    r = c.post(
        "/api/generate/video-edit",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json=_edit_payload(source_video=""),
    )
    assert r.status_code == 422


def test_edit_rejects_path_traversal(client):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "vetrav")
    r = c.post(
        "/api/generate/video-edit",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json=_edit_payload(source_video="../evil.mp4"),
    )
    assert r.status_code == 422
    r = c.post(
        "/api/generate/video-edit",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json=_edit_payload(preserve_mask="../evil.png"),
    )
    assert r.status_code == 422


def test_edit_rejects_too_many_keyframes(client):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "vemanykf")
    r = c.post(
        "/api/generate/video-edit",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json=_edit_payload(keyframe_indices=list(range(MAX_KEYFRAMES + 1))),
    )
    assert r.status_code == 422


def test_edit_rejects_negative_keyframe(client):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "venegkf")
    r = c.post(
        "/api/generate/video-edit",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json=_edit_payload(keyframe_indices=[-1]),
    )
    assert r.status_code == 422


def test_edit_rejects_keyframe_beyond_output_frames(client, monkeypatch):
    """关键帧索引 ≥ 输出帧数(1s@16fps → 17 帧,索引 20 越界)→ 422。"""
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "vekfidx")
    fake = _FakeWanClient()
    _install_wan(monkeypatch, fake)
    _stub_wan_settings(monkeypatch)
    r = c.post(
        "/api/generate/video-edit",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json=_edit_payload(duration_sec=1, keyframe_indices=[20]),
    )
    assert r.status_code == 422
    assert "越界" in r.json()["detail"]
    assert fake.graphs == []  # 未提交


def test_edit_rejects_duration_over_10s(client):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "vedur")
    r = c.post(
        "/api/generate/video-edit",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json=_edit_payload(duration_sec=10.5),
    )
    assert r.status_code == 422


# --------------------------------------------------------------------------- #
# POST /api/generate/video-edit
# --------------------------------------------------------------------------- #


def test_edit_ok_transfers_video_and_submits(client, monkeypatch):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "veok")
    fake = _FakeWanClient()
    _install_wan(monkeypatch, fake)
    _stub_wan_settings(monkeypatch)
    r = c.post(
        "/api/generate/video-edit",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json=_edit_payload(duration_sec=5, seed=7, keyframe_indices=[0, 40]),
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["prompt_id"] == "prompt-edit-1"
    assert body["worker"] == "http://fake-wan"
    assert body["seed"] == 7

    # 源视频从源 worker 转运到 :8197;图内引用转运文件名
    assert fake.uploads == [(b"media-bytes", "src.mp4")]
    graph = fake.graphs[0]
    assert graph["50"]["inputs"]["video"] == "wan-src.mp4"
    assert graph["10"]["inputs"]["input_frames"] == ["51", 0]
    assert graph["10"]["inputs"]["num_frames"] == 81  # 5s@16fps → 81
    assert graph["10"]["inputs"]["input_masks"] == ["90", 0]  # 双锚点 mask 支路
    assert graph["13"]["inputs"]["seed"] == 7

    with Session(engine) as s:
        job = s.exec(select(Job).where(Job.user_id == uid)).first()
        assert job is not None
        assert job.kind == "video_edit"
        assert job.nsfw is False
        assert job.seed == 7
        assert job.worker == "http://fake-wan"


def test_edit_ok_transfers_preserve_mask(client, monkeypatch):
    """区域保留 mask 与源视频同路转运(同 worker 落点,PNG 与图片同通道)。"""
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "vemask")
    fake = _FakeWanClient()
    _install_wan(monkeypatch, fake)
    _stub_wan_settings(monkeypatch)
    r = c.post(
        "/api/generate/video-edit",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json=_edit_payload(preserve_mask="keep.png"),
    )
    assert r.status_code == 200, r.text
    names = [name for _, name in fake.uploads]
    assert names == ["src.mp4", "keep.png"]
    graph = fake.graphs[0]
    assert graph["62"]["inputs"]["image"] == "wan-keep.png"
    assert graph["10"]["inputs"]["input_masks"] == ["90", 0]


def test_edit_without_masks_has_no_mask_branch(client, monkeypatch):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "venomask")
    fake = _FakeWanClient()
    _install_wan(monkeypatch, fake)
    _stub_wan_settings(monkeypatch)
    r = c.post(
        "/api/generate/video-edit",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json=_edit_payload(),
    )
    assert r.status_code == 200, r.text
    graph = fake.graphs[0]
    assert "input_masks" not in graph["10"]["inputs"]
    assert "90" not in graph


def test_edit_route_rejects_unknown_accel(client):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "veaccelbad")
    r = c.post(
        "/api/generate/video-edit",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json=_edit_payload(accel="turbo"),
    )
    assert r.status_code == 422


def test_edit_route_accel_passthrough(client, monkeypatch):
    """accel=magcache 透传到编辑图(cache 节点+cache_args);缺省 off 零变化。"""
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "veaccel")
    fake = _FakeWanClient()
    _install_wan(monkeypatch, fake)
    _stub_wan_settings(monkeypatch)
    r = c.post(
        "/api/generate/video-edit",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json=_edit_payload(accel="magcache"),
    )
    assert r.status_code == 200, r.text
    graph = fake.graphs[0]
    assert graph["17"]["class_type"] == "WanVideoMagCache"
    assert graph["17"]["inputs"]["magcache_thresh"] == 0.06
    assert graph["13"]["inputs"]["cache_args"] == ["17", 0]

    r = c.post(
        "/api/generate/video-edit",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json=_edit_payload(),
    )
    assert r.status_code == 200, r.text
    graph = fake.graphs[1]
    assert "17" not in graph
    assert "cache_args" not in graph["13"]["inputs"]


def test_edit_instance_unreachable_503(client, monkeypatch):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "vedown")
    _install_wan(monkeypatch, _FakeWanClient(reachable=False))
    _stub_wan_settings(monkeypatch)
    r = c.post(
        "/api/generate/video-edit",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json=_edit_payload(),
    )
    assert r.status_code == 503
    assert "不可达" in r.json()["detail"]


def test_edit_requires_auth(client):
    c, _ = client
    r = c.post("/api/generate/video-edit", json=_edit_payload())
    assert r.status_code == 401


def test_edit_marks_job_nsfw_with_x_nsfw_header(client, monkeypatch):
    """/nsfw 专区(X-NSFW: 1)提交视频编辑:Job 打 nsfw 标,主站作品库不可见。"""
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "vensfw")
    fake = _FakeWanClient()
    _install_wan(monkeypatch, fake)
    _stub_wan_settings(monkeypatch)
    r = c.post(
        "/api/generate/video-edit",
        headers={"Authorization": f"Bearer {create_token(uid)}", "X-NSFW": "1"},
        json=_edit_payload(edit_prompt="make it neon noir style", edit_mode="style_transfer"),
    )
    assert r.status_code == 200, r.text
    with Session(engine) as s:
        job = s.exec(select(Job).where(Job.user_id == uid)).first()
        assert job is not None
        assert job.kind == "video_edit" and job.nsfw is False
