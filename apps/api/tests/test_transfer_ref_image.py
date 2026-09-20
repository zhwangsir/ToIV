"""transfer_ref_image input→output 兜底(2026-09-21 M2 根修):

主体库 AI 三视图/作品库产物回填的参考图是 type=output URL,转运读取不能只查 input。
longcat 与 h3 两个 transfer_ref_image 同策略:input 失败自动再试 output,双败 502。
"""
from __future__ import annotations

import pytest
from fastapi import HTTPException

from app.comfy.client import ComfyUIError
from app.services import h3, longcat


class _Source:
    def __init__(self, ok_types: set[str]):
        self.ok_types = ok_types
        self.calls: list[str] = []

    async def get_image_bytes(self, filename, subfolder, url_type):
        self.calls.append(url_type)
        if url_type in self.ok_types:
            return b"IMG", "image/png"
        raise ComfyUIError(f"404 {url_type}")


class _Target:
    def __init__(self):
        self.uploads: list[tuple[bytes, str]] = []

    async def upload_image(self, content, name):
        self.uploads.append((content, name))
        return f"up-{name}"


@pytest.mark.parametrize("svc", [longcat, h3])
@pytest.mark.asyncio
async def test_transfer_input_hit_single_read(svc):
    src, tgt = _Source({"input"}), _Target()
    name = await svc.transfer_ref_image(tgt, src, "a.png")
    assert name == "up-a.png"
    assert src.calls == ["input"]  # input 命中不再多查


@pytest.mark.parametrize("svc", [longcat, h3])
@pytest.mark.asyncio
async def test_transfer_output_fallback(svc):
    src, tgt = _Source({"output"}), _Target()
    name = await svc.transfer_ref_image(tgt, src, "b.png")
    assert name == "up-b.png"
    assert src.calls == ["input", "output"]  # input 落空后 output 兜底
    assert tgt.uploads == [(b"IMG", "b.png")]


@pytest.mark.parametrize("svc", [longcat, h3])
@pytest.mark.asyncio
async def test_transfer_both_missing_502(svc):
    src, tgt = _Source(set()), _Target()
    with pytest.raises(HTTPException) as exc:
        await svc.transfer_ref_image(tgt, src, "c.png")
    assert exc.value.status_code == 502
    assert "读取失败" in exc.value.detail
    assert src.calls == ["input", "output"]
