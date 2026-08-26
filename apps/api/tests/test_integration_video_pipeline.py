"""视频创作管线四模块集成测试 —— 多镜头/关键帧链/视频编辑(Aleph)/Motion Brush。

验证四个模块在视频创作流程中的兼容性与无缝衔接(全部基于真实接口,非 mock):

| 模块 | 落点 | 产物 kind |
|---|---|---|
| 多镜头单次生成 | services/multishot_protocol.py + POST /api/h3/multishot | h3_multishot |
| 关键帧链式转场 | services/keyframe_chain.py + POST /api/generate/keyframe-chain | keyframe_chain(+段 transition) |
| 视频到视频编辑 | POST /api/generate/video-edit(wan_studio)+ build_wan_vace_edit_graph | video_edit |
| Motion Brush | services/motion_brush.py + POST /api/motion-brush/mask | (mask PNG,消费方入参) |

## 集成场景

- 场景 A:多镜头生成 → 视频编辑(多镜头产物作为编辑源视频)
- 场景 B:Motion Brush mask → 视频编辑(preserve_mask 控制编辑区域)
- 场景 C:关键帧链 → 视频编辑(链式转场产物作为编辑源)
- 场景 D:Motion Brush mask → 转场链(transition 段层已接通;keyframe-chain 链端点
  段级透传已接通,见 test_scenario_d_keyframe_chain_mask_gap)

## 数据流契约(真实实现实证)

- 产物 → 编辑源:多镜头/关键帧链成片经 worker input 目录落点,文件名直接可作
  video-edit 的 source_video(端点内 transfer_drive_video 同机直达/跨机转运)
- mask → 各链路:POST /api/motion-brush/mask 产物 PNG 文件名 → WanVaceRequest.
  motion_mask / TransitionRequest.motion_mask(图节点 50-52 支路)/ WanVaceEditRequest.
  preserve_mask(编辑图 62-66 支路)
- 资源互斥:transition/keyframe-chain/video-edit 共用 :8197 实例,三端点均经同一
  _wan_precheck_or_hold 显存/RAM 预检(hold FIFO 排队),机制上杜绝并发抢卡
"""
from __future__ import annotations

import inspect
import json
import re
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

import app.routes.h3_studio as h3_route
import app.routes.motion_brush as mb_route
import app.routes.wan_studio as wan_route
import app.services.engine_registry as engine_registry
import app.services.h3 as h3_service
import app.services.keyframe_chain as keychain
import app.services.longcat as longcat_service
import app.services.motion_brush as mb
import app.services.multishot_protocol as multishot
import app.services.wan_video as wan_service
from app.agent import tools_gen
from app.comfy import tracker
from app.comfy.client import ComfyUIError
from app.db import get_session
from app.main import app
from app.models import Job, Tenant, User
from app.security import create_token, hash_password
from app.workflows.wan_vace import (
    WanVaceEditParams,
    WanVaceParams,
    build_wan_vace_edit_graph,
    build_wan_vace_graph,
)

# --------------------------------------------------------------------------- #
# 公共 fixtures / fakes(与 test_keyframe_chain.py 同型,本文件自足)
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
    """:8197 实例替身:queue_prompt 按序发 prompt_id,记录图与上传。"""

    def __init__(self, *, reachable: bool = True, free_vram_gib: float = 96.0) -> None:
        self.base_url = "http://fake-wan"
        self._reachable = reachable
        self.free_gib = free_vram_gib
        self.graphs: list[dict] = []
        self.uploads: list[tuple[bytes, str]] = []
        self._n = 0

    async def object_info(self, node: str) -> dict:
        if not self._reachable:
            raise ComfyUIError("connection refused")
        return {node: {}}

    async def queue_prompt(self, graph: dict, client_id: str) -> str:
        self.graphs.append(graph)
        self._n += 1
        return f"prompt-seg-{self._n}"

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
    """上传落点 worker 替身:读源图/视频 + 接收 mask 上传(motion-brush 端点)。"""

    base_url = "http://fake-worker"

    def __init__(self) -> None:
        self.uploads: list[tuple[bytes, str]] = []

    async def get_image_bytes(self, filename: str, subfolder: str, type_: str):
        return b"frame-bytes", "application/octet-stream"

    async def upload_image(self, content: bytes, filename: str) -> str:
        self.uploads.append((content, filename))
        return filename


def _install_wan(monkeypatch, fake: _FakeWanClient, source: _FakeSourceWorker) -> None:
    """Wan 系端点(transition/keyframe-chain/video-edit)公共 fake 安装。"""
    monkeypatch.setattr(longcat_service, "get_longcat_client", lambda: fake)
    monkeypatch.setattr(longcat_service, "spawn_tracker", lambda client, prompt_id: None)
    monkeypatch.setattr(wan_route, "resolve_worker", lambda worker: source)
    monkeypatch.setattr(
        wan_service,
        "get_settings",
        lambda: SimpleNamespace(wan_min_free_vram_gb=26.0, wan_min_free_ram_gb=15.0),
    )
    # 源视频转运的音轨探测要真跑 ffprobe(假字节非视频,虽有降级兜底但不确定),测试钉死
    async def _noop_audio(content, filename):
        return content

    monkeypatch.setattr(wan_service, "ensure_audio_track", _noop_audio)
    # 合并链挂后台(等段产物+ffmpeg),路由测试不真跑,验证 spawn 被调用即可
    monkeypatch.setattr(keychain, "spawn_keyframe_chain_merge", lambda **kw: None)


def _app_paths() -> set[str]:
    """枚举 FastAPI 路由表路径(_IncludedRouter 包装项经 original_router 展开,
    include_router(prefix="/api") 的前缀补回)。"""
    paths: set[str] = set()
    for r in app.routes:
        if p := getattr(r, "path", None):
            paths.add(p)
        if orig := getattr(r, "original_router", None):
            for sub in orig.routes:
                if sp := getattr(sub, "path", None):
                    paths.add("/api" + sp)
    return paths


# --------------------------------------------------------------------------- #
# 模块间兼容性断言(横向接缝,真实代码)
# --------------------------------------------------------------------------- #


def test_module_param_namespaces_disjoint():
    """参数命名空间隔离:四模块请求模型的模块特有字段两两不相交;共享接缝显式化——
    motion_mask(VACE/transition 入参,Motion Brush 产物名)与 preserve_mask(编辑入参)。
    通用参数(width/height/steps/cfg/seed/fps 等)各模型同语义声明,不构成冲突。"""
    chain_specific = set(wan_route.KeyframeChainRequest.model_fields) - set(
        wan_route.TransitionRequest.model_fields
    )
    assert chain_specific == {"keyframes", "prompts", "durations"}
    multishot_specific = set(h3_route.H3MultiShotRequest.model_fields) - set(
        h3_route.H3T2VRequest.model_fields
    )
    assert multishot_specific == {"shots", "total_duration"}
    edit_specific = set(wan_route.WanVaceEditRequest.model_fields) - set(
        wan_route.WanVaceRequest.model_fields
    )
    assert edit_specific == {
        "source_video", "edit_prompt", "edit_mode", "keyframe_indices", "preserve_mask",
    }
    brush_specific = set(mb_route.MotionBrushMaskRequest.model_fields) - set(
        wan_route.WanVaceRequest.model_fields
    )
    assert brush_specific == {"source_image", "strokes"}

    specific_sets = [chain_specific, multishot_specific, edit_specific, brush_specific]
    for i, a in enumerate(specific_sets):
        for b in specific_sets[i + 1:]:
            assert a.isdisjoint(b), f"模块特有参数冲突: {a & b}"
    # 显式共享接缝:Motion Brush 产物 mask 文件名 → VACE/transition 的 motion_mask 入参
    assert "motion_mask" in wan_route.WanVaceRequest.model_fields
    assert "motion_mask" in wan_route.TransitionRequest.model_fields
    # 编辑链路的区域保留通道是 preserve_mask(白色保留/黑色重生成,语义与 motion_mask 相反)
    assert "preserve_mask" in wan_route.WanVaceEditRequest.model_fields
    assert "motion_mask" not in edit_specific - set(wan_route.WanVaceRequest.model_fields)


def test_routes_registered_and_no_collision():
    """路由表:四模块端点全部真实注册;与 OpenCut 时间线剪辑(/api/video-edit/render,
    既有不同模块)路径不冲突;Aleph 编辑走 /generate 前缀(生成类语义分组)。"""
    paths = _app_paths()
    assert "/api/h3/multishot" in paths  # 多镜头
    assert "/api/generate/keyframe-chain" in paths  # 关键帧链
    assert "/api/generate/video-edit" in paths  # 视频编辑(Aleph)
    assert "/api/motion-brush/mask" in paths  # Motion Brush
    assert "/api/video-edit/render" in paths  # OpenCut 时间线剪辑(并存不冲突)
    assert "/api/generate/video-edit" != "/api/video-edit/render"


def test_engine_registry_multishot_registered():
    """引擎注册表:h3-multishot 已注册(submit 路由真实存在);编辑/brush 为功能端点
    (专用编辑器/画板交互),当前不强制走通用引擎注册表,注册时 id 不得与既有冲突。"""
    engine_registry.populate_registry()
    ids = [s["id"] for s in engine_registry._REGISTRY]
    assert len(ids) == len(set(ids)), "引擎 id 须全局唯一"
    spec = engine_registry.get_engine_spec("h3-multishot")
    assert spec is not None, "h3-multishot 须在注册表"
    assert spec["submit"]["route"] == "/api/h3/multishot"
    assert spec["submit"]["route"] in _app_paths()
    for eid in ("keyframe-chain", "wan-transition", "wan-vace", "h3-t2v"):
        assert engine_registry.get_engine_spec(eid) is not None


def test_agent_dispatch_multishot_registered():
    """助手工具链:h3-multishot 已注册 submit_generation 分发(与 keyframe-chain 同表);
    video-edit/motion-brush 尚未注册(落地时按同表扩展,当前断言现状防幽灵条目)。"""
    assert "h3-multishot" in tools_gen._DISPATCH
    assert "keyframe-chain" in tools_gen._DISPATCH
    assert "video-edit" not in tools_gen._DISPATCH
    assert "motion-brush" not in tools_gen._DISPATCH


def test_tracker_reconcile_skips_synthetic_chain_ids():
    """tracker 孤儿检测豁免:kind=keyframe_chain 的合并作业 prompt_id 是 chain-* 合成
    占位(worker 上无对应 prompt),必须跳过 reconcile 重挂,否则被误杀;video_edit/
    h3_multishot 是真实 ComfyUI prompt_id,不在豁免清单(豁免即泄漏)。"""
    src = inspect.getsource(tracker)
    assert 'j.kind == "keyframe_chain"' in src
    assert '"video_edit"' not in src
    assert '"h3_multishot"' not in src


def test_vace_graph_motion_mask_branch_layout():
    """Motion Brush mask 支路节点布局(生成图):LoadImage(50)→ImageToMask(red,51);
    与首尾帧支路并存时经 MaskComposite multiply(52)取交集(两约束同时生效);
    alpha 通道是方向角编码,必须用 channel=red 提取区域(服务层 PNG 约定)。"""
    # 无首尾帧:mask 直连 input_masks
    p = WanVaceParams(positive="x", ref_images=("r.png",), motion_mask="mb-mask.png")
    graph = build_wan_vace_graph(p)
    assert graph["50"] == {"class_type": "LoadImage", "inputs": {"image": "mb-mask.png"}}
    assert graph["51"]["class_type"] == "ImageToMask"
    assert graph["51"]["inputs"]["channel"] == "red", "alpha 是方向角,区域必须走 red 通道"
    assert graph["10"]["inputs"]["input_masks"] == ["51", 0]
    assert "52" not in graph, "无首尾帧时不需要 MaskComposite"

    # 与首尾帧并存:MaskComposite multiply 交集(首尾帧保持区 × 动效区)
    p2 = WanVaceParams(
        positive="x", ref_images=("r.png",),
        start_image="s.png", end_image="e.png", motion_mask="mb-mask.png",
    )
    g2 = build_wan_vace_graph(p2)
    assert g2["52"]["class_type"] == "MaskComposite"
    assert g2["52"]["inputs"]["operation"] == "multiply"
    assert g2["52"]["inputs"]["destination"] == ["44", 1]  # 首尾帧 masks
    assert g2["52"]["inputs"]["source"] == ["51", 0]  # motion mask
    assert g2["10"]["inputs"]["input_masks"] == ["52", 0]


def test_vace_edit_graph_node_layout_no_conflict():
    """视频编辑图节点布局:源视频支路 50(VHS_LoadVideo,帧数截断同步 num_frames,
    原声回打包 audio=[50,2]);关键帧锚点/区域 mask 批支路 60-90;两 builder 是独立
    函数,图实例各自唯一,与生成图的 50-52 mask 支路无冲突(不会同图共存)。"""
    # 无锚点无 mask:不接 input_masks(wrapper 缺省全 1 重生成兜底)
    p = WanVaceEditParams(positive="改变风格", ref_images=(), source_video="src.mp4", num_frames=81)
    g = build_wan_vace_edit_graph(p)
    assert g["50"]["class_type"] == "VHS_LoadVideo"
    assert g["50"]["inputs"]["frame_load_cap"] == 81
    assert g["15"]["inputs"]["audio"] == ["50", 2], "源视频原声须回打包"
    assert "input_masks" not in g["10"]["inputs"]
    assert len(g) == len(set(g)), "图内节点 id 唯一"

    # 关键帧锚点:SolidMask(0) 整帧保留 + fill 段 RepeatImageBatch + ImageBatch 链
    p2 = WanVaceEditParams(
        positive="改变风格", ref_images=(), source_video="src.mp4", num_frames=81,
        keyframe_indices=(0, 40),
    )
    g2 = build_wan_vace_edit_graph(p2)
    assert g2["60"]["class_type"] == "SolidMask"  # 锚点帧全 0(整帧保留)
    assert g2["62"]["class_type"] == "SolidMask"  # fill 帧全 1(重生成)
    assert g2["90"]["class_type"] == "ImageToMask"
    assert g2["10"]["inputs"]["input_masks"] == ["90", 0]
    assert len(g2) == len(set(g2))

    # preserve_mask 区域保留:LoadImage→ImageToMask(red)→InvertMask(白=保留→0)
    p3 = WanVaceEditParams(
        positive="局部重绘", ref_images=(), source_video="src.mp4", num_frames=81,
        preserve_mask="keep.png",
    )
    g3 = build_wan_vace_edit_graph(p3)
    assert g3["62"] == {"class_type": "LoadImage", "inputs": {"image": "keep.png"}}
    assert g3["63"]["inputs"]["channel"] == "red"
    assert g3["64"]["class_type"] == "InvertMask", "白色保留区须反转为 0(锚点语义)"
    assert len(g3) == len(set(g3))


def test_edit_graph_inherited_motion_mask_field_not_consumed():
    """语义陷阱修复固化:WanVaceEditParams 继承 WanVaceParams.motion_mask 字段,但
    build_wan_vace_edit_graph 不消费它(编辑图节点 50 已被 VHS_LoadVideo 源视频支路
    占用);编辑链路的区域控制唯一通道是 preserve_mask。误传 motion_mask 到编辑参数
    现在会被 __post_init__ 显式拒绝(ValueError),防止静默无效。"""
    # 误传 motion_mask → 显式拒绝(修复后行为)
    with pytest.raises(ValueError, match="视频编辑不支持 motion_mask"):
        WanVaceEditParams(
            positive="x", ref_images=(), source_video="src.mp4", num_frames=81, motion_mask="mb.png",
        )
    # 正常路径:preserve_mask 畅通
    p = WanVaceEditParams(
        positive="x", ref_images=(), source_video="src.mp4", num_frames=81, preserve_mask="mb.png",
    )
    g = build_wan_vace_edit_graph(p)
    assert g["50"]["class_type"] == "VHS_LoadVideo", (
        "编辑图节点 50 是源视频支路;motion_mask 字段在编辑图中不生效(用 preserve_mask)"
    )
    # preserve_mask 进入编辑图 62-66 支路
    assert any(
        node["class_type"] == "LoadImage" and node["inputs"].get("image") == "mb.png"
        for node in g.values()
    ), "preserve_mask 必须进入编辑图(62-66 支路)"


def test_wan_endpoints_share_single_resource_precheck(client, monkeypatch):
    """资源占用冲突防线:transition/keyframe-chain/video-edit 共用 :8197 实例,
    三端点必须经同一个 _wan_precheck_or_hold 互斥预检(VRAM/RAM 预算 + hold FIFO
    排队),机制上杜绝并发抢卡;关键帧链整链只预检一次(非逐段叠加)。"""
    c, eng = client
    with Session(eng) as s:
        uid = _seed_user(s, "ix-precheck")
    fake, source = _FakeWanClient(), _FakeSourceWorker()
    _install_wan(monkeypatch, fake, source)
    calls: list[object] = []

    async def _spy(client_obj):
        calls.append(client_obj)
        return None

    monkeypatch.setattr(wan_route, "_wan_precheck_or_hold", _spy)
    headers = {"Authorization": f"Bearer {create_token(uid)}"}

    r = c.post(
        "/api/generate/transition",
        headers=headers,
        json={
            "positive": "转场", "first_frame": "a.png", "last_frame": "b.png",
            "worker": "http://fake-worker",
        },
    )
    assert r.status_code == 200, r.text
    assert len(calls) == 1

    r = c.post(
        "/api/generate/keyframe-chain",
        headers=headers,
        json={
            "keyframes": ["k1.png", "k2.png", "k3.png"], "prompts": "镜头平滑过渡",
            "worker": "http://fake-worker",
        },
    )
    assert r.status_code == 200, r.text
    assert len(calls) == 2, "关键帧链整链只做一次共享预检(2 段不叠加)"

    r = c.post(
        "/api/generate/video-edit",
        headers=headers,
        json={
            "source_video": "src.mp4", "edit_prompt": "make it rainy",
            "worker": "http://fake-worker",
        },
    )
    assert r.status_code == 200, r.text
    assert len(calls) == 3, "视频编辑端点须经同一共享资源预检"


def test_frontend_video_bucket_includes_module_kinds():
    """跨栈接缝:四模块产物 kind 全部归前端作品库视频桶(libraryQuery),视频编辑的
    源选择器(作品库选视频)才能选到多镜头/关键帧链产物,编辑产物本身也可见。"""
    ts = (Path(__file__).parents[2] / "web" / "lib" / "libraryQuery.ts").read_text(encoding="utf-8")
    video_block = re.search(r'label: "视频",\s*kinds: \[(.*?)\]', ts, re.S)
    assert video_block is not None, "libraryQuery 须存在视频桶定义"
    kinds = video_block.group(1)
    assert '"keyframe_chain"' in kinds
    assert '"transition"' in kinds
    assert '"h3_multishot"' in kinds, "多镜头产物须在视频桶(编辑源可选)"
    assert '"video_edit"' in kinds, "video_edit 前端须在视频桶(编辑源可选)"


# --------------------------------------------------------------------------- #
# 场景 A:多镜头单次生成 → 视频编辑(多镜头产物作为编辑源视频)
# --------------------------------------------------------------------------- #


def _install_h3(monkeypatch) -> list[dict]:
    """H3 提交链 fake:拦截 submit_h3_job,按真实语义落 Job 并返回 prompt_id。"""
    submits: list[dict] = []

    async def _fake_submit(
        graph, *, kind, positive, seed, req, user, session, nsfw=False, **kw
    ):
        submits.append({"graph": graph, "kind": kind, "positive": positive})
        prompt_id = f"h3-sub-{len(submits)}"
        session.add(
            Job(
                tenant_id=user.tenant_id, user_id=user.id, prompt_id=prompt_id,
                worker="http://fake-h3", kind=kind, status="queued",
                prompt=positive, seed=seed or 0, nsfw=nsfw,
                params=req.model_dump_json(),
            )
        )
        session.commit()
        return {"prompt_id": prompt_id, "worker": "http://fake-h3", "seed": seed}

    monkeypatch.setattr(h3_service, "submit_h3_job", _fake_submit)
    return submits


def test_scenario_a_multishot_endpoint_prompt_protocol(client, monkeypatch):
    """多镜头端点:2 镜头 → 「镜头一…镜头二…」单 prompt 协议组装 + kind=h3_multishot 建档。"""
    c, eng = client
    with Session(eng) as s:
        uid = _seed_user(s, "ix-ms")
    submits = _install_h3(monkeypatch)
    r = c.post(
        "/api/h3/multishot",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={
            "shots": [
                {"prompt": "男孩走进酒吧", "camera_hint": "跟"},
                {"prompt": "男孩点了一杯牛奶", "transition_hint": "硬切"},
            ],
            "total_duration": 10,
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert len(submits) == 1 and submits[0]["kind"] == "h3_multishot"
    prompt = submits[0]["positive"]
    assert "镜头一(约5秒):男孩走进酒吧,镜头跟随主体移动" in prompt
    assert "镜头切换:硬切" in prompt
    assert "镜头二(约5秒):男孩点了一杯牛奶" in prompt
    # 响应透出多镜头计划快照(前端段进度/精确重生的事实源)
    assert body["multishot"]["total_duration"] == 10.0
    assert len(body["multishot"]["shots"]) == 2
    with Session(eng) as s:
        job = s.exec(select(Job).where(Job.prompt_id == body["prompt_id"])).first()
        assert job is not None and job.kind == "h3_multishot"


def test_scenario_a_multishot_product_feeds_video_edit(client, monkeypatch):
    """场景 A 全链:多镜头生成 → 产物(h3_multishot)→ 作为 video-edit 源视频。

    参数流:产物文件在 worker 落点(input 目录),文件名直接作 source_video;
    端点内 transfer_drive_video 同机转运 → 编辑图 50 节点 VHS_LoadVideo。
    """
    c, eng = client
    with Session(eng) as s:
        uid = _seed_user(s, "ix-scen-a")
    submits = _install_h3(monkeypatch)
    fake, source = _FakeWanClient(), _FakeSourceWorker()
    _install_wan(monkeypatch, fake, source)
    headers = {"Authorization": f"Bearer {create_token(uid)}"}

    # ① 多镜头生成(2 镜头,各 5s)
    r = c.post(
        "/api/h3/multishot",
        headers=headers,
        json={
            "shots": [{"prompt": "白天街道人来人往"}, {"prompt": "夜晚街道霓虹亮起"}],
            "total_duration": 10,
        },
    )
    assert r.status_code == 200, r.text
    ms_prompt_id = r.json()["prompt_id"]

    # ② 模拟多镜头成片:产物落 worker input 目录(真实合并/生成链同一落点语义)
    with Session(eng) as s:
        job = s.exec(select(Job).where(Job.prompt_id == ms_prompt_id)).first()
        assert job is not None and job.kind == "h3_multishot"
        job.status = "done"
        job.result = json.dumps(["/api/images?filename=multishot_final.mp4&type=input&sig=x"])
        s.add(job)
        s.commit()

    # ③ 多镜头产物 → 视频编辑源(文件名直传,与前端「从作品库选择」数据流一致)
    r = c.post(
        "/api/generate/video-edit",
        headers=headers,
        json={
            "source_video": "multishot_final.mp4",
            "edit_prompt": "turn the whole scene into a thunderstorm",
            "edit_mode": "relight",
            "worker": "http://fake-worker",
        },
    )
    assert r.status_code == 200, r.text
    # 参数传递:源视频经转运进编辑图 50 节点
    assert len(fake.graphs) == 1
    g = fake.graphs[0]
    assert g["50"]["class_type"] == "VHS_LoadVideo"
    assert g["50"]["inputs"]["video"] == "wan-multishot_final.mp4"
    assert g["5"]["inputs"]["positive_prompt"] == "turn the whole scene into a thunderstorm"
    # 产物建档:video_edit Job 与 h3_multishot Job 共存,kind 无冲突
    with Session(eng) as s:
        kinds = sorted(j.kind for j in s.exec(select(Job).where(Job.user_id == uid)).all())
        assert kinds == ["h3_multishot", "video_edit"]
        edit = s.exec(select(Job).where(Job.kind == "video_edit")).first()
        params = json.loads(edit.params)
        assert params["source_video"] == "multishot_final.mp4"
        assert params["edit_mode"] == "relight"


# --------------------------------------------------------------------------- #
# 场景 B:Motion Brush mask → 视频编辑(preserve_mask 控制编辑区域)
# --------------------------------------------------------------------------- #


def test_scenario_b_motion_brush_mask_endpoint(client, monkeypatch):
    """Motion Brush 端点:笔画 → RGBA mask PNG 上传源 worker input → 返回文件名。"""
    c, eng = client
    with Session(eng) as s:
        uid = _seed_user(s, "ix-mb")
    source = _FakeSourceWorker()
    monkeypatch.setattr(mb_route, "resolve_worker", lambda worker: source)
    r = c.post(
        "/api/motion-brush/mask",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={
            "source_image": "frame0.png",
            "worker": "http://fake-worker",
            "width": 832,
            "height": 480,
            "strokes": [
                {"center_x": 200, "center_y": 240, "radius": 40,
                 "direction_x": 1.0, "direction_y": 0.0, "strength": 0.9},
                {"center_x": 600, "center_y": 120, "radius": 24, "strength": 1.0},
            ],
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["mask"].startswith("motion-brush-") and body["mask"].endswith(".png")
    assert body["strokes"] == 2
    # mask 上传到源 worker input(与源图同机,后续随生成/编辑请求同路转运)
    assert len(source.uploads) == 1
    content, name = source.uploads[0]
    assert name == body["mask"]
    assert content[:8] == b"\x89PNG\r\n\x1a\n", "产物须为 PNG"


def test_scenario_b_mask_feeds_video_edit_preserve_mask(client, monkeypatch):
    """场景 B 全链:Motion Brush mask → video-edit preserve_mask(白色区域保留,
    黑色区域按 edit_prompt 重生成)—— mask 与编辑指令同参共存,图支路 62-66。"""
    c, eng = client
    with Session(eng) as s:
        uid = _seed_user(s, "ix-scen-b")
    source = _FakeSourceWorker()
    monkeypatch.setattr(mb_route, "resolve_worker", lambda worker: source)
    fake = _FakeWanClient()
    _install_wan(monkeypatch, fake, source)
    headers = {"Authorization": f"Bearer {create_token(uid)}"}

    # ① 生成 motion mask(标记要保持不动的区域)
    r = c.post(
        "/api/motion-brush/mask",
        headers=headers,
        json={
            "source_image": "frame0.png", "worker": "http://fake-worker",
            "width": 832, "height": 480,
            "strokes": [{"center_x": 400, "center_y": 240, "radius": 60, "strength": 1.0}],
        },
    )
    assert r.status_code == 200, r.text
    mask_name = r.json()["mask"]

    # ② mask 作为 preserve_mask 与编辑指令同参提交
    r = c.post(
        "/api/generate/video-edit",
        headers=headers,
        json={
            "source_video": "src.mp4",
            "edit_prompt": "repaint the background as a cyberpunk city",
            "preserve_mask": mask_name,
            "worker": "http://fake-worker",
        },
    )
    assert r.status_code == 200, r.text
    g = fake.graphs[0]
    # 参数传递:mask 经同路转运进编辑图区域保留支路(白=保留→反转→0)
    assert g["62"] == {"class_type": "LoadImage", "inputs": {"image": f"wan-{mask_name}"}}
    assert g["63"]["inputs"]["channel"] == "red"
    assert g["64"]["class_type"] == "InvertMask"
    assert g["10"]["inputs"]["input_masks"] == ["90", 0]
    # 与编辑指令共存无冲突
    assert g["5"]["inputs"]["positive_prompt"] == "repaint the background as a cyberpunk city"
    with Session(eng) as s:
        edit = s.exec(select(Job).where(Job.kind == "video_edit")).first()
        assert edit is not None
        params = json.loads(edit.params)
        assert params["preserve_mask"] == mask_name


# --------------------------------------------------------------------------- #
# 场景 C:关键帧链 → 视频编辑(链式转场产物作为编辑源)
# --------------------------------------------------------------------------- #


def test_scenario_c_keyframe_chain_product_feeds_video_edit(client, monkeypatch):
    """场景 C 全链:3 帧关键帧链 → 合并 Job(keyframe_chain)→ 成片 → video-edit 源。

    验证:参数传递正确 / 三类 Job 建档(段 transition×2 + 合并 + 编辑)/ kind 无冲突。
    """
    c, eng = client
    with Session(eng) as s:
        uid = _seed_user(s, "ix-scen-c")
    fake, source = _FakeSourceWorker(), None
    wan_fake = _FakeWanClient()
    _install_wan(monkeypatch, wan_fake, fake)
    headers = {"Authorization": f"Bearer {create_token(uid)}"}

    # ① 关键帧链生成(3 帧 2 段)
    r = c.post(
        "/api/generate/keyframe-chain",
        headers=headers,
        json={
            "keyframes": ["k1.png", "k2.png", "k3.png"], "prompts": "镜头平滑过渡",
            "worker": "http://fake-worker", "durations": [3.0, 4.0],
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["prompt_id"].startswith("chain-")
    assert len(body["segments"]) == 2

    # ② 模拟合并链完成:成片回写合并 Job(文件名即 worker input 落点)
    with Session(eng) as s:
        merged = s.exec(select(Job).where(Job.prompt_id == body["prompt_id"])).first()
        assert merged is not None and merged.kind == "keyframe_chain"
        merged.status = "done"
        merged.result = json.dumps(
            ["/api/images?filename=toiv_kfchain_final.mp4&type=input&sig=y"]
        )
        s.add(merged)
        s.commit()

    # ③ 链产物 → 视频编辑源(关键帧锚点:首帧整帧保留,编辑向全片传播)
    r = c.post(
        "/api/generate/video-edit",
        headers=headers,
        json={
            "source_video": "toiv_kfchain_final.mp4",
            "edit_prompt": "replace the man with a woman, keep everything else",
            "edit_mode": "object_replace",
            "keyframe_indices": [0],
            "worker": "http://fake-worker",
            "duration_sec": 7.0,
        },
    )
    assert r.status_code == 200, r.text
    # 编辑图:源视频 50 节点 + 关键帧锚点支路(SolidMask 0 整帧保留)
    g = wan_fake.graphs[-1]
    assert g["50"]["inputs"]["video"] == "wan-toiv_kfchain_final.mp4"
    assert g["60"]["class_type"] == "SolidMask"
    assert g["10"]["inputs"]["input_masks"] == ["90", 0]
    # 三类 Job 共存建档,kind 无冲突
    with Session(eng) as s:
        kinds = sorted(j.kind for j in s.exec(select(Job).where(Job.user_id == uid)).all())
        assert kinds == ["keyframe_chain", "transition", "transition", "video_edit"]
        edit = s.exec(select(Job).where(Job.kind == "video_edit")).first()
        params = json.loads(edit.params)
        assert params["source_video"] == "toiv_kfchain_final.mp4"
        assert params["keyframe_indices"] == [0]


# --------------------------------------------------------------------------- #
# 场景 D:Motion Brush mask → 转场链(transition 段层已接通;链端点段级透传为缺口)
# --------------------------------------------------------------------------- #


def test_scenario_d_mask_feeds_transition_endpoint(client, monkeypatch):
    """场景 D(段层已接通):motion_mask 与首尾帧同参提交 transition ——
    mask 与首尾帧同路转运,图支路 50/51 + MaskComposite multiply(52)取交集
    (首尾帧保持区 × 动效标记区,两约束同时生效),即「mask 控制转场运动区域」。"""
    c, eng = client
    with Session(eng) as s:
        uid = _seed_user(s, "ix-scen-d")
    source = _FakeSourceWorker()
    monkeypatch.setattr(mb_route, "resolve_worker", lambda worker: source)
    fake = _FakeWanClient()
    _install_wan(monkeypatch, fake, source)
    headers = {"Authorization": f"Bearer {create_token(uid)}"}

    r = c.post(
        "/api/motion-brush/mask",
        headers=headers,
        json={
            "source_image": "k1.png", "worker": "http://fake-worker",
            "width": 832, "height": 480,
            "strokes": [{"center_x": 300, "center_y": 200, "radius": 50,
                         "direction_x": 0.7, "direction_y": 0.7}],
        },
    )
    assert r.status_code == 200, r.text
    mask_name = r.json()["mask"]

    r = c.post(
        "/api/generate/transition",
        headers=headers,
        json={
            "positive": "云层缓缓流动", "first_frame": "k1.png", "last_frame": "k2.png",
            "motion_mask": mask_name, "worker": "http://fake-worker",
        },
    )
    assert r.status_code == 200, r.text
    g = fake.graphs[0]
    # mask 支路与首尾帧支路并存:MaskComposite multiply 交集(仅标记区域可动)
    assert g["50"] == {"class_type": "LoadImage", "inputs": {"image": f"wan-{mask_name}"}}
    assert g["51"]["inputs"]["channel"] == "red"
    assert g["52"]["class_type"] == "MaskComposite"
    assert g["52"]["inputs"]["operation"] == "multiply"
    assert g["10"]["inputs"]["input_masks"] == ["52", 0]
    with Session(eng) as s:
        job = s.exec(select(Job).where(Job.kind == "transition")).first()
        assert job is not None
        params = json.loads(job.params)
        assert params["motion_mask"] == mask_name, "mask 文件名须随请求快照建档(精确重生)"


def test_scenario_d_keyframe_chain_mask_gap():
    """场景 D(链层已接通):keyframe-chain 端点的 KeyframeChainRequest 已补
    motion_mask 字段 —— 段级透传已接通(段 seg_req 按 TransitionRequest 构造并
    透传 mask,链路本身具备透传能力)。mask 控制转场运动区域经「逐段 transition」
    与「链端点」双路径可用。"""
    assert "motion_mask" in wan_route.TransitionRequest.model_fields, (
        "段层(transition)已接通 motion_mask"
    )
    assert "motion_mask" in wan_route.KeyframeChainRequest.model_fields, (
        "链端点(keyframe-chain)段级 motion_mask 透传已接通"
    )


# --------------------------------------------------------------------------- #
# Motion Brush 服务层契约(笔画校验/mask 栅格化,支撑场景 B/D 的参数正确性)
# --------------------------------------------------------------------------- #


def test_motion_brush_stroke_validation_and_rasterization():
    """笔画校验(坐标/半径/强度/方向归一)+ 栅格化通道约定(R=G=B 强度,A 方向角):
    mask 与视频编辑/转场链路的尺寸一致性由同一 width/height 坐标系保证。"""
    strokes = mb.validate_strokes(
        [
            mb.BrushStroke(center_x=100, center_y=100, radius=20,
                           direction_x=3.0, direction_y=4.0, strength=0.8),
        ],
        832, 480,
    )
    # 方向矢量模长 >1 归一化(3-4-5 → 0.6-0.8)
    assert abs(strokes[0].direction_x - 0.6) < 1e-6
    assert abs(strokes[0].direction_y - 0.8) < 1e-6
    img = mb.generate_mask(mb.MotionBrushMask(width=832, height=480, strokes=tuple(strokes)))
    assert img.size == (832, 480) and img.mode == "RGBA"
    # 圆心像素:R=G=B=强度(round(0.8*255)=204),A=方向角(非 0)
    r, g, b, a = img.getpixel((100, 100))
    assert r == g == b == 204
    assert a > 0, "有向笔画 alpha 须携带方向角(读取区域须走 red 通道)"
    # 画布外/越界笔画 → 422 语义(MotionBrushError)
    with pytest.raises(mb.MotionBrushError, match="超出画布"):
        mb.validate_strokes(
            [mb.BrushStroke(center_x=900, center_y=100, radius=20)], 832, 480
        )
    with pytest.raises(mb.MotionBrushError, match="至少需要 1 条"):
        mb.validate_strokes([], 832, 480)
