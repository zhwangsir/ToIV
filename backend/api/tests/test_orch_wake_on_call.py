"""按需资源分配 R2:冷层路由接线(wake-on-call)单测。

覆盖:
  · ensure_awake helper:开关关直通 / 未注册直通 / 注册表条目 wake_on_call=false
    直通 / running 只打点不唤醒 / sleeping 触发唤醒(审计 orch.wake)/
    SSH 失败 503 + error + orch.wake_failed / 健康超时 503 / 打点先于唤醒;
  · i2l 路由:sleeping 唤醒成功再转发(ssh 先于 http)/ 唤醒失败 503 不触达
    agent / 开关关直通 / 替身 settings 缺字段直通 / 单服务禁用直通;
  · hy3dtex 路由:唤醒成功再委托 / 唤醒失败 503 不委托;
  · lipsync 路由:唤醒失败 503 不建档 / 唤醒成功 → Job 落库时状态已 running
    (说明性:唤醒在建 Job 前完成,无 tracker 孤儿窗口)。
全 mock SSH(_run_systemctl)与健康检查(_check_health),不触真实设备。
"""
from __future__ import annotations

import io
import json
import time

import pytest
from fastapi import HTTPException, UploadFile
from sqlmodel import Session, SQLModel, create_engine, select
from sqlalchemy.pool import StaticPool
from starlette.datastructures import Headers

import app.services.service_orchestrator as orch
from app.config import get_settings
from app.models import AuditLog, Job, User
from app.routes import threed_texture, train as train_routes
from app.routes import video_lipsync as vl
from app.routes.threed_ops import OpsSource

_PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32
_GLB = b"glTF" + b"\x02\x00\x00\x00" + b"\x00" * 64


# --------------------------------------------------------------------------- #
# 公共 fixtures / fakes
# --------------------------------------------------------------------------- #


@pytest.fixture(autouse=True)
def _isolate():
    orch.reset_orchestrator()
    yield
    orch.reset_orchestrator()


@pytest.fixture
def orch_db(monkeypatch):
    eng = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    SQLModel.metadata.create_all(eng)
    monkeypatch.setattr(orch, "engine", eng)
    return eng


def _patch_ssh(monkeypatch, events: list[str] | None = None, rc: int = 0):
    async def fake(spec, action: str):
        if events is not None:
            events.append(f"ssh:{spec.name}:{action}")
        return rc, "" if rc == 0 else "Permission denied"

    monkeypatch.setattr(orch, "_run_systemctl", fake)


def _patch_health(monkeypatch, ok: bool = True):
    async def fake(spec) -> bool:
        return ok

    monkeypatch.setattr(orch, "_check_health", fake)


def _user() -> User:
    return User(id="u1", tenant_id="t1", email="u1@t.com", hashed_password="x")


def _audit_actions(engine) -> list[str]:
    with Session(engine) as s:
        return [row.action for row in s.exec(select(AuditLog)).all()]


# --------------------------------------------------------------------------- #
# ensure_awake helper
# --------------------------------------------------------------------------- #


async def test_ensure_awake_disabled_passthrough(monkeypatch):
    called = False

    async def spy(name: str):
        nonlocal called
        called = True

    monkeypatch.setattr(orch, "ensure_running", spy)
    assert await orch.ensure_awake("i2l", enabled=False) is False
    assert called is False, "开关关不应触碰唤醒"
    assert "i2l" not in orch._states, "开关关不应打点"


async def test_ensure_awake_unregistered_passthrough(monkeypatch):
    async def spy(name: str):
        raise AssertionError("未注册服务不应唤醒")

    monkeypatch.setattr(orch, "ensure_running", spy)
    assert await orch.ensure_awake("ghost", enabled=True) is False


async def test_ensure_awake_service_disabled_via_registry(monkeypatch):
    monkeypatch.setattr(
        get_settings(),
        "orch_services",
        json.dumps({"i2l": {"wake_on_call": False}}),
    )
    orch.reset_orchestrator()

    async def spy(name: str):
        raise AssertionError("条目 wake_on_call=false 不应唤醒")

    monkeypatch.setattr(orch, "ensure_running", spy)
    assert await orch.ensure_awake("i2l", enabled=True) is False
    assert "i2l" not in orch._states, "条目禁用不应打点"
    # 未提及服务不受影响
    assert orch.get_registry()["trainer"].wake_on_call is True


async def test_ensure_awake_running_marks_only(monkeypatch):
    async def spy(name: str):
        raise AssertionError("running 态不应再唤醒")

    monkeypatch.setattr(orch, "ensure_running", spy)
    orch._state("i2l").status = "running"
    assert await orch.ensure_awake("i2l", enabled=True) is True
    assert orch._state("i2l").last_request_at is not None, "running 态也应打点"


async def test_ensure_awake_sleeping_wakes(monkeypatch, orch_db):
    events: list[str] = []
    _patch_ssh(monkeypatch, events)
    _patch_health(monkeypatch)
    orch._state("trainer").status = "sleeping"

    assert await orch.ensure_awake("trainer", enabled=True) is True
    st = orch._state("trainer")
    assert st.status == "running" and st.wake_count == 1
    assert events == ["ssh:trainer:start"]
    assert _audit_actions(orch_db) == ["orch.wake"]


async def test_ensure_awake_wake_failure_503(monkeypatch, orch_db):
    _patch_ssh(monkeypatch, rc=1)
    _patch_health(monkeypatch)

    with pytest.raises(HTTPException) as exc:
        await orch.ensure_awake("lipsync", enabled=True)
    assert exc.value.status_code == 503
    assert "lipsync" in exc.value.detail
    st = orch._state("lipsync")
    assert st.status == "error"
    assert st.last_request_at is not None, "唤醒失败也应已打点(先 mark 后 wake)"
    assert _audit_actions(orch_db) == ["orch.wake_failed"]


async def test_ensure_awake_health_timeout_503(monkeypatch, orch_db):
    _patch_ssh(monkeypatch)
    _patch_health(monkeypatch, ok=False)
    monkeypatch.setattr(orch, "WAKE_POLL_INTERVAL_SEC", 0.01)
    monkeypatch.setattr(get_settings(), "orch_wake_timeout_sec", 0.05)

    with pytest.raises(HTTPException) as exc:
        await orch.ensure_awake("hy3dtex", enabled=True)
    assert exc.value.status_code == 503
    assert "超时" in exc.value.detail
    assert orch._state("hy3dtex").status == "error"
    assert _audit_actions(orch_db) == ["orch.wake_failed"]


# --------------------------------------------------------------------------- #
# i2l 路由接线
# --------------------------------------------------------------------------- #


class _I2LSettings:
    i2l_url = "http://i2l.test:9101"
    orch_wake_on_call = True


class _I2LSettingsNoFlag:
    """替身 settings 缺 orch_wake_on_call 字段(旧测试形态)→ getattr 兜底直通。"""

    i2l_url = "http://i2l.test:9101"


class _Resp:
    def __init__(self, status: int = 200, payload: dict | None = None):
        self.status_code = status
        self._payload = payload or {}

    def json(self) -> dict:
        return self._payload


class _FakeHttp:
    """httpx.AsyncClient 替身:记录 POST,返回预置响应。"""

    def __init__(self, resp: _Resp, events: list[str] | None = None):
        self.calls: list[str] = []
        self._resp = resp
        self._events = events

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    async def post(self, url, files=None, data=None, json=None):  # noqa: A002
        self.calls.append(url)
        if self._events is not None:
            self._events.append(f"http:{url}")
        return self._resp


def _upload(name: str = "a.png") -> UploadFile:
    return UploadFile(
        filename=name,
        file=io.BytesIO(_PNG),
        headers=Headers({"content-type": "image/png"}),
    )


def _patch_i2l_route(monkeypatch, settings, http: _FakeHttp):
    monkeypatch.setattr(train_routes, "get_settings", lambda: settings)
    monkeypatch.setattr(
        train_routes, "enforce_generation_rate_limit", lambda *a, **k: None
    )
    monkeypatch.setattr(
        "app.routes.train.httpx.AsyncClient", lambda *a, **k: http
    )


async def test_i2l_sleeping_wakes_then_forwards(monkeypatch, orch_db):
    events: list[str] = []
    _patch_ssh(monkeypatch, events)
    _patch_health(monkeypatch)
    orch._state("i2l").status = "sleeping"
    http = _FakeHttp(_Resp(200, {"lora_name": "x.safetensors", "size_mb": 1.0}), events)
    _patch_i2l_route(monkeypatch, _I2LSettings(), http)

    result = await train_routes.i2l_style_lora(
        files=[_upload()], lora_name="x", demo_prompt="", user=_user()
    )
    assert result["ok"] is True
    assert http.calls == ["http://i2l.test:9101/i2l"]
    # 唤醒(ssh)必须先于转发(http)
    assert events[0] == "ssh:i2l:start"
    assert events[1].startswith("http:")
    assert orch._state("i2l").status == "running"
    assert orch._state("i2l").wake_count == 1


async def test_i2l_wake_failure_503_no_forward(monkeypatch, orch_db):
    _patch_ssh(monkeypatch, rc=1)
    _patch_health(monkeypatch)
    http = _FakeHttp(_Resp(200, {}))
    _patch_i2l_route(monkeypatch, _I2LSettings(), http)

    with pytest.raises(HTTPException) as exc:
        await train_routes.i2l_style_lora(
            files=[_upload()], lora_name="x", demo_prompt="", user=_user()
        )
    assert exc.value.status_code == 503
    assert http.calls == [], "唤醒失败不得触达 agent(不造假产物)"


async def test_i2l_flag_off_passthrough(monkeypatch, orch_db):
    _patch_ssh(monkeypatch)  # 不应被调用
    http = _FakeHttp(_Resp(200, {"lora_name": "x.safetensors"}))

    class _S:
        i2l_url = "http://i2l.test:9101"
        orch_wake_on_call = False

    _patch_i2l_route(monkeypatch, _S(), http)
    result = await train_routes.i2l_style_lora(
        files=[_upload()], lora_name="x", demo_prompt="", user=_user()
    )
    assert result["ok"] is True
    assert http.calls, "直通时原转发逻辑不变"
    assert "i2l" not in orch._states, "直通时不打点不唤醒"


async def test_i2l_stub_settings_missing_flag_passthrough(monkeypatch, orch_db):
    """热路径兜底:替身 settings 无 orch_wake_on_call 字段 → 直通(零行为变化)。"""
    _patch_ssh(monkeypatch)
    http = _FakeHttp(_Resp(200, {"lora_name": "x.safetensors"}))
    _patch_i2l_route(monkeypatch, _I2LSettingsNoFlag(), http)

    result = await train_routes.i2l_style_lora(
        files=[_upload()], lora_name="x", demo_prompt="", user=_user()
    )
    assert result["ok"] is True
    assert "i2l" not in orch._states


async def test_i2l_registry_disabled_passthrough(monkeypatch, orch_db):
    monkeypatch.setattr(
        get_settings(),
        "orch_services",
        json.dumps({"i2l": {"wake_on_call": False}}),
    )
    orch.reset_orchestrator()
    _patch_ssh(monkeypatch)
    http = _FakeHttp(_Resp(200, {"lora_name": "x.safetensors"}))
    _patch_i2l_route(monkeypatch, _I2LSettings(), http)

    result = await train_routes.i2l_style_lora(
        files=[_upload()], lora_name="x", demo_prompt="", user=_user()
    )
    assert result["ok"] is True
    assert "i2l" not in orch._states, "单服务禁用时不打点不唤醒"


# --------------------------------------------------------------------------- #
# hy3dtex 路由接线
# --------------------------------------------------------------------------- #


class _TexSettings:
    hy3d_tex_url = "http://hy3d.test:9404"
    hy3d_tex_timeout_sec = 5.0
    orch_wake_on_call = True


class _FakeWorkerClient:
    def __init__(self, base_url: str):
        self.base_url = base_url

    async def get_image_bytes(self, filename: str, subfolder: str, type_: str):
        return _GLB, "application/octet-stream"


class _FakeGlbResp:
    status_code = 200
    content = _GLB

    def json(self) -> dict:
        return {"detail": "unused"}


class _FakeTexHttp:
    def __init__(self, events: list[str] | None = None):
        self.calls: list[str] = []
        self._events = events

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    async def post(self, url, data=None, files=None):
        self.calls.append(url)
        if self._events is not None:
            self._events.append(f"http:{url}")
        return _FakeGlbResp()


def _patch_texture_route(monkeypatch, tmp_path, http: _FakeTexHttp):
    monkeypatch.setattr(threed_texture, "get_settings", lambda: _TexSettings())
    monkeypatch.setattr(
        threed_texture, "enforce_generation_rate_limit", lambda *a, **k: None
    )
    monkeypatch.setattr(threed_texture, "content_subdir", lambda sub: tmp_path / sub)
    monkeypatch.setattr(threed_texture, "resolve_worker", lambda w: _FakeWorkerClient(w))
    monkeypatch.setattr(
        "app.routes.threed_ops.resolve_worker", lambda w: _FakeWorkerClient(w)
    )
    monkeypatch.setattr("httpx.AsyncClient", lambda *a, **k: http)


async def test_texture_wakes_then_delegates(monkeypatch, tmp_path, orch_db):
    events: list[str] = []
    _patch_ssh(monkeypatch, events)
    _patch_health(monkeypatch)
    orch._state("hy3dtex").status = "sleeping"
    http = _FakeTexHttp(events)
    _patch_texture_route(monkeypatch, tmp_path, http)

    with Session(orch_db) as session:
        result = await threed_texture.threed_texture(
            threed_texture.ThreeDTextureRequest(
                source=OpsSource(filename="model.glb", worker="http://w:8193")
            ),
            _user(),
            session,
            None,
        )
    assert result["kind"] == "threed_texture"
    assert http.calls == ["http://hy3d.test:9404/texture"]
    assert events[0] == "ssh:hy3dtex:start"
    assert events[1].startswith("http:"), "唤醒必须先于委托"
    assert orch._state("hy3dtex").status == "running"


async def test_texture_wake_failure_503_no_delegate(monkeypatch, tmp_path, orch_db):
    _patch_ssh(monkeypatch, rc=1)
    _patch_health(monkeypatch)
    http = _FakeTexHttp()
    _patch_texture_route(monkeypatch, tmp_path, http)

    with pytest.raises(HTTPException) as exc:
        with Session(orch_db) as session:
            await threed_texture.threed_texture(
                threed_texture.ThreeDTextureRequest(
                    source=OpsSource(filename="model.glb", worker="http://w:8193")
                ),
                _user(),
                session,
                None,
            )
    assert exc.value.status_code == 503
    assert http.calls == [], "唤醒失败不得委托纹理服务"


# --------------------------------------------------------------------------- #
# lipsync 路由接线(含 Job 窗口说明性测试)
# --------------------------------------------------------------------------- #


class _LsSettings:
    lipsync_url = "http://lipsync.test:9103"
    orch_wake_on_call = True


class _FakeAgent:
    """lipsync agent 替身:upload/submit;submit 时记录编排器状态(窗口断言)。"""

    def __init__(self, events: list[str]):
        self._events = events

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    async def post(self, url, files=None, data=None, json=None):  # noqa: A002
        if "/v1/video/upload" in url:
            return _Resp(200, {"filename": "up.bin"})
        if "/v1/lipsync/submit" in url:
            # 说明性断言:提交 agent 时编排器状态必须已是 running
            # (唤醒在建 Job/提交之前完成 → 无「作业在跑而服务睡眠」窗口;
            #  且 lipsync 作业走自有 task_id 轮询,不经 comfy tracker 孤儿检测)
            self._events.append(f"submit:state={orch._state('lipsync').status}")
            return _Resp(200, {"task_id": "task-1"})
        raise AssertionError(f"unexpected POST {url}")


def _patch_lipsync_route(monkeypatch, events: list[str]):
    monkeypatch.setattr(vl, "get_settings", lambda: _LsSettings())
    monkeypatch.setattr(vl, "enforce_generation_rate_limit", lambda *a, **k: None)
    monkeypatch.setattr(vl, "_resolve_video_source", lambda *a: False)
    monkeypatch.setattr(vl, "_resolve_audio_source", lambda *a: False)

    async def _fake_fetch(url: str, dest) -> None:
        dest.write_bytes(b"\x00" * 16)

    monkeypatch.setattr(vl, "_fetch_video", _fake_fetch)
    monkeypatch.setattr(vl, "_fetch_audio", _fake_fetch)
    monkeypatch.setattr("httpx.AsyncClient", lambda *a, **k: _FakeAgent(events))
    monkeypatch.setattr(vl, "spawn_lipsync_job", lambda *a: None)


async def test_lipsync_wake_failure_503_no_job(monkeypatch, orch_db):
    _patch_ssh(monkeypatch, rc=1)
    _patch_health(monkeypatch)
    _patch_lipsync_route(monkeypatch, [])

    with pytest.raises(HTTPException) as exc:
        with Session(orch_db) as session:
            await vl.video_lipsync_submit(
                vl.VideoLipsyncRequest(video_url="/v.mp4", audio_url="/a.wav"),
                _user(),
                session,
            )
    assert exc.value.status_code == 503
    with Session(orch_db) as s:
        assert s.exec(select(Job)).all() == [], "唤醒失败不得建 Job(不造假)"


async def test_lipsync_wake_success_then_submit_and_job(monkeypatch, orch_db):
    events: list[str] = []
    _patch_ssh(monkeypatch, events)
    _patch_health(monkeypatch)
    orch._state("lipsync").status = "sleeping"
    _patch_lipsync_route(monkeypatch, events)

    with Session(orch_db) as session:
        result = await vl.video_lipsync_submit(
            vl.VideoLipsyncRequest(video_url="/v.mp4", audio_url="/a.wav"),
            _user(),
            session,
        )
    assert result["kind"] == "lipsync" and result["status"] == "processing"
    assert events[0] == "ssh:lipsync:start"
    assert events[1] == "submit:state=running", "提交时服务必须已 running(无孤儿窗口)"
    with Session(orch_db) as s:
        jobs = s.exec(select(Job).where(Job.kind == "lipsync")).all()
    assert len(jobs) == 1 and jobs[0].status == "processing"
    assert orch._state("lipsync").wake_count == 1
