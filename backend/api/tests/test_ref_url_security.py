"""C1b 逆向安全:参考 URL 安全边界。

覆盖:
- pipeline_c_render._fetch_bytes:
  · 裸文件路径拒绝(且拒绝发生在任何文件/网络 I/O 之前)
  · /api/studio/files 合法站内直读
  · /api/images?worker= 必须经 deps.resolve_worker 白名单(未知 worker 拒绝;
    旧端口经同机回退仍可用)
  · 公网 http(s) 保留正当远程参考用途,但默认拒绝私网/环回/链路本地/保留地址、
    拒绝 URL userinfo;仅 Settings.ref_fetch_allowed_hosts 配置主机可放行
- voice_ref_url 同口径(站内直读 / 公网守卫 / 非法拒绝)
- RenderShotBody.video_model 缺省保持 shot.video_model(不强制 h3 覆盖 ltx)
"""
from __future__ import annotations

import socket

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

import app.services.h3 as h3_svc
from app.db import get_session
from app.main import app
from app.models import StudioShot, Tenant, User
from app.security import create_token, hash_password
from app.services.studio import voice
from app.services.studio.pipeline_c_render import _fetch_bytes
from app.services.studio.renderers.base import RenderError


# ── 工具 ─────────────────────────────────────────────────────────────────────


def _patch_settings(monkeypatch, **fields):
    """替换 app.deps/app.config 两处 get_settings(resolve_worker/ref_guard 口径)。"""
    base = {
        "worker_urls": ["http://192.168.71.127:8189", "http://192.168.71.127:8190"],
        "worker_host_groups": [],
        "request_timeout": 30.0,
        "ref_fetch_allowed_hosts": "",
    }
    base.update(fields)
    fake = type("S", (), base)()
    monkeypatch.setattr("app.deps.get_settings", lambda: fake)
    monkeypatch.setattr("app.config.get_settings", lambda: fake)
    monkeypatch.setattr(h3_svc, "h3_instances", lambda: [])
    return fake


class _BoomAsyncClient:
    """任何请求都视为测试失败:证明安全拒绝发生在网络 I/O 之前。"""

    def __init__(self, *a, **k):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def get(self, *a, **k):
        raise AssertionError("安全拒绝后仍发起网络请求")

    async def post(self, *a, **k):
        raise AssertionError("安全拒绝后仍发起网络请求")


def _no_network(monkeypatch, module):
    monkeypatch.setattr(module.httpx, "AsyncClient", lambda *a, **k: _BoomAsyncClient())


class _FakeResponse:
    def __init__(self, content: bytes):
        self.status_code = 200
        self.content = content

    def raise_for_status(self):
        return None


def _fake_http_client(monkeypatch, module, content: bytes, seen: dict):
    class _C:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def get(self, url, *a, **k):
            seen["url"] = url
            return _FakeResponse(content)

    monkeypatch.setattr(module.httpx, "AsyncClient", lambda *a, **k: _C())


# ── _fetch_bytes:裸路径 / 站内文件 ────────────────────────────────────────────


async def test_fetch_bytes_rejects_bare_path_before_io(tmp_path, monkeypatch):
    """裸绝对路径(历史上 Path.is_file() 可读任意本地文件)必须拒绝,且在 I/O 之前。"""
    from pathlib import Path

    import app.services.studio.pipeline_c_render as pcr

    secret = tmp_path / "secret.png"
    secret.write_bytes(b"TOPSECRET")
    _no_network(monkeypatch, pcr)
    # 任何文件读取都视为失败
    monkeypatch.setattr(
        Path,
        "read_bytes",
        lambda self: (_ for _ in ()).throw(AssertionError("拒绝后仍读取文件")),
    )
    with pytest.raises(RenderError, match="裸文件路径"):
        await _fetch_bytes(str(secret))


async def test_fetch_bytes_studio_files_reads_disk(tmp_path, monkeypatch):
    """合法 /api/studio/files/{name} 站内直读不被破坏。"""
    import app.services.studio.pipeline_c_render as pcr

    root = tmp_path
    (root / "studio").mkdir()
    (root / "studio" / "ref.png").write_bytes(b"PNGDATA")
    monkeypatch.setattr("app.storage.drama_output_root", lambda: root)
    _no_network(monkeypatch, pcr)
    assert await _fetch_bytes("/api/studio/files/ref.png") == b"PNGDATA"


async def test_fetch_bytes_studio_files_missing_rejected(tmp_path, monkeypatch):
    import app.services.studio.pipeline_c_render as pcr

    monkeypatch.setattr("app.storage.drama_output_root", lambda: tmp_path)
    (tmp_path / "studio").mkdir()
    _no_network(monkeypatch, pcr)
    with pytest.raises(RenderError):
        await _fetch_bytes("/api/studio/files/nope.png")


# ── _fetch_bytes:/api/images worker 白名单 ───────────────────────────────────


async def test_fetch_bytes_api_images_unknown_worker_rejected(monkeypatch):
    """worker 未配置(任意 host)不得直接构造 ComfyUIClient(SSRF)。"""
    import app.comfy.client as comfy_client
    import app.services.studio.pipeline_c_render as pcr

    _patch_settings(monkeypatch)
    _no_network(monkeypatch, pcr)

    def _boom(self, *a, **k):
        raise AssertionError("绕过白名单直接构造 ComfyUIClient 取图")

    monkeypatch.setattr(comfy_client.ComfyUIClient, "get_image_bytes", _boom)
    url = "/api/images?filename=x.png&worker=http://evil.example.com:8188"
    with pytest.raises(RenderError, match="worker"):
        await _fetch_bytes(url)


async def test_fetch_bytes_api_images_uses_resolve_worker_same_host_fallback(monkeypatch):
    """旧产物 URL 的 worker 端口(:8188)已不在白名单 → 经 resolve_worker 同机回退代取。"""
    import app.comfy.client as comfy_client
    import app.services.studio.pipeline_c_render as pcr

    _patch_settings(monkeypatch)
    seen: dict = {}

    async def _fake_get(self, fn, sub, typ):
        seen["base_url"] = self.base_url
        return b"IMG", "image/png"

    monkeypatch.setattr(comfy_client.ComfyUIClient, "get_image_bytes", _fake_get)
    url = "/api/images?filename=x.png&worker=http://192.168.71.127:8188"
    assert await _fetch_bytes(url) == b"IMG"
    assert seen["base_url"] == "http://192.168.71.127:8189"


# ── _fetch_bytes:公网 http(s) SSRF 守卫 ─────────────────────────────────────


@pytest.mark.parametrize(
    "url",
    [
        "http://127.0.0.1:8090/api/x.png",  # 环回
        "http://10.0.0.8/a.png",  # 私网 A
        "http://172.16.0.1/a.png",  # 私网 B
        "http://192.168.71.127:8188/a.png",  # 私网 C(受信机也不可经任意 http 直取)
        "http://169.254.169.254/latest/meta-data",  # 链路本地(云元数据)
        "http://[::1]/a.png",  # IPv6 环回
        "http://[fe80::1]/a.png",  # IPv6 链路本地
        "http://0.0.0.0/a.png",  # 未指定地址
        "http://user:pass@93.184.216.34/a.png",  # URL userinfo(凭据外带/解析歧义)
    ],
)
async def test_fetch_bytes_rejects_nonpublic_http_targets(url, monkeypatch):
    """私网/环回/链路本地/userinfo 目标默认拒绝,且拒绝先于任何网络请求。"""
    import app.services.studio.pipeline_c_render as pcr

    _patch_settings(monkeypatch)
    _no_network(monkeypatch, pcr)
    with pytest.raises(RenderError):
        await _fetch_bytes(url)


def _ref_guard():
    import app.services.ref_guard as ref_guard

    return ref_guard


async def test_fetch_bytes_rejects_hostname_resolving_to_private(monkeypatch):
    """公网主机名解析到私网地址(DNS 指向内网)同样拒绝。"""
    import app.services.studio.pipeline_c_render as pcr

    ref_guard = _ref_guard()
    _patch_settings(monkeypatch)
    _no_network(monkeypatch, pcr)

    def _fake_getaddrinfo(host, port, *a, **k):
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("10.0.0.5", port or 80))]

    monkeypatch.setattr(ref_guard.socket, "getaddrinfo", _fake_getaddrinfo)
    with pytest.raises(RenderError):
        await _fetch_bytes("http://cdn.example.com/a.png")


async def test_fetch_bytes_allows_public_http(monkeypatch):
    """公网 http(s) 媒体(正当远程参考用途)不被砍:正常取回。"""
    import app.services.studio.pipeline_c_render as pcr

    _patch_settings(monkeypatch)
    seen: dict = {}
    _fake_http_client(monkeypatch, pcr, b"REMOTEIMG", seen)
    assert await _fetch_bytes("http://93.184.216.34/ref.png") == b"REMOTEIMG"
    assert seen["url"] == "http://93.184.216.34/ref.png"


async def test_fetch_bytes_configured_host_may_be_private(monkeypatch):
    """仅 Settings.ref_fetch_allowed_hosts 显式配置的主机可放行内网目标。"""
    import app.services.studio.pipeline_c_render as pcr

    ref_guard = _ref_guard()
    _patch_settings(monkeypatch, ref_fetch_allowed_hosts="cdn.internal")
    seen: dict = {}

    def _fake_getaddrinfo(host, port, *a, **k):
        assert host == "cdn.internal"
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("10.0.0.5", port or 80))]

    monkeypatch.setattr(ref_guard.socket, "getaddrinfo", _fake_getaddrinfo)
    _fake_http_client(monkeypatch, pcr, b"TRUSTEDIMG", seen)
    assert await _fetch_bytes("http://cdn.internal/ref.png") == b"TRUSTEDIMG"


async def test_fetch_bytes_unconfigured_private_hostname_still_rejected(monkeypatch):
    """不在配置清单里的内网主机名仍拒绝(配置例外不扩散)。"""
    import app.services.studio.pipeline_c_render as pcr

    ref_guard = _ref_guard()
    _patch_settings(monkeypatch, ref_fetch_allowed_hosts="cdn.internal")
    _no_network(monkeypatch, pcr)

    def _fake_getaddrinfo(host, port, *a, **k):
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("10.0.0.6", port or 80))]

    monkeypatch.setattr(ref_guard.socket, "getaddrinfo", _fake_getaddrinfo)
    with pytest.raises(RenderError):
        await _fetch_bytes("http://other.internal/ref.png")


# ── voice_ref_url 同口径 ──────────────────────────────────────────────────────


async def test_voice_ref_studio_files_reads_disk(tmp_path, monkeypatch):
    """角色参考音 /api/studio/files 站内直读(不再回环 HTTP 拉取)。"""
    root = tmp_path
    (root / "studio").mkdir()
    (root / "studio" / "ref-voice.wav").write_bytes(b"RIFFVOICE")
    monkeypatch.setattr("app.storage.drama_output_root", lambda: root)
    _no_network(monkeypatch, voice)
    assert await voice._fetch_voice_ref("/api/studio/files/ref-voice.wav") == b"RIFFVOICE"


@pytest.mark.parametrize(
    "url",
    [
        "/etc/passwd",  # 裸文件路径
        "file:///etc/passwd",  # 非 http(s) scheme
        "http://127.0.0.1:8090/api/studio/files/x.wav",  # 环回
        "http://192.168.71.127/x.wav",  # 私网
        "http://user:pass@93.184.216.34/x.wav",  # userinfo
    ],
)
async def test_voice_ref_rejects_unsafe(url, monkeypatch):
    """非法参考音返回 None(降级默认音色),且不发起网络请求。"""
    _no_network(monkeypatch, voice)
    assert await voice._fetch_voice_ref(url) is None


async def test_voice_ref_allows_public_http(monkeypatch):
    seen: dict = {}
    _fake_http_client(monkeypatch, voice, b"RIFFREMOTE", seen)
    assert await voice._fetch_voice_ref("http://93.184.216.34/voice.wav") == b"RIFFREMOTE"


# ── video_model 缺省保持 shot 已选引擎 ───────────────────────────────────────


@pytest.fixture()
def ctx():
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    SQLModel.metadata.create_all(engine)

    def override() -> Session:
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override
    with Session(engine) as s:
        tenant = Tenant(name="c1b-sec")
        s.add(tenant)
        s.commit()
        s.refresh(tenant)
        user = User(
            email="c1b-sec@toiv.ai",
            hashed_password=hash_password("password1"),
            tenant_id=tenant.id,
        )
        s.add(user)
        s.commit()
        s.refresh(user)
        uid = user.id
    yield TestClient(app), create_token(uid), engine
    app.dependency_overrides.clear()


def _mk_video_shot(client, token):
    H = {"Authorization": f"Bearer {token}"}
    pr = client.post(
        "/api/studio/projects",
        headers=H,
        json={"title": "c1b", "premise": "x", "render_mode_default": "video"},
    )
    assert pr.status_code == 200, pr.text
    pid = pr.json()["id"]
    cr = client.post(
        f"/api/studio/projects/{pid}/characters",
        headers=H,
        json={"name": "林夏", "visual_prompt": "girl"},
    )
    cid = cr.json()["id"]
    refs = [
        "/api/studio/files/sample_linxia_front.png",
        "/api/studio/files/sample_linxia_side.png",
        "/api/studio/files/sample_linxia_full.png",
    ]
    assert client.patch(
        f"/api/studio/characters/{cid}", headers=H, json={"reference_images": refs}
    ).status_code == 200
    sr = client.put(
        f"/api/studio/projects/{pid}/shots",
        headers=H,
        json={
            "shots": [
                {
                    "scene": "雨夜",
                    "prompt": "进店",
                    "dialogue": "还营业吧？",
                    "characters": ["林夏"],
                    "render_mode": "video",
                }
            ]
        },
    )
    assert sr.status_code == 200, sr.text
    return pid, sr.json()["shots"][0]["id"]


def _patch_renderer(monkeypatch, seen):
    from app.services.studio import orchestrator as orch
    from app.services.studio.renderers.base import RenderResult

    class FakeRenderer:
        name = "video"

        async def render(self, shot, cast, pool, **kw):
            seen["video_model"] = kw.get("video_model")
            return RenderResult(
                kind="video",
                url="/api/studio/files/c1b_1.mp4",
                pipeline_meta={"pipeline": "c", "prompt": "cleaned"},
            )

    monkeypatch.setattr(orch, "get_renderer", lambda shot: FakeRenderer())
    monkeypatch.setattr(
        "app.services.studio.candidate_pick.pick_best_candidate",
        lambda cands, ref_image_path=None, local_url_resolver=None, **kw: (
            cands[0]["id"],
            [{**c, "is_picked": i == 0} for i, c in enumerate(cands)],
        ),
    )


def test_render_shot_body_video_model_default_is_none():
    from app.routes.studio import RenderShotBody

    assert RenderShotBody().video_model is None


def test_render_default_keeps_shot_ltx(ctx, monkeypatch):
    """body 不传 video_model 时保持 shot.video_model=ltx,不得被默认 h3 覆盖。"""
    client, token, engine = ctx
    H = {"Authorization": f"Bearer {token}"}
    _, sid = _mk_video_shot(client, token)
    with Session(engine) as s:
        shot = s.get(StudioShot, sid)
        shot.video_model = "ltx"
        s.add(shot)
        s.commit()
    seen: dict = {}
    _patch_renderer(monkeypatch, seen)
    r = client.post(
        f"/api/studio/shots/{sid}/render",
        headers=H,
        json={"num_candidates": 1, "force_direct": True},
    )
    assert r.status_code == 200, r.text
    assert seen["video_model"] == "ltx"


def test_render_explicit_video_model_overrides_shot(ctx, monkeypatch):
    """显式传 video_model=h3 仍可覆盖 ltx(旧能力不丢)。"""
    client, token, engine = ctx
    H = {"Authorization": f"Bearer {token}"}
    _, sid = _mk_video_shot(client, token)
    with Session(engine) as s:
        shot = s.get(StudioShot, sid)
        shot.video_model = "ltx"
        s.add(shot)
        s.commit()
    seen: dict = {}
    _patch_renderer(monkeypatch, seen)
    r = client.post(
        f"/api/studio/shots/{sid}/render",
        headers=H,
        json={"video_model": "h3", "num_candidates": 1, "force_direct": True},
    )
    assert r.status_code == 200, r.text
    assert seen["video_model"] == "h3"


def test_render_empty_body_keeps_shot_ltx(ctx, monkeypatch):
    """完全无 body(旧客户端)同样保持 shot 已选引擎。"""
    client, token, engine = ctx
    H = {"Authorization": f"Bearer {token}"}
    _, sid = _mk_video_shot(client, token)
    with Session(engine) as s:
        shot = s.get(StudioShot, sid)
        shot.video_model = "ltx"
        # 无 body 时无法带 force_direct;补关键帧使 keyframe 软闸放行
        shot.image_url = "/api/studio/files/kf.png"
        s.add(shot)
        s.commit()
    seen: dict = {}
    _patch_renderer(monkeypatch, seen)
    r = client.post(f"/api/studio/shots/{sid}/render", headers=H)
    assert r.status_code == 200, r.text
    assert seen["video_model"] == "ltx"
