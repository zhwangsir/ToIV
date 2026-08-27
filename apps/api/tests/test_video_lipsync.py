"""通用对口型(POST /api/video/lipsync)测试(mock LatentSync agent HTTP,不触真机)。

覆盖:
  · 503:lipsync_url 空(未部署)
  · 契约:401 未认证 / video·audio 外部 URL 非白名单 400 / 未知本地前缀 422 /
    音频非法名 422、缺失 404 / 视频缺失 404 / inference_steps 越界 422
  · 归属:/api/images 源他人产物无 sig → 404(属主隔离);R18 源 + 专区上下文 → nsfw 继承
  · 下载失败:video/audio _fetch 异常 → 400
  · agent:上传 500 → 502 / 不可达 → 502 / 提交成功 → 建档 Job(kind=lipsync,
    status=processing, params 溯源含 task_id/output;上传两次 type=video/audio)
  · 后台轮询:succeeded 非 degraded → 产物落盘 + Job done + result URL;
    degraded → error(原因「推理降级…原视频副本」,零产物不造假);
    failed → error;轮询超时 → error
  · 产物端点:200 / 206 Range / 非法名 400 / 不存在 404 / 401
"""
from __future__ import annotations

import contextlib
import json
import time
from pathlib import Path

import anyio.from_thread
import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

import app.db as app_db
import app.services.video_upscale as upscale_svc
from app.db import get_session
from app.main import app
from app.models import Job, Tenant, User
from app.routes import video_lipsync as vl
from app.security import create_token, hash_password

_MP4 = b"\x00\x00\x00\x18ftypmp42" + b"\x00" * 200
_WAV = b"RIFF" + b"\x00" * 100


# ---------------------------------------------------------------------------
# agent 替身
# ---------------------------------------------------------------------------
class _Resp:
    def __init__(self, status_code: int = 200, payload: dict | None = None, content: bytes = b""):
        self.status_code = status_code
        self._payload = payload or {}
        self.content = content
        self.text = "" if status_code == 200 else "upstream error"

    def json(self) -> dict:
        return self._payload


class _FakeAgent:
    """LatentSync agent 替身:按 URL 路由;类属性预置响应/异常,测试间重置。"""

    uploads: list = []
    submits: list = []
    statuses: list = [{"status": "succeeded", "degraded": False, "progress": 1.0}]
    result_payload: dict = {"video_url": "/files/output/out.mp4", "duration_seconds": 5.0}
    result_bytes: bytes = _MP4
    fail: Exception | None = None
    upload_status: int = 200
    submit_status: int = 200

    def __init__(self, *a, **k):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        pass

    async def post(self, url: str, files=None, data=None, json=None):
        if type(self).fail is not None:
            raise type(self).fail
        if url.endswith("/v1/video/upload"):
            type(self).uploads.append(dict(data or {}))
            if type(self).upload_status != 200:
                return _Resp(status_code=type(self).upload_status, payload={"detail": "upload boom"})
            fn = f"up-{len(type(self).uploads)}-{(data or {}).get('type')}.bin"
            return _Resp(payload={"filename": fn})
        if url.endswith("/v1/lipsync/submit"):
            type(self).submits.append(dict(json or {}))
            if type(self).submit_status != 200:
                return _Resp(status_code=type(self).submit_status, payload={"detail": "submit boom"})
            return _Resp(payload={"task_id": "task-1"})
        raise AssertionError(f"unexpected POST {url}")

    async def get(self, url: str, timeout=None):
        if type(self).fail is not None:
            raise type(self).fail
        if "/v1/lipsync/status/" in url:
            seq = type(self).statuses
            item = seq.pop(0) if len(seq) > 1 else seq[-1]
            return _Resp(payload=item)
        if "/v1/lipsync/result/" in url:
            return _Resp(payload=type(self).result_payload)
        if "/files/output/" in url:
            return _Resp(content=type(self).result_bytes)
        raise AssertionError(f"unexpected GET {url}")


@pytest.fixture(autouse=True)
def _reset_agent():
    _FakeAgent.uploads = []
    _FakeAgent.submits = []
    _FakeAgent.statuses = [{"status": "succeeded", "degraded": False, "progress": 1.0}]
    _FakeAgent.result_payload = {"video_url": "/files/output/out.mp4", "duration_seconds": 5.0}
    _FakeAgent.result_bytes = _MP4
    _FakeAgent.fail = None
    _FakeAgent.upload_status = 200
    _FakeAgent.submit_status = 200
    yield


class _Settings:
    lipsync_url = "http://lipsync.test:9103"


@pytest.fixture()
def ctx(tmp_path, monkeypatch):
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    SQLModel.metadata.create_all(engine)

    def override():
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override
    with Session(engine) as s:
        tenant = Tenant(name="ls")
        s.add(tenant)
        s.commit()
        s.refresh(tenant)
        user = User(
            email="ls@toiv.ai",
            hashed_password=hash_password("password1"),
            tenant_id=tenant.id,
        )
        s.add(user)
        s.commit()
        s.refresh(user)
        uid = user.id

    # 后台任务 _set_job 走 app.db.engine(晚绑定) → 指到同一内存库
    monkeypatch.setattr(app_db, "engine", engine)
    # agent 基址 + HTTP 替身 + 轮询提速
    monkeypatch.setattr(vl, "get_settings", lambda: _Settings())
    monkeypatch.setattr("httpx.AsyncClient", _FakeAgent)
    monkeypatch.setattr(vl, "_POLL_INTERVAL", 0.01)
    # 存储:产物根 / 音频本地源 / 视频源(超分产物)全部指向 tmp
    monkeypatch.setattr(vl, "content_subdir", lambda sub: tmp_path / sub)
    monkeypatch.setattr(upscale_svc, "product_root", lambda: tmp_path)
    # 持久门户:裸 TestClient 每请求建/毁一次事件循环(starlette 1.3 _portal_factory),
    # 响应返回后定时器再不触发,后台轮询任务永不推进;手工建常驻 portal 赋给 client
    # (复用循环且不触发 lifespan,避免 init_db/reconcile 污染真实库)。
    portal_stack = contextlib.ExitStack()
    portal = portal_stack.enter_context(anyio.from_thread.start_blocking_portal())
    client = TestClient(app)
    client.portal = portal
    yield client, create_token(uid), engine, uid, tmp_path
    app.dependency_overrides.clear()
    portal_stack.close()


def _h(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def _video_url(tmp_path: Path, content: bytes = _MP4) -> str:
    """造一个本地视频来源(超分产物 URL 形态)。"""
    name = "upscale-" + "a" * 32 + ".mp4"
    (tmp_path / name).write_bytes(content)
    return f"/api/video/upscale/output/{name}"


def _audio_url(tmp_path: Path, content: bytes = _WAV) -> str:
    """造一个本地音频来源(TTS 配音产物 URL 形态)。"""
    d = tmp_path / "manju"
    d.mkdir(parents=True, exist_ok=True)
    name = "voice-" + "b" * 32 + ".wav"
    (d / name).write_bytes(content)
    return f"/api/manju/voice/{name}"


def _wait_terminal(engine, prompt_id: str, timeout: float = 10.0) -> Job:
    """等后台任务落终态(TestClient 门户循环在独立线程,真实 sleep 让步)。"""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        with Session(engine) as s:
            job = s.exec(select(Job).where(Job.prompt_id == prompt_id)).first()
        if job is not None and job.status in ("done", "error"):
            return job
        time.sleep(0.02)
    raise AssertionError(f"作业 {prompt_id} 未在 {timeout}s 内落终态")


# ---------------------------------------------------------------------------
# 未部署 / 契约校验
# ---------------------------------------------------------------------------


def test_disabled_503(ctx, monkeypatch):
    class _S(_Settings):
        lipsync_url = ""

    monkeypatch.setattr(vl, "get_settings", lambda: _S())
    client, token, *_ = ctx
    r = client.post(
        "/api/video/lipsync", headers=_h(token),
        json={"video_url": "/api/video/upscale/output/x.mp4", "audio_url": "/api/manju/voice/x.wav"},
    )
    assert r.status_code == 503
    assert "未配置" in r.json()["detail"]


def test_endpoint_requires_auth(ctx):
    client, *_ = ctx
    r = client.post("/api/video/lipsync", json={"video_url": "/x.mp4", "audio_url": "/y.wav"})
    assert r.status_code == 401


def test_steps_out_of_range_422(ctx):
    client, token, *_ = ctx
    r = client.post(
        "/api/video/lipsync", headers=_h(token),
        json={"video_url": "/x.mp4", "audio_url": "/y.wav", "inference_steps": 500},
    )
    assert r.status_code == 422


def test_video_external_not_whitelisted_400(ctx):
    client, token, *_ = ctx
    r = client.post(
        "/api/video/lipsync", headers=_h(token),
        json={"video_url": "http://evil.example.com/x.mp4", "audio_url": "/y.wav"},
    )
    assert r.status_code == 400
    assert "白名单" in r.json()["detail"]


def test_audio_external_not_whitelisted_400(ctx, tmp_path):
    client, token, *_ = ctx
    r = client.post(
        "/api/video/lipsync", headers=_h(token),
        json={"video_url": _video_url(tmp_path), "audio_url": "http://evil.example.com/x.wav"},
    )
    assert r.status_code == 400
    assert "白名单" in r.json()["detail"]


def test_video_unknown_prefix_422(ctx):
    client, token, *_ = ctx
    r = client.post(
        "/api/video/lipsync", headers=_h(token),
        json={"video_url": "/api/unknown/x.mp4", "audio_url": "/y.wav"},
    )
    assert r.status_code == 422


def test_audio_unknown_prefix_422(ctx, tmp_path):
    client, token, *_ = ctx
    r = client.post(
        "/api/video/lipsync", headers=_h(token),
        json={"video_url": _video_url(tmp_path), "audio_url": "/api/dub/files/x.wav"},
    )
    assert r.status_code == 422


def test_audio_bad_name_422(ctx, tmp_path):
    client, token, *_ = ctx
    r = client.post(
        "/api/video/lipsync", headers=_h(token),
        json={"video_url": _video_url(tmp_path), "audio_url": "/api/manju/voice/..%2Fetc.wav"},
    )
    assert r.status_code == 422


def test_audio_missing_file_404(ctx, tmp_path):
    client, token, *_ = ctx
    r = client.post(
        "/api/video/lipsync", headers=_h(token),
        json={"video_url": _video_url(tmp_path),
              "audio_url": "/api/manju/voice/voice-" + "c" * 32 + ".wav"},
    )
    assert r.status_code == 404


def test_video_missing_file_404(ctx, tmp_path):
    client, token, *_ = ctx
    r = client.post(
        "/api/video/lipsync", headers=_h(token),
        json={"video_url": "/api/video/upscale/output/upscale-" + "d" * 32 + ".mp4",
              "audio_url": _audio_url(tmp_path)},
    )
    assert r.status_code == 404


# ---------------------------------------------------------------------------
# 归属 / 下载失败
# ---------------------------------------------------------------------------


def test_images_source_other_user_404(ctx, tmp_path):
    """他人 /api/images 产物(无 sig)→ 404,不泄露存在性(属主隔离)。"""
    client, token, engine, uid, tmp_path = ctx
    with Session(engine) as s:
        tenant2 = Tenant(name="other")
        s.add(tenant2)
        s.commit()
        s.refresh(tenant2)
        other = User(email="other@toiv.ai", hashed_password=hash_password("password1"),
                     tenant_id=tenant2.id)
        s.add(other)
        s.commit()
        s.refresh(other)
        s.add(Job(
            tenant_id=tenant2.id, user_id=other.id, prompt_id="p-other",
            worker="http://w", kind="txt2video", status="done", seed=1,
            result=json.dumps(["/api/images?filename=other.mp4&worker=http://w"]),
        ))
        s.commit()
    r = client.post(
        "/api/video/lipsync", headers=_h(token),
        json={"video_url": "/api/images?filename=other.mp4&subfolder=&type=output&worker=http://w",
              "audio_url": _audio_url(tmp_path)},
    )
    assert r.status_code == 404


def test_video_download_failure_400(ctx, monkeypatch, tmp_path):
    client, token, *_ = ctx

    async def _boom(url, dest):
        raise upscale_svc.VideoUpscaleError("源视频下载失败(同机 worker 均不可达)")

    monkeypatch.setattr(upscale_svc, "_fetch_source_local", _boom)
    r = client.post(
        "/api/video/lipsync", headers=_h(token),
        json={"video_url": _video_url(tmp_path), "audio_url": _audio_url(tmp_path)},
    )
    assert r.status_code == 400
    assert "视频下载失败" in r.json()["detail"]


def test_audio_download_failure_400(ctx, monkeypatch, tmp_path):
    client, token, engine, uid, tmp_path = ctx

    async def _boom(url, dest):
        raise upscale_svc.VideoUpscaleError("源音频下载失败")

    monkeypatch.setattr(upscale_svc, "_fetch_source_local", _boom)
    # 音频走 /api/images 形态才会经 _fetch_source_local;先建本人 Job 过归属校验
    with Session(engine) as s:
        user = s.get(User, uid)
        s.add(Job(
            tenant_id=user.tenant_id, user_id=uid, prompt_id="p-audio",
            worker="http://w", kind="avatar_talk", status="done", seed=1,
            result=json.dumps(["/api/images?filename=ref.wav&worker=http://w"]),
        ))
        s.commit()
    r = client.post(
        "/api/video/lipsync", headers=_h(token),
        json={"video_url": _video_url(tmp_path),
              "audio_url": "/api/images?filename=ref.wav&subfolder=&type=output&worker=http://w"},
    )
    assert r.status_code == 400
    assert "音频下载失败" in r.json()["detail"]


# ---------------------------------------------------------------------------
# agent 上传/提交
# ---------------------------------------------------------------------------


def test_upload_failure_502(ctx, tmp_path):
    client, token, *_ = ctx
    _FakeAgent.upload_status = 500
    r = client.post(
        "/api/video/lipsync", headers=_h(token),
        json={"video_url": _video_url(tmp_path), "audio_url": _audio_url(tmp_path)},
    )
    assert r.status_code == 502
    assert "上传失败" in r.json()["detail"]


def test_agent_unreachable_502(ctx, tmp_path):
    import httpx

    client, token, *_ = ctx
    _FakeAgent.fail = httpx.ConnectError("refused")
    r = client.post(
        "/api/video/lipsync", headers=_h(token),
        json={"video_url": _video_url(tmp_path), "audio_url": _audio_url(tmp_path)},
    )
    assert r.status_code == 502
    assert "不可达" in r.json()["detail"]


def test_submit_creates_processing_job(ctx, tmp_path):
    """提交成功:两源各上传一次(type=video/audio)→ submit 参数透传 →
    Job(kind=lipsync, processing, params 含 task_id/output/两源 URL)。"""
    client, token, engine, uid, tmp_path = ctx
    v_url, a_url = _video_url(tmp_path), _audio_url(tmp_path)
    # 多轮 pending 后才 succeeded:断言 processing 的窗口内后台不会抢先落终态
    _FakeAgent.statuses = [{"status": "pending", "progress": 0.0}] * 30 + [
        {"status": "succeeded", "degraded": False, "progress": 1.0}
    ]
    r = client.post(
        "/api/video/lipsync", headers=_h(token),
        json={"video_url": v_url, "audio_url": a_url,
              "inference_steps": 30, "guidance_scale": 2.0},
    )
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["kind"] == "lipsync" and data["status"] == "processing"
    assert data["task_id"] == "task-1" and data["job_id"]

    # 上传契约:两次 /v1/video/upload,type 分别为 video/audio
    assert [u["type"] for u in _FakeAgent.uploads] == ["video", "audio"]
    # 提交契约:filename 来自上传响应,参数透传
    sub = _FakeAgent.submits[0]
    # 字段名与 serve_api.py 真实契约一致(video/audio,2026-08-27 生产 400 实证)
    assert sub["video"] == "up-1-video.bin"
    assert sub["audio"] == "up-2-audio.bin"
    assert sub["inference_steps"] == 30 and sub["guidance_scale"] == 2.0

    with Session(engine) as s:
        job = s.exec(select(Job).where(Job.kind == "lipsync")).first()
    assert job is not None and job.status == "processing"
    # 视频源为无登记源 Job 的超分产物 URL → 按 nsfw 继承纪律保守置 True(2026-08-27 T0)
    assert job.user_id == uid and job.nsfw is True
    params = json.loads(job.params)
    assert params["video_url"] == v_url and params["audio_url"] == a_url
    assert params["task_id"] == "task-1"
    assert params["output"].startswith("lipsync-") and params["output"].endswith(".mp4")
    assert params["inference_steps"] == 30

    # 后台继续推进:30 轮 pending 后 succeeded → done(不留悬挂任务)
    assert _wait_terminal(engine, data["prompt_id"]).status == "done"


# ---------------------------------------------------------------------------
# 后台轮询终态
# ---------------------------------------------------------------------------


def test_poll_success_lands_product_and_done(ctx, tmp_path):
    """pending → running → succeeded(非 degraded):产物落盘 + Job done + result URL。"""
    client, token, engine, uid, tmp_path = ctx
    _FakeAgent.statuses = [
        {"status": "pending", "progress": 0.0},
        {"status": "running", "progress": 0.4},
        {"status": "succeeded", "degraded": False, "progress": 1.0},
    ]
    r = client.post(
        "/api/video/lipsync", headers=_h(token),
        json={"video_url": _video_url(tmp_path), "audio_url": _audio_url(tmp_path)},
    )
    assert r.status_code == 200, r.text
    job = _wait_terminal(engine, r.json()["prompt_id"])
    assert job.status == "done"
    urls = json.loads(job.result)
    assert len(urls) == 1 and urls[0].startswith("/api/video/lipsync/output/lipsync-")

    # 产物真落盘且可回读(Range)
    name = urls[0].rsplit("/", 1)[-1]
    assert (tmp_path / "lipsync" / name).read_bytes() == _MP4
    r2 = client.get(urls[0], headers=_h(token))
    assert r2.status_code == 200
    assert r2.headers["Accept-Ranges"] == "bytes"
    assert r2.headers["Content-Type"] == "video/mp4"


def test_poll_degraded_marks_error_no_faking(ctx, tmp_path):
    """succeeded 但 degraded=true(agent 返回原视频副本)→ error,零产物不造假。"""
    client, token, engine, uid, tmp_path = ctx
    _FakeAgent.statuses = [{"status": "succeeded", "degraded": True, "progress": 1.0}]
    r = client.post(
        "/api/video/lipsync", headers=_h(token),
        json={"video_url": _video_url(tmp_path), "audio_url": _audio_url(tmp_path)},
    )
    job = _wait_terminal(engine, r.json()["prompt_id"])
    assert job.status == "error"
    assert "推理降级" in job.hold_reason and "原视频副本" in job.hold_reason
    assert job.result in ("", "[]")  # 不建档
    assert not list((tmp_path / "lipsync").glob("*.mp4"))  # 原视频副本不落产物库


def test_poll_failed_marks_error(ctx, tmp_path):
    client, token, engine, uid, tmp_path = ctx
    _FakeAgent.statuses = [{"status": "failed", "error": "no face detected"}]
    r = client.post(
        "/api/video/lipsync", headers=_h(token),
        json={"video_url": _video_url(tmp_path), "audio_url": _audio_url(tmp_path)},
    )
    job = _wait_terminal(engine, r.json()["prompt_id"])
    assert job.status == "error"
    assert "推理失败" in job.hold_reason and "no face detected" in job.hold_reason


def test_poll_timeout_marks_error(ctx, monkeypatch, tmp_path):
    client, token, engine, uid, tmp_path = ctx
    monkeypatch.setattr(vl, "_POLL_TIMEOUT", 0.15)
    _FakeAgent.statuses = [{"status": "pending", "progress": 0.0}]
    r = client.post(
        "/api/video/lipsync", headers=_h(token),
        json={"video_url": _video_url(tmp_path), "audio_url": _audio_url(tmp_path)},
    )
    job = _wait_terminal(engine, r.json()["prompt_id"])
    assert job.status == "error"
    assert "超时" in job.hold_reason


def test_nsfw_inherited_from_source(ctx, monkeypatch, tmp_path):
    """R18 /api/images 源 + 专区上下文:新作业继承 nsfw=True。"""
    client, token, engine, uid, tmp_path = ctx
    with Session(engine) as s:
        user = s.get(User, uid)
        s.add(Job(
            tenant_id=user.tenant_id, user_id=uid, prompt_id="p-r18",
            worker="http://w", kind="avatar_talk", status="done", seed=1, nsfw=True,
            result=json.dumps(["/api/images?filename=r18.mp4&worker=http://w"]),
        ))
        s.commit()

    async def _fake_fetch(url, dest):
        dest.write_bytes(_MP4)

    monkeypatch.setattr(upscale_svc, "_fetch_source_local", _fake_fetch)
    r = client.post(
        "/api/video/lipsync", headers={**_h(token), "X-NSFW": "1"},
        json={"video_url": "/api/images?filename=r18.mp4&subfolder=&type=output&worker=http://w",
              "audio_url": _audio_url(tmp_path)},
    )
    assert r.status_code == 200, r.text
    job = _wait_terminal(engine, r.json()["prompt_id"])
    assert job.nsfw is True
    assert job.status == "done"


# ---------------------------------------------------------------------------
# 产物服务端点
# ---------------------------------------------------------------------------


def test_output_endpoint_range_and_guards(ctx, tmp_path):
    client, token, *_ = ctx
    out_dir = tmp_path / "lipsync"
    out_dir.mkdir(parents=True, exist_ok=True)
    name = "lipsync-" + "e" * 32 + ".mp4"
    (out_dir / name).write_bytes(_MP4)

    r = client.get(f"/api/video/lipsync/output/{name}", headers=_h(token))
    assert r.status_code == 200
    assert r.headers["Accept-Ranges"] == "bytes"

    r2 = client.get(
        f"/api/video/lipsync/output/{name}",
        headers={**_h(token), "Range": "bytes=0-7"},
    )
    assert r2.status_code == 206
    assert r2.headers["Content-Range"].startswith("bytes 0-7/")

    r3 = client.get("/api/video/lipsync/output/..%2F..%2Fetc", headers=_h(token))
    assert r3.status_code in (400, 404, 422)

    r4 = client.get(
        f"/api/video/lipsync/output/lipsync-{'f' * 32}.mp4", headers=_h(token)
    )
    assert r4.status_code == 404

    r5 = client.get(f"/api/video/lipsync/output/{name}")
    assert r5.status_code == 401
