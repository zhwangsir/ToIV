"""SCoPE 运镜路由 /api/scope/* 单测(mock HTTP,不触真实 :9401 服务)。

覆盖:
- generate 建档:Job(kind=scope_camera, queued) → 后台任务 done,产物 URL 可回放
- 服务 500 / 不可达 / 空产物 → Job error(不造假)
- 未配置 scope_base_url → 503
- 首帧图入参校验:双来源互斥 400、坏 base64 400、白名单拦截
- trajectories 代理与上游失败 502
- reconcile_interrupted:重启后 queued/running → error
- 产物文件服务:非法名 400 / 不存在 404
"""
import base64
import json

import pytest
from fastapi import HTTPException
from sqlmodel import Session, select

from app.db import engine, init_db
from app.models import Job, User
from app.routes import scope as scope_routes
from app.routes.scope import (
    ScopeGenerateRequest,
    _fetch_image_b64,
    get_scope_file,
    reconcile_interrupted,
    scope_generate,
    scope_trajectories,
)

init_db()  # 本地 sqlite 可能是旧结构;迁移幂等

_MP4 = b"\x00\x00\x00\x18ftypmp42" + b"\x00" * 200
_PNG_B64 = base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"\x00" * 64).decode()


class _FakeResponse:
    def __init__(self, status_code: int = 200, content: bytes = _MP4, payload: dict | None = None):
        self.status_code = status_code
        self.content = content
        self._payload = payload or {}
        self.text = "" if status_code == 200 else "upstream error"

    def json(self) -> dict:
        return self._payload


class _FakeClient:
    """记录 post 调用;按预置响应/异常返回。"""

    responses: list = []
    fail: Exception | None = None
    calls: list = []

    def __init__(self, *a, **k):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        pass

    async def get(self, url: str):
        type(self).calls.append(("get", url))
        if type(self).fail is not None:
            raise type(self).fail
        return type(self).responses.pop(0) if type(self).responses else _FakeResponse()

    async def post(self, url: str, json=None):
        type(self).calls.append(("post", url, json))
        if type(self).fail is not None:
            raise type(self).fail
        return type(self).responses.pop(0) if type(self).responses else _FakeResponse()


@pytest.fixture(autouse=True)
def _reset_fake():
    _FakeClient.responses = []
    _FakeClient.fail = None
    _FakeClient.calls = []
    yield


def _user() -> User:
    return User(id="u1", tenant_id="t1", email="u@t.com", hashed_password="x")


class _Settings:
    scope_base_url = "http://scope.test:9401"
    scope_timeout_sec = 5.0
    api_base_url = "http://127.0.0.1:8090"
    worker_urls: list = []


def _patch_common(monkeypatch, tmp_path, settings=None):
    monkeypatch.setattr(
        "app.routes.scope.get_settings", lambda: settings or _Settings()
    )
    monkeypatch.setattr(
        "app.routes.scope.enforce_generation_rate_limit", lambda *a, **k: None
    )
    monkeypatch.setattr(
        "app.routes.scope.content_subdir", lambda sub: tmp_path / sub
    )
    monkeypatch.setattr("httpx.AsyncClient", _FakeClient)


def _req(**kw) -> ScopeGenerateRequest:
    base = {"prompt": "camera moves", "trajectory": "gen/dolly_in", "image_base64": _PNG_B64}
    base.update(kw)
    return ScopeGenerateRequest(**base)


async def _drain_bg():
    import asyncio

    tasks = [t for t in scope_routes._BG_TASKS if not t.done()]
    if tasks:
        await asyncio.gather(*tasks)


def _job(prompt_id: str) -> Job | None:
    with Session(engine) as s:
        return s.exec(select(Job).where(Job.prompt_id == prompt_id)).first()


async def test_generate_happy_path_job_done_and_file_served(monkeypatch, tmp_path):
    """建档 queued → 后台任务写产物 → Job done,产物 URL 可回放(带 Range)。"""
    _patch_common(monkeypatch, tmp_path)
    with Session(engine) as session:
        out = await scope_generate(_req(seed=7, steps=2), _user(), session)
    assert out["kind"] == "scope_camera" and out["status"] == "queued"
    job = _job(out["prompt_id"])
    assert job is not None and job.kind == "scope_camera" and job.seed == 7

    await _drain_bg()
    job = _job(out["prompt_id"])
    assert job.status == "done"
    urls = json.loads(job.result)
    assert len(urls) == 1 and urls[0].startswith("/api/scope/files/scope-")

    # 服务侧收到了完整载荷(首帧 base64 + 轨迹 + seed + steps)
    post = next(c for c in _FakeClient.calls if c[0] == "post")
    assert post[1] == "http://scope.test:9401/generate"
    assert post[2]["trajectory"] == "gen/dolly_in" and post[2]["steps"] == 2

    # 产物可回放
    name = urls[0].rsplit("/", 1)[-1]

    class _Req:
        headers = {}

    resp = await get_scope_file(name, _Req(), _user())
    assert resp.status_code == 200 and resp.body == _MP4


async def test_generate_upstream_500_marks_error(monkeypatch, tmp_path):
    _patch_common(monkeypatch, tmp_path)
    _FakeClient.responses = [_FakeResponse(status_code=500, content=b"err", payload={"detail": "boom"})]
    with Session(engine) as session:
        out = await scope_generate(_req(), _user(), session)
    await _drain_bg()
    assert _job(out["prompt_id"]).status == "error"


async def test_generate_unreachable_marks_error(monkeypatch, tmp_path):
    import httpx

    _patch_common(monkeypatch, tmp_path)
    _FakeClient.fail = httpx.ConnectError("refused")
    with Session(engine) as session:
        out = await scope_generate(_req(), _user(), session)
    await _drain_bg()
    assert _job(out["prompt_id"]).status == "error"


async def test_generate_empty_artifact_marks_error(monkeypatch, tmp_path):
    _patch_common(monkeypatch, tmp_path)
    _FakeClient.responses = [_FakeResponse(content=b"")]
    with Session(engine) as session:
        out = await scope_generate(_req(), _user(), session)
    await _drain_bg()
    assert _job(out["prompt_id"]).status == "error"


async def test_generate_disabled_503(monkeypatch, tmp_path):
    class _S(_Settings):
        scope_base_url = ""

    _patch_common(monkeypatch, tmp_path, settings=_S())
    with Session(engine) as session:
        with pytest.raises(HTTPException) as ei:
            await scope_generate(_req(), _user(), session)
    assert ei.value.status_code == 503


async def test_image_inputs_mutually_exclusive_and_bad_base64(monkeypatch, tmp_path):
    _patch_common(monkeypatch, tmp_path)
    with pytest.raises(HTTPException) as ei:
        await _fetch_image_b64(_req(image_url="/api/images/x.png"))
    assert ei.value.status_code == 400
    with pytest.raises(HTTPException) as ei:
        await _fetch_image_b64(_req(image_base64="!!!not-b64!!!"))
    assert ei.value.status_code == 400
    with pytest.raises(HTTPException) as ei:
        await _fetch_image_b64(_req(image_base64=None))
    assert ei.value.status_code == 400


async def test_image_url_whitelist_blocks_ssrf(monkeypatch, tmp_path):
    _patch_common(monkeypatch, tmp_path)
    with pytest.raises(HTTPException) as ei:
        await _fetch_image_b64(
            _req(image_base64=None, image_url="http://evil.example.com/x.png")
        )
    assert ei.value.status_code == 400


async def test_trajectories_proxy_and_upstream_failure(monkeypatch, tmp_path):
    _patch_common(monkeypatch, tmp_path)
    _FakeClient.responses = [
        _FakeResponse(payload={"count": 2, "trajectories": [{"name": "gen/dolly_in"}]})
    ]
    out = await scope_trajectories(_user())
    assert out["count"] == 2

    import httpx

    _FakeClient.fail = httpx.ConnectError("refused")
    with pytest.raises(HTTPException) as ei:
        await scope_trajectories(_user())
    assert ei.value.status_code == 502


def test_reconcile_interrupted_marks_stale_jobs(tmp_path):
    prompt_id = "scope-reconcile-test"
    with Session(engine) as s:
        s.add(
            Job(
                tenant_id="t1",
                user_id="u1",
                prompt_id=prompt_id,
                worker="http://scope.test:9401",
                kind="scope_camera",
                status="running",
                prompt="x",
                seed=0,
            )
        )
        s.commit()
    assert reconcile_interrupted() >= 1
    assert _job(prompt_id).status == "error"


async def test_files_rejects_bad_name_and_missing(monkeypatch, tmp_path):
    _patch_common(monkeypatch, tmp_path)

    class _Req:
        headers = {}

    with pytest.raises(HTTPException) as ei:
        await get_scope_file("../../etc/passwd", _Req(), _user())
    assert ei.value.status_code == 400
    with pytest.raises(HTTPException) as ei:
        await get_scope_file("scope-" + "0" * 32 + ".mp4", _Req(), _user())
    assert ei.value.status_code == 404
