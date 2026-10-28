"""W5 pose-gallery 只读静态接口测试。

覆盖:
- 合法 thumbs/img 回读 200 + Cache-Control
- 缺文件 / 缺根目录 → 404
- 路径穿越(.. / 绝对 / 子路径) → 400
- health 探活反映目录存在与否
根路径 monkeypatch 到 tmp,不依赖真实 NAS/core 盘。
"""
from __future__ import annotations

from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.routes import pose_gallery as pg

_PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 8


@pytest.fixture()
def roots(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    thumbs = tmp_path / "thumbs"
    imgs = tmp_path / "img"
    thumbs.mkdir()
    imgs.mkdir()
    monkeypatch.setattr(pg, "_thumbs_root", thumbs)
    monkeypatch.setattr(pg, "_img_root", imgs)
    return thumbs, imgs


@pytest.fixture()
def client(roots):
    app = FastAPI()
    app.include_router(pg.router, prefix="/api")
    with TestClient(app) as c:
        yield c


def test_thumb_serves_file(client: TestClient, roots):
    thumbs, _ = roots
    (thumbs / "a.webp").write_bytes(b"RIFF....WEBP")
    r = client.get("/api/pose-gallery/thumbs/a.webp")
    assert r.status_code == 200, r.text
    assert r.content.startswith(b"RIFF")
    assert "public" in r.headers.get("cache-control", "").lower()
    assert "max-age=" in r.headers.get("cache-control", "").lower()


def test_img_serves_file(client: TestClient, roots):
    _, imgs = roots
    (imgs / "b.png").write_bytes(_PNG)
    r = client.get("/api/pose-gallery/img/b.png")
    assert r.status_code == 200, r.text
    assert r.content[:4] == b"\x89PNG"
    assert "public" in r.headers.get("cache-control", "").lower()


def test_missing_file_404(client: TestClient, roots):
    assert client.get("/api/pose-gallery/thumbs/nope.webp").status_code == 404
    assert client.get("/api/pose-gallery/img/nope.png").status_code == 404


def test_missing_root_404(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    missing = tmp_path / "absent"
    monkeypatch.setattr(pg, "_thumbs_root", missing)
    monkeypatch.setattr(pg, "_img_root", missing)
    app = FastAPI()
    app.include_router(pg.router, prefix="/api")
    with TestClient(app) as c:
        assert c.get("/api/pose-gallery/thumbs/a.webp").status_code == 404
        assert c.get("/api/pose-gallery/img/a.png").status_code == 404


@pytest.mark.parametrize(
    "name",
    [
        "..",
        "../etc/passwd",
        "..%2Fetc%2Fpasswd",
        "/etc/passwd",
        "a/../../etc/passwd",
        "foo/bar.webp",
    ],
)
def test_traversal_rejected(client: TestClient, roots, name: str):
    r_t = client.get(f"/api/pose-gallery/thumbs/{name}")
    r_i = client.get(f"/api/pose-gallery/img/{name}")
    # 含 / 的 path 参数可能 404(路由不匹配);其余非法名 400
    assert r_t.status_code in (400, 404), (name, r_t.status_code, r_t.text)
    assert r_i.status_code in (400, 404), (name, r_i.status_code, r_i.text)
    assert r_t.status_code != 200 and r_i.status_code != 200


def test_encoded_dotdot_basename_400(client: TestClient, roots):
    """URL 编码的 `..`(%2e%2e)打到 handler 后必须 400(pathsafe)。
    字面 `/thumbs/..` 会被 Starlette 归一成上级路径 → 路由 404,另测覆盖。
    """
    r = client.get("/api/pose-gallery/thumbs/%2e%2e")
    assert r.status_code == 400
    assert client.get("/api/pose-gallery/thumbs/..").status_code in (400, 404)


def test_health_reports_dirs(client: TestClient, roots):
    r = client.get("/api/pose-gallery/health")
    assert r.status_code == 200
    body = r.json()
    assert body["thumbs_ok"] is True
    assert body["img_ok"] is True
    assert body["ok"] is True
    assert str(roots[0]) == body["thumbs_root"]
    assert str(roots[1]) == body["img_root"]


def test_health_false_when_absent(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(pg, "_thumbs_root", tmp_path / "no-thumbs")
    monkeypatch.setattr(pg, "_img_root", tmp_path / "no-img")
    app = FastAPI()
    app.include_router(pg.router, prefix="/api")
    with TestClient(app) as c:
        body = c.get("/api/pose-gallery/health").json()
        assert body["thumbs_ok"] is False
        assert body["img_ok"] is False
        assert body["ok"] is False
