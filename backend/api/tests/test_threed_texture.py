"""3D 纹理 /api/3d/texture 单测(mock worker 取件 + mock toiv-hy3dtex HTTP,不触真实服务)。

覆盖:
- job_id 来源全链路:取 GLB → multipart 委托 → 产物落盘 + Job(kind=threed_texture) 建档
- 参考图三优先级:显式 image > 原作业 params 回填 > 无图(不发 image 字段)
- 归属/状态校验:他人 job 404、未 done 422、job_id+source 双传 422
- 服务侧:未配置 503、HTTP 500 → 502、坏产物(magic)502、非 GLB 参考图 422
"""
import json

import pytest
from fastapi import HTTPException
from sqlmodel import Session, select

from app.db import engine, init_db
from app.models import Job, User
from app.routes import threed_texture
from app.routes.threed_ops import OpsSource
from app.routes.threed_texture import ThreeDTextureRequest
from app.routes.threed_texture import threed_texture as run_texture

init_db()

_GLB = b"glTF" + b"\x02\x00\x00\x00" + b"\x00" * 64
_PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32


def _session() -> Session:
    return Session(engine)


def _user(uid: str = "u1") -> User:
    return User(id=uid, tenant_id="t1", email=f"{uid}@t.com", hashed_password="x")


def _seed_3d_job(user: User, with_ref: bool = False, status: str = "done") -> str:
    """建档含签名 GLB 产物 URL 的作业;with_ref 时 params 带原始参考图句柄。"""
    with _session() as s:
        job = Job(
            tenant_id=user.tenant_id,
            user_id=user.id,
            prompt_id="pid-3d",
            worker="http://10.0.0.1:8193",
            kind="hunyuan3d",
            status=status,
            prompt="图生3D",
            seed=0,
            result=json.dumps(
                [
                    "/api/images?filename=ToIV_3d_00001_.glb&subfolder=&type=output"
                    "&worker=http%3A%2F%2F10.0.0.1%3A8193&sig=fakesig"
                ]
            ),
            params=json.dumps({"image": "ref_input.png"}) if with_ref else "{}",
        )
        s.add(job)
        s.commit()
        s.refresh(job)
        return job.id


class _FakeWorkerClient:
    """get_image_bytes 按 type 区分:output→GLB,input→PNG(参考图)。"""

    def __init__(self, base_url: str):
        self.base_url = base_url

    async def get_image_bytes(self, filename: str, subfolder: str, type_: str):
        return (_PNG if type_ == "input" else _GLB), "application/octet-stream"


class _FakeResponse:
    def __init__(self, status_code: int = 200, content: bytes = _GLB):
        self.status_code = status_code
        self.content = content

    def json(self) -> dict:
        return {"detail": "hy3dtex error"}


class _FakeHttp:
    def __init__(self, resp: _FakeResponse | None = None, fail: Exception | None = None):
        self.calls: list[tuple] = []
        self._resp = resp or _FakeResponse()
        self._fail = fail

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        pass

    async def post(self, url: str, data=None, files=None):
        self.calls.append((url, data, files))
        if self._fail is not None:
            raise self._fail
        return self._resp


def _patch_common(monkeypatch, tmp_path, http: _FakeHttp, tex_url: str = "http://hy3d.test:9404"):
    class _Settings:
        hy3d_tex_url = tex_url
        hy3d_tex_timeout_sec = 5.0

    monkeypatch.setattr(threed_texture, "get_settings", lambda: _Settings())
    monkeypatch.setattr(threed_texture, "enforce_generation_rate_limit", lambda *a, **k: None)
    monkeypatch.setattr(threed_texture, "content_subdir", lambda sub: tmp_path / sub)
    monkeypatch.setattr(threed_texture, "resolve_worker", lambda w: _FakeWorkerClient(w))
    # threed_ops 的取件路径同样走 resolve_worker(_fetch_glb_bytes)
    monkeypatch.setattr(
        "app.routes.threed_ops.resolve_worker", lambda w: _FakeWorkerClient(w)
    )
    monkeypatch.setattr("httpx.AsyncClient", lambda *a, **k: http)


async def test_texture_via_job_id_full_chain(monkeypatch, tmp_path):
    http = _FakeHttp(_FakeResponse(200, _GLB))
    _patch_common(monkeypatch, tmp_path, http)
    user = _user()
    job_id = _seed_3d_job(user)

    req = ThreeDTextureRequest(job_id=job_id, prompt="青铜锈蚀质感")
    result = await run_texture(req, user, _session(), None)

    assert result["kind"] == "threed_texture"
    assert result["format"] == "glb"
    assert str(result["url"]).startswith("/api/3d/texture/files/threedtex-")
    url, data, files = http.calls[0]
    assert url.endswith("/texture")
    assert data["prompt"] == "青铜锈蚀质感"
    assert data["texture_size"] == "2048"
    assert files["file"][1][:4] == b"glTF"
    assert "image" not in files  # 无参考图句柄时不发 image 字段
    name = str(result["url"]).rsplit("/", 1)[-1]
    assert (tmp_path / "threed" / name).read_bytes() == _GLB
    with _session() as s:
        job = s.exec(
            select(Job).where(Job.kind == "threed_texture").order_by(Job.created_at.desc())
        ).first()
    assert job is not None and job.status == "done"
    assert json.loads(job.result) == [result["url"]]
    assert "青铜锈蚀" in job.prompt


async def test_texture_ref_image_autofill_from_job_params(monkeypatch, tmp_path):
    """图生3D 作业的 params.image + job.worker 自动回填参考图(input 目录取件)。"""
    http = _FakeHttp(_FakeResponse(200, _GLB))
    _patch_common(monkeypatch, tmp_path, http)
    user = _user()
    job_id = _seed_3d_job(user, with_ref=True)

    req = ThreeDTextureRequest(job_id=job_id)
    result = await run_texture(req, user, _session(), None)

    assert result["kind"] == "threed_texture"
    _, _, files = http.calls[0]
    assert "image" in files
    assert files["image"][0] == "reference.png"
    assert files["image"][1] == _PNG
    assert "prompt" not in http.calls[0][1] or not http.calls[0][1].get("prompt")


async def test_texture_explicit_image_overrides_autofill(monkeypatch, tmp_path):
    http = _FakeHttp(_FakeResponse(200, _GLB))
    _patch_common(monkeypatch, tmp_path, http)
    user = _user()
    job_id = _seed_3d_job(user, with_ref=True)

    req = ThreeDTextureRequest(
        job_id=job_id,
        image=OpsSource(filename="explicit.webp", worker="http://10.0.0.1:8193"),
    )
    await run_texture(req, user, _session(), None)
    _, _, files = http.calls[0]
    assert files["image"][0] == "reference.webp"


async def test_texture_validation_errors(monkeypatch, tmp_path):
    http = _FakeHttp(_FakeResponse(200, _GLB))
    _patch_common(monkeypatch, tmp_path, http)
    user = _user()
    job_id = _seed_3d_job(user)

    # job_id + source 双传 422
    with pytest.raises(HTTPException) as exc:
        await run_texture(
            ThreeDTextureRequest(
                job_id=job_id,
                source=OpsSource(filename="a.glb", worker="http://10.0.0.1:8193"),
            ),
            user, _session(), None,
        )
    assert exc.value.status_code == 422

    # 他人 job(跨租户)404(同租户按设计共享可见)
    other = User(id="u2", tenant_id="t2", email="u2@t.com", hashed_password="x")
    with pytest.raises(HTTPException) as exc:
        await run_texture(ThreeDTextureRequest(job_id=job_id), other, _session(), None)
    assert exc.value.status_code == 404

    # 未 done 422
    running = _seed_3d_job(user, status="running")
    with pytest.raises(HTTPException) as exc:
        await run_texture(ThreeDTextureRequest(job_id=running), user, _session(), None)
    assert exc.value.status_code == 422

    # 参考图扩展名非法 422
    with pytest.raises(HTTPException) as exc:
        await run_texture(
            ThreeDTextureRequest(
                job_id=job_id,
                image=OpsSource(filename="bad.gif", worker="http://10.0.0.1:8193"),
            ),
            user, _session(), None,
        )
    assert exc.value.status_code == 422
    assert http.calls == []  # 全部在触达服务前拦截


async def test_texture_service_failures(monkeypatch, tmp_path):
    user = _user()
    job_id = _seed_3d_job(user)

    # 未配置 503
    http = _FakeHttp()
    _patch_common(monkeypatch, tmp_path, http, tex_url="")
    with pytest.raises(HTTPException) as exc:
        await run_texture(ThreeDTextureRequest(job_id=job_id), user, _session(), None)
    assert exc.value.status_code == 503

    # 服务 HTTP 500 → 502 透传 detail
    http = _FakeHttp(_FakeResponse(500, b"{}"))
    _patch_common(monkeypatch, tmp_path, http)
    with pytest.raises(HTTPException) as exc:
        await run_texture(ThreeDTextureRequest(job_id=job_id), user, _session(), None)
    assert exc.value.status_code == 502
    assert "hy3dtex error" in exc.value.detail

    # 坏产物(magic 非 glTF)→ 502
    http = _FakeHttp(_FakeResponse(200, _PNG))
    _patch_common(monkeypatch, tmp_path, http)
    with pytest.raises(HTTPException) as exc:
        await run_texture(ThreeDTextureRequest(job_id=job_id), user, _session(), None)
    assert exc.value.status_code == 502
    assert "magic" in exc.value.detail


async def test_adjust_3d_tool_texture_delegates(monkeypatch, tmp_path):
    """adjust_3d op=texture 委托 threed_texture 路由,job 事件带产物 URL。"""
    from app.agent import tools_gen

    user = _user()
    _seed_3d_job(user)

    async def _fake_texture(req, u, s, pool):
        assert isinstance(req, ThreeDTextureRequest)
        assert req.prompt == "卡通皮肤"
        return {
            "kind": "threed_texture", "url": "/api/3d/texture/files/threedtex-x.glb",
            "job_id": "newjob", "op": "texture", "format": "glb",
        }

    monkeypatch.setattr(threed_texture, "threed_texture", _fake_texture)
    text, events = await tools_gen.exec_adjust_3d(
        {"op": "texture", "prompt": "卡通皮肤"},
        {"user": user, "session": _session(), "pool": None},
    )
    assert "纹理" in text
    assert events[0]["data"]["results"] == ["/api/3d/texture/files/threedtex-x.glb"]
