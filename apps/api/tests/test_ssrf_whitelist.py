"""SSRF 白名单收口(T0 安全红线,P1):

1) 7 处同源白名单副本(lipsync/scope/cad/audio_orchestrate/voice/drama_studio/assembly):
   回环 127.0.0.1/localhost 不再全端口通配(旧行为可经这些端点打 Redis/内网服务),
   仅放行本 API 自身端口(api_base_url);worker host 与相对路径语义不变。
2) follow_redirects 下载:最终落点不在白名单且与初始(已验)URL 不同源 → 400,
   防白名单内地址开放重定向绕过 SSRF 检查。
"""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import HTTPException

from app.models import User
from app.routes import (
    assembly,
    audio_orchestrate,
    avatar_studio,
    cad,
    chromakey,
    drama_studio,
    lipsync,
    scope,
    video_lipsync,
    voice,
)


class _Settings:
    api_base_url = "http://127.0.0.1:8090"
    worker_urls = ["http://worker1:8188", "http://192.168.71.127:8189"]
    tts_url = "http://tts.zh"  # voice/avatar_studio 读;白名单判定不涉
    tts_multilingual_url = ""


@pytest.fixture(autouse=True)
def _patch_settings(monkeypatch):
    for mod in (assembly, audio_orchestrate, cad, drama_studio, lipsync, scope, voice):
        monkeypatch.setattr(mod, "get_settings", lambda: _Settings())


def _user() -> User:
    return User(id="u1", tenant_id="t1", email="u@t.com", hashed_password="x")


# ---------------------------------------------------------------------------
# 1) 白名单语义:回环仅放行本 API 端口
# ---------------------------------------------------------------------------

_WHITELIST_FUNCS = [
    ("lipsync._allowed", lipsync._allowed),
    ("scope._allowed", scope._allowed),
    ("cad._allowed", cad._allowed),
    ("audio_orchestrate._allowed_source", audio_orchestrate._allowed_source),
    ("voice._allowed_ref", voice._allowed_ref),
    ("drama_studio._allowed_ref", drama_studio._allowed_ref),
    ("assembly._is_allowed_clip", assembly._is_allowed_clip),
]

_URL_CASES = [
    ("/api/images/x.png", True),  # 相对路径(本 API)
    ("http://worker1:8188/view?filename=a.png", True),  # 白名单 worker
    ("http://192.168.71.127:8189/view?filename=a.png", True),
    ("http://127.0.0.1:8090/api/images/a.png", True),  # 本机 API 端口(同源回链)
    ("http://localhost:8090/api/images/a.png", True),
    ("http://127.0.0.1:6379/", False),  # Redis:旧通配放行,现拒
    ("http://127.0.0.1:9100/train", False),  # trainer
    ("http://localhost:9999/x", False),
    # 注意:白名单是 host 级(worker host 上任意端口放行,既有语义保留),
    # 故 192.168.71.127:9100 这类「worker 同机其他服务」仍放行;非 worker 内网才拒。
    ("http://192.168.71.99:9100/x", False),  # 内网非 worker host
    ("http://169.254.169.254/latest/meta-data", False),  # 云元数据
    ("http://evil.example.com/x.png", False),
    ("ftp://worker1:8188/x", False),  # 非 http(s) scheme
    ("http://127.0.0.1:99999999/x", False),  # 非法端口不炸,拒
]


@pytest.mark.parametrize("label,func", _WHITELIST_FUNCS)
@pytest.mark.parametrize("url,expected", _URL_CASES)
def test_whitelist_loopback_restricted(label, func, url, expected):
    assert func(url) is expected, f"{label}({url})"


# ---------------------------------------------------------------------------
# 2) 重定向复验:白名单内地址 302 到白名单外 → 400
# ---------------------------------------------------------------------------

_EVIL = "http://169.254.169.254/latest/meta-data"


class _Resp:
    def __init__(self, url: str, content: bytes = b"x"):
        self.url = url
        self.content = content

    def raise_for_status(self) -> None:
        pass


class _RedirectClient:
    """httpx.AsyncClient 替身:模拟 follow_redirects 后落到指定最终 URL。"""

    def __init__(self, final_url: str):
        self._final = final_url

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        pass

    async def get(self, url: str):
        return _Resp(self._final)


def _patch_http(monkeypatch, module, final_url: str) -> None:
    """只换 AsyncClient(保留 httpx.HTTPError 等真实异常类,供 except 子句捕获)。"""
    monkeypatch.setattr(
        module.httpx, "AsyncClient", lambda *a, **k: _RedirectClient(final_url)
    )


async def test_lipsync_redirect_to_evil_blocked(monkeypatch):
    monkeypatch.setattr(
        "app.routes.lipsync.enforce_generation_rate_limit", lambda *a, **k: None
    )
    _patch_http(monkeypatch, lipsync, _EVIL)
    pool = MagicMock()
    pool.pick = AsyncMock(return_value=MagicMock(base_url="http://worker1:8188"))
    with pytest.raises(HTTPException) as ei:
        await lipsync.lipsync_shot(
            lipsync.LipsyncRequest(
                video_url="http://worker1:8188/v.mp4", voice_url="/api/voice.wav"
            ),
            pool,
            _user(),
            MagicMock(),
        )
    assert ei.value.status_code == 400
    assert "重定向" in ei.value.detail


async def test_scope_image_redirect_to_evil_blocked(monkeypatch):
    _patch_http(monkeypatch, scope, _EVIL)
    req = scope.ScopeGenerateRequest(
        prompt="p", trajectory="gen/dolly_in", image_url="http://worker1:8188/a.png"
    )
    with pytest.raises(HTTPException) as ei:
        await scope._fetch_image_b64(req)
    assert ei.value.status_code == 400
    assert "重定向" in ei.value.detail


async def test_cad_control_redirect_to_evil_blocked(monkeypatch):
    _patch_http(monkeypatch, cad, _EVIL)
    with pytest.raises(HTTPException) as ei:
        await cad._load_control_bytes("http://worker1:8188/c.png")
    assert ei.value.status_code == 400
    assert "重定向" in ei.value.detail


async def test_audio_orchestrate_separate_redirect_blocked(monkeypatch, tmp_path):
    monkeypatch.setattr(
        "app.routes.audio_orchestrate.enforce_generation_rate_limit", lambda *a, **k: None
    )
    monkeypatch.setattr(
        "app.routes.audio_orchestrate.audio_output_root", lambda: tmp_path
    )
    monkeypatch.setattr(
        "app.routes.audio_orchestrate.content_subdir", lambda sub: tmp_path / sub
    )
    _patch_http(monkeypatch, audio_orchestrate, _EVIL)
    body = audio_orchestrate.OrchestrateRequest(
        steps=[
            audio_orchestrate.SeparateStep(
                type="separate", source_url="http://worker1:8188/a.wav"
            )
        ]
    )
    with pytest.raises(HTTPException) as ei:
        await audio_orchestrate.audio_orchestrate(body, _user(), MagicMock())
    assert ei.value.status_code == 400
    assert "重定向" in ei.value.detail


async def test_voice_ref_redirect_to_evil_blocked(monkeypatch):
    monkeypatch.setattr(
        "app.routes.voice.enforce_generation_rate_limit", lambda *a, **k: None
    )
    _patch_http(monkeypatch, voice, _EVIL)
    body = voice.VoiceRequest(text="你好", ref_audio_url="http://worker1:8188/ref.wav")
    with pytest.raises(HTTPException) as ei:
        await voice.synth_voice(body, _user(), MagicMock())
    assert ei.value.status_code == 400
    assert "重定向" in ei.value.detail


async def test_chromakey_background_redirect_blocked(tmp_path):
    with pytest.raises(HTTPException) as ei:
        await chromakey._download_background(
            _RedirectClient(_EVIL), "http://worker1:8188/bg.png", tmp_path / "bg.png"
        )
    assert ei.value.status_code == 400
    assert "重定向" in ei.value.detail


async def test_video_lipsync_external_redirect_blocked(monkeypatch, tmp_path):
    _patch_http(monkeypatch, video_lipsync, _EVIL)
    with pytest.raises(HTTPException) as ei:
        await video_lipsync._download_external(
            "http://worker1:8188/v.mp4", tmp_path / "v.mp4", 1024, "视频"
        )
    assert ei.value.status_code == 400
    assert "重定向" in ei.value.detail


async def test_drama_ref_image_redirect_blocked(monkeypatch):
    _patch_http(monkeypatch, drama_studio, _EVIL)
    with pytest.raises(HTTPException) as ei:
        await drama_studio._fetch_ref_image_bytes(MagicMock(), "http://worker1:8188/ref.png")
    assert ei.value.status_code == 400
    assert "重定向" in ei.value.detail


async def test_avatar_drive_voice_redirect_blocked(monkeypatch):
    monkeypatch.setattr("app.routes.avatar_studio.get_settings", lambda: _Settings())
    _patch_http(monkeypatch, avatar_studio, _EVIL)
    with pytest.raises(HTTPException) as ei:
        await avatar_studio._synth_drive_audio("你好", "http://worker1:8188/ref.wav", 1.0)
    assert ei.value.status_code == 400
    assert "重定向" in ei.value.detail


async def test_assembly_download_clip_redirect_blocked(tmp_path):
    with pytest.raises(HTTPException) as ei:
        await assembly._download_clip(
            _RedirectClient(_EVIL), "http://worker1:8188/x.mp4", tmp_path / "c.mp4"
        )
    assert ei.value.status_code == 400
    assert "重定向" in ei.value.detail


async def test_assembly_download_clip_same_origin_redirect_ok(tmp_path):
    """同 worker 内的重定向(换路径)放行——白名单内落点不构成 SSRF。"""
    dest = tmp_path / "c.mp4"
    await assembly._download_clip(
        _RedirectClient("http://worker1:8188/redirected/x.mp4"),
        "http://worker1:8188/x.mp4",
        dest,
    )
    assert dest.read_bytes() == b"x"
