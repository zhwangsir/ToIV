"""统一时长策略层(services/duration)+ 后处理链 + 路由 duration_sec 集成测试。

覆盖:
  · resolve_duration 全引擎矩阵:direct(网格向上取整,秒差 ≤0.25s)/ trim(秒差 >0.25s
    精确裁剪)/ extend(超上限分段续写 + 60s 安全上限)/ 不支持 extend 引擎超上限报错
  · 网格边界:22 帧下限、min 钳位、threshold 恰好 0.25s 不裁、超过才裁
  · snap_engine_frames(down)与旧 drama _snap_*_length 公式全量等价(-10..700)
  · validate_engine_frames 文案(与旧 drama 422 文案一致)
  · run_duration_chain:trim 单段 ffmpeg 精确裁 + 产物回传 input + on_final 回写;
    extend 两段(末帧抽取 + 续段帧数 + concat);缺 submit_next 报错
  · 路由:H3 duration_sec 入参(direct/trim/extend/422)、legacy length 兼容、
    R18 LTX duration_sec(direct/422)
  · 路由(2026-08-17 收口):LongCat/Avatar/Wan-Animate/Wan-VACE duration_sec
    (direct/trim/上下文窗口提示/422)、legacy num_frames 兼容、双缺省默认秒数
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

import app.routes.video as video_route
import app.routes.avatar_studio as avatar_route
import app.routes.wan_studio as wan_route
import app.services.h3 as h3_service
import app.services.longcat as longcat_service
import app.services.video_generators as vgen
from app.comfy.client import ComfyUIError
from app.db import get_session
from app.main import app
from app.models import Job, Tenant, User
from app.security import create_token, hash_password
from app.services.duration import (
    DurationLimitError,
    engine_spec,
    resolve_duration,
    snap_engine_frames,
    validate_engine_frames,
)

# ---------------------------------------------------------------------------
# resolve_duration 矩阵
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "engine,seconds,fps,frames,strategy",
    [
        # H3 17k+5 [22,362] @24
        ("h3", 5, 24, 124, "direct"),      # 120→124(5.17s,差 0.17)
        ("h3", 15, 24, 362, "direct"),     # 360→362(15.08s,差 0.08)
        ("h3", 0.9, 24, 22, "direct"),     # 21.6→22 帧(0.917s,差 0.017)
        ("h3", 6, 24, 158, "trim"),        # 144→158(6.58s,差 0.58 → 裁)
        ("h3", 0.5, 24, 22, "trim"),       # 12→22 帧(0.92s,差 0.42 → 裁)
        ("h3", 10, 24, 243, "direct"),     # 240→243(10.125s,差 0.125)
        # LTX-2.3 8k+1 [9,241] @16
        ("ltx", 6, 16, 97, "direct"),
        ("ltx", 15, 16, 241, "direct"),
        # LongCat [17,961] 无网格 @16
        ("longcat", 5, 16, 80, "direct"),
        ("longcat", 30, 16, 480, "direct"),
        ("longcat", 60, 16, 960, "direct"),
        ("longcat", 0.5, 16, 17, "trim"),  # 8→min 17(1.06s,差 0.56 → 裁)
        # Wan-Animate 4k+1 [17,501] / VACE 4k+1 [17,241]
        ("animate", 7.5, 16, 121, "direct"),
        ("vace", 5, 16, 81, "direct"),
        # LongCat-Avatar 4k+1 @25
        ("avatar", 3.7, 25, 93, "direct"),
    ],
)
def test_resolve_direct_and_trim(engine, seconds, fps, frames, strategy):
    plan = resolve_duration(engine, seconds, fps)
    assert plan.frames == frames
    assert plan.strategy == strategy
    assert plan.segments == 1
    assert plan.segment_frames == (frames,)
    if strategy == "trim":
        assert plan.trim_to == seconds
        assert "精确裁" in plan.notice
    else:
        assert plan.trim_to is None


def test_resolve_trim_threshold_exact_025_not_trimmed():
    """秒差恰好 0.25s 不裁(> 才裁):fps=4 时 H3 下限 22 帧=5.5s,请求 5.25s 差 0.25 → direct。"""
    plan = resolve_duration("h3", 5.25, 4)
    assert plan.frames == 22
    assert plan.strategy == "direct"
    # 多一丝(5.24 → 差 0.26)→ trim
    plan2 = resolve_duration("h3", 5.24, 4)
    assert plan2.strategy == "trim"


def test_resolve_h3_extend_two_segments():
    """H3 20s@24=480 帧 > 362:分 2 段 [362, 124](残量 118 向上取 17k+5=124),裁至 20s。"""
    plan = resolve_duration("h3", 20, 24)
    assert plan.strategy == "extend"
    assert plan.segment_frames == (362, 124)
    assert plan.frames == 362
    assert plan.segments == 2
    assert plan.trim_to == 20
    assert "分 2 段" in plan.notice and "20 秒" in plan.notice


def test_resolve_h3_extend_max_60s():
    """H3 60s@24=1440 → [362,362,362,362] 4 段;60.5s 超安全上限报错。"""
    plan = resolve_duration("h3", 60, 24)
    assert plan.strategy == "extend"
    assert plan.segment_frames == (362, 362, 362, 362)
    assert plan.segments == 4
    with pytest.raises(DurationLimitError, match="最长支持 60 秒"):
        resolve_duration("h3", 60.5, 24)


@pytest.mark.parametrize(
    "engine,seconds,fps",
    [("ltx", 16, 16), ("ltx", 15, 30), ("longcat", 61, 16), ("animate", 32, 16), ("vace", 16, 16)],
)
def test_resolve_no_extend_engine_over_limit_errors(engine, seconds, fps):
    """不支持 extend 的引擎超上限:DurationLimitError 且文案说明单段上限。"""
    with pytest.raises(DurationLimitError, match="单段上限"):
        resolve_duration(engine, seconds, fps)


def test_resolve_longcat_context_window_notice():
    """LongCat 超 241 帧给上下文窗口提示;241 及以下无提示。"""
    assert "上下文窗口" in resolve_duration("longcat", 30, 16).notice
    assert resolve_duration("longcat", 15, 16).notice == ""


def test_resolve_direct_no_notice():
    assert resolve_duration("h3", 5, 24).notice == ""
    assert resolve_duration("ltx", 6, 16).notice == ""


def test_resolve_errors():
    with pytest.raises(ValueError, match="未知时长引擎"):
        resolve_duration("nonexistent", 5, 24)
    with pytest.raises(DurationLimitError):
        resolve_duration("h3", 0, 24)
    with pytest.raises(DurationLimitError):
        resolve_duration("h3", -3, 24)
    with pytest.raises(DurationLimitError):
        resolve_duration("h3", float("nan"), 24)
    with pytest.raises(DurationLimitError):
        resolve_duration("h3", 5, 0)


# ---------------------------------------------------------------------------
# snap / validate(drama 委托等价性)
# ---------------------------------------------------------------------------


def _old_snap_ltx(n: int) -> int:
    n = max(9, min(241, n))
    return ((n - 1) // 8) * 8 + 1


def _old_snap_h3(n: int) -> int:
    n = max(22, min(362, n))
    return ((n - 5) // 17) * 17 + 5


def test_snap_down_equivalent_to_legacy_drama_formula():
    """snap_engine_frames(direction=down) 与旧 drama _snap_*_length 全量等价。"""
    for n in range(-10, 700):
        assert snap_engine_frames("ltx", n, direction="down") == _old_snap_ltx(n)
        assert snap_engine_frames("h3", n, direction="down") == _old_snap_h3(n)


def test_snap_up_grid():
    assert snap_engine_frames("h3", 124, direction="up") == 124
    assert snap_engine_frames("h3", 125, direction="up") == 141
    assert snap_engine_frames("h3", 1, direction="up") == 22
    assert snap_engine_frames("ltx", 120, direction="up") == 121
    assert snap_engine_frames("longcat", 5, direction="up") == 17  # 无网格仅钳位
    with pytest.raises(ValueError, match="未知吸附方向"):
        snap_engine_frames("h3", 124, direction="nearest")


def test_validate_engine_frames_messages():
    assert validate_engine_frames("h3", 124) is None
    assert validate_engine_frames("h3", 100) == "H3 length 必须为 17k+5 且 22-362(如 124/141/362)"
    assert validate_engine_frames("ltx", 97) is None
    assert validate_engine_frames("ltx", 100) == "LTX length 必须为 8k+1 且 9-241(如 97/121/241)"
    assert validate_engine_frames("longcat", 961) is None
    assert validate_engine_frames("longcat", 5) is not None


def test_engine_spec_unknown():
    with pytest.raises(ValueError, match="未知时长引擎"):
        engine_spec("xxx")


# ---------------------------------------------------------------------------
# run_duration_chain(trim / extend)
# ---------------------------------------------------------------------------


class _FakeChainClient:
    """worker 替身:history 产物 / 下载 / 上传。"""

    def __init__(self) -> None:
        self.base_url = "http://fake-worker"
        self.uploads: list[tuple[bytes, str]] = []

    async def get_history(self, prompt_id: str) -> dict:
        return {
            prompt_id: {
                "outputs": {"1": {"videos": [{"filename": f"{prompt_id}.mp4", "type": "output"}]}},
                "status": {"status_str": "success", "completed": True},
            }
        }

    async def get_image_bytes(self, filename: str, subfolder: str, type_: str):
        return b"mp4-bytes-" + filename.encode(), "video/mp4"

    async def upload_image(self, content: bytes, filename: str) -> str:
        self.uploads.append((content, filename))
        return filename


def _fake_ffmpeg_factory(calls: list[list[str]]):
    """ffmpeg 替身:记录命令并产出非空输出文件(末帧 jpg / 最终 mp4)。"""

    async def _fake(cmd: list[str], timeout: float = 600.0) -> None:
        calls.append(cmd)
        Path(cmd[-1]).write_bytes(b"out-bytes")

    return _fake


def test_chain_trim_single_segment(tmp_path):
    """trim:下载原片 → concat(单段)+ -t 精确裁 → 上传 input 目录 → on_final 收到签名 URL。"""
    client = _FakeChainClient()
    calls: list[list[str]] = []
    finals: list[list[str]] = []
    plan = resolve_duration("h3", 6, 24)  # trim 至 6s
    assert plan.strategy == "trim"

    asyncio.run(
        vgen.run_duration_chain(
            client=client,
            plan=plan,
            first_prompt_id="pid-1",
            on_final=lambda urls: finals.append(urls) or asyncio.sleep(0),
            wait_files=vgen._wait_files,
            ffmpeg=_fake_ffmpeg_factory(calls),
        )
    )

    # 仅一次 ffmpeg(单段 concat+裁剪,无末帧抽取)
    assert len(calls) == 1
    cmd = calls[0]
    assert "concat" in cmd and "-t" in cmd
    assert cmd[cmd.index("-t") + 1] == "6.000"
    # 最终产物回传 worker input 目录,URL 带 type=input + sig
    assert len(client.uploads) == 1
    assert client.uploads[0][0] == b"out-bytes"
    assert len(finals) == 1 and len(finals[0]) == 1
    assert "type=input" in finals[0][0] and "sig=" in finals[0][0]


def test_chain_extend_two_segments(tmp_path):
    """extend:等首段 → 抽末帧 → submit_next(残段帧数)→ concat+裁剪 → 回写。"""
    client = _FakeChainClient()
    calls: list[list[str]] = []
    submitted: list[tuple[bytes, int, int]] = []
    finals: list[list[str]] = []
    plan = resolve_duration("h3", 20, 24)  # [362, 124]

    async def _submit_next(frame_bytes: bytes, frames: int, idx: int) -> str:
        submitted.append((frame_bytes, frames, idx))
        return "pid-2"

    async def _on_final(urls: list[str]) -> None:
        finals.append(urls)

    asyncio.run(
        vgen.run_duration_chain(
            client=client,
            plan=plan,
            first_prompt_id="pid-1",
            submit_next=_submit_next,
            on_final=_on_final,
            ffmpeg=_fake_ffmpeg_factory(calls),
        )
    )

    # 续段 1 次:帧数为残段 124,idx=1,末帧非空
    assert submitted == [(b"out-bytes", 124, 1)]
    # ffmpeg 两次:末帧抽取 + concat 裁剪(裁至 20s)
    assert len(calls) == 2
    assert "-sseof" in calls[0]
    assert calls[1][calls[1].index("-t") + 1] == "20.000"
    assert len(finals) == 1 and "type=input" in finals[0][0]


def test_chain_extend_requires_submit_next():
    plan = resolve_duration("h3", 20, 24)
    with pytest.raises(ValueError, match="submit_next"):
        asyncio.run(
            vgen.run_duration_chain(
                client=_FakeChainClient(), plan=plan, first_prompt_id="pid-1",
            )
        )


def test_chain_direct_noop():
    """direct 计划直接返回(不碰 worker)。"""
    plan = resolve_duration("h3", 5, 24)
    asyncio.run(
        vgen.run_duration_chain(client=None, plan=plan, first_prompt_id="pid-1")
    )


def test_wait_files_error_status_raises():
    """worker 执行报错(status_str=error)→ RuntimeError,不无限等。"""

    class _ErrClient:
        base_url = "http://w"

        async def get_history(self, prompt_id: str) -> dict:
            return {prompt_id: {"outputs": {}, "status": {"status_str": "error"}}}

    with pytest.raises(RuntimeError, match="执行失败"):
        asyncio.run(vgen._wait_files(_ErrClient(), "pid-x"))


def test_wait_files_unreachable_then_ok():
    """worker 暂不可达(ComfyUIError)重试后拿到产物。"""

    class _FlakyClient:
        base_url = "http://w"

        def __init__(self) -> None:
            self.calls = 0

        async def get_history(self, prompt_id: str) -> dict:
            self.calls += 1
            if self.calls == 1:
                raise ComfyUIError("connection refused")
            return {prompt_id: {"outputs": {"1": {"v": [{"filename": "a.mp4"}]}}, "status": {}}}

    files = asyncio.run(vgen._wait_files(_FlakyClient(), "pid-x", poll=0.01))
    assert files[0]["filename"] == "a.mp4"


def test_rewrite_job_result(monkeypatch):
    """rewrite_job_result:Job 存在 → status/result 改写;不存在 → 仅日志不炸。"""
    eng = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    SQLModel.metadata.create_all(eng)
    monkeypatch.setattr("app.db.engine", eng)
    with Session(eng) as s:
        s.add(Job(tenant_id="t", user_id="u", prompt_id="pid-r", worker="http://w",
                  kind="h3_t2v", status="done", result=json.dumps(["/api/images?old=1"])))
        s.commit()
    vgen.rewrite_job_result("pid-r", ["/api/images?new=1"])
    with Session(eng) as s:
        job = s.exec(select(Job).where(Job.prompt_id == "pid-r")).first()
        assert job.status == "done"
        assert json.loads(job.result) == ["/api/images?new=1"]
    vgen.rewrite_job_result("pid-missing", ["/x"])  # 不抛异常


# ---------------------------------------------------------------------------
# post_status 裁切链标记(挂链置位 / 成功随终产物清零 / 失败清零回落原片 / direct 不动)
# ---------------------------------------------------------------------------


def _pp_engine(monkeypatch):
    eng = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    SQLModel.metadata.create_all(eng)
    monkeypatch.setattr("app.db.engine", eng)
    return eng


def _pp_seed(eng, prompt_id: str) -> None:
    """种一条 tracker 已落库的原始产物作业(status=done + 未裁原片)。"""
    with Session(eng) as s:
        s.add(Job(tenant_id="t", user_id="u", prompt_id=prompt_id, worker="http://w",
                  kind="h3_t2v", status="done", result=json.dumps(["/raw"])))
        s.commit()


def _pp_read(eng, prompt_id: str) -> Job:
    with Session(eng) as s:
        job = s.exec(select(Job).where(Job.prompt_id == prompt_id)).first()
        assert job is not None
        return job


def test_spawn_trim_marks_then_rewrite_clears(monkeypatch):
    """trim 挂链即置 processing;链成功 rewrite 同一 commit 清零并写入终产物。"""
    eng = _pp_engine(monkeypatch)
    _pp_seed(eng, "pid-pp")
    plan = resolve_duration("h3", 6, 24)
    assert plan.strategy == "trim"

    async def _fake_chain(**kwargs):
        vgen.rewrite_job_result(kwargs["first_prompt_id"], ["/final"])

    monkeypatch.setattr(vgen, "run_duration_chain", _fake_chain)

    async def _main():
        before = set(vgen._post_tasks)
        vgen.spawn_duration_chain(client=None, plan=plan, first_prompt_id="pid-pp")
        # 同步置位(事件循环尚未调度后台任务,此刻必为 processing)
        assert _pp_read(eng, "pid-pp").post_status == "processing"
        # 只等本次 spawn 新建的任务:_post_tasks 是进程级全局集合,全量高负载下
        # 可能残留其他用例挂在已关闭/异事件循环上的任务(done 回调 discard 不一定
        # 已跑),gather 整个集合会被无关残留牵连(CancelledError/跨循环 RuntimeError)
        # ——flaky 根因。按前后差集精确取本用例的任务,确定性等待。
        new_tasks = [t for t in vgen._post_tasks if t not in before]
        assert len(new_tasks) == 1
        await asyncio.gather(*new_tasks)

    asyncio.run(_main())
    job = _pp_read(eng, "pid-pp")
    assert job.post_status == ""
    assert job.status == "done"
    assert json.loads(job.result) == ["/final"]


def test_spawn_chain_failure_clears_flag_keeps_raw(monkeypatch):
    """链异常:清零 post_status 回落原始产物,不标 error(不把事情搞砸语义)。"""
    eng = _pp_engine(monkeypatch)
    _pp_seed(eng, "pid-fail")
    plan = resolve_duration("h3", 6, 24)

    async def _boom(**kwargs):
        raise RuntimeError("ffmpeg 炸")

    monkeypatch.setattr(vgen, "run_duration_chain", _boom)

    async def _main():
        before = set(vgen._post_tasks)
        vgen.spawn_duration_chain(client=None, plan=plan, first_prompt_id="pid-fail")
        assert _pp_read(eng, "pid-fail").post_status == "processing"
        # 同上:只等本次 spawn 新建的任务,不 gather 进程级全局集合(flaky 根因)。
        new_tasks = [t for t in vgen._post_tasks if t not in before]
        assert len(new_tasks) == 1
        await asyncio.gather(*new_tasks)

    asyncio.run(_main())
    job = _pp_read(eng, "pid-fail")
    assert job.post_status == ""
    assert job.status == "done"
    assert json.loads(job.result) == ["/raw"]


def test_spawn_direct_no_mark_no_task(monkeypatch):
    """direct 计划不挂链、不置位、不建后台任务。"""
    eng = _pp_engine(monkeypatch)
    _pp_seed(eng, "pid-d")
    plan = resolve_duration("h3", 5, 24)
    assert plan.strategy == "direct"
    before = set(vgen._post_tasks)
    vgen.spawn_duration_chain(client=None, plan=plan, first_prompt_id="pid-d")
    assert set(vgen._post_tasks) == before
    assert _pp_read(eng, "pid-d").post_status == ""


def test_job_dict_exposes_post_status():
    """_job_dict 透出 post_status(无标记作业回落空串)。"""
    from app.routes.jobs import _job_dict

    job = Job(tenant_id="t", user_id="u", prompt_id="p1", worker="w", kind="h3_t2v",
              status="done", result='["/x"]', post_status="processing")
    assert _job_dict(job)["post_status"] == "processing"
    job2 = Job(tenant_id="t", user_id="u", prompt_id="p2", worker="w", kind="h3_t2v",
               status="done", result='["/x"]')
    assert _job_dict(job2)["post_status"] == ""


def test_emit_done_carries_post_status(monkeypatch):
    """done SSE 事件带 post_status:裁切链窗口期为 processing,清零后回落空串。"""
    from app.routes import jobs as jobs_route

    eng = _pp_engine(monkeypatch)
    # record_result 走 tracker.engine;_emit_done 现读走 jobs.engine —— 两处都打
    monkeypatch.setattr("app.comfy.tracker.engine", eng)
    monkeypatch.setattr("app.routes.jobs.engine", eng)
    _pp_seed(eng, "pid-e")

    class _DoneClient:
        base_url = "http://w"

        async def get_result_files(self, prompt_id: str):
            return [{"filename": "a.mp4", "subfolder": "", "type": "output"}]

    vgen.mark_post_processing("pid-e", "processing")
    event, urls = asyncio.run(jobs_route._emit_done(_DoneClient(), "pid-e"))
    payload = json.loads(event["data"])
    assert event["event"] == "done"
    assert payload["post_status"] == "processing"
    assert len(urls) == 1 and "sig=" in payload["images"][0]

    vgen.mark_post_processing("pid-e", "")
    event2, _ = asyncio.run(jobs_route._emit_done(_DoneClient(), "pid-e"))
    assert json.loads(event2["data"])["post_status"] == ""


def test_clear_stale_post_status_on_startup(monkeypatch):
    """启动自愈:processing 残留清零(重启在飞链已死);无标记作业不受影响。"""
    from app import db as app_db

    eng = _pp_engine(monkeypatch)
    _pp_seed(eng, "pid-s1")
    _pp_seed(eng, "pid-s2")
    vgen.mark_post_processing("pid-s1", "processing")
    app_db._clear_stale_post_status()
    assert _pp_read(eng, "pid-s1").post_status == ""
    assert _pp_read(eng, "pid-s2").post_status == ""


# ---------------------------------------------------------------------------
# 路由集成:H3 / R18 LTX 的 duration_sec
# ---------------------------------------------------------------------------


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


class _FakeInstanceClient:
    """专用实例替身(H3 等专用实例通用):object_info/queue_prompt/upload_image/stats。"""

    def __init__(self, base_url: str = "http://fake-inst") -> None:
        self.base_url = base_url
        self.graphs: list[dict] = []
        self.uploads: list[tuple[bytes, str]] = []

    async def object_info(self, node: str) -> dict:
        return {node: {}}

    async def queue_prompt(self, graph: dict, client_id: str) -> str:
        self.graphs.append(graph)
        return f"prompt-{len(self.graphs)}"

    async def upload_image(self, content: bytes, filename: str) -> str:
        self.uploads.append((content, filename))
        return f"up-{filename}"

    async def queue_len(self) -> int:
        return 0

    async def queue_counts(self) -> tuple[int, int]:
        return 0, 0

    async def get_system_stats(self) -> dict:
        return {
            "devices": [{
                "name": "cuda:0 FakeGPU", "type": "cuda",
                "vram_free": 96 * (1 << 30), "vram_total": 96 * (1 << 30),
            }]
        }


class _FakePool:
    def __init__(self, picked) -> None:  # noqa: ANN001
        self._picked = picked

    async def pick(self, **kwargs):  # noqa: ANN002,ANN003,ANN201
        return self._picked


def _install_h3(monkeypatch, fake: _FakeInstanceClient) -> None:
    monkeypatch.setattr(h3_service, "get_h3_client", lambda: fake)
    monkeypatch.setattr(h3_service, "spawn_tracker", lambda client, prompt_id: None)


def _capture_spawn(monkeypatch) -> list[dict]:
    """捕获 spawn_duration_chain 调用(不真跑后台链)。"""
    calls: list[dict] = []

    def _fake_spawn(**kwargs):  # noqa: ANN003,ANN201
        calls.append(kwargs)

    monkeypatch.setattr(vgen, "spawn_duration_chain", _fake_spawn)
    return calls


# ── H3 路由 ──


def test_h3_route_duration_sec_trim(client, monkeypatch):
    """H3 duration_sec=6:144→158 帧 trim,响应带 notice,挂起后处理链。"""
    c, eng = client
    with Session(eng) as s:
        uid = _seed_user(s, "dur-h3-trim")
    fake = _FakeInstanceClient("http://fake-h3")
    _install_h3(monkeypatch, fake)
    spawns = _capture_spawn(monkeypatch)
    r = c.post(
        "/api/h3/t2v",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "一只猫", "duration_sec": 6, "seed": 7},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert "精确裁至 6 秒" in body["duration_notice"]
    graph = fake.graphs[0]
    assert graph["104"]["inputs"]["length"] == 158
    assert len(spawns) == 1
    assert spawns[0]["plan"].strategy == "trim"
    assert spawns[0]["first_prompt_id"] == body["prompt_id"]


def test_h3_route_duration_sec_extend(client, monkeypatch):
    """H3 duration_sec=20:超 15s 上限 → 2 段续写计划,首段 362 帧,notice 说明。"""
    c, eng = client
    with Session(eng) as s:
        uid = _seed_user(s, "dur-h3-ext")
    fake = _FakeInstanceClient("http://fake-h3")
    _install_h3(monkeypatch, fake)
    spawns = _capture_spawn(monkeypatch)
    r = c.post(
        "/api/h3/t2v",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "一只猫", "duration_sec": 20},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert "分 2 段续写" in body["duration_notice"]
    assert fake.graphs[0]["104"]["inputs"]["length"] == 362
    assert len(spawns) == 1
    plan = spawns[0]["plan"]
    assert plan.strategy == "extend" and plan.segment_frames == (362, 124)
    assert callable(spawns[0]["submit_next"])


def test_h3_route_duration_sec_over_60_422(client, monkeypatch):
    c, eng = client
    with Session(eng) as s:
        uid = _seed_user(s, "dur-h3-max")
    _install_h3(monkeypatch, _FakeInstanceClient("http://fake-h3"))
    r = c.post(
        "/api/h3/t2v",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "一只猫", "duration_sec": 61},
    )
    assert r.status_code == 422
    assert "最长支持 60 秒" in r.json()["detail"]


def test_h3_route_legacy_length_still_works(client, monkeypatch):
    """legacy length 入参(deprecated):行为不变,无 notice,不挂后处理链。"""
    c, eng = client
    with Session(eng) as s:
        uid = _seed_user(s, "dur-h3-legacy")
    fake = _FakeInstanceClient("http://fake-h3")
    _install_h3(monkeypatch, fake)
    spawns = _capture_spawn(monkeypatch)
    r = c.post(
        "/api/h3/t2v",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "一只猫", "length": 141},
    )
    assert r.status_code == 200, r.text
    assert fake.graphs[0]["104"]["inputs"]["length"] == 141
    assert "duration_notice" not in r.json()
    assert spawns == []


def test_h3_route_duration_sec_wins_over_length(client, monkeypatch):
    """duration_sec 与 length 同给:duration_sec 优先。"""
    c, eng = client
    with Session(eng) as s:
        uid = _seed_user(s, "dur-h3-both")
    fake = _FakeInstanceClient("http://fake-h3")
    _install_h3(monkeypatch, fake)
    _capture_spawn(monkeypatch)
    r = c.post(
        "/api/h3/t2v",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "一只猫", "duration_sec": 5, "length": 362},
    )
    assert r.status_code == 200, r.text
    assert fake.graphs[0]["104"]["inputs"]["length"] == 124  # 5s → 124,非 362


def test_h3_route_default_is_5s(client, monkeypatch):
    """缺省(duration_sec/length 都不给):5s → 124 帧(与历史默认一致)。"""
    c, eng = client
    with Session(eng) as s:
        uid = _seed_user(s, "dur-h3-def")
    fake = _FakeInstanceClient("http://fake-h3")
    _install_h3(monkeypatch, fake)
    _capture_spawn(monkeypatch)
    r = c.post(
        "/api/h3/t2v",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "一只猫"},
    )
    assert r.status_code == 200, r.text
    assert fake.graphs[0]["104"]["inputs"]["length"] == 124


# ── R18 LTX 路由(/api/generate/ltx-t2v)──

_NSFW = {"X-NSFW": "1"}


def test_ltx_nsfw_route_duration_sec_direct(client, monkeypatch):
    """R18 LTX t2v 无首帧锁优先于时长计划:duration_sec 合法也 422,不提交。"""
    c, eng = client
    with Session(eng) as s:
        uid = _seed_user(s, "dur-ltx-nsfw")
    fake = _FakeInstanceClient("http://fake-worker")
    monkeypatch.setattr("app.deps.get_pool", lambda: _FakePool(fake))
    monkeypatch.setattr(video_route, "spawn_tracker", lambda client, prompt_id: None)
    spawns = _capture_spawn(monkeypatch)
    r = c.post(
        "/api/generate/ltx-t2v",
        headers={"Authorization": f"Bearer {create_token(uid)}", **_NSFW},
        json={"positive": "a", "duration_sec": 6},
    )
    assert r.status_code == 422, r.text
    assert "首帧" in r.json()["detail"]
    assert spawns == []


def test_ltx_nsfw_route_duration_sec_over_limit_422(client, monkeypatch):
    """R18 LTX t2v 无首帧锁优先:超限 duration 也先 422 首帧提示(单段上限改测 i2v)。"""
    c, eng = client
    with Session(eng) as s:
        uid = _seed_user(s, "dur-ltx-nsfw-max")
    fake = _FakeInstanceClient("http://fake-worker")
    monkeypatch.setattr("app.deps.get_pool", lambda: _FakePool(fake))
    monkeypatch.setattr(video_route, "spawn_tracker", lambda client, prompt_id: None)
    r = c.post(
        "/api/generate/ltx-t2v",
        headers={"Authorization": f"Bearer {create_token(uid)}", **_NSFW},
        json={"positive": "a", "duration_sec": 16},
    )
    assert r.status_code == 422
    assert "首帧" in r.json()["detail"]


# ---------------------------------------------------------------------------
# 路由集成:LongCat / LongCat-Avatar / Wan2.2-Animate / Wan2.1-VACE 的 duration_sec
# (2026-08-17 秒数化收口:四引擎统一策略层接入,legacy num_frames 兼容通道保留)
# ---------------------------------------------------------------------------


class _FakeSourceWorker:
    """上传落点 pool worker 替身:get_image_bytes 按扩展名返回图片/音频/视频字节。"""

    base_url = "http://fake-worker"

    async def get_image_bytes(self, filename, subfolder, type_):
        if filename.endswith((".wav", ".mp3")):
            return b"audio-bytes", "audio/wav"
        if filename.endswith((".mp4", ".webm", ".mov")):
            return b"video-bytes", "video/mp4"
        return b"img-bytes", "image/png"


def _install_longcat(monkeypatch, fake: _FakeInstanceClient) -> None:
    """LongCat 系实例替身(:8197 四引擎共用);spawn_tracker 旁路。"""
    monkeypatch.setattr(longcat_service, "get_longcat_client", lambda: fake)
    monkeypatch.setattr(longcat_service, "spawn_tracker", lambda client, prompt_id: None)


# ── LongCat t2v(/api/longcat/t2v;无网格,17-961 帧)──


def test_longcat_route_duration_sec_direct(client, monkeypatch):
    """LongCat duration_sec=7.5@16fps:120 帧 direct,无 notice,不挂链。"""
    c, eng = client
    with Session(eng) as s:
        uid = _seed_user(s, "dur-lc-direct")
    fake = _FakeInstanceClient("http://fake-longcat")
    _install_longcat(monkeypatch, fake)
    spawns = _capture_spawn(monkeypatch)
    r = c.post(
        "/api/longcat/t2v",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "a", "duration_sec": 7.5},
    )
    assert r.status_code == 200, r.text
    assert fake.graphs[0]["6"]["inputs"]["num_frames"] == 120
    assert "duration_notice" not in r.json()
    assert spawns == []


def test_longcat_route_duration_sec_trim(client, monkeypatch):
    """LongCat duration_sec=0.5:8 帧→下限 17 帧(1.06s),秒差 >0.25 → trim 链 + notice。"""
    c, eng = client
    with Session(eng) as s:
        uid = _seed_user(s, "dur-lc-trim")
    fake = _FakeInstanceClient("http://fake-longcat")
    _install_longcat(monkeypatch, fake)
    spawns = _capture_spawn(monkeypatch)
    r = c.post(
        "/api/longcat/t2v",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "a", "duration_sec": 0.5},
    )
    assert r.status_code == 200, r.text
    assert fake.graphs[0]["6"]["inputs"]["num_frames"] == 17
    assert "精确裁至 0.5 秒" in r.json()["duration_notice"]
    assert len(spawns) == 1
    assert spawns[0]["plan"].strategy == "trim"
    assert spawns[0]["first_prompt_id"] == r.json()["prompt_id"]


def test_longcat_route_duration_sec_context_notice(client, monkeypatch):
    """LongCat duration_sec=20:320 帧 >241 上下文窗口阈值 → direct + 窗口提示。"""
    c, eng = client
    with Session(eng) as s:
        uid = _seed_user(s, "dur-lc-ctx")
    fake = _FakeInstanceClient("http://fake-longcat")
    _install_longcat(monkeypatch, fake)
    spawns = _capture_spawn(monkeypatch)
    r = c.post(
        "/api/longcat/t2v",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "a", "duration_sec": 20},
    )
    assert r.status_code == 200, r.text
    assert fake.graphs[0]["6"]["inputs"]["num_frames"] == 320
    assert "上下文窗口" in r.json()["duration_notice"]
    assert spawns == []  # direct:仅提示,不挂后处理链


def test_longcat_route_duration_sec_over_limit_422(client, monkeypatch):
    """LongCat 不支持 extend:duration_sec=61@16fps=976>961 → 422 + 单段上限提示。"""
    c, eng = client
    with Session(eng) as s:
        uid = _seed_user(s, "dur-lc-max")
    _install_longcat(monkeypatch, _FakeInstanceClient("http://fake-longcat"))
    r = c.post(
        "/api/longcat/t2v",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "a", "duration_sec": 61},
    )
    assert r.status_code == 422
    assert "单段上限" in r.json()["detail"]


def test_longcat_route_default_duration(client, monkeypatch):
    """双缺省 → 默认 7.5s → 120 帧(与旧默认 121 帧等价取整)。"""
    c, eng = client
    with Session(eng) as s:
        uid = _seed_user(s, "dur-lc-def")
    fake = _FakeInstanceClient("http://fake-longcat")
    _install_longcat(monkeypatch, fake)
    r = c.post(
        "/api/longcat/t2v",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "a"},
    )
    assert r.status_code == 200, r.text
    assert fake.graphs[0]["6"]["inputs"]["num_frames"] == 120


def test_longcat_route_legacy_num_frames_still_works(client, monkeypatch):
    """legacy num_frames=121(无 duration_sec):等价 direct 计划,行为不变无 notice。"""
    c, eng = client
    with Session(eng) as s:
        uid = _seed_user(s, "dur-lc-legacy")
    fake = _FakeInstanceClient("http://fake-longcat")
    _install_longcat(monkeypatch, fake)
    spawns = _capture_spawn(monkeypatch)
    r = c.post(
        "/api/longcat/t2v",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "a", "num_frames": 121},
    )
    assert r.status_code == 200, r.text
    assert fake.graphs[0]["6"]["inputs"]["num_frames"] == 121
    assert "duration_notice" not in r.json()
    assert spawns == []


# ── LongCat-Avatar(/api/avatar/talk;4k+1 网格,17-2500 帧 @25fps)──


def _post_avatar(c, uid, **fields):
    body = {"positive": "a", "image": "f.png", "audio": "a.wav", "worker": "http://fake-worker"}
    body.update(fields)
    return c.post(
        "/api/avatar/talk",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json=body,
    )


def test_avatar_route_duration_sec_direct(client, monkeypatch):
    """Avatar duration_sec=3.7@25fps:92→4k+1 吸附 93 帧(3.72s),秒差 ≤0.25 → direct。"""
    c, eng = client
    with Session(eng) as s:
        uid = _seed_user(s, "dur-av-direct")
    fake = _FakeInstanceClient("http://fake-longcat")
    _install_longcat(monkeypatch, fake)
    monkeypatch.setattr(avatar_route, "resolve_worker", lambda w: _FakeSourceWorker())
    spawns = _capture_spawn(monkeypatch)
    r = _post_avatar(c, uid, duration_sec=3.7)
    assert r.status_code == 200, r.text
    assert fake.graphs[0]["7"]["inputs"]["num_frames"] == 93
    assert "duration_notice" not in r.json()
    assert spawns == []


def test_avatar_route_duration_sec_over_limit_422(client, monkeypatch):
    """Avatar 不支持 extend:duration_sec=101@25fps=2525>2500 → 422 + 单段上限提示。"""
    c, eng = client
    with Session(eng) as s:
        uid = _seed_user(s, "dur-av-max")
    _install_longcat(monkeypatch, _FakeInstanceClient("http://fake-longcat"))
    monkeypatch.setattr(avatar_route, "resolve_worker", lambda w: _FakeSourceWorker())
    r = _post_avatar(c, uid, duration_sec=101)
    assert r.status_code == 422
    assert "单段上限" in r.json()["detail"]


def test_avatar_route_legacy_num_frames_still_works(client, monkeypatch):
    """legacy num_frames=93(无 duration_sec):等价 direct 计划,行为不变无 notice。"""
    c, eng = client
    with Session(eng) as s:
        uid = _seed_user(s, "dur-av-legacy")
    fake = _FakeInstanceClient("http://fake-longcat")
    _install_longcat(monkeypatch, fake)
    monkeypatch.setattr(avatar_route, "resolve_worker", lambda w: _FakeSourceWorker())
    spawns = _capture_spawn(monkeypatch)
    r = _post_avatar(c, uid, num_frames=93)
    assert r.status_code == 200, r.text
    assert fake.graphs[0]["7"]["inputs"]["num_frames"] == 93
    assert "duration_notice" not in r.json()
    assert spawns == []


# ── Wan2.2-Animate / Wan2.1-VACE(/api/wan/*;4k+1 网格 @16fps)──


def test_wan_animate_route_duration_sec_grid_snap(client, monkeypatch):
    """Animate duration_sec=7.5@16fps:120→4k+1 吸附 121 帧(7.5625s),秒差 ≤0.25 → direct。"""
    c, eng = client
    with Session(eng) as s:
        uid = _seed_user(s, "dur-wa-snap")
    fake = _FakeInstanceClient("http://fake-wan")
    _install_longcat(monkeypatch, fake)
    monkeypatch.setattr(wan_route, "resolve_worker", lambda w: _FakeSourceWorker())
    spawns = _capture_spawn(monkeypatch)
    r = c.post(
        "/api/wan/animate",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "a", "image": "in.png", "video": "d.mp4",
              "worker": "http://fake-worker", "duration_sec": 7.5},
    )
    assert r.status_code == 200, r.text
    assert fake.graphs[0]["12"]["inputs"]["num_frames"] == 121
    assert "duration_notice" not in r.json()
    assert spawns == []


def test_wan_animate_route_duration_sec_over_limit_422(client, monkeypatch):
    """Animate 不支持 extend:duration_sec=32@16fps=512>501 → 422 + 单段上限提示。"""
    c, eng = client
    with Session(eng) as s:
        uid = _seed_user(s, "dur-wa-max")
    _install_longcat(monkeypatch, _FakeInstanceClient("http://fake-wan"))
    monkeypatch.setattr(wan_route, "resolve_worker", lambda w: _FakeSourceWorker())
    r = c.post(
        "/api/wan/animate",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "a", "image": "in.png", "video": "d.mp4",
              "worker": "http://fake-worker", "duration_sec": 32},
    )
    assert r.status_code == 422
    assert "单段上限" in r.json()["detail"]


def test_wan_vace_route_duration_sec_direct(client, monkeypatch):
    """VACE duration_sec=5@16fps:80→4k+1 吸附 81 帧(5.0625s),秒差 ≤0.25 → direct。"""
    c, eng = client
    with Session(eng) as s:
        uid = _seed_user(s, "dur-wv-direct")
    fake = _FakeInstanceClient("http://fake-wan")
    _install_longcat(monkeypatch, fake)
    monkeypatch.setattr(wan_route, "resolve_worker", lambda w: _FakeSourceWorker())
    spawns = _capture_spawn(monkeypatch)
    r = c.post(
        "/api/wan/vace",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "a", "images": ["r1.png"],
              "worker": "http://fake-worker", "duration_sec": 5},
    )
    assert r.status_code == 200, r.text
    assert fake.graphs[0]["10"]["inputs"]["num_frames"] == 81
    assert "duration_notice" not in r.json()
    assert spawns == []


def test_wan_vace_route_legacy_num_frames_still_works(client, monkeypatch):
    """legacy num_frames=81(无 duration_sec):等价 direct 计划,行为不变无 notice。"""
    c, eng = client
    with Session(eng) as s:
        uid = _seed_user(s, "dur-wv-legacy")
    fake = _FakeInstanceClient("http://fake-wan")
    _install_longcat(monkeypatch, fake)
    monkeypatch.setattr(wan_route, "resolve_worker", lambda w: _FakeSourceWorker())
    spawns = _capture_spawn(monkeypatch)
    r = c.post(
        "/api/wan/vace",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "a", "images": ["r1.png"],
              "worker": "http://fake-worker", "num_frames": 81},
    )
    assert r.status_code == 200, r.text
    assert fake.graphs[0]["10"]["inputs"]["num_frames"] == 81
    assert "duration_notice" not in r.json()
    assert spawns == []
