"""C5 粗剪端点(2026-10-06):auto-editor 参数校验 / 产物名 / 路由注册 / 失败路径。

不真跑 auto-editor(子进程 mock);真机链路由运维侧实弹验证(雨夜成片)。
"""
from __future__ import annotations

import re

import pytest


def test_output_name_matches_whitelist():
    from app.routes.video_edit import _OUT_RE, _roughcut_out_name

    name = _roughcut_out_name()
    assert _OUT_RE.match(name), f"{name} 不在产物白名单内"


def test_roughcut_route_registered():
    from app.routes.video_edit import router

    paths = {getattr(r, "path", "") for r in router.routes}
    assert "/video-edit/rough-cut" in paths


@pytest.mark.asyncio
async def test_roughcut_rejects_non_api_url(monkeypatch):
    from app.routes import video_edit as ve

    async def _no_call(*a, **k):  # 不应触达取回逻辑
        raise AssertionError("不应发起取回")

    monkeypatch.setattr("httpx.AsyncClient", _no_call)
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as ei:
        await ve.rough_cut_video(url="https://evil.example/x.mp4", user=SimpleUser())
    assert ei.value.status_code == 422


@pytest.mark.asyncio
async def test_roughcut_rejects_bad_threshold(monkeypatch):
    from fastapi import HTTPException

    from app.routes import video_edit as ve

    monkeypatch.setattr("httpx.AsyncClient", object)
    with pytest.raises(HTTPException) as ei:
        await ve.rough_cut_video(url="/api/images?x=1", threshold="4%; rm -rf", user=SimpleUser())
    assert ei.value.status_code == 422


class SimpleUser:
    id = "u-roughcut"


# ── M3 收尾:Remotion 渲染端点(2026-10-06) ─────────────────────────────────

def test_remotion_route_registered():
    from app.routes.video_edit import router

    paths = {getattr(r, "path", "") for r in router.routes}
    assert "/video-edit/remotion-render" in paths


def test_remotion_out_name_whitelist():
    from app.routes.video_edit import _OUT_RE, _remotion_out_name

    name = _remotion_out_name()
    assert _OUT_RE.match(name), f"{name} 不在产物白名单"


def test_build_remotion_props_contract():
    from app.routes.video_edit import build_remotion_props

    p = build_remotion_props(["雨夜便利店", "林夏推门而入"], "旁白", 3.0)
    assert p["lines"] == ["雨夜便利店", "林夏推门而入"]
    assert p["speaker"] == "旁白"
    assert p["durationInFrames"] == 90  # 3s @30fps
    assert build_remotion_props(["x"], "", 0.2)["durationInFrames"] == 30  # 下限钳制


@pytest.mark.asyncio
async def test_remotion_rejects_empty_and_oversize(monkeypatch):
    from fastapi import HTTPException

    from app.routes import video_edit as ve

    with pytest.raises(HTTPException) as e1:
        await ve.remotion_render(lines="  \n  ", duration_sec=3.0, speaker="", user=SimpleUser())
    assert e1.value.status_code == 422
    with pytest.raises(HTTPException) as e2:
        await ve.remotion_render(lines="行" * 61, duration_sec=3.0, speaker="", user=SimpleUser())
    assert e2.value.status_code == 422
    with pytest.raises(HTTPException) as e3:
        await ve.remotion_render(lines="正常字幕", duration_sec=99.0, speaker="", user=SimpleUser())
    assert e3.value.status_code == 422
