"""动态分镜 /api/animatic 单测。

- _build_ffmpeg_cmd:时长/尺寸/concat 结构、shell 引用。
- POST 上传校验:数量不符/非法格式/穿越文件名/超量/时长越界/fps 越界 → 422。
- POST 成功路径:mock subprocess(ssh ffmpeg)与 NAS 路径(tmp_path),落盘编号 + 返回 url。
- ffmpeg 失败/超时 → 502 并清理。
- GET 白名单:非法名/不存在 → 404,存在 → 200。
"""
from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.db import get_session
from app.main import app
from app.models import Tenant, User
from app.routes.animatic import _build_ffmpeg_cmd, _fmt_sec
from app.security import create_token, hash_password

_JPG = b"\xff\xd8\xff\xe0" + b"\x00" * 32
_PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32


def _make_user(session: Session, email: str) -> str:
    tenant = Tenant(name=email.split("@")[0])
    session.add(tenant)
    session.commit()
    session.refresh(tenant)
    user = User(email=email, hashed_password=hash_password("password1"), tenant_id=tenant.id)
    session.add(user)
    session.commit()
    session.refresh(user)
    return user.id


@pytest.fixture()
def ctx(tmp_path, monkeypatch):
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)

    def override():
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override
    with Session(engine) as s:
        uid = _make_user(s, "anim@toiv.ai")

    imp = tmp_path / "imports"
    out = tmp_path / "outputs"
    monkeypatch.setattr("app.routes.animatic._IMPORT_DIR", imp)
    monkeypatch.setattr("app.routes.animatic._OUTPUT_DIR", out)
    monkeypatch.setattr("app.routes.animatic._WS_IMPORT_DIR", "/ws/imports")
    monkeypatch.setattr("app.routes.animatic._WS_OUTPUT_DIR", "/ws/outputs")
    monkeypatch.setattr(
        "app.routes.animatic.enforce_generation_rate_limit", lambda *a, **k: None
    )
    yield TestClient(app), {"Authorization": f"Bearer {create_token(uid)}"}, imp, out
    app.dependency_overrides.clear()


def _fake_run_ok(out_dir: Path, captured: list):
    """模拟 ssh ffmpeg 成功:在 core 侧 outputs 造出同名成片(NAS 双向可见)。"""
    def fake_run(cmd, **kwargs):
        captured.append(cmd)
        remote = cmd[-1]
        name = Path(remote.rsplit(" ", 1)[-1]).name
        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / name).write_bytes(b"\x00\x00\x00\x18ftypmp42")
        return subprocess.CompletedProcess(cmd, 0, "", "")

    return fake_run


def _fake_run_fail(cmd, **kwargs):
    return subprocess.CompletedProcess(cmd, 1, "", "x" * 600 + "boom-tail")


def _post(client, auth, files, data):
    return client.post("/api/animatic", files=files, data=data, headers=auth)


# ────────────────────────────────
# ffmpeg 命令构造(纯函数)
# ────────────────────────────────

def test_fmt_sec():
    assert _fmt_sec(3.0) == "3"
    assert _fmt_sec(2.5) == "2.5"
    assert _fmt_sec(0.5) == "0.5"
    assert _fmt_sec(1.25) == "1.25"


def test_build_cmd_structure():
    cmd = _build_ffmpeg_cmd(
        ["/ws/in/abc123def456/001.jpg", "/ws/in/abc123def456/002.png", "/ws/in/abc123def456/003.webp"],
        [3.0, 2.5, 1.0],
        24,
        1920,
        1080,
        "/ws/out/abc123def456.mp4",
    )
    # 每张图一段 -loop 1 -t {dur} -i
    assert cmd.count("-loop 1") == 3
    assert "-t 3 -i /ws/in/abc123def456/001.jpg" in cmd
    assert "-t 2.5 -i /ws/in/abc123def456/002.png" in cmd
    assert "-t 1 -i /ws/in/abc123def456/003.webp" in cmd
    # scale 保比缩小 + pad 黑边居中 + fps/像素格式/采样比归一
    assert "scale=1920:1080:force_original_aspect_ratio=decrease" in cmd
    assert "pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black" in cmd
    assert "fps=24" in cmd
    assert "format=yuv420p" in cmd
    # concat 串接 + h264 + faststart 输出
    assert "[v0][v1][v2]concat=n=3:v=1:a=0[outv]" in cmd
    assert "-c:v libx264" in cmd
    assert "-pix_fmt yuv420p" in cmd
    assert "+faststart" in cmd
    assert cmd.endswith("-y /ws/out/abc123def456.mp4")


def test_build_cmd_single_image_concat_n1():
    cmd = _build_ffmpeg_cmd(["/ws/in/a/001.jpg"], [5.0], 30, 1280, 720, "/ws/out/a.mp4")
    assert "concat=n=1:v=1:a=0" in cmd
    assert "scale=1280:720" in cmd
    assert "fps=30" in cmd


def test_build_cmd_quotes_paths_with_spaces():
    cmd = _build_ffmpeg_cmd(["/ws/my dir/001.jpg"], [2.0], 24, 1920, 1080, "/ws/my dir/o.mp4")
    assert "'/ws/my dir/001.jpg'" in cmd
    assert "'/ws/my dir/o.mp4'" in cmd
    # [outv] 含 shell glob 元字符,必须引用
    assert "'[outv]'" in cmd


# ────────────────────────────────
# POST 校验 → 422
# ────────────────────────────────

def test_durations_count_mismatch_422(ctx):
    client, auth, _, _ = ctx
    files = [
        ("images", ("a.jpg", _JPG, "image/jpeg")),
        ("images", ("b.jpg", _JPG, "image/jpeg")),
    ]
    r = _post(client, auth, files, {"durations": json.dumps([3.0])})
    assert r.status_code == 422


def test_invalid_extension_422(ctx):
    client, auth, _, _ = ctx
    files = [("images", ("a.gif", b"GIF89a", "image/gif"))]
    r = _post(client, auth, files, {"durations": json.dumps([3.0])})
    assert r.status_code == 422
    assert "格式" in r.json()["detail"]


def test_traversal_filename_422(ctx):
    client, auth, _, _ = ctx
    files = [("images", ("../../etc/evil.jpg", _JPG, "image/jpeg"))]
    r = _post(client, auth, files, {"durations": json.dumps([3.0])})
    assert r.status_code == 422
    assert "穿越" in r.json()["detail"]


def test_too_many_images_422(ctx):
    client, auth, _, _ = ctx
    files = [("images", (f"{i:03d}.jpg", _JPG, "image/jpeg")) for i in range(21)]
    r = _post(client, auth, files, {"durations": json.dumps([3.0] * 21)})
    assert r.status_code == 422


def test_duration_out_of_range_422(ctx):
    client, auth, _, _ = ctx
    files = [("images", ("a.jpg", _JPG, "image/jpeg"))]
    r = _post(client, auth, files, {"durations": json.dumps([0.1])})
    assert r.status_code == 422
    r = _post(client, auth, files, {"durations": json.dumps([31.0])})
    assert r.status_code == 422
    r = _post(client, auth, files, {"durations": json.dumps(["x"])})
    assert r.status_code == 422


def test_bad_durations_json_422(ctx):
    client, auth, _, _ = ctx
    files = [("images", ("a.jpg", _JPG, "image/jpeg"))]
    r = _post(client, auth, files, {"durations": "not-json"})
    assert r.status_code == 422


def test_fps_out_of_range_422(ctx):
    client, auth, _, _ = ctx
    files = [("images", ("a.jpg", _JPG, "image/jpeg"))]
    r = _post(client, auth, files, {"durations": json.dumps([3.0]), "fps": "8"})
    assert r.status_code == 422


def test_unauthenticated_401(ctx):
    client, _, _, _ = ctx
    files = [("images", ("a.jpg", _JPG, "image/jpeg"))]
    r = client.post("/api/animatic", files=files, data={"durations": json.dumps([3.0])})
    assert r.status_code == 401


# ────────────────────────────────
# POST 成功 / ffmpeg 失败
# ────────────────────────────────

def test_create_success(ctx, monkeypatch):
    client, auth, imp, out = ctx
    captured: list = []
    monkeypatch.setattr("subprocess.run", _fake_run_ok(out, captured))

    files = [
        ("images", ("b.png", _PNG, "image/png")),
        ("images", ("a.jpg", _JPG, "image/jpeg")),
    ]
    r = _post(
        client, auth, files,
        {"durations": json.dumps([2.5, 3.0]), "fps": "24", "width": "1920", "height": "1080"},
    )
    assert r.status_code == 200, r.text
    data = r.json()
    assert re.fullmatch(r"[a-z0-9]{12}", data["job_id"])
    assert data["url"] == f"/api/animatic/output/{data['job_id']}.mp4"
    assert data["count"] == 2
    assert data["duration"] == 5.5
    assert data["fps"] == 24 and data["width"] == 1920 and data["height"] == 1080

    # 图片按上传顺序编号落 NAS imports,保留原格式扩展名
    job_dir = imp / data["job_id"]
    assert (job_dir / "001.png").is_file()
    assert (job_dir / "002.jpg").is_file()

    # ssh 到 workstation 执行,命令内为 workstation 侧 NAS 路径
    cmd = captured[0]
    assert cmd[0] == "ssh" and "merlin@192.168.71.127" in cmd
    remote = cmd[-1]
    assert f"/ws/imports/{data['job_id']}/001.png" in remote
    assert f"/ws/outputs/{data['job_id']}.mp4" in remote
    assert "concat=n=2:v=1:a=0" in remote

    # 成片经 NAS 回到 core 侧
    assert (out / f"{data['job_id']}.mp4").is_file()


def test_odd_dimensions_snapped_even(ctx, monkeypatch):
    client, auth, _, out = ctx
    captured: list = []
    monkeypatch.setattr("subprocess.run", _fake_run_ok(out, captured))
    files = [("images", ("a.jpg", _JPG, "image/jpeg"))]
    r = _post(
        client, auth, files,
        {"durations": json.dumps([3.0]), "width": "1279", "height": "719"},
    )
    assert r.status_code == 200
    assert r.json()["width"] == 1278 and r.json()["height"] == 718


def test_ffmpeg_failure_502_and_cleanup(ctx, monkeypatch):
    client, auth, imp, out = ctx
    monkeypatch.setattr("subprocess.run", _fake_run_fail)
    files = [("images", ("a.jpg", _JPG, "image/jpeg"))]
    r = _post(client, auth, files, {"durations": json.dumps([3.0])})
    assert r.status_code == 502
    # stderr 尾 500 字符随 detail 返回
    assert "boom-tail" in r.json()["detail"]
    # 失败清理:imports 作业目录与 outputs 半成品都不留
    assert list(imp.iterdir()) == []
    assert list(out.glob("*.mp4")) == []


def test_ffmpeg_timeout_502(ctx, monkeypatch):
    client, auth, _, _ = ctx

    def _timeout(cmd, **kwargs):
        raise subprocess.TimeoutExpired(cmd, 300)

    monkeypatch.setattr("subprocess.run", _timeout)
    files = [("images", ("a.jpg", _JPG, "image/jpeg"))]
    r = _post(client, auth, files, {"durations": json.dumps([3.0])})
    assert r.status_code == 502
    assert "超时" in r.json()["detail"]


# ────────────────────────────────
# GET 白名单
# ────────────────────────────────

def test_output_whitelist_404(ctx):
    client, auth, _, _ = ctx
    for bad in ["../../etc/passwd", "abc.mp4", "ABC123DEF456.mp4", "abc123def456.mp4.bak", "abc123def456"]:
        r = client.get(f"/api/animatic/output/{bad}", headers=auth)
        assert r.status_code == 404, bad


def test_output_missing_404(ctx):
    client, auth, _, _ = ctx
    r = client.get("/api/animatic/output/abc123def456.mp4", headers=auth)
    assert r.status_code == 404


def test_output_served(ctx):
    client, auth, _, out = ctx
    out.mkdir(parents=True, exist_ok=True)
    (out / "abc123def456.mp4").write_bytes(b"\x00\x00\x00\x18ftypmp42")
    r = client.get("/api/animatic/output/abc123def456.mp4", headers=auth)
    assert r.status_code == 200
    assert r.headers["content-type"] == "video/mp4"
    assert r.content == b"\x00\x00\x00\x18ftypmp42"
