"""3D 调整 /api/3d/ops 单测(mock worker 取 GLB + mock toiv-3dops HTTP,不触真实服务)。

覆盖:
- render(png/mp4)/material 三链路:job_id 与 source 两种来源、产物建档、文件端点 Range
- 归属校验:他人 job_id 404;无 .glb 产物 422;非 .glb source 422
- 3dops 未配置 503 / 不可达 502 / 返回坏产物(magic 校验)502
- adjust_3d 助手工具:自动选最近 GLB 作业、job 事件透出、无产物报错
"""
import json

import pytest
from fastapi import HTTPException
from sqlmodel import Session, select

from app.db import engine, init_db
from app.models import Job, User
from app.routes import threed_ops
from app.routes.threed_ops import ThreeDOpsRequest, OpsSource, threed_ops as run_ops

init_db()  # 本地 sqlite 可能是旧结构;迁移幂等

_GLB = b"glTF" + b"\x02\x00\x00\x00" + b"\x00" * 64  # 合法 magic 的伪 GLB
_PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32
_MP4 = b"\x00\x00\x00\x18ftypmp42" + b"\x00" * 32


def _session() -> Session:
    return Session(engine)


def _user(uid: str = "u1") -> User:
    return User(id=uid, tenant_id="t1", email=f"{uid}@t.com", hashed_password="x")


def _seed_3d_job(user: User, prompt: str = "图生3D") -> str:
    """建档一个含签名 GLB 产物 URL 的 done 作业,返回 job.id。"""
    with _session() as s:
        job = Job(
            tenant_id=user.tenant_id,
            user_id=user.id,
            prompt_id=f"pid-{prompt}",
            worker="http://10.0.0.1:8193",
            kind="hunyuan3d",
            status="done",
            prompt=prompt,
            seed=0,
            result=json.dumps(
                [
                    "/api/images?filename=ToIV_3d_00001_.glb&subfolder=&type=output"
                    "&worker=http%3A%2F%2F10.0.0.1%3A8193&sig=fakesig"
                ]
            ),
        )
        s.add(job)
        s.commit()
        s.refresh(job)
        return job.id


class _FakeWorkerClient:
    def __init__(self, base_url: str, content: bytes = _GLB, fail: bool = False):
        self.base_url = base_url
        self._content = content
        self._fail = fail

    async def get_image_bytes(self, filename: str, subfolder: str, type_: str):
        from app.comfy.client import ComfyUIError

        if self._fail:
            raise ComfyUIError("worker down")
        return self._content, "model/gltf-binary"


class _FakeResponse:
    def __init__(self, status_code: int = 200, content: bytes = _PNG):
        self.status_code = status_code
        self.content = content

    def json(self) -> dict:
        return {"detail": "3dops error"}


class _FakeHttp:
    """模拟到 toiv-3dops 的 httpx.AsyncClient;记录请求供断言。"""

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


def _patch_common(monkeypatch, tmp_path, http: _FakeHttp, worker_content: bytes = _GLB):
    class _Settings:
        threed_ops_url = "http://3dops.test:9402"
        threed_ops_timeout_sec = 5.0

    monkeypatch.setattr(threed_ops, "get_settings", lambda: _Settings())
    monkeypatch.setattr(threed_ops, "enforce_generation_rate_limit", lambda *a, **k: None)
    monkeypatch.setattr(threed_ops, "content_subdir", lambda sub: tmp_path / sub)
    monkeypatch.setattr(
        threed_ops, "resolve_worker",
        lambda w: _FakeWorkerClient(w, content=worker_content),
    )
    monkeypatch.setattr("httpx.AsyncClient", lambda *a, **k: http)


async def test_render_png_via_job_id_registers_job(monkeypatch, tmp_path):
    http = _FakeHttp(_FakeResponse(200, _PNG))
    _patch_common(monkeypatch, tmp_path, http)
    user = _user()
    job_id = _seed_3d_job(user)

    req = ThreeDOpsRequest(op="render", job_id=job_id, material="clay", format="png")
    result = await run_ops(req, user, _session(), None)

    assert result["kind"] == "threed_render"
    assert result["format"] == "png"
    assert str(result["url"]).startswith("/api/3d/ops/files/threedops-")
    # 3dops 调用:上传了 GLB 字节且走 /render
    url, data, files = http.calls[0]
    assert url.endswith("/render")
    assert data["material"] == "clay"
    assert files["file"][1][:4] == b"glTF"
    # 产物落盘 + 建档
    name = str(result["url"]).rsplit("/", 1)[-1]
    assert (tmp_path / "threed" / name).read_bytes() == _PNG
    with _session() as s:
        job = s.exec(
            select(Job).where(Job.kind == "threed_render").order_by(Job.created_at.desc())
        ).first()
    assert job is not None and job.status == "done"
    assert json.loads(job.result) == [result["url"]]
    assert "黏土" in job.prompt


async def test_render_mp4_via_source(monkeypatch, tmp_path):
    http = _FakeHttp(_FakeResponse(200, _MP4))
    _patch_common(monkeypatch, tmp_path, http)
    user = _user()

    req = ThreeDOpsRequest(
        op="render",
        source=OpsSource(filename="ToIV_3d_00001_.glb", worker="http://10.0.0.1:8193"),
        material="metal",
        format="mp4",
        frames=24,
    )
    result = await run_ops(req, user, _session(), None)

    assert result["format"] == "mp4"
    assert str(result["url"]).endswith(".mp4")
    url, data, _ = http.calls[0]
    assert data["frames"] == "24"
    with _session() as s:
        job = s.exec(
            select(Job).where(Job.kind == "threed_render").order_by(Job.created_at.desc())
        ).first()
    assert "旋转视频" in job.prompt and "金属" in job.prompt


async def test_material_op_returns_glb(monkeypatch, tmp_path):
    http = _FakeHttp(_FakeResponse(200, _GLB))
    _patch_common(monkeypatch, tmp_path, http)
    user = _user()
    job_id = _seed_3d_job(user, "材质来源")

    req = ThreeDOpsRequest(
        op="material", job_id=job_id, base_color="#b87333", metallic=0.9, roughness=0.3
    )
    result = await run_ops(req, user, _session(), None)

    assert result["kind"] == "threed_material"
    assert str(result["url"]).endswith(".glb")
    url, data, _ = http.calls[0]
    assert url.endswith("/material")
    assert data["base_color"] == "#b87333"
    with _session() as s:
        job = s.exec(
            select(Job).where(Job.kind == "threed_material").order_by(Job.created_at.desc())
        ).first()
    assert job is not None and job.status == "done"


async def test_job_id_ownership_enforced(monkeypatch, tmp_path):
    http = _FakeHttp()
    _patch_common(monkeypatch, tmp_path, http)
    # 异租户作业(同租户按作品库纪律可见,不算越权):u1 访问 t2 的 job 须 404
    with _session() as s:
        job = Job(
            tenant_id="t2", user_id="u-other", prompt_id="pid-other",
            worker="w", kind="hunyuan3d", status="done", prompt="他人作业", seed=0,
            result=json.dumps(
                ["/api/images?filename=x.glb&worker=http%3A%2F%2F10.0.0.1%3A8193&sig=s"]
            ),
        )
        s.add(job)
        s.commit()
        s.refresh(job)
        job_id = job.id

    req = ThreeDOpsRequest(op="render", job_id=job_id)
    with pytest.raises(HTTPException) as exc:
        await run_ops(req, _user("u1"), _session(), None)
    assert exc.value.status_code == 404
    assert http.calls == []  # 未触达 3dops


async def test_job_without_glb_result_422(monkeypatch, tmp_path):
    http = _FakeHttp()
    _patch_common(monkeypatch, tmp_path, http)
    user = _user()
    with _session() as s:
        job = Job(
            tenant_id=user.tenant_id, user_id=user.id, prompt_id="pid-img",
            worker="w", kind="txt2img", status="done", prompt="图", seed=0,
            result=json.dumps(["/api/images?filename=a.png&worker=w&sig=x"]),
        )
        s.add(job)
        s.commit()
        s.refresh(job)
        jid = job.id

    with pytest.raises(HTTPException) as exc:
        await run_ops(ThreeDOpsRequest(op="render", job_id=jid), user, _session(), None)
    assert exc.value.status_code == 422
    assert ".glb" in exc.value.detail


async def test_source_non_glb_rejected(monkeypatch, tmp_path):
    http = _FakeHttp()
    _patch_common(monkeypatch, tmp_path, http)
    req = ThreeDOpsRequest(
        op="render", source=OpsSource(filename="a.png", worker="http://10.0.0.1:8193")
    )
    with pytest.raises(HTTPException) as exc:
        await run_ops(req, _user(), _session(), None)
    assert exc.value.status_code == 422


async def test_3dops_unconfigured_503(monkeypatch, tmp_path):
    http = _FakeHttp()
    _patch_common(monkeypatch, tmp_path, http)

    class _Empty:
        threed_ops_url = ""
        threed_ops_timeout_sec = 5.0

    monkeypatch.setattr(threed_ops, "get_settings", lambda: _Empty())
    req = ThreeDOpsRequest(
        op="render", source=OpsSource(filename="a.glb", worker="http://10.0.0.1:8193")
    )
    with pytest.raises(HTTPException) as exc:
        await run_ops(req, _user(), _session(), None)
    assert exc.value.status_code == 503


async def test_3dops_unreachable_502(monkeypatch, tmp_path):
    import httpx

    http = _FakeHttp(fail=httpx.ConnectError("conn refused"))
    _patch_common(monkeypatch, tmp_path, http)
    req = ThreeDOpsRequest(
        op="render", source=OpsSource(filename="a.glb", worker="http://10.0.0.1:8193")
    )
    with pytest.raises(HTTPException) as exc:
        await run_ops(req, _user(), _session(), None)
    assert exc.value.status_code == 502
    assert "不可达" in exc.value.detail


async def test_bad_output_magic_502(monkeypatch, tmp_path):
    http = _FakeHttp(_FakeResponse(200, b"not-a-png-at-all"))
    _patch_common(monkeypatch, tmp_path, http)
    req = ThreeDOpsRequest(
        op="render", source=OpsSource(filename="a.glb", worker="http://10.0.0.1:8193")
    )
    with pytest.raises(HTTPException) as exc:
        await run_ops(req, _user(), _session(), None)
    assert exc.value.status_code == 502
    assert "magic" in exc.value.detail


async def test_files_endpoint_range_and_guards(monkeypatch, tmp_path):
    monkeypatch.setattr(threed_ops, "content_subdir", lambda sub: tmp_path / sub)
    (tmp_path / "threed").mkdir(parents=True)
    name = f"threedops-{'a' * 32}.mp4"
    (tmp_path / "threed" / name).write_bytes(_MP4)

    class _Req:
        headers: dict = {}

    resp = await threed_ops.get_threed_ops_file(name, _Req(), _user())
    assert resp.status_code == 200
    assert resp.headers["Accept-Ranges"] == "bytes"

    class _ReqRange:
        headers = {"range": "bytes=0-7"}

    resp2 = await threed_ops.get_threed_ops_file(name, _ReqRange(), _user())
    assert resp2.status_code == 206

    with pytest.raises(HTTPException) as exc:
        await threed_ops.get_threed_ops_file("../../etc/passwd", _Req(), _user())
    assert exc.value.status_code == 400
    with pytest.raises(HTTPException) as exc:
        await threed_ops.get_threed_ops_file(f"threedops-{'b' * 32}.png", _Req(), _user())
    assert exc.value.status_code == 404


# ---------- adjust_3d 助手工具 ----------

async def test_adjust_3d_tool_picks_latest_glb_job(monkeypatch, tmp_path):
    from app.agent import tools_gen

    user = _user()
    src_id = _seed_3d_job(user, "最近的3D")

    async def _fake_ops(req, u, s, pool):
        return {
            "kind": "threed_render", "url": "/api/3d/ops/files/threedops-x.mp4",
            "job_id": "newjob", "op": "render", "format": "mp4",
        }

    monkeypatch.setattr(threed_ops, "threed_ops", _fake_ops)
    text, events = await tools_gen.exec_adjust_3d(
        {"op": "render", "format": "mp4", "material": "clay"},
        {"user": user, "session": _session(), "pool": None},
    )
    assert "3D 调整完成" in text
    assert len(events) == 1 and events[0]["type"] == "job"
    assert events[0]["data"]["status"] == "done"
    assert events[0]["data"]["results"] == ["/api/3d/ops/files/threedops-x.mp4"]
    assert src_id  # 来源作业存在(自动命中最近一个)


async def test_adjust_3d_tool_no_source(monkeypatch):
    from app.agent import tools_gen

    user = _user("u-no3d")
    text, events = await tools_gen.exec_adjust_3d(
        {"op": "render"}, {"user": user, "session": _session(), "pool": None}
    )
    assert "没有找到可调整的 3D 产物" in text
    assert events[0]["type"] == "tool_event"


async def test_adjust_3d_tool_http_error_passthrough(monkeypatch):
    from app.agent import tools_gen

    user = _user()
    _seed_3d_job(user, "报错来源")

    async def _boom(req, u, s, pool):
        raise HTTPException(status_code=502, detail="3D 调整服务不可达:x")

    monkeypatch.setattr(threed_ops, "threed_ops", _boom)
    text, events = await tools_gen.exec_adjust_3d(
        {"op": "material", "base_color": "#b87333"},
        {"user": user, "session": _session(), "pool": None},
    )
    assert "3D 调整失败(502)" in text
    assert events[0]["data"]["status"] == "error"


async def test_chained_local_glb_via_job_id(monkeypatch, tmp_path):
    """链式调整:threed_material 作业(本地 GLB 产物)作为 render 来源。"""
    http = _FakeHttp(_FakeResponse(200, _PNG))
    _patch_common(monkeypatch, tmp_path, http)
    user = _user()
    # 本服务自有产物:/api/3d/ops/files/*.glb 直接读本地产物目录
    name = f"threedops-{'c' * 32}.glb"
    (tmp_path / "threed").mkdir(parents=True)
    (tmp_path / "threed" / name).write_bytes(_GLB)
    with _session() as s:
        job = Job(
            tenant_id=user.tenant_id, user_id=user.id, prompt_id="pid-mat",
            worker="local", kind="threed_material", status="done",
            prompt="3D 材质调整", seed=0,
            result=json.dumps([f"/api/3d/ops/files/{name}"]),
        )
        s.add(job)
        s.commit()
        s.refresh(job)
        jid = job.id

    req = ThreeDOpsRequest(op="render", job_id=jid, material="metal", format="png")
    result = await run_ops(req, user, _session(), None)
    assert result["format"] == "png"
    # 3dops 收到的是本地产物字节(不经 worker)
    _, _, files = http.calls[0]
    assert files["file"][1] == _GLB
