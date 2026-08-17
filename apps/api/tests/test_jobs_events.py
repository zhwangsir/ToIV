"""GET /api/jobs/{prompt_id}/events —— SSE 转发端点级测试。

覆盖:
  · 未认证 401
  · 他人租户作业 403(租户隔离,不泄露进度)
  · 防竞态:WS 连接前作业已完成(history 已有产物)→ 直接回推 done 事件(含产物 URL)
  · execution_error → 推 error 事件 + mark_status("error") 落库标记

SSE 消费方式:测试流的生成器均会主动结束(done/error 后 return/break),
故用普通 GET 读完整响应体断言事件帧,不做完整流式消费。
websockets.connect 与 ComfyUIClient 一律用替身,不联真 worker。
"""
from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

import app.routes.jobs as jobs_route
from app.db import get_session
from app.main import app
from app.models import Job, Tenant, User
from app.security import create_token, hash_password


# --------------------------------------------------------------------------- #
# 公共 fixtures / fakes
# --------------------------------------------------------------------------- #


def _seed_user(session: Session, email: str) -> tuple[str, str]:
    """建租户+用户,返回 (user_id, tenant_id)。"""
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
    return user.id, tenant.id


def _seed_job(session: Session, *, tenant_id: str, user_id: str, prompt_id: str) -> None:
    session.add(
        Job(
            tenant_id=tenant_id,
            user_id=user_id,
            prompt_id=prompt_id,
            worker="http://fake-worker",
            kind="txt2img",
            status="queued",
            prompt="x",
            seed=1,
        )
    )
    session.commit()


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


class _FakeClient:
    """ComfyUIClient 替身:get_result_files 可控(有产物=已完成,空=进行中)。"""

    def __init__(self, files: list[dict] | None = None) -> None:
        self.base_url = "http://fake-worker"
        self._files = list(files or [])

    async def get_result_files(self, prompt_id: str) -> list[dict]:
        return list(self._files)

    def ws_url(self, client_id: str) -> str:
        return f"ws://fake-worker/ws?clientId={client_id}"


class _FakeWS:
    """websockets 连接替身:按需吐出预置文本帧。"""

    def __init__(self, frames: list[str]) -> None:
        self._frames = frames

    def __aiter__(self):
        async def _gen():
            for f in self._frames:
                yield f

        return _gen()


class _FakeWSConn:
    """websockets.connect(...) 返回值的替身(异步上下文管理器)。"""

    def __init__(self, frames: list[str]) -> None:
        self._frames = frames

    async def __aenter__(self) -> _FakeWS:
        return _FakeWS(self._frames)

    async def __aexit__(self, *exc) -> bool:  # noqa: ANN002
        return False


def _install_no_warning(monkeypatch) -> None:
    """视频质量评估容错路径与本组断言无关,屏蔽以免依赖外部 VLM 配置。"""

    async def _none(job, url):  # noqa: ANN001
        return None

    monkeypatch.setattr(jobs_route, "_maybe_quality_warning", _none)


# --------------------------------------------------------------------------- #
# 认证与租户隔离
# --------------------------------------------------------------------------- #


def test_events_requires_auth(client):
    c, _ = client
    r = c.get("/api/jobs/p-any/events?client_id=c1&worker=http://fake-worker")
    assert r.status_code == 401


def test_events_other_tenant_403(client):
    """作业存在但属他人租户 → 403(在 resolve_worker/WS 之前拦截,无需任何替身)。"""
    c, engine = client
    with Session(engine) as s:
        uid_a, _ = _seed_user(s, "evt-a")
        uid_b, tid_b = _seed_user(s, "evt-b")
        _seed_job(s, tenant_id=tid_b, user_id=uid_b, prompt_id="p-other")
    r = c.get(
        "/api/jobs/p-other/events?client_id=c1&worker=http://fake-worker",
        headers={"Authorization": f"Bearer {create_token(uid_a)}"},
    )
    assert r.status_code == 403


# --------------------------------------------------------------------------- #
# 防竞态:WS 连接前已完成 → 直接回推 done
# --------------------------------------------------------------------------- #


def test_events_done_race_pushes_done_immediately(client, monkeypatch):
    c, engine = client
    # _emit_done 用 Session(engine) 直连全局引擎做新鲜读(裁切链并发更新 post_status,
    # 需绕过请求会话身份映射缓存)——测试须把模块级 engine 替身到内存库,
    # 否则打到本地 dev 库(可能无 post_status 列)
    monkeypatch.setattr(jobs_route, "engine", engine)
    with Session(engine) as s:
        uid, tid = _seed_user(s, "evt-done")
        _seed_job(s, tenant_id=tid, user_id=uid, prompt_id="p-done")

    # history 已有产物 → 走防竞态分支;record_result 替身返回产物代理 URL
    fake = _FakeClient(files=[{"filename": "a.png", "subfolder": "", "type": "output"}])
    monkeypatch.setattr(jobs_route, "resolve_worker", lambda worker: fake)

    async def _record(client, prompt_id):  # noqa: ANN001
        return ["/api/images?filename=a.png&subfolder=&type=output"]

    monkeypatch.setattr(jobs_route, "record_result", _record)
    _install_no_warning(monkeypatch)

    r = c.get(
        "/api/jobs/p-done/events?client_id=c1&worker=http://fake-worker",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
    )
    assert r.status_code == 200, r.text
    assert "event: done" in r.text
    assert "a.png" in r.text  # done 帧携带产物 URL


# --------------------------------------------------------------------------- #
# execution_error → error 事件 + 状态落库标记
# --------------------------------------------------------------------------- #


def test_events_execution_error_pushes_error(client, monkeypatch):
    c, engine = client
    with Session(engine) as s:
        uid, tid = _seed_user(s, "evt-err")
        _seed_job(s, tenant_id=tid, user_id=uid, prompt_id="p-err")

    # history 无产物(进行中)→ 进入 WS 监听;预置一帧 execution_error
    fake = _FakeClient(files=[])
    monkeypatch.setattr(jobs_route, "resolve_worker", lambda worker: fake)

    frames = [
        json.dumps(
            {
                "type": "execution_error",
                "data": {"prompt_id": "p-err", "exception_message": "boom"},
            }
        )
    ]
    monkeypatch.setattr(
        jobs_route.websockets, "connect", lambda url, **kw: _FakeWSConn(frames)
    )

    marked: list[tuple[str, str]] = []
    monkeypatch.setattr(
        jobs_route, "mark_status", lambda pid, status: marked.append((pid, status))
    )
    _install_no_warning(monkeypatch)

    r = c.get(
        "/api/jobs/p-err/events?client_id=c1&worker=http://fake-worker",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
    )
    assert r.status_code == 200, r.text
    assert "event: error" in r.text
    assert "boom" in r.text  # 上游异常信息透传给前端
    assert marked == [("p-err", "error")]  # 作业状态同步标记为 error
