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
