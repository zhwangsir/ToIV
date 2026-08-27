"""Wan 工作室(Wan2.2-Animate 动作迁移 / Wan2.1-VACE 多参考图)—— 图构建 / 参数校验 / 端点 / 显存互斥预检 测试。

覆盖:
  · Animate 图构建器:节点类型与连线(照搬官方示例 wanvideo_WanAnimate_example_01)、
    rope_function="comfy"、scheduler=dpm++_sde、fp8 运行时量化 + offload、
    VHS_LoadVideo frame_load_cap 与 num_frames 同步截断、帧数 4k+1 取整、
    relight_lora 置空无 LoraSelect 节点 / 挂上则接 ModelLoader.lora、两次构建互不影响
  · VACE 图构建器:scheduler=unipc、cfg/shift 官方值、单参考图直连不 concat、
    多参考图 ImageConcatMulti 合 batch、可选首尾帧 WanVideoVACEStartToEndFrame 支路、
    0 张 / >4 张参考图 ValueError
  · 请求校验:帧数越界 422(Animate 17-501 / VACE 17-241);宽高超界 422;
    参考图/驱动视频路径穿越 422;VACE images 空 / 超 4 张 422
  · POST /api/wan/animate:参考图 + 驱动视频从源 worker 转运到 :8197 后提交,
    图内引用转运文件名,Job kind=wan_animate;实例不可达/缺节点 → 503;X-NSFW 头 → Job 打标
  · POST /api/wan/vace:多参考图(+首尾帧)转运提交,Job kind=wan_vace
  · ensure_wan_vram 显存互斥预检:空闲充足放行;不足且队列空闲 → 驱逐自身缓存复查放行;
    不足且队列忙 → 503 错峰;stats 读取失败 → 跳过预检放行;阈值 0 → 关闭预检
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
from app.workflows.wan_animate import (
    BLOCK_SWAP as ANIMATE_BLOCK_SWAP,
    DEFAULT_CLIP_VISION,
    DEFAULT_MODEL as ANIMATE_MODEL,
    DEFAULT_RELIGHT_LORA,
    DEFAULT_T5,
    DEFAULT_VAE,
    FRAME_WINDOW,
    WanAnimateParams,
    build_wan_animate_graph,
)
from app.workflows.wan_vace import (
    BLOCK_SWAP as VACE_BLOCK_SWAP,
    DEFAULT_MODEL as VACE_MODEL,
    MAX_REF_IMAGES,
    WanVaceParams,
    build_wan_vace_graph,
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


class _FakeWanClient:
    """:8197 实例替身:object_info/queue_prompt/upload_image/system_stats/queue_len/free_memory 可控。"""

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
        self.base_url = "http://fake-wan"
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
        return "prompt-wan-1"

    async def upload_image(self, content: bytes, filename: str) -> str:
        self.uploads.append((content, filename))
        return f"wan-{filename}"

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


def _install_wan(monkeypatch, fake: _FakeWanClient) -> None:
    monkeypatch.setattr(longcat_service, "get_longcat_client", lambda: fake)
    monkeypatch.setattr(longcat_service, "spawn_tracker", lambda client, prompt_id: None)
    monkeypatch.setattr(wan_route, "resolve_worker", lambda worker: _FakeSourceWorker())


def _stub_wan_settings(monkeypatch, threshold: float = 26.0) -> None:
    """替换 wan_video 服务层 settings:显存预检阈值可控。"""
    monkeypatch.setattr(
        wan_service,
        "get_settings",
        # fake stats 无 system 段 → RAM 预检解析 None 放行(不占本文件用例语义)
        lambda: SimpleNamespace(wan_min_free_vram_gb=threshold, wan_min_free_ram_gb=15.0),
    )


# --------------------------------------------------------------------------- #
# Animate 图构建器
# --------------------------------------------------------------------------- #


def test_animate_builder_structure_and_critical_inputs():
    """节点类型/连线照搬官方示例;关键输入(rope/scheduler/cfg/shift/量化)锁定。"""
    g = build_wan_animate_graph(WanAnimateParams(
        positive="女孩跳舞", image="ref.png", video="drive.mp4", seed=42,
    ))

    assert g["1"]["class_type"] == "WanVideoModelLoader"
    assert g["1"]["inputs"]["model"] == ANIMATE_MODEL
    assert g["1"]["inputs"]["base_precision"] == "bf16"
    assert g["1"]["inputs"]["quantization"] == "fp8_e4m3fn"
    assert g["1"]["inputs"]["load_device"] == "offload_device"
    assert g["1"]["inputs"]["attention_mode"] == "sdpa"
    assert g["1"]["inputs"]["block_swap_args"] == ["2", 0]
    assert g["2"]["class_type"] == "WanVideoBlockSwap"
    assert g["2"]["inputs"]["blocks_to_swap"] == ANIMATE_BLOCK_SWAP
    assert g["3"]["class_type"] == "WanVideoVAELoader"
    assert g["3"]["inputs"]["model_name"] == DEFAULT_VAE
    assert g["4"]["class_type"] == "LoadWanVideoT5TextEncoder"
    assert g["4"]["inputs"]["model_name"] == DEFAULT_T5
    assert g["5"]["class_type"] == "WanVideoTextEncode"
    assert g["5"]["inputs"]["t5"] == ["4", 0]

    # 参考图支路:LoadImage → 16 对齐 crop → CLIP 视觉编码
    assert g["6"]["class_type"] == "LoadImage"
    assert g["6"]["inputs"]["image"] == "ref.png"
    assert g["7"]["class_type"] == "ImageResizeKJv2"
    assert g["7"]["inputs"]["image"] == ["6", 0]
    assert g["7"]["inputs"]["divisible_by"] == 16
    assert g["8"]["class_type"] == "CLIPVisionLoader"
    assert g["8"]["inputs"]["clip_name"] == DEFAULT_CLIP_VISION
    assert g["9"]["class_type"] == "WanVideoClipVisionEncode"
    assert g["9"]["inputs"]["clip_vision"] == ["8", 0]
    assert g["9"]["inputs"]["image_1"] == ["7", 0]

    # 驱动视频支路:VHS_LoadVideo → wrapper 自带姿态提取(帧数截断同步)
    assert g["10"]["class_type"] == "VHS_LoadVideo"
    assert g["10"]["inputs"]["video"] == "drive.mp4"
    assert g["10"]["inputs"]["frame_load_cap"] == g["12"]["inputs"]["num_frames"]
    assert g["11"]["class_type"] == "WanVideoUniAnimateDWPoseDetector"
    assert g["11"]["inputs"]["pose_images"] == ["10", 0]

    # Animate 条件组装:ref + pose(Animation 模式)
    assert g["12"]["class_type"] == "WanVideoAnimateEmbeds"
    assert g["12"]["inputs"]["vae"] == ["3", 0]
    assert g["12"]["inputs"]["clip_embeds"] == ["9", 0]
    assert g["12"]["inputs"]["ref_images"] == ["7", 0]
    assert g["12"]["inputs"]["pose_images"] == ["11", 0]
    assert g["12"]["inputs"]["frame_window_size"] == FRAME_WINDOW

    # 采样器:真机踩坑约束(rope_function 必须 comfy,否则 4096 vs 128 维度错)
    s = g["13"]["inputs"]
    assert s["rope_function"] == "comfy"
    assert s["scheduler"] == "dpm++_sde"
    assert s["cfg"] == 1.0 and s["shift"] == 5.0 and s["steps"] == 6
    assert s["model"] == ["1", 0] and s["image_embeds"] == ["12", 0] and s["text_embeds"] == ["5", 0]

    # 解码 + 打包(驱动视频原声回打包)
    assert g["14"]["class_type"] == "WanVideoDecode"
    assert g["14"]["inputs"]["vae"] == ["3", 0] and g["14"]["inputs"]["samples"] == ["13", 0]
    assert g["15"]["class_type"] == "VHS_VideoCombine"
    assert g["15"]["inputs"]["images"] == ["14", 0]
    assert g["15"]["inputs"]["audio"] == ["10", 2]
    assert g["15"]["inputs"]["filename_prefix"] == "ToIV_wan/animate"


def test_animate_builder_injects_params():
    g = build_wan_animate_graph(WanAnimateParams(
        positive="武术表演", negative="模糊", image="a.png", video="b.mp4",
        width=640, height=640, num_frames=81, steps=8, cfg=2.0, shift=6.0,
        fps=24, seed=7,
    ))
    assert g["5"]["inputs"]["positive_prompt"] == "武术表演"
    assert g["5"]["inputs"]["negative_prompt"] == "模糊"
    assert g["7"]["inputs"]["width"] == 640 and g["7"]["inputs"]["height"] == 640
    assert g["12"]["inputs"]["width"] == 640 and g["12"]["inputs"]["num_frames"] == 81
    assert g["10"]["inputs"]["force_rate"] == 24
    assert g["13"]["inputs"]["steps"] == 8 and g["13"]["inputs"]["seed"] == 7
    assert g["13"]["inputs"]["cfg"] == 2.0 and g["13"]["inputs"]["shift"] == 6.0
    assert g["15"]["inputs"]["frame_rate"] == 24


@pytest.mark.parametrize("given,snapped", [(17, 17), (120, 121), (122, 125), (500, 501)])
def test_animate_frames_snap_4k1(given, snapped):
    """WanVideo 系时序网格 (T-1)%4==0:向上取整 4k+1,图内同步(条件 + 视频截断)。"""
    g = build_wan_animate_graph(WanAnimateParams(
        positive="x", image="a.png", video="b.mp4", num_frames=given, seed=1,
    ))
    assert g["12"]["inputs"]["num_frames"] == snapped
    assert g["10"]["inputs"]["frame_load_cap"] == snapped


def test_animate_builder_no_relight_lora_by_default():
    """relight_lora 置空(默认 Animation 模式):无 LoraSelect 节点,ModelLoader.lora=None。"""
    g = build_wan_animate_graph(WanAnimateParams(
        positive="x", image="a.png", video="b.mp4", seed=1,
    ))
    assert "16" not in g
    assert g["1"]["inputs"]["lora"] is None


def test_animate_builder_with_relight_lora():
    """relight_lora 挂上(Replacement 换背景):LoraSelectMulti 节点接 ModelLoader.lora。"""
    g = build_wan_animate_graph(WanAnimateParams(
        positive="x", image="a.png", video="b.mp4", seed=1,
        relight_lora=DEFAULT_RELIGHT_LORA,
    ))
    assert g["16"]["class_type"] == "WanVideoLoraSelectMulti"
    assert g["16"]["inputs"]["lora_0"] == DEFAULT_RELIGHT_LORA
    assert g["1"]["inputs"]["lora"] == ["16", 0]


def test_animate_two_builds_independent():
    g1 = build_wan_animate_graph(WanAnimateParams(
        positive="first", image="a.png", video="b.mp4", seed=1,
    ))
    g2 = build_wan_animate_graph(WanAnimateParams(
        positive="second", image="a.png", video="b.mp4", seed=2,
    ))
    assert g1["5"]["inputs"]["positive_prompt"] == "first"
    assert g2["5"]["inputs"]["positive_prompt"] == "second"
    assert g1["13"]["inputs"]["seed"] == 1


def test_animate_default_seed_random():
    p1 = WanAnimateParams(positive="x", image="a.png", video="b.mp4")
    p2 = WanAnimateParams(positive="x", image="a.png", video="b.mp4")
    assert p1.seed >= 0 and p2.seed >= 0  # 随机种子(极低概率相等,不断言不等)


# --------------------------------------------------------------------------- #
# VACE 图构建器
# --------------------------------------------------------------------------- #


def test_vace_builder_structure_and_critical_inputs():
    """骨架节点 + VACE 条件组装;关键输入(rope/scheduler=unipc/cfg/shift)锁定。"""
    g = build_wan_vace_graph(WanVaceParams(
        positive="城市漫步", ref_images=("r1.png",), seed=42,
    ))
    assert g["1"]["class_type"] == "WanVideoModelLoader"
    assert g["1"]["inputs"]["model"] == VACE_MODEL
    assert g["1"]["inputs"]["quantization"] == "fp8_e4m3fn"
    assert g["1"]["inputs"]["load_device"] == "offload_device"
    assert g["2"]["inputs"]["blocks_to_swap"] == VACE_BLOCK_SWAP
    assert g["5"]["class_type"] == "WanVideoTextEncode"

    # 单参考图:直连 ref_images,不走 concat
    assert "30" not in g
    assert g["20"]["class_type"] == "LoadImage"
    assert g["20"]["inputs"]["image"] == "r1.png"
    assert g["21"]["class_type"] == "ImageResizeKJv2"
    assert g["21"]["inputs"]["divisible_by"] == 16

    v = g["10"]
    assert v["class_type"] == "WanVideoVACEEncode"
    assert v["inputs"]["vae"] == ["3", 0]
    assert v["inputs"]["ref_images"] == ["21", 0]
    assert v["inputs"]["strength"] == 1.0
    assert v["inputs"]["vace_start_percent"] == 0.0
    assert v["inputs"]["vace_end_percent"] == 1.0
    # 无首尾帧:不接 input_frames/input_masks
    assert "input_frames" not in v["inputs"]
    assert "input_masks" not in v["inputs"]

    s = g["13"]["inputs"]
    assert s["rope_function"] == "comfy"
    assert s["scheduler"] == "unipc"
    assert s["cfg"] == 5.0 and s["shift"] == 8.0 and s["steps"] == 20
    assert s["model"] == ["1", 0] and s["image_embeds"] == ["10", 0] and s["text_embeds"] == ["5", 0]
    assert g["15"]["inputs"]["filename_prefix"] == "ToIV_wan/vace"


def test_vace_multi_ref_images_concat():
    """多参考图:ImageConcatMulti(direction=right) 合成 batch 喂 ref_images。"""
    g = build_wan_vace_graph(WanVaceParams(
        positive="x", ref_images=("r1.png", "r2.png", "r3.png"), seed=1,
    ))
    concat = g["30"]
    assert concat["class_type"] == "ImageConcatMulti"
    assert concat["inputs"]["inputcount"] == 3
    assert concat["inputs"]["direction"] == "right"
    assert concat["inputs"]["match_image_size"] is True
    assert concat["inputs"]["image_1"] == ["21", 0]
    assert concat["inputs"]["image_2"] == ["23", 0]
    assert concat["inputs"]["image_3"] == ["25", 0]
    assert g["10"]["inputs"]["ref_images"] == ["30", 0]
    # 三张参考图各自 LoadImage → resize
    for nid, name in (("20", "r1.png"), ("22", "r2.png"), ("24", "r3.png")):
        assert g[nid]["class_type"] == "LoadImage"
        assert g[nid]["inputs"]["image"] == name


def test_vace_max_ref_images_concat():
    g = build_wan_vace_graph(WanVaceParams(
        positive="x", ref_images=tuple(f"r{i}.png" for i in range(MAX_REF_IMAGES)), seed=1,
    ))
    assert g["30"]["inputs"]["inputcount"] == MAX_REF_IMAGES


def test_vace_start_end_frame_branch():
    """首尾帧可选支路:WanVideoVACEStartToEndFrame → VACEEncode.input_frames/input_masks。"""
    g = build_wan_vace_graph(WanVaceParams(
        positive="x", ref_images=("r1.png",),
        start_image="s.png", end_image="e.png", num_frames=121, seed=1,
    ))
    assert g["40"]["inputs"]["image"] == "s.png"
    assert g["42"]["inputs"]["image"] == "e.png"
    s2e = g["44"]
    assert s2e["class_type"] == "WanVideoVACEStartToEndFrame"
    assert s2e["inputs"]["start_image"] == ["41", 0]
    assert s2e["inputs"]["end_image"] == ["43", 0]
    assert s2e["inputs"]["num_frames"] == 121
    assert g["10"]["inputs"]["input_frames"] == ["44", 0]
    assert g["10"]["inputs"]["input_masks"] == ["44", 1]


def test_vace_start_only_frame_branch():
    """只给首帧:支路同样建立,end_image 不进图。"""
    g = build_wan_vace_graph(WanVaceParams(
        positive="x", ref_images=("r1.png",), start_image="s.png", seed=1,
    ))
    assert "44" in g
    assert g["44"]["inputs"]["start_image"] == ["41", 0]
    assert "end_image" not in g["44"]["inputs"]
    assert "42" not in g and "43" not in g
    assert g["10"]["inputs"]["input_frames"] == ["44", 0]


def test_vace_requires_at_least_one_ref():
    with pytest.raises(ValueError, match="至少需要 1 张"):
        build_wan_vace_graph(WanVaceParams(positive="x", ref_images=(), seed=1))


def test_vace_rejects_too_many_refs():
    refs = tuple(f"r{i}.png" for i in range(MAX_REF_IMAGES + 1))
    with pytest.raises(ValueError, match="最多"):
        build_wan_vace_graph(WanVaceParams(positive="x", ref_images=refs, seed=1))


def test_vace_frames_snap_4k1():
    g = build_wan_vace_graph(WanVaceParams(
        positive="x", ref_images=("r1.png",), num_frames=80, seed=1,
    ))
    assert g["10"]["inputs"]["num_frames"] == 81


def test_vace_accel_off_default_no_cache_node():
    """默认 off:不建 cache 节点,采样器不接 cache_args(旧行为零变化)。"""
    g = build_wan_vace_graph(WanVaceParams(positive="x", ref_images=("r1.png",), seed=1))
    assert "17" not in g
    assert "cache_args" not in g["13"]["inputs"]


def test_vace_accel_magcache_wires_cache_node():
    """magcache 档:WanVideoMagCache 串在 model loader 与采样器之间(cache_args 口)。

    官方 Wan2.1 校准默认 thresh=0.06/K=2;retention_ratio 0.2(前 20% 步不缓存)
    按步数映射 start_step(默认 20 步 → 4);VACE 为 Wan2.1 非 MoE 单模型,只串一个
    cache 节点(与 wan_i2v 双专家 EasyCache×2 分流)。
    """
    g = build_wan_vace_graph(WanVaceParams(
        positive="x", ref_images=("r1.png",), accel="magcache", seed=1,
    ))
    cache = g["17"]
    assert cache["class_type"] == "WanVideoMagCache"
    assert cache["inputs"]["magcache_thresh"] == 0.06
    assert cache["inputs"]["magcache_K"] == 2
    assert cache["inputs"]["start_step"] == 4  # retention 0.2 × 20 步
    assert cache["inputs"]["end_step"] == -1
    assert cache["inputs"]["cache_device"] == "offload_device"
    assert g["13"]["inputs"]["cache_args"] == ["17", 0]


def test_vace_accel_magcache_start_step_scales_with_steps():
    """start_step 按 retention 0.2 随步数缩放(30 步→6),下限 1(首步永不缓存)。"""
    g = build_wan_vace_graph(WanVaceParams(
        positive="x", ref_images=("r1.png",), accel="magcache", steps=30, seed=1,
    ))
    assert g["17"]["inputs"]["start_step"] == 6
    g = build_wan_vace_graph(WanVaceParams(
        positive="x", ref_images=("r1.png",), accel="magcache", steps=4, seed=1,
    ))
    assert g["17"]["inputs"]["start_step"] == 1


def test_vace_accel_magcache_threshold_overridable():
    """cache_thresh/cache_k 显式覆盖档位默认(与 wan_i2v 显式 steps/cfg 覆盖同风格)。"""
    g = build_wan_vace_graph(WanVaceParams(
        positive="x", ref_images=("r1.png",), accel="magcache",
        cache_thresh=0.12, cache_k=4, seed=1,
    ))
    assert g["17"]["inputs"]["magcache_thresh"] == 0.12
    assert g["17"]["inputs"]["magcache_K"] == 4


def test_vace_accel_unknown_rejected():
    with pytest.raises(ValueError, match="未知 VACE 加速档"):
        build_wan_vace_graph(WanVaceParams(
            positive="x", ref_images=("r1.png",), accel="turbo", seed=1,
        ))


# --------------------------------------------------------------------------- #
# 请求校验(422 / 对齐取整)
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize("num_frames", [16, 502, 0])
def test_animate_rejects_out_of_range_frames(client, num_frames):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, f"waframes-{num_frames}")
    r = c.post(
        "/api/wan/animate",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "a", "image": "in.png", "video": "d.mp4",
              "worker": "http://fake-worker", "num_frames": num_frames},
    )
    assert r.status_code == 422


@pytest.mark.parametrize("field,value", [("width", 319), ("height", 1281)])
def test_animate_rejects_out_of_range_size(client, field, value):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, f"wasize-{field}")
    r = c.post(
        "/api/wan/animate",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "a", "image": "in.png", "video": "d.mp4",
              "worker": "http://fake-worker", field: value},
    )
    assert r.status_code == 422


@pytest.mark.parametrize("field", ["image", "video"])
def test_animate_rejects_path_traversal(client, field):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, f"watrav-{field}")
    payload = {"positive": "a", "image": "in.png", "video": "d.mp4",
               "worker": "http://fake-worker"}
    payload[field] = "../evil.png"
    r = c.post(
        "/api/wan/animate",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json=payload,
    )
    assert r.status_code == 422


@pytest.mark.parametrize("num_frames", [16, 242])
def test_vace_rejects_out_of_range_frames(client, num_frames):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, f"wvframes-{num_frames}")
    r = c.post(
        "/api/wan/vace",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "a", "images": ["r.png"], "worker": "http://fake-worker",
              "num_frames": num_frames},
    )
    assert r.status_code == 422


def test_vace_rejects_empty_images(client):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "wvempty")
    r = c.post(
        "/api/wan/vace",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "a", "images": [], "worker": "http://fake-worker"},
    )
    assert r.status_code == 422


def test_vace_rejects_too_many_images(client):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "wvtoomany")
    r = c.post(
        "/api/wan/vace",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "a", "worker": "http://fake-worker",
              "images": [f"r{i}.png" for i in range(MAX_REF_IMAGES + 1)]},
    )
    assert r.status_code == 422


def test_vace_rejects_path_traversal_in_images(client):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "wvtrav")
    r = c.post(
        "/api/wan/vace",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "a", "images": ["../evil.png"], "worker": "http://fake-worker"},
    )
    assert r.status_code == 422


# --------------------------------------------------------------------------- #
# POST /api/wan/animate
# --------------------------------------------------------------------------- #


def test_animate_ok_transfers_assets_and_submits(client, monkeypatch):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "waok")
    fake = _FakeWanClient()
    _install_wan(monkeypatch, fake)
    _stub_wan_settings(monkeypatch)
    r = c.post(
        "/api/wan/animate",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "角色打拳", "image": "in.png", "video": "d.mp4",
              "worker": "http://fake-worker", "num_frames": 121, "seed": 7},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["prompt_id"] == "prompt-wan-1"
    assert body["worker"] == "http://fake-wan"
    assert body["seed"] == 7

    # 参考图 + 驱动视频都从源 worker 转运到实例
    assert fake.uploads == [(b"media-bytes", "in.png"), (b"media-bytes", "d.mp4")]
    graph = fake.graphs[0]
    assert graph["6"]["inputs"]["image"] == "wan-in.png"
    assert graph["10"]["inputs"]["video"] == "wan-d.mp4"
    assert graph["12"]["inputs"]["num_frames"] == 121
    assert graph["13"]["inputs"]["seed"] == 7

    with Session(engine) as s:
        job = s.exec(select(Job).where(Job.user_id == uid)).first()
        assert job is not None
        assert job.kind == "wan_animate"
        assert job.nsfw is False
        assert job.seed == 7
        assert job.worker == "http://fake-wan"


def test_animate_snaps_non_aligned_size(client, monkeypatch):
    """宽高非 16 对齐:向下取整进图(833→832),而非 422。"""
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "wasnap")
    fake = _FakeWanClient()
    _install_wan(monkeypatch, fake)
    _stub_wan_settings(monkeypatch)
    r = c.post(
        "/api/wan/animate",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "a", "image": "in.png", "video": "d.mp4",
              "worker": "http://fake-worker", "width": 833, "height": 485},
    )
    assert r.status_code == 200, r.text
    embeds = fake.graphs[0]["12"]["inputs"]
    assert embeds["width"] == 832 and embeds["height"] == 480


def test_animate_relight_lora_flag_flows_into_graph(client, monkeypatch):
    """relight_lora=true → 图内挂重打光 LoRA(Replacement 模式)。"""
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "warelight")
    fake = _FakeWanClient()
    _install_wan(monkeypatch, fake)
    _stub_wan_settings(monkeypatch)
    r = c.post(
        "/api/wan/animate",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "a", "image": "in.png", "video": "d.mp4",
              "worker": "http://fake-worker", "relight_lora": True},
    )
    assert r.status_code == 200, r.text
    graph = fake.graphs[0]
    assert graph["16"]["inputs"]["lora_0"] == DEFAULT_RELIGHT_LORA
    assert graph["1"]["inputs"]["lora"] == ["16", 0]


def test_animate_instance_unreachable_503(client, monkeypatch):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "wadown")
    _install_wan(monkeypatch, _FakeWanClient(reachable=False))
    _stub_wan_settings(monkeypatch)
    r = c.post(
        "/api/wan/animate",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "a", "image": "in.png", "video": "d.mp4",
              "worker": "http://fake-worker"},
    )
    assert r.status_code == 503
    assert "不可达" in r.json()["detail"]


def test_animate_missing_wanvideo_node_503(client, monkeypatch):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "wanonode")
    _install_wan(monkeypatch, _FakeWanClient(has_node=False))
    _stub_wan_settings(monkeypatch)
    r = c.post(
        "/api/wan/animate",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "a", "image": "in.png", "video": "d.mp4",
              "worker": "http://fake-worker"},
    )
    assert r.status_code == 503
    assert "WanVideoModelLoader" in r.json()["detail"]


def test_animate_requires_auth(client):
    c, _ = client
    r = c.post("/api/wan/animate", json={
        "positive": "a", "image": "in.png", "video": "d.mp4", "worker": "http://fake-worker",
    })
    assert r.status_code == 401


def test_animate_source_worker_read_failure_502(client, monkeypatch):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "wabadread")

    class _BrokenSource:
        base_url = "http://fake-worker"

        async def get_image_bytes(self, filename, subfolder, type_):
            raise ComfyUIError("no such file")

    _install_wan(monkeypatch, _FakeWanClient())
    monkeypatch.setattr(wan_route, "resolve_worker", lambda worker: _BrokenSource())
    r = c.post(
        "/api/wan/animate",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "a", "image": "in.png", "video": "d.mp4",
              "worker": "http://fake-worker"},
    )
    assert r.status_code == 502
    assert "读取失败" in r.json()["detail"]


def test_animate_marks_job_nsfw_with_x_nsfw_header(client, monkeypatch):
    """/nsfw 专区(X-NSFW: 1)提交 animate:Job 打 nsfw 标,主站作品库不可见。"""
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "wansfw")
    fake = _FakeWanClient()
    _install_wan(monkeypatch, fake)
    _stub_wan_settings(monkeypatch)
    r = c.post(
        "/api/wan/animate",
        headers={"Authorization": f"Bearer {create_token(uid)}", "X-NSFW": "1"},
        json={"positive": "a girl dancing", "image": "in.png", "video": "d.mp4",
              "worker": "http://fake-worker"},
    )
    assert r.status_code == 200, r.text
    with Session(engine) as s:
        job = s.exec(select(Job).where(Job.user_id == uid)).first()
        assert job is not None
        assert job.kind == "wan_animate" and job.nsfw is True


# --------------------------------------------------------------------------- #
# POST /api/wan/vace
# --------------------------------------------------------------------------- #


def test_vace_ok_transfers_refs_and_submits(client, monkeypatch):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "wvok")
    fake = _FakeWanClient()
    _install_wan(monkeypatch, fake)
    _stub_wan_settings(monkeypatch)
    r = c.post(
        "/api/wan/vace",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "三视图角色在街头", "worker": "http://fake-worker",
              "images": ["r1.png", "r2.png", "r3.png"],
              "start_image": "s.png", "end_image": "e.png",
              "num_frames": 81, "seed": 11},
    )
    assert r.status_code == 200, r.text
    assert r.json()["seed"] == 11

    # 3 参考图 + 首尾帧全部转运到实例
    names = [name for _, name in fake.uploads]
    assert names == ["r1.png", "r2.png", "r3.png", "s.png", "e.png"]
    graph = fake.graphs[0]
    assert graph["20"]["inputs"]["image"] == "wan-r1.png"
    assert graph["30"]["inputs"]["inputcount"] == 3
    assert graph["40"]["inputs"]["image"] == "wan-s.png"
    assert graph["42"]["inputs"]["image"] == "wan-e.png"
    assert graph["10"]["inputs"]["input_frames"] == ["44", 0]
    assert graph["13"]["inputs"]["seed"] == 11

    with Session(engine) as s:
        job = s.exec(select(Job).where(Job.user_id == uid)).first()
        assert job is not None
        assert job.kind == "wan_vace"
        assert job.nsfw is False


def test_vace_without_start_end_has_no_s2e_branch(client, monkeypatch):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "wvnos2e")
    fake = _FakeWanClient()
    _install_wan(monkeypatch, fake)
    _stub_wan_settings(monkeypatch)
    r = c.post(
        "/api/wan/vace",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "a", "images": ["r.png"], "worker": "http://fake-worker"},
    )
    assert r.status_code == 200, r.text
    graph = fake.graphs[0]
    assert "44" not in graph
    assert "input_frames" not in graph["10"]["inputs"]
    # 单参考图不 concat
    assert "30" not in graph
    assert [name for _, name in fake.uploads] == ["r.png"]


def test_vace_route_rejects_unknown_accel(client):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "wvaccelbad")
    r = c.post(
        "/api/wan/vace",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "a", "images": ["r.png"], "worker": "http://fake-worker",
              "accel": "turbo"},
    )
    assert r.status_code == 422


def test_vace_route_accel_passthrough(client, monkeypatch):
    """accel=magcache 透传到图(cache 节点+cache_args);缺省 off 零变化。"""
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "wvaccel")
    fake = _FakeWanClient()
    _install_wan(monkeypatch, fake)
    _stub_wan_settings(monkeypatch)
    r = c.post(
        "/api/wan/vace",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "a", "images": ["r.png"], "worker": "http://fake-worker",
              "accel": "magcache"},
    )
    assert r.status_code == 200, r.text
    graph = fake.graphs[0]
    assert graph["17"]["class_type"] == "WanVideoMagCache"
    assert graph["17"]["inputs"]["magcache_thresh"] == 0.06
    assert graph["13"]["inputs"]["cache_args"] == ["17", 0]

    r = c.post(
        "/api/wan/vace",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "a", "images": ["r.png"], "worker": "http://fake-worker"},
    )
    assert r.status_code == 200, r.text
    graph = fake.graphs[1]
    assert "17" not in graph
    assert "cache_args" not in graph["13"]["inputs"]


def test_vace_instance_unreachable_503(client, monkeypatch):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "wvdown")
    _install_wan(monkeypatch, _FakeWanClient(reachable=False))
    _stub_wan_settings(monkeypatch)
    r = c.post(
        "/api/wan/vace",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "a", "images": ["r.png"], "worker": "http://fake-worker"},
    )
    assert r.status_code == 503
    assert "不可达" in r.json()["detail"]


def test_vace_requires_auth(client):
    c, _ = client
    r = c.post("/api/wan/vace", json={
        "positive": "a", "images": ["r.png"], "worker": "http://fake-worker",
    })
    assert r.status_code == 401


# --------------------------------------------------------------------------- #
# 显存互斥预检(ensure_wan_vram):H3 突发占卡时 503 错峰,绝不驱逐 H3
# --------------------------------------------------------------------------- #


def _animate_payload() -> dict:
    return {"positive": "a", "image": "in.png", "video": "d.mp4",
            "worker": "http://fake-worker"}


def test_vram_enough_passes_without_evict(client, monkeypatch):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "wvram-ok")
    fake = _FakeWanClient(free_vram_gib=60.0)
    _install_wan(monkeypatch, fake)
    _stub_wan_settings(monkeypatch, threshold=26.0)
    r = c.post("/api/wan/animate",
               headers={"Authorization": f"Bearer {create_token(uid)}"},
               json=_animate_payload())
    assert r.status_code == 200, r.text
    assert fake.self_free_calls == 0  # 充足:不驱逐


def test_vram_low_evicts_self_cache_then_passes(client, monkeypatch):
    """空闲不足 + :8197 队列空闲 → 驱逐自身模型缓存(LongCat/Avatar 驻留)后复查放行。"""
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "wvram-evict")
    fake = _FakeWanClient(
        free_vram_gib=10.0, self_queue=0,
        on_self_free=lambda: setattr(fake, "free_gib", 40.0),
    )
    _install_wan(monkeypatch, fake)
    _stub_wan_settings(monkeypatch, threshold=26.0)
    r = c.post("/api/wan/animate",
               headers={"Authorization": f"Bearer {create_token(uid)}"},
               json=_animate_payload())
    assert r.status_code == 200, r.text
    assert fake.self_free_calls == 1


def test_vram_low_and_queue_busy_503(client, monkeypatch):
    monkeypatch.setattr(hold_queue, "holdable", lambda exc: False)  # 预检拦截单测:关 hold 保一期 503 语义(资源预算二期)
    """空闲不足 + 实例队列非空闲(或 H3 突发占卡):不驱逐,直接 503 错峰。"""
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "wvram-busy")
    fake = _FakeWanClient(free_vram_gib=10.0, self_queue=2)
    _install_wan(monkeypatch, fake)
    _stub_wan_settings(monkeypatch, threshold=26.0)
    r = c.post("/api/wan/animate",
               headers={"Authorization": f"Bearer {create_token(uid)}"},
               json=_animate_payload())
    assert r.status_code == 503
    assert "错峰" in r.json()["detail"]
    assert fake.self_free_calls == 0  # 队列忙:绝不驱逐
    assert fake.graphs == []  # 未提交


def test_vram_still_low_after_evict_503(client, monkeypatch):
    monkeypatch.setattr(hold_queue, "holdable", lambda exc: False)  # 预检拦截单测:关 hold 保一期 503 语义(资源预算二期)
    """驱逐自身缓存后仍不足(H3 在跑,突发 ~48GB)→ 503;绝不驱逐 H3。"""
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "wvram-still")
    fake = _FakeWanClient(
        free_vram_gib=10.0, self_queue=0,
        on_self_free=lambda: setattr(fake, "free_gib", 12.0),  # 驱逐收效甚微
    )
    _install_wan(monkeypatch, fake)
    _stub_wan_settings(monkeypatch, threshold=26.0)
    r = c.post("/api/wan/animate",
               headers={"Authorization": f"Bearer {create_token(uid)}"},
               json=_animate_payload())
    assert r.status_code == 503
    assert "错峰" in r.json()["detail"]
    assert fake.self_free_calls == 1
    assert fake.graphs == []


def test_vram_stats_failure_skips_precheck(client, monkeypatch):
    """/system_stats 读取失败:降级为不预检放行,由 ComfyUI 自身错误兜底。"""
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "wvram-statsfail")
    fake = _FakeWanClient(stats_fail=True)
    _install_wan(monkeypatch, fake)
    _stub_wan_settings(monkeypatch, threshold=26.0)
    r = c.post("/api/wan/animate",
               headers={"Authorization": f"Bearer {create_token(uid)}"},
               json=_animate_payload())
    assert r.status_code == 200, r.text


def test_vram_precheck_disabled_with_zero_threshold(client, monkeypatch):
    """TOIV_WAN_MIN_FREE_VRAM_GB=0:显式关闭预检,低显存也放行。"""
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "wvram-off")
    fake = _FakeWanClient(free_vram_gib=1.0)
    _install_wan(monkeypatch, fake)
    _stub_wan_settings(monkeypatch, threshold=0.0)
    r = c.post("/api/wan/animate",
               headers={"Authorization": f"Bearer {create_token(uid)}"},
               json=_animate_payload())
    assert r.status_code == 200, r.text
    assert fake.self_free_calls == 0


def test_vace_submission_also_vram_checked(client, monkeypatch):
    monkeypatch.setattr(hold_queue, "holdable", lambda exc: False)  # 预检拦截单测:关 hold 保一期 503 语义(资源预算二期)
    """VACE 端点同走显存互斥预检(与 animate 共卡同实例)。"""
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "wvram-vace")
    fake = _FakeWanClient(free_vram_gib=10.0, self_queue=1)
    _install_wan(monkeypatch, fake)
    _stub_wan_settings(monkeypatch, threshold=26.0)
    r = c.post("/api/wan/vace",
               headers={"Authorization": f"Bearer {create_token(uid)}"},
               json={"positive": "a", "images": ["r.png"], "worker": "http://fake-worker"})
    assert r.status_code == 503
    assert "错峰" in r.json()["detail"]


# --------------------------------------------------------------------------- #
# transfer_drive_video 服务单测(与 transfer_ref_image 同一机制)
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_transfer_drive_video_ok(monkeypatch):
    monkeypatch.setattr(wan_service, "ensure_audio_track", lambda c, f: _identity(c))
    fake = _FakeWanClient()
    source = _FakeSourceWorker(content=b"mp4-bytes")
    name = await wan_service.transfer_drive_video(fake, source, "drive.mp4")
    assert name == "wan-drive.mp4"
    assert fake.uploads == [(b"mp4-bytes", "drive.mp4")]


async def _identity(content):
    return content


@pytest.mark.asyncio
async def test_transfer_drive_video_read_failure_502(monkeypatch):
    monkeypatch.setattr(wan_service, "ensure_audio_track", lambda c, f: _identity(c))
    from fastapi import HTTPException

    class _BrokenSource:
        base_url = "http://fake-worker"

        async def get_image_bytes(self, filename, subfolder, type_):
            raise ComfyUIError("gone")

    with pytest.raises(HTTPException) as exc:
        await wan_service.transfer_drive_video(_FakeWanClient(), _BrokenSource(), "d.mp4")
    assert exc.value.status_code == 502
    assert "读取失败" in exc.value.detail


@pytest.mark.asyncio
async def test_transfer_drive_video_upload_failure_502(monkeypatch):
    monkeypatch.setattr(wan_service, "ensure_audio_track", lambda c, f: _identity(c))
    from fastapi import HTTPException

    class _BrokenUpload(_FakeWanClient):
        async def upload_image(self, content, filename):
            raise ComfyUIError("disk full")

    with pytest.raises(HTTPException) as exc:
        await wan_service.transfer_drive_video(
            _BrokenUpload(), _FakeSourceWorker(), "d.mp4")
    assert exc.value.status_code == 502
    assert "上传到实例失败" in exc.value.detail


# --------------------------------------------------------------------------- #
# ensure_audio_track:无音轨驱动视频补静音轨(VHS_LoadVideo 无音轨抛错,2026-08-13 冒烟实测)
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_ensure_audio_track_no_ffprobe_passthrough(monkeypatch):
    """ffprobe/ffmpeg 不可用 → 降级原样返回。"""
    monkeypatch.setattr(wan_service.shutil, "which", lambda c: None)
    assert await wan_service.ensure_audio_track(b"raw", "d.mp4") == b"raw"


@pytest.mark.asyncio
async def test_ensure_audio_track_ffmpeg_failure_passthrough(monkeypatch, tmp_path):
    """ffprobe 检测无音轨但 ffmpeg 补轨失败(坏数据) → 原样返回。"""
    monkeypatch.setattr(wan_service.shutil, "which", lambda c: "/usr/bin/x")
    monkeypatch.setattr(wan_service.tempfile, "mkdtemp", lambda prefix: str(tmp_path))
    assert await wan_service.ensure_audio_track(b"not-a-video", "d.mp4") == b"not-a-video"


@pytest.mark.skipif(
    __import__("shutil").which("ffmpeg") is None
    or __import__("shutil").which("ffprobe") is None,
    reason="需要真 ffmpeg/ffprobe",
)
@pytest.mark.asyncio
async def test_ensure_audio_track_real_video(tmp_path):
    """真机:无音轨视频补静音轨后可检出 audio 流;有音轨视频原样返回(bytes 不变)。"""
    import subprocess

    no_audio = tmp_path / "no_audio.mp4"
    subprocess.run(
        ["ffmpeg", "-y", "-f", "lavfi", "-i", "testsrc2=size=64x64:rate=8:duration=0.5",
         "-pix_fmt", "yuv420p", str(no_audio)],
        check=True, capture_output=True,
    )
    raw = no_audio.read_bytes()
    out = await wan_service.ensure_audio_track(raw, "no_audio.mp4")
    assert out != raw  # 补轨后内容变化
    fixed = tmp_path / "fixed.mp4"
    fixed.write_bytes(out)
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "a",
         "-show_entries", "stream=codec_type", "-of", "csv=p=0", str(fixed)],
        check=True, capture_output=True,
    )
    assert b"audio" in probe.stdout

    with_audio = tmp_path / "with_audio.mp4"
    subprocess.run(
        ["ffmpeg", "-y", "-f", "lavfi", "-i", "testsrc2=size=64x64:rate=8:duration=0.5",
         "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo", "-shortest",
         "-pix_fmt", "yuv420p", "-c:a", "aac", str(with_audio)],
        check=True, capture_output=True,
    )
    raw2 = with_audio.read_bytes()
    assert await wan_service.ensure_audio_track(raw2, "with_audio.mp4") == raw2


# --------------------------------------------------------------------------- #
# ensure_wan_vram 直接单测:无 CUDA 设备 → 放行(降级)
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_ensure_wan_vram_no_cuda_device_passes(monkeypatch):
    class _NoCuda(_FakeWanClient):
        async def get_system_stats(self):
            return {"devices": [{"name": "cpu", "type": "cpu"}]}

    _stub_wan_settings(monkeypatch, threshold=26.0)
    await wan_service.ensure_wan_vram(_NoCuda())  # 不抛异常即放行
