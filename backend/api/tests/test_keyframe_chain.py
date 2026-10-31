"""关键帧链式转场(POST /api/generate/keyframe-chain)—— 校验 / 计划拆分 / 合并链 / 端点测试。

对标 Pika 2.5 Pikaframes:2-5 张关键帧 → N-1 段首尾帧转场(复用 transition 的
VACE 链路)→ 后台 ffmpeg 拼接为整条视频(单段 1-10s,总长 ≤25s)。

覆盖:
  · validate_keyframe_chain:1 帧/6 帧/段时长越界/总时长越界/提示词与时长数不齐 → KeyframeChainError
  · plan_keyframe_chain:2 帧→1 段 / 3 帧→2 段 / 5 帧→4 段;段间首尾帧衔接;
    时长均分(默认 5s)/自定义;VACE 4k+1 网格吸附;种子按段推导(seed+i)
  · run_keyframe_chain_merge:等全部段产物 → concat+精确裁 → 上传 → on_final 回写
  · 端点:缺图 422(1 帧/6 帧/空提示词/时长越界/数不齐);串行提交 N-1 段(图序正确);
    合并 Job(kind=keyframe_chain)落库且 params 含完整链计划与段 prompt_id;
    X-NSFW 上下文全链打标;hold 预检失败时各段转 hold 排队
"""
from __future__ import annotations

import json
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

import app.routes.wan_studio as wan_route
import app.services.hold_queue as hold_queue
import app.services.keyframe_chain as keychain
import app.services.longcat as longcat_service
import app.services.wan_video as wan_service
from app.comfy.client import ComfyUIError
from app.db import get_session
from app.main import app
from app.models import Job, Tenant, User
from app.security import create_token, hash_password


# --------------------------------------------------------------------------- #
# 校验(纯函数层)
# --------------------------------------------------------------------------- #


def test_validate_rejects_single_keyframe():
    with pytest.raises(keychain.KeyframeChainError, match="2-5"):
        keychain.validate_keyframe_chain(["a.png"], "过渡", None)


def test_validate_rejects_six_keyframes():
    with pytest.raises(keychain.KeyframeChainError, match="2-5"):
        keychain.validate_keyframe_chain(
            ["a.png", "b.png", "c.png", "d.png", "e.png", "f.png"], "过渡", None
        )


def test_validate_accepts_two_and_five_keyframes():
    keychain.validate_keyframe_chain(["a.png", "b.png"], "过渡", None)
    keychain.validate_keyframe_chain(
        ["a.png", "b.png", "c.png", "d.png", "e.png"], "过渡", None
    )


def test_validate_rejects_segment_duration_out_of_range():
    with pytest.raises(keychain.KeyframeChainError, match="1-10"):
        keychain.validate_keyframe_chain(["a.png", "b.png"], "过渡", [0.5])
    with pytest.raises(keychain.KeyframeChainError, match="1-10"):
        keychain.validate_keyframe_chain(["a.png", "b.png"], "过渡", [10.5])


def test_validate_rejects_total_duration_over_limit():
    """3 段 × 10s = 30s > 25s 上限 → 拒绝。"""
    with pytest.raises(keychain.KeyframeChainError, match="25"):
        keychain.validate_keyframe_chain(
            ["a.png", "b.png", "c.png", "d.png"], "过渡", [10.0, 10.0, 10.0]
        )


def test_validate_rejects_durations_count_mismatch():
    with pytest.raises(keychain.KeyframeChainError, match="段数"):
        keychain.validate_keyframe_chain(["a.png", "b.png", "c.png"], "过渡", [5.0])


def test_validate_rejects_prompts_count_mismatch():
    with pytest.raises(keychain.KeyframeChainError, match="段数"):
        keychain.validate_keyframe_chain(
            ["a.png", "b.png", "c.png"], ["只有一段"], None
        )


def test_validate_rejects_empty_prompt():
    with pytest.raises(keychain.KeyframeChainError, match="提示词"):
        keychain.validate_keyframe_chain(["a.png", "b.png"], "   ", None)
    with pytest.raises(keychain.KeyframeChainError, match="提示词"):
        keychain.validate_keyframe_chain(["a.png", "b.png", "c.png"], ["有内容", " "], None)


# --------------------------------------------------------------------------- #
# 计划拆分
# --------------------------------------------------------------------------- #


def test_plan_splits_two_frames_into_one_segment():
    plan = keychain.plan_keyframe_chain(["a.png", "b.png"], "白天到夜晚", None)
    assert len(plan.segments) == 1
    seg = plan.segments[0]
    assert seg.first_frame == "a.png" and seg.last_frame == "b.png"
    assert seg.prompt == "白天到夜晚"


def test_plan_splits_three_frames_into_two_chained_segments():
    """段间衔接:第 i 段尾帧 = 第 i+1 段首帧(复用 transition 天然平滑)。"""
    plan = keychain.plan_keyframe_chain(["a.png", "b.png", "c.png"], "过渡", None)
    assert len(plan.segments) == 2
    assert plan.segments[0].first_frame == "a.png"
    assert plan.segments[0].last_frame == "b.png"
    assert plan.segments[1].first_frame == "b.png"
    assert plan.segments[1].last_frame == "c.png"


def test_plan_splits_five_frames_into_four_segments():
    plan = keychain.plan_keyframe_chain(
        ["a.png", "b.png", "c.png", "d.png", "e.png"], "过渡", None
    )
    assert len(plan.segments) == 4
    for i, seg in enumerate(plan.segments):
        assert seg.first_frame == ["a.png", "b.png", "c.png", "d.png", "e.png"][i]
        assert seg.last_frame == ["a.png", "b.png", "c.png", "d.png", "e.png"][i + 1]


def test_plan_even_duration_allocation_by_default():
    """durations=None → 每段默认 5s 均分;总时长 = 段数 × 5s。"""
    plan = keychain.plan_keyframe_chain(["a.png", "b.png", "c.png"], "过渡", None)
    assert [s.duration_sec for s in plan.segments] == [5.0, 5.0]
    assert plan.total_duration == 10.0


def test_plan_custom_durations_and_total():
    plan = keychain.plan_keyframe_chain(
        ["a.png", "b.png", "c.png", "d.png"], "过渡", [2.0, 4.5, 8.0]
    )
    assert [s.duration_sec for s in plan.segments] == [2.0, 4.5, 8.0]
    assert plan.total_duration == 14.5


def test_plan_snaps_frames_to_vace_grid():
    """帧网格对齐:每段帧数按 Wan VACE 4k+1 网格向上吸附(16fps:3s→49,5s→81,1s→17)。"""
    plan = keychain.plan_keyframe_chain(
        ["a.png", "b.png", "c.png", "d.png"], "过渡", [3.0, 5.0, 1.0], fps=16
    )
    assert [s.frames for s in plan.segments] == [49, 81, 17]
    for s in plan.segments:
        assert (s.frames - 1) % 4 == 0


def test_plan_per_segment_prompts_and_shared_prompt():
    shared = keychain.plan_keyframe_chain(["a.png", "b.png", "c.png"], "同一提示词", None)
    assert [s.prompt for s in shared.segments] == ["同一提示词", "同一提示词"]
    per = keychain.plan_keyframe_chain(["a.png", "b.png", "c.png"], ["段一", "段二"], None)
    assert [s.prompt for s in per.segments] == ["段一", "段二"]


def test_plan_seed_derivation_per_segment():
    """显式种子按段推导(seed+i),无种子则段种子为 None(各段随机)。"""
    seeded = keychain.plan_keyframe_chain(
        ["a.png", "b.png", "c.png"], "过渡", None, seed=100
    )
    assert [s.seed for s in seeded.segments] == [100, 101]
    unseeded = keychain.plan_keyframe_chain(["a.png", "b.png", "c.png"], "过渡", None)
    assert [s.seed for s in unseeded.segments] == [None, None]


def test_plan_carries_render_params():
    plan = keychain.plan_keyframe_chain(
        ["a.png", "b.png"], "过渡", None,
        width=832, height=480, steps=12, cfg=4.5, fps=16,
    )
    seg = plan.segments[0]
    assert (plan.width, plan.height, plan.fps) == (832, 480, 16)
    assert (seg.steps, seg.cfg) == (12, 4.5)


# --------------------------------------------------------------------------- #
# 合并链:等全部段产物 → concat+精确裁 → 上传 → 回写
# --------------------------------------------------------------------------- #


class _FakeMergeClient:
    """合并链 worker 替身:get_image_bytes 返回段视频字节,upload_image 记录上传。"""

    base_url = "http://fake-wan"

    def __init__(self) -> None:
        self.uploads: list[tuple[bytes, str]] = []

    async def get_image_bytes(self, filename: str, subfolder: str, type_: str):
        return f"video-bytes-{filename}".encode(), "application/octet-stream"

    async def upload_image(self, content: bytes, filename: str) -> str:
        self.uploads.append((content, filename))
        return filename


async def test_merge_chain_waits_all_segments_concat_and_finalizes(tmp_path):
    """3 段链:逐段等产物 → ffmpeg concat+裁剪 → 上传成片 → on_final 收到 URL。"""
    client = _FakeMergeClient()
    waited: list[str] = []
    ffmpeg_cmds: list[list[str]] = []

    async def _wait(c, pid, **kw):
        waited.append(pid)
        return [{"filename": f"{pid}.mp4", "subfolder": "", "type": "output"}]

    async def _ffmpeg(cmd, **kw):
        ffmpeg_cmds.append(cmd)
        out = cmd[-1]
        if out.endswith(".mp4"):
            from pathlib import Path

            Path(out).write_bytes(b"merged-video")

    finals: list[list[str]] = []

    async def _on_final(urls: list[str]) -> None:
        finals.append(urls)

    await keychain.run_keyframe_chain_merge(
        client=client,
        prompt_ids=["p1", "p2", "p3"],
        seconds=15.0,
        on_final=_on_final,
        wait_files=_wait,
        ffmpeg=_ffmpeg,
    )
    assert waited == ["p1", "p2", "p3"], "须按链序逐段等产物"
    assert any("concat" in " ".join(cmd) for cmd in ffmpeg_cmds), "须经 concat 拼接"
    trim_cmds = [cmd for cmd in ffmpeg_cmds if "-t" in cmd]
    assert trim_cmds, "须按总时长精确裁切"
    assert trim_cmds[0][trim_cmds[0].index("-t") + 1] == "15.000"
    assert len(client.uploads) == 1, "成片须回传 worker"
    assert len(finals) == 1 and len(finals[0]) == 1
    url = finals[0][0]
    assert "type=input" in url and "sig=" in url, "成片 URL 须为签名产物 URL"


async def test_merge_chain_propagates_segment_failure():
    """任一段失败(error/超时)→ 链上抛,不出假成片。"""

    async def _wait_fail(c, pid, **kw):
        raise RuntimeError(f"作业 {pid} 执行失败")

    async def _noop_final(urls: list[str]) -> None:
        raise AssertionError("失败链不得回调 on_final")

    with pytest.raises(RuntimeError, match="执行失败"):
        await keychain.run_keyframe_chain_merge(
            client=_FakeMergeClient(),
            prompt_ids=["p1", "p2"],
            seconds=10.0,
            on_final=_noop_final,
            wait_files=_wait_fail,
            ffmpeg=lambda cmd, **kw: None,
        )


# --------------------------------------------------------------------------- #
# 端点:公共 fixtures / fakes(与 test_transition.py 同型,本文件自足)
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
    base_url = "http://fake-worker"

    async def get_image_bytes(self, filename: str, subfolder: str, type_: str):
        return b"frame-bytes", "application/octet-stream"


def _install(monkeypatch, fake: _FakeWanClient) -> None:
    monkeypatch.setattr(longcat_service, "get_longcat_client", lambda: fake)
    monkeypatch.setattr(longcat_service, "spawn_tracker", lambda client, prompt_id: None)
    monkeypatch.setattr(wan_route, "resolve_worker", lambda worker: _FakeSourceWorker())
    monkeypatch.setattr(
        wan_service,
        "get_settings",
        lambda: SimpleNamespace(wan_min_free_vram_gb=26.0, wan_min_free_ram_gb=15.0),
    )
    # 合并链挂后台(等段产物+ffmpeg),路由测试不真跑,验证 spawn 被调用即可
    monkeypatch.setattr(
        keychain, "spawn_keyframe_chain_merge", lambda **kw: None
    )


def _payload(**over) -> dict:
    body = {
        "keyframes": ["k1.png", "k2.png", "k3.png"],
        "prompts": "镜头平滑过渡",
        "worker": "http://fake-worker",
    }
    body.update(over)
    return body


# --------------------------------------------------------------------------- #
# 端点:请求校验(422)
# --------------------------------------------------------------------------- #


def test_chain_requires_auth(client):
    c, _ = client
    r = c.post("/api/generate/keyframe-chain", json=_payload())
    assert r.status_code == 401


@pytest.mark.parametrize("frames", [["only-one.png"], ["a", "b", "c", "d", "e", "f"]])
def test_chain_rejects_bad_keyframe_count(client, frames):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, f"kc-count-{len(frames)}")
    r = c.post(
        "/api/generate/keyframe-chain",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json=_payload(keyframes=frames),
    )
    assert r.status_code == 422


def test_chain_rejects_empty_prompt(client):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "kc-empty-prompt")
    r = c.post(
        "/api/generate/keyframe-chain",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json=_payload(prompts="  "),
    )
    assert r.status_code == 422


@pytest.mark.parametrize("durations", [[0.5, 5.0], [11.0, 5.0], [10.0, 10.0, 10.0]])
def test_chain_rejects_bad_durations(client, durations):
    """段时长越界(0.5/11s)与总时长越界(4 帧 3 段 ×10s=30s>25s)→ 422。"""
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, f"kc-dur-{len(durations)}-{durations[0]}")
    frames = ["a.png", "b.png", "c.png"] if len(durations) == 2 else ["a", "b", "c", "d"]
    r = c.post(
        "/api/generate/keyframe-chain",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json=_payload(keyframes=frames, durations=durations),
    )
    assert r.status_code == 422


def test_chain_rejects_prompts_count_mismatch(client):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "kc-prompts-mismatch")
    r = c.post(
        "/api/generate/keyframe-chain",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json=_payload(prompts=["只有一段"]),
    )
    assert r.status_code == 422


def test_chain_rejects_path_traversal(client):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "kc-traversal")
    r = c.post(
        "/api/generate/keyframe-chain",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json=_payload(keyframes=["k1.png", "../evil.png"]),
    )
    assert r.status_code == 422


# --------------------------------------------------------------------------- #
# 端点:串行提交 + 合并 Job
# --------------------------------------------------------------------------- #


def test_chain_submits_segments_serially_and_creates_merged_job(client, monkeypatch):
    """3 帧 → 2 段 transition 依次提交(段 i 尾帧=段 i+1 首帧)+ 1 个合并 Job。"""
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "kc-ok")
    fake = _FakeWanClient()
    _install(monkeypatch, fake)
    r = c.post(
        "/api/generate/keyframe-chain",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json=_payload(durations=[3.0, 6.0], seed=42),
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["prompt_id"].startswith("chain-"), "返回须为合并作业 id"
    assert body["segments"] == ["prompt-seg-1", "prompt-seg-2"]
    assert body["total_duration"] == 9.0

    # 关键帧全部转运到 :8197(3 张各一次)
    assert [name for _, name in fake.uploads] == ["k1.png", "k2.png", "k3.png"]
    # 两段串行提交,图序:段1 k1→k2,段2 k2→k3(首帧兼作 ref 锚点,与 transition 同构)
    assert len(fake.graphs) == 2
    g1, g2 = fake.graphs
    assert g1["40"]["inputs"]["image"] == "wan-k1.png"
    assert g1["42"]["inputs"]["image"] == "wan-k2.png"
    assert g2["40"]["inputs"]["image"] == "wan-k2.png"
    assert g2["42"]["inputs"]["image"] == "wan-k3.png"
    # 帧网格吸附:3s→49 帧 / 6s→97 帧(4k+1)
    assert g1["10"]["inputs"]["num_frames"] == 49
    assert g2["10"]["inputs"]["num_frames"] == 97
    # 种子按段推导:42 / 43
    assert g1["13"]["inputs"]["seed"] == 42
    assert g2["13"]["inputs"]["seed"] == 43

    with Session(engine) as s:
        jobs = s.exec(select(Job).where(Job.user_id == uid).order_by(Job.created_at)).all()
        seg_jobs = [j for j in jobs if j.kind == "transition"]
        merged = [j for j in jobs if j.kind == "keyframe_chain"]
        assert len(seg_jobs) == 2, "各段须保留独立 transition Job(便于调试)"
        assert len(merged) == 1, "须有单个合并 Job"
        m = merged[0]
        assert m.prompt_id == body["prompt_id"]
        assert m.status == "queued"
        assert m.nsfw is False
        params = json.loads(m.params)
        assert params["segment_prompt_ids"] == ["prompt-seg-1", "prompt-seg-2"]
        assert params["total_duration"] == 9.0
        assert len(params["segments"]) == 2
        assert params["keyframes"] == ["k1.png", "k2.png", "k3.png"]


def test_chain_two_frames_single_segment(client, monkeypatch):
    """2 帧 → 1 段,与单组 transition 等价(仍出合并 Job)。"""
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "kc-two")
    fake = _FakeWanClient()
    _install(monkeypatch, fake)
    r = c.post(
        "/api/generate/keyframe-chain",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json=_payload(keyframes=["k1.png", "k2.png"]),
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert len(body["segments"]) == 1
    assert len(fake.graphs) == 1
    with Session(engine) as s:
        kinds = [j.kind for j in s.exec(select(Job).where(Job.user_id == uid)).all()]
        assert sorted(kinds) == ["keyframe_chain", "transition"]


def test_chain_per_segment_prompts(client, monkeypatch):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "kc-per-prompt")
    fake = _FakeWanClient()
    _install(monkeypatch, fake)
    r = c.post(
        "/api/generate/keyframe-chain",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json=_payload(prompts=["从白天到黄昏", "从黄昏到夜晚"]),
    )
    assert r.status_code == 200, r.text
    with Session(engine) as s:
        seg_jobs = s.exec(
            select(Job).where(Job.user_id == uid, Job.kind == "transition")
        ).all()
        assert {j.prompt for j in seg_jobs} == {"从白天到黄昏", "从黄昏到夜晚"}


def test_chain_marks_all_jobs_nsfw_with_x_nsfw_header(client, monkeypatch):
    """X-NSFW 头只做门控,不再单独打 nsfw 标(fb78872):段 Job 与合并 Job 均 nsfw=False。"""
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "kc-nsfw")
    fake = _FakeWanClient()
    _install(monkeypatch, fake)
    r = c.post(
        "/api/generate/keyframe-chain",
        headers={"Authorization": f"Bearer {create_token(uid)}", "X-NSFW": "1"},
        json=_payload(),
    )
    assert r.status_code == 200, r.text
    with Session(engine) as s:
        jobs = s.exec(select(Job).where(Job.user_id == uid)).all()
        assert len(jobs) == 3
        assert all(j.nsfw is False for j in jobs)


def test_chain_spawns_merge_with_segment_ids(client, monkeypatch):
    """合并链 spawn:携带段 prompt_id 序列 + 总时长 + 合并 id。"""
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "kc-spawn")
    fake = _FakeWanClient()
    _install(monkeypatch, fake)
    captured: list[dict] = []
    monkeypatch.setattr(
        keychain, "spawn_keyframe_chain_merge", lambda **kw: captured.append(kw)
    )
    r = c.post(
        "/api/generate/keyframe-chain",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json=_payload(durations=[4.0, 4.0]),
    )
    assert r.status_code == 200, r.text
    assert len(captured) == 1
    kw = captured[0]
    assert kw["prompt_ids"] == ["prompt-seg-1", "prompt-seg-2"]
    assert kw["seconds"] == 8.0
    assert kw["merged_prompt_id"] == r.json()["prompt_id"]


def test_chain_instance_unreachable_503(client, monkeypatch):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "kc-down")
    _install(monkeypatch, _FakeWanClient(reachable=False))
    r = c.post(
        "/api/generate/keyframe-chain",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json=_payload(),
    )
    assert r.status_code == 503


def test_chain_hold_when_vram_low(client, monkeypatch):
    """显存不足且 hold 开:各段转 hold 排队,响应带 held 标记;合并链仍挂(等放行)。"""
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "kc-hold")
    fake = _FakeWanClient(free_vram_gib=10.0)
    _install(monkeypatch, fake)
    monkeypatch.setattr(hold_queue, "holdable", lambda exc: True)
    r = c.post(
        "/api/generate/keyframe-chain",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json=_payload(keyframes=["k1.png", "k2.png"]),
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body.get("held") is True
    assert fake.graphs == [], "hold 时不得直提"
    assert body["segments"][0].startswith("hold-"), "段作业为 hold 占位 id"
    with Session(engine) as s:
        seg = s.exec(select(Job).where(Job.user_id == uid, Job.kind == "transition")).first()
        assert seg is not None and seg.status == "held"
