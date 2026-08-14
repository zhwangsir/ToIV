"""短剧/Studio 管线状态重算测试(services/drama_pipeline.py + 两端点)。

覆盖:
  ① 空项目 → next_step=storyboard(拆解分镜)
  ② 分镜视频部分完成 → video 阶段 partial + next_step=video 带待办 shot_ids
  ③ 本地产物 URL 存在/缺失两态(is_file 分级 ok/missing)
  ④ /api/images 代理 URL 走 Job 行判定(done→ok / 仅 error→unknown / 无 Job→unknown)
  ⑤ 分裂态 recoverable 检出(shot error 但匹配 Job done 且产物可取回)
  ⑥ 端点鉴权:401 未登录 / 404 不存在 / 404 他人项目(不泄露存在性)
  ⑦ studio next_step 纯函数:render/voice/lipsync/assemble/done/空项目/error 优先
  ⑧ studio /status 端点契约:原字段不变,追加 next_step 且 {pid} 已填充
  ⑨ 重算性能:24 分镜项目全量重算 ms 级
"""
from __future__ import annotations

import json
import time

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

import app.services.drama_pipeline as pipeline_svc
from app.db import get_session
from app.main import app
from app.models import (
    DramaProject,
    DramaShot,
    Job,
    StudioProject,
    StudioShot,
    Tenant,
    User,
)
from app.security import create_token, hash_password


@pytest.fixture()
def ctx(tmp_path):
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    SQLModel.metadata.create_all(engine)

    def override() -> Session:
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override
    with Session(engine) as s:
        tenant = Tenant(name="pipe")
        s.add(tenant)
        s.commit()
        s.refresh(tenant)
        user = User(
            email="pipe@toiv.ai",
            hashed_password=hash_password("password1"),
            tenant_id=tenant.id,
        )
        other = User(
            email="other@toiv.ai",
            hashed_password=hash_password("password1"),
            tenant_id=tenant.id,
        )
        s.add(user)
        s.add(other)
        s.commit()
        s.refresh(user)
        s.refresh(other)
        uid, other_uid, tid = user.id, other.id, tenant.id
    # 产物目录指向 tmp_path;stat 缓存每用例清空,防跨用例污染
    import app.storage as storage

    storage._drama_root_cache = None
    pipeline_svc._stat_cache.clear()
    yield TestClient(app), create_token(uid), engine, uid, other_uid, tid, tmp_path
    pipeline_svc._stat_cache.clear()
    app.dependency_overrides.clear()


def _h(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def _mk_project(engine, tid: str, uid: str, **kw) -> str:
    with Session(engine) as s:
        p = DramaProject(tenant_id=tid, user_id=uid, title="管线测试", **kw)
        s.add(p)
        s.commit()
        s.refresh(p)
        return p.id


def _mk_shot(engine, pid: str, idx: int, **kw) -> str:
    with Session(engine) as s:
        shot = DramaShot(project_id=pid, idx=idx, **kw)
        s.add(shot)
        s.commit()
        s.refresh(shot)
        return shot.id


def _mk_job(engine, tid: str, uid: str, **kw) -> str:
    with Session(engine) as s:
        j = Job(tenant_id=tid, user_id=uid, prompt_id="p-" + uid[:6], worker="w1", **kw)
        s.add(j)
        s.commit()
        s.refresh(j)
        return j.id


_HEX32 = "a1b2c3d4e5f60718293a4b5c6d7e8f90"


# ── ① 空项目:next_step=storyboard ─────────────────────────────────────────


def test_empty_project_next_step_storyboard(ctx):
    client, token, engine, uid, _, tid, _ = ctx
    pid = _mk_project(engine, tid, uid)
    r = client.get(f"/api/drama/projects/{pid}/pipeline/status", headers=_h(token))
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["next_step"]["step"] == "storyboard"
    assert data["next_step"]["label"] == "拆解分镜"
    assert data["next_step"]["action"] == f"/drama/projects/{pid}/storyboard"
    assert data["stages"]["storyboard"]["status"] == "pending"
    assert data["stages"]["video"]["status"] == "done"  # 无分镜=无可做,skipped 语义
    assert data["recoverable"] == []
    assert "generated_at" in data and data["elapsed_ms"] >= 0


# ── ② 分镜部分完成:partial + next_step=video ──────────────────────────────


def test_partial_video_next_step(ctx, monkeypatch, tmp_path):
    client, token, engine, uid, _, tid, _ = ctx
    monkeypatch.setattr(pipeline_svc, "drama_output_root", lambda: tmp_path)
    pid = _mk_project(engine, tid, uid, script="夜雨重逢")
    # 分镜 0:视频已完成(本地产物真实存在);分镜 1:未开始;均无台词(配音链 skipped)
    name0 = f"drama-{_HEX32}.mp4"
    (tmp_path / name0).write_bytes(b"mp4")
    _mk_shot(engine, pid, 0, prompt="rain alley", video_status="done",
             video_url=f"/api/drama/output/{name0}", seed=11)
    sid1 = _mk_shot(engine, pid, 1, prompt="close up", seed=22)

    r = client.get(f"/api/drama/projects/{pid}/pipeline/status", headers=_h(token))
    data = r.json()
    assert data["stages"]["storyboard"]["status"] == "done"
    video = data["stages"]["video"]
    assert video["status"] == "partial"
    assert video["detail"]["done"] == 1 and video["detail"]["total"] == 2
    assert video["detail"]["artifacts"]["ok"] == 1
    assert data["stages"]["voice"]["status"] == "done"  # 无台词 → skipped
    assert data["stages"]["voice"]["detail"]["skipped"] is True
    ns = data["next_step"]
    assert ns["step"] == "video"
    assert ns["shot_ids"] == [sid1]
    assert ns["action"] == f"/drama/shots/{sid1}/generate-video"


# ── ③ 本地文件存在/缺失两态 ────────────────────────────────────────────────


def test_local_artifact_ok_and_missing(ctx, monkeypatch, tmp_path):
    _, _, engine, uid, _, tid, _ = ctx
    monkeypatch.setattr(pipeline_svc, "drama_output_root", lambda: tmp_path)
    pid = _mk_project(engine, tid, uid)
    name_ok = f"drama-{_HEX32}.mp4"
    (tmp_path / name_ok).write_bytes(b"mp4")
    name_lost = "drama-" + "f" * 32 + ".mp4"
    _mk_shot(engine, pid, 0, video_status="done", video_url=f"/api/drama/output/{name_ok}")
    sid_lost = _mk_shot(
        engine, pid, 1, video_status="done", video_url=f"/api/drama/output/{name_lost}"
    )
    with Session(engine) as s:
        data = pipeline_svc.compute_drama_pipeline_status(s, pid)
    video = data["stages"]["video"]
    # 状态列 done 即计入完成;产物缺失在 detail 点名,不阻塞阶段
    assert video["status"] == "done"
    assert video["detail"]["artifacts"] == {"ok": 1, "missing": 1, "unknown": 0}
    assert video["detail"]["missing_shot_ids"] == [sid_lost]


def test_assemble_artifact_missing_marks_error(ctx, monkeypatch, tmp_path):
    """成片 URL 在但文件丢了 → assemble 阶段 error(漂移标红),next_step=assemble。"""
    _, _, engine, uid, _, tid, _ = ctx
    monkeypatch.setattr(pipeline_svc, "drama_output_root", lambda: tmp_path)
    name = f"drama-{_HEX32}.mp4"
    (tmp_path / name).write_bytes(b"mp4")
    pid = _mk_project(
        engine, tid, uid, video_url="/api/drama/output/drama-" + "0" * 32 + ".mp4"
    )
    # 前置阶段全部 done(分镜视频已完成且产物在),assemble 漂移才能轮到它报 error
    _mk_shot(engine, pid, 0, video_status="done", video_url=f"/api/drama/output/{name}")
    with Session(engine) as s:
        data = pipeline_svc.compute_drama_pipeline_status(s, pid)
    assert data["stages"]["assemble"]["status"] == "error"
    assert data["stages"]["assemble"]["detail"]["artifact"] == "missing"
    assert data["next_step"]["step"] == "assemble"


# ── ④ /api/images URL 走 Job 行判定 ────────────────────────────────────────


def test_images_url_job_verdicts(ctx):
    _, _, engine, uid, _, tid, _ = ctx
    pid = _mk_project(engine, tid, uid)
    # done Job 且 result 含 filename → ok
    _mk_job(
        engine, tid, uid, kind="drama_shot_video", status="done",
        result=json.dumps(["/api/images?filename=a.mp4&worker=w1"]),
    )
    # 仅 error Job(产物没落盘)→ unknown
    _mk_job(
        engine, tid, uid, kind="drama_shot_video", status="error",
        result=json.dumps(["/api/images?filename=b.mp4&worker=w1"]),
    )
    _mk_shot(
        engine, pid, 0, video_status="done",
        video_url="/api/images?filename=a.mp4&worker=w1",
    )
    _mk_shot(
        engine, pid, 1, video_status="done",
        video_url="/api/images?filename=b.mp4&worker=w1",
    )
    _mk_shot(
        engine, pid, 2, video_status="done",
        video_url="/api/images?filename=c.mp4&worker=w1",  # 无任何 Job → unknown
    )
    with Session(engine) as s:
        data = pipeline_svc.compute_drama_pipeline_status(s, pid)
    artifacts = data["stages"]["video"]["detail"]["artifacts"]
    assert artifacts == {"ok": 1, "missing": 0, "unknown": 2}
    # unknown 不阻塞:状态列全 done → 阶段 done
    assert data["stages"]["video"]["status"] == "done"


def test_images_url_other_user_job_not_counted(ctx):
    """Job 行按 tenant+user 归属匹配:他人同名产物不算数(防串号误判 ok)。"""
    _, _, engine, uid, other_uid, tid, _ = ctx
    pid = _mk_project(engine, tid, uid)
    _mk_job(
        engine, tid, other_uid, kind="drama_shot_video", status="done",
        result=json.dumps(["/api/images?filename=a.mp4&worker=w1"]),
    )
    _mk_shot(
        engine, pid, 0, video_status="done",
        video_url="/api/images?filename=a.mp4&worker=w1",
    )
    with Session(engine) as s:
        data = pipeline_svc.compute_drama_pipeline_status(s, pid)
    assert data["stages"]["video"]["detail"]["artifacts"]["unknown"] == 1
    assert data["stages"]["video"]["detail"]["artifacts"]["ok"] == 0


# ── ⑤ 分裂态 recoverable 检出 ──────────────────────────────────────────────


def test_recoverable_detected(ctx):
    _, _, engine, uid, _, tid, _ = ctx
    pid = _mk_project(engine, tid, uid)
    # shot 标 error,但同 seed+prompt 的 drama_shot_video Job 已 done 且产物可取回
    job_id = _mk_job(
        engine, tid, uid, kind="drama_shot_video_v2", status="done", seed=42,
        prompt="1boy, rain, cinematic",
        result=json.dumps(["/api/images?filename=rec.mp4&worker=w1"]),
    )
    sid = _mk_shot(
        engine, pid, 0, prompt="1boy, rain, cinematic", seed=42,
        video_status="error", error="worker 超时",
    )
    # 分镜 1:同样 error,但 Job 不匹配(seed 不同)→ 不可恢复
    _mk_shot(engine, pid, 1, prompt="other", seed=99, video_status="error")
    with Session(engine) as s:
        data = pipeline_svc.compute_drama_pipeline_status(s, pid)
    rec = data["recoverable"]
    assert len(rec) == 1
    assert rec[0]["shot_id"] == sid and rec[0]["job_id"] == job_id
    assert rec[0]["chain"] == "video"
    assert "rec.mp4" in rec[0]["url"]
    # 视频链有 error → 阶段 error,next_step 先救火
    assert data["stages"]["video"]["status"] == "error"
    assert data["next_step"]["step"] == "video"


def test_recoverable_requires_done_job(ctx):
    """匹配 Job 仍是 running → 不算 recoverable(任务可能真还在跑)。"""
    _, _, engine, uid, _, tid, _ = ctx
    pid = _mk_project(engine, tid, uid)
    _mk_job(
        engine, tid, uid, kind="drama_shot_video", status="running", seed=42,
        prompt="p", result="",
    )
    _mk_shot(engine, pid, 0, prompt="p", seed=42, video_status="error")
    with Session(engine) as s:
        data = pipeline_svc.compute_drama_pipeline_status(s, pid)
    assert data["recoverable"] == []


# ── ⑥ 端点鉴权:401/404/归属 ────────────────────────────────────────────────


def test_endpoint_auth_and_ownership(ctx):
    client, token, engine, uid, other_uid, tid, _ = ctx
    pid = _mk_project(engine, tid, uid)
    other_pid = _mk_project(engine, tid, other_uid)
    # 未登录 → 401/403
    assert client.get(f"/api/drama/projects/{pid}/pipeline/status").status_code in (401, 403)
    # 不存在的项目 → 404
    assert (
        client.get("/api/drama/projects/nope/pipeline/status", headers=_h(token)).status_code
        == 404
    )
    # 他人项目 → 404(不泄露存在性)
    assert (
        client.get(f"/api/drama/projects/{other_pid}/pipeline/status", headers=_h(token)).status_code
        == 404
    )


# ── ⑦ studio next_step 纯函数 ──────────────────────────────────────────────


def _studio_shot(idx: int, status: str) -> StudioShot:
    return StudioShot(project_id="p1", idx=idx, status=status)


def test_studio_next_step_pure_function():
    # 空项目 → render
    ns = pipeline_svc.compute_studio_next_step([])
    assert ns["step"] == "render" and ns["todo"] == 0
    # 全 draft → render
    ns = pipeline_svc.compute_studio_next_step([_studio_shot(0, "draft"), _studio_shot(1, "draft")])
    assert ns["step"] == "render" and ns["todo"] == 2
    # 全 rendered → voice
    ns = pipeline_svc.compute_studio_next_step(
        [_studio_shot(0, "rendered"), _studio_shot(1, "rendered")]
    )
    assert ns["step"] == "voice" and ns["todo"] == 2
    # 全 voiced → lipsync
    ns = pipeline_svc.compute_studio_next_step([_studio_shot(0, "voiced")])
    assert ns["step"] == "lipsync"
    # 全 lipsynced → assemble
    ns = pipeline_svc.compute_studio_next_step([_studio_shot(0, "lipsynced")])
    assert ns["step"] == "assemble"
    # 全 done → done
    ns = pipeline_svc.compute_studio_next_step([_studio_shot(0, "done")])
    assert ns["step"] == "done" and ns["action"] == ""
    # error 优先:只有渲染段会置 error(orchestrator),error 分镜排首位
    err_shot = _studio_shot(1, "error")
    ns = pipeline_svc.compute_studio_next_step([_studio_shot(0, "voiced"), err_shot])
    assert ns["step"] == "render"
    assert ns["shot_ids"][0] == err_shot.id
    assert ns["action"] == "/studio/projects/{pid}/render"


# ── ⑧ studio /status 端点契约:原字段不变 + next_step 追加 ──────────────────


def test_studio_status_endpoint_keeps_contract(ctx):
    client, token, engine, uid, _, tid, _ = ctx
    with Session(engine) as s:
        p = StudioProject(tenant_id=tid, user_id=uid, title="工作室")
        s.add(p)
        s.commit()
        s.refresh(p)
        pid = p.id
        s.add(StudioShot(project_id=pid, idx=0, status="rendered"))
        s.add(StudioShot(project_id=pid, idx=1, status="draft"))
        s.commit()
    r = client.get(f"/api/studio/projects/{pid}/status", headers=_h(token))
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["total"] == 2
    assert data["by_status"] == {"rendered": 1, "draft": 1}
    ns = data["next_step"]
    assert ns["step"] == "render"  # draft 镜未过渲染段
    assert "{pid}" not in ns["action"]
    assert ns["action"] == f"/studio/projects/{pid}/render"


# ── ⑨ 重算性能:24 分镜 ms 级 ───────────────────────────────────────────────


def test_recompute_performance_ms_level(ctx, monkeypatch, tmp_path):
    _, _, engine, uid, _, tid, _ = ctx
    monkeypatch.setattr(pipeline_svc, "drama_output_root", lambda: tmp_path)
    pid = _mk_project(engine, tid, uid, script="性能")
    for i in range(24):
        name = f"drama-{i:032x}.mp4"
        (tmp_path / name).write_bytes(b"x")
        _mk_shot(
            engine, pid, i, prompt=f"shot {i}", dialogue=f"台词{i}",
            video_status="done", video_url=f"/api/drama/output/{name}",
            voice_status="done", voice_url=f"/api/drama/voice/voice-{i:032x}.wav",
        )
    with Session(engine) as s:
        t0 = time.perf_counter()
        data = pipeline_svc.compute_drama_pipeline_status(s, pid)
        wall_ms = (time.perf_counter() - t0) * 1000
    # 24 分镜 × 本地 stat(带缓存)应在 ms 级;阈值放宽防 CI 抖动,实测值记录于日志
    assert wall_ms < 1000, f"重算耗时 {wall_ms:.1f}ms 超预期"
    assert data["elapsed_ms"] < 1000
    assert data["stages"]["video"]["detail"]["artifacts"]["ok"] == 24
    # voice 产物未落盘 → missing 24,但阶段仍 done(状态列为准)
    assert data["stages"]["voice"]["detail"]["artifacts"]["missing"] == 24
    assert data["stages"]["voice"]["status"] == "done"
    # 全链 done 且有台词 → lipsync 前置就绪未启用,next_step=lipsync(可选链建议)
    assert data["next_step"]["step"] == "lipsync"
    assert len(data["next_step"]["shot_ids"]) == 20  # 上限 20
