"""LongCat-Avatar 数字人工作室 —— 图构建 / 参数校验 / 端点提交链路 测试。

覆盖:
  · 图构建器:节点类型与连线(照搬 longcat_avatar_smoke.py v1.5 链路)、
    whisper-large-v3 音频编码节点、MelBandRoFormer 人声分离、GGUF Q8_0 底模、
    BlockSwap=25、scheduler=longcat_distill_euler、fps=25、图片/音频名注入、
    两次构建互不影响、seed 缺省随机
  · 请求校验:num_frames 越界 422;宽高超界 422;非 16 对齐自动向下取整;
    image/audio 路径穿越 422
  · POST /api/avatar/talk:成功提交(图片+音频转运到实例、Job kind=avatar_talk、
    seed 落快照);未鉴权 401;实例不可达 503
  · R18 打标:X-NSFW 头 → Job.nsfw=True;无头恒 False;未成年硬阻断(带头也 False)

全部 mock worker(LongCat 实例与上传落点 pool worker 均为替身),不提交真实作业。
"""
from __future__ import annotations

from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

import app.services.longcat as longcat_service
import app.routes.avatar_studio as avatar_route
from app.comfy.client import ComfyUIError
from app.db import get_session
from app.main import app
from app.models import Job, Tenant, User
from app.security import create_token, hash_password
from app.workflows.longcat_avatar import (
    DEFAULT_DMD_LORA,
    DEFAULT_MODEL,
    DEFAULT_NEGATIVE,
    DEFAULT_T5,
    DEFAULT_VAE,
    DEFAULT_VOCAL_SEP,
    DEFAULT_WHISPER,
    LongCatAvatarParams,
    build_longcat_avatar_graph,
)


# --------------------------------------------------------------------------- #
# 公共 fixtures / fakes
# --------------------------------------------------------------------------- #


def _seed_user(session: Session, email: str, *, birthdate: date | None = None) -> str:
    tenant = Tenant(name=email)
    session.add(tenant)
    session.commit()
    session.refresh(tenant)
    user = User(
        email=email,
        hashed_password=hash_password("password1"),
        tenant_id=tenant.id,
        birthdate=birthdate,
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
    """LongCat 实例替身:object_info/queue_prompt/upload_image 可控,不联网。"""

    def __init__(self, *, reachable: bool = True, has_node: bool = True) -> None:
        self.base_url = "http://fake-longcat"
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
        return "prompt-avatar-1"

    async def upload_image(self, content: bytes, filename: str) -> str:
        self.uploads.append((content, filename))
        return f"lc-{filename}"


class _FakeSourceWorker:
    """上传落点 pool worker 替身:get_image_bytes 按文件名返回图片/音频字节。"""

    base_url = "http://fake-worker"

    async def get_image_bytes(self, filename, subfolder, type_):
        if filename.endswith(".wav") or filename.endswith(".mp3"):
            return b"audio-bytes", "audio/wav"
        return b"img-bytes", "image/png"


def _install_longcat(monkeypatch, fake: _FakeLongCatClient) -> None:
    monkeypatch.setattr(longcat_service, "get_longcat_client", lambda: fake)
    monkeypatch.setattr(longcat_service, "spawn_tracker", lambda client, prompt_id: None)
    monkeypatch.setattr(avatar_route, "resolve_worker", lambda worker: _FakeSourceWorker())


# --------------------------------------------------------------------------- #
# 图构建器(照搬 longcat_avatar_smoke.py v1.5 链路)
# --------------------------------------------------------------------------- #


def test_builder_graph_structure_and_critical_inputs():
    """节点类型/连线照搬冒烟脚本;关键输入(whisper/BlockSwap/GGUF/scheduler)锁定。"""
    g = build_longcat_avatar_graph(LongCatAvatarParams(
        positive="女生对镜头说话", image="face.png", audio="voice.wav", seed=42,
    ))

    assert g["1"]["class_type"] == "LoadImage"
    assert g["2"]["class_type"] == "ImageResizeKJv2"
    assert g["2"]["inputs"]["image"] == ["1", 0]
    assert g["3"]["class_type"] == "LoadAudio"
    # 人声分离:MelBandRoFormer 链(loader → sampler)
    assert g["4"]["class_type"] == "MelBandRoFormerModelLoader"
    assert g["4"]["inputs"]["model_name"] == DEFAULT_VOCAL_SEP
    assert g["5"]["class_type"] == "MelBandRoFormerSampler"
    assert g["5"]["inputs"]["model"] == ["4", 0]
    assert g["5"]["inputs"]["audio"] == ["3", 0]
    # v1.5 音频编码必须 whisper-large-v3(wav2vec2 是 v1.0 旧路线,维度不匹配)
    assert g["6"]["class_type"] == "WhisperModelLoader"
    assert g["6"]["inputs"]["model"] == DEFAULT_WHISPER
    assert g["7"]["class_type"] == "LongCatAvatarWhisperEmbeds"
    assert g["7"]["inputs"]["whisper_model"] == ["6", 0]
    assert g["7"]["inputs"]["audio_1"] == ["5", 0]
    assert g["8"]["class_type"] == "WanVideoBlockSwap"
    assert g["8"]["inputs"]["blocks_to_swap"] == 25
    assert g["9"]["class_type"] == "WanVideoLoraSelect"
    assert g["9"]["inputs"]["lora"] == DEFAULT_DMD_LORA
    assert g["10"]["class_type"] == "WanVideoModelLoader"
    assert g["10"]["inputs"]["model"] == DEFAULT_MODEL
    assert g["10"]["inputs"]["lora"] == ["9", 0]
    assert g["10"]["inputs"]["block_swap_args"] == ["8", 0]
    assert g["10"]["inputs"]["attention_mode"] == "sdpa"
    assert g["10"]["inputs"]["load_device"] == "offload_device"
    assert g["11"]["class_type"] == "LoadWanVideoT5TextEncoder"
    assert g["11"]["inputs"]["model_name"] == DEFAULT_T5
    assert g["13"]["class_type"] == "WanVideoSchedulerv2"
    assert g["13"]["inputs"]["scheduler"] == "longcat_distill_euler"
    assert g["14"]["class_type"] == "WanVideoVAELoader"
    assert g["14"]["inputs"]["model_name"] == DEFAULT_VAE
    assert g["15"]["class_type"] == "WanVideoEncode"
    assert g["15"]["inputs"]["vae"] == ["14", 0]
    assert g["15"]["inputs"]["image"] == ["2", 0]
    # 首帧 latents + 音频 embeds 融合进采样器
    assert g["16"]["class_type"] == "WanVideoLongCatAvatarExtendEmbeds"
    assert g["16"]["inputs"]["prev_latents"] == ["15", 0]
    assert g["16"]["inputs"]["audio_embeds"] == ["7", 0]
    assert g["17"]["class_type"] == "WanVideoSamplerv2"
    assert g["17"]["inputs"]["model"] == ["10", 0]
    assert g["17"]["inputs"]["image_embeds"] == ["16", 0]
    assert g["17"]["inputs"]["text_embeds"] == ["12", 0]
    assert g["17"]["inputs"]["scheduler"] == ["13", 0]
    assert g["18"]["class_type"] == "WanVideoDecode"
    assert g["18"]["inputs"]["samples"] == ["17", 0]
    # 成片带回原音频
    assert g["19"]["class_type"] == "VHS_VideoCombine"
    assert g["19"]["inputs"]["images"] == ["18", 0]
    assert g["19"]["inputs"]["audio"] == ["3", 0]


def test_builder_injects_params():
    g = build_longcat_avatar_graph(LongCatAvatarParams(
        positive="讲解产品", negative="模糊", image="me.jpg", audio="take2.mp3",
        width=832, height=480, num_frames=89, fps=30, steps=16,
        shift=8.0, cfg=1.5, dmd_lora_strength=0.8, seed=7,
    ))
    assert g["1"]["inputs"]["image"] == "me.jpg"
    assert g["3"]["inputs"]["audio"] == "take2.mp3"
    assert g["2"]["inputs"]["width"] == 832 and g["2"]["inputs"]["height"] == 480
    assert g["12"]["inputs"]["positive_prompt"] == "讲解产品"
    assert g["12"]["inputs"]["negative_prompt"] == "模糊"
    # 单段(≤93 帧窗口):帧数同时进 WhisperEmbeds 与 ExtendEmbeds
    assert g["7"]["inputs"]["num_frames"] == 89
    assert g["16"]["inputs"]["num_frames"] == 89
    assert g["7"]["inputs"]["fps"] == 30.0
    assert g["19"]["inputs"]["frame_rate"] == 30
    assert g["13"]["inputs"]["steps"] == 16
    assert g["13"]["inputs"]["shift"] == 8.0
    assert g["17"]["inputs"]["cfg"] == 1.5
    assert g["17"]["inputs"]["seed"] == 7
    assert g["9"]["inputs"]["strength"] == 0.8


def test_builder_defaults_match_smoke():
    """缺省参数与冒烟脚本一致:480×832/93 帧/25fps/steps=12/shift=12/cfg=1.0。"""
    g = build_longcat_avatar_graph(LongCatAvatarParams(
        positive="x", image="f.png", audio="a.wav", seed=1,
    ))
    assert g["2"]["inputs"]["width"] == 480 and g["2"]["inputs"]["height"] == 832
    assert g["7"]["inputs"]["num_frames"] == 93
    assert g["7"]["inputs"]["fps"] == 25.0
    assert g["13"]["inputs"]["steps"] == 12
    assert g["13"]["inputs"]["shift"] == 12.0
    assert g["17"]["inputs"]["cfg"] == 1.0
    assert g["9"]["inputs"]["strength"] == 1.0
    assert g["12"]["inputs"]["negative_prompt"] == DEFAULT_NEGATIVE
    assert g["19"]["inputs"]["frame_rate"] == 25
    assert g["19"]["inputs"]["filename_prefix"] == "ToIV_avatar/talk"


def test_builder_two_builds_independent():
    g1 = build_longcat_avatar_graph(LongCatAvatarParams(
        positive="first", image="a.png", audio="a.wav", seed=1,
    ))
    g2 = build_longcat_avatar_graph(LongCatAvatarParams(
        positive="second", image="b.png", audio="b.wav", seed=2,
    ))
    assert g1["12"]["inputs"]["positive_prompt"] == "first"
    assert g2["12"]["inputs"]["positive_prompt"] == "second"
    assert g1["1"]["inputs"]["image"] == "a.png"
    assert g2["1"]["inputs"]["image"] == "b.png"
    assert g1["17"]["inputs"]["seed"] == 1


def test_builder_default_seed_random():
    p1 = LongCatAvatarParams(positive="x", image="f.png", audio="a.wav")
    p2 = LongCatAvatarParams(positive="x", image="f.png", audio="a.wav")
    assert p1.seed >= 0 and p2.seed >= 0  # 随机种子(极低概率相等,不断言不等)


# --------------------------------------------------------------------------- #
# 长音频自动续段(num_frames > 93:官方示例链式 ExtendEmbeds 多段)
# --------------------------------------------------------------------------- #


def _extend_ids(g: dict) -> list[str]:
    return sorted(
        (nid for nid, n in g.items()
         if n["class_type"] == "WanVideoLongCatAvatarExtendEmbeds"),
        key=int)


def test_segments_single_window_boundary_unchanged():
    """93 帧(刚好一段):不出续段节点,图与单段冒烟形态一致。"""
    g = build_longcat_avatar_graph(LongCatAvatarParams(
        positive="x", image="f.png", audio="a.wav", num_frames=93, seed=1,
    ))
    assert _extend_ids(g) == ["16"]
    assert "20" not in g
    assert g["16"]["inputs"]["num_frames"] == 93
    assert g["16"]["inputs"]["frames_processed"] == 0
    assert g["16"]["inputs"]["overlap"] == 1
    assert "ref_latent" not in g["16"]["inputs"]  # 首段不带 ref_latent(同冒烟)
    assert g["19"]["inputs"]["images"] == ["18", 0]


def test_segments_two_windows_structure():
    """173 帧=93+80(两段):第二段 ExtendEmbeds 接上一段 latents/解码帧,
    frames_processed=93,拼帧后进 VHS。"""
    g = build_longcat_avatar_graph(LongCatAvatarParams(
        positive="x", image="f.png", audio="a.wav", num_frames=173, seed=1,
    ))
    assert _extend_ids(g) == ["16", "20"]
    # WhisperEmbeds 一次性编码整段音频(总帧数),各段自行切片
    assert g["7"]["inputs"]["num_frames"] == 173
    # 首段仍是窗口帧数
    assert g["16"]["inputs"]["num_frames"] == 93
    # 第二段:prev_latents=上一段采样器输出,prev_images=上一段解码帧(v1.5 重编码),
    # ref_latent=首帧 latents,frames_processed 累计 93,overlap=13(官方示例值)
    e2 = g["20"]["inputs"]
    assert g["20"]["class_type"] == "WanVideoLongCatAvatarExtendEmbeds"
    assert e2["prev_latents"] == ["17", 0]
    assert e2["audio_embeds"] == ["7", 0]
    assert e2["num_frames"] == 93
    assert e2["overlap"] == 13
    assert e2["frames_processed"] == 93
    assert e2["if_not_enough_audio"] == "pad_with_start"
    assert e2["ref_latent"] == ["15", 0]
    assert e2["prev_images"] == ["18", 0]
    assert e2["vae"] == ["14", 0]
    # 第二段采样/解码
    assert g["21"]["class_type"] == "WanVideoSamplerv2"
    assert g["21"]["inputs"]["image_embeds"] == ["20", 0]
    assert g["21"]["inputs"]["model"] == ["10", 0]
    assert g["22"]["class_type"] == "WanVideoDecode"
    assert g["22"]["inputs"]["samples"] == ["21", 0]
    # 拼帧:warmup 13 帧切掉(new_images/cut,官方示例参数),VHS 改接拼帧链
    assert g["23"]["class_type"] == "ImageBatchExtendWithOverlap"
    assert g["23"]["inputs"]["source_images"] == ["18", 0]
    assert g["23"]["inputs"]["new_images"] == ["22", 0]
    assert g["23"]["inputs"]["overlap"] == 13
    assert g["23"]["inputs"]["overlap_side"] == "new_images"
    assert g["23"]["inputs"]["overlap_mode"] == "cut"
    assert g["19"]["inputs"]["images"] == ["23", 2]


def test_segments_three_windows_cumulative_frames_processed():
    """186 帧=93+80+16(三段,末段残段取整 4k+1 网格到 29 帧):
    frames_processed 累计 0/93/173。"""
    g = build_longcat_avatar_graph(LongCatAvatarParams(
        positive="x", image="f.png", audio="a.wav", num_frames=186, seed=1,
    ))
    assert _extend_ids(g) == ["16", "20", "23"]
    assert g["16"]["inputs"]["frames_processed"] == 0
    assert g["20"]["inputs"]["frames_processed"] == 93
    assert g["23"]["inputs"]["frames_processed"] == 173
    assert g["23"]["inputs"]["num_frames"] == 29  # 残段 26 → 4k+1 网格 29
    assert (g["23"]["inputs"]["num_frames"] - 1) % 4 == 0
    assert g["23"]["inputs"]["prev_latents"] == ["21", 0]
    assert g["23"]["inputs"]["prev_images"] == ["22", 0]
    # 两段拼帧链:seg1+seg2 → +seg3,VHS 接链尾
    assert g["26"]["inputs"]["source_images"] == ["18", 0]
    assert g["26"]["inputs"]["new_images"] == ["22", 0]
    assert g["27"]["inputs"]["source_images"] == ["26", 2]
    assert g["27"]["inputs"]["new_images"] == ["25", 0]
    assert g["19"]["inputs"]["images"] == ["27", 2]


def test_segments_boundary_just_over_one_window():
    """94 帧(两段零一帧):残段 14 帧向上取整 4k+1 网格到 17 帧(净增 4)。"""
    g = build_longcat_avatar_graph(LongCatAvatarParams(
        positive="x", image="f.png", audio="a.wav", num_frames=94, seed=1,
    ))
    assert _extend_ids(g) == ["16", "20"]
    assert g["20"]["inputs"]["num_frames"] == 17
    assert (g["20"]["inputs"]["num_frames"] - 1) % 4 == 0
    assert g["20"]["inputs"]["frames_processed"] == 93


def test_segments_multi_seed_propagates_to_all_samplers():
    """多段所有采样器共用同一 seed(官方示例 seed fixed)与 cfg。"""
    g = build_longcat_avatar_graph(LongCatAvatarParams(
        positive="x", image="f.png", audio="a.wav", num_frames=300, seed=7, cfg=1.5,
    ))
    samplers = [n for n in g.values() if n["class_type"] == "WanVideoSamplerv2"]
    assert len(samplers) == len(_extend_ids(g))
    for s in samplers:
        assert s["inputs"]["seed"] == 7
        assert s["inputs"]["cfg"] == 1.5


def test_talk_ok_multi_segment_submit(client, monkeypatch):
    """端点提交 173 帧:图内含两段 ExtendEmbeds,Job 正常落库。"""
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "avmulti")
    fake = _FakeLongCatClient()
    _install_longcat(monkeypatch, fake)
    r = _post(c, uid, num_frames=173)
    assert r.status_code == 200, r.text
    graph = fake.graphs[0]
    extends = [n for n in graph.values()
               if n["class_type"] == "WanVideoLongCatAvatarExtendEmbeds"]
    assert len(extends) == 2
    assert graph["19"]["inputs"]["images"] == ["23", 2]


def test_talk_accepts_max_frames(client, monkeypatch):
    """num_frames=2500(新上限):通过校验并提交(32 段)。"""
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "avmax")
    fake = _FakeLongCatClient()
    _install_longcat(monkeypatch, fake)
    r = _post(c, uid, num_frames=2500)
    assert r.status_code == 200, r.text
    extends = [n for n in fake.graphs[0].values()
               if n["class_type"] == "WanVideoLongCatAvatarExtendEmbeds"]
    assert len(extends) == 32  # 1 + ceil((2500-93)/80)


# --------------------------------------------------------------------------- #
# 请求校验(422 / 对齐取整 / 路径穿越)
# --------------------------------------------------------------------------- #

_BASE = {"positive": "对镜头说话", "image": "f.png", "audio": "a.wav",
         "worker": "http://fake-worker"}


def _post(c, uid, **over):
    return c.post(
        "/api/avatar/talk",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={**_BASE, **over},
    )


@pytest.mark.parametrize("num_frames", [16, 2501, 0])
def test_talk_rejects_out_of_range_frames(client, num_frames):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, f"avframes-{num_frames}")
    assert _post(c, uid, num_frames=num_frames).status_code == 422


@pytest.mark.parametrize("field,value", [("width", 319), ("height", 1281)])
def test_talk_rejects_out_of_range_size(client, field, value):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, f"avsize-{field}")
    assert _post(c, uid, **{field: value}).status_code == 422


def test_talk_snaps_non_aligned_size(client, monkeypatch):
    """宽高非 16 对齐:向下取整进图(481→480、833→832),而非 422。"""
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "avsnap")
    fake = _FakeLongCatClient()
    _install_longcat(monkeypatch, fake)
    r = _post(c, uid, width=481, height=833)
    assert r.status_code == 200, r.text
    resize = fake.graphs[0]["2"]["inputs"]
    assert resize["width"] == 480 and resize["height"] == 832


@pytest.mark.parametrize("field", ["image", "audio"])
def test_talk_rejects_path_traversal(client, field):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, f"avtrav-{field}")
    assert _post(c, uid, **{field: "../evil.png"}).status_code == 422


# --------------------------------------------------------------------------- #
# POST /api/avatar/talk
# --------------------------------------------------------------------------- #


def test_talk_ok_transfers_inputs_and_submits(client, monkeypatch):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "avok")
    fake = _FakeLongCatClient()
    _install_longcat(monkeypatch, fake)
    r = _post(c, uid, positive="介绍新产品", num_frames=93, seed=7)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["prompt_id"] == "prompt-avatar-1"
    assert body["worker"] == "http://fake-longcat"
    assert body["seed"] == 7

    # 图片+音频从源 worker 读出并上传到 LongCat 实例,图内引用转运后的文件名
    assert fake.uploads == [(b"img-bytes", "f.png"), (b"audio-bytes", "a.wav")]
    graph = fake.graphs[0]
    assert graph["1"]["inputs"]["image"] == "lc-f.png"
    assert graph["3"]["inputs"]["audio"] == "lc-a.wav"
    assert graph["7"]["inputs"]["num_frames"] == 93

    with Session(engine) as s:
        job = s.exec(select(Job).where(Job.user_id == uid)).first()
        assert job is not None
        assert job.kind == "avatar_talk"
        assert job.nsfw is False
        assert job.seed == 7
        assert job.worker == "http://fake-longcat"


def test_talk_requires_auth(client):
    c, _ = client
    assert c.post("/api/avatar/talk", json=_BASE).status_code == 401


def test_talk_instance_unreachable_503(client, monkeypatch):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "avdown")
    _install_longcat(monkeypatch, _FakeLongCatClient(reachable=False))
    r = _post(c, uid)
    assert r.status_code == 503
    assert "不可达" in r.json()["detail"]


def test_talk_audio_read_failure_502(client, monkeypatch):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "avbadread")

    class _BrokenSource:
        base_url = "http://fake-worker"

        async def get_image_bytes(self, filename, subfolder, type_):
            raise ComfyUIError("no such file")

    monkeypatch.setattr(longcat_service, "get_longcat_client", lambda: _FakeLongCatClient())
    monkeypatch.setattr(longcat_service, "spawn_tracker", lambda client, prompt_id: None)
    monkeypatch.setattr(avatar_route, "resolve_worker", lambda worker: _BrokenSource())
    r = _post(c, uid)
    assert r.status_code == 502
    assert "读取失败" in r.json()["detail"]


# --------------------------------------------------------------------------- #
# R18 打标:X-NSFW 上下文 → Job.nsfw(与 longcat_studio 同一判定来源);
# 未成年硬阻断优先于 X-NSFW 头
# --------------------------------------------------------------------------- #


def test_talk_marks_job_nsfw_with_x_nsfw_header(client, monkeypatch):
    """/nsfw 专区(X-NSFW: 1)提交 avatar talk:Job 打 nsfw 标。"""
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "avnsfw")
    _install_longcat(monkeypatch, _FakeLongCatClient())
    r = c.post(
        "/api/avatar/talk",
        headers={"Authorization": f"Bearer {create_token(uid)}", "X-NSFW": "1"},
        json=_BASE,
    )
    assert r.status_code == 200, r.text
    with Session(engine) as s:
        job = s.exec(select(Job).where(Job.user_id == uid)).first()
        assert job is not None
        assert job.kind == "avatar_talk" and job.nsfw is True


def test_talk_main_site_job_not_nsfw(client, monkeypatch):
    """主站(无 X-NSFW 头)行为不变:Job 不打 nsfw 标。"""
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "avsfw")
    _install_longcat(monkeypatch, _FakeLongCatClient())
    r = _post(c, uid)
    assert r.status_code == 200, r.text
    with Session(engine) as s:
        job = s.exec(select(Job).where(Job.user_id == uid)).first()
        assert job is not None and job.nsfw is False


def test_talk_underage_hard_blocked_from_nsfw(client, monkeypatch):
    """未成年用户即便带 X-NSFW 头也不打 nsfw 标(硬阻断,同 LTX/longcat 门控)。"""
    c, engine = client
    with Session(engine) as s:
        ten_years_ago = date.today() - timedelta(days=365 * 10)
        uid = _seed_user(s, "avminor", birthdate=ten_years_ago)
    _install_longcat(monkeypatch, _FakeLongCatClient())
    r = c.post(
        "/api/avatar/talk",
        headers={"Authorization": f"Bearer {create_token(uid)}", "X-NSFW": "1"},
        json=_BASE,
    )
    assert r.status_code == 200, r.text
    with Session(engine) as s:
        job = s.exec(select(Job).where(Job.user_id == uid)).first()
        assert job is not None
        assert job.kind == "avatar_talk" and job.nsfw is False
