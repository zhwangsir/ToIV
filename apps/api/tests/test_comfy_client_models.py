"""ComfyUIClient.model_names 的 object_info 解析测试。

覆盖两种 ComfyUI 返回格式:
- 旧版: required.field = [[opt1, opt2]]
- 新版 COMBO widget: required.field = ["COMBO", {"options": [...]}]
  (如新版 ComfyUI 的 UpscaleModelLoader)

回归背景: worker 实际有 RealESRGAN_x2plus.pth,但 _MODEL_LOADERS 未含
UpscaleModelLoader 且新版格式未解析 → LTX use_upscale 的 required_models
误判缺模型 → /generate-video 503。
"""
from __future__ import annotations

import pytest

from app.comfy.client import _MODEL_LOADERS, ComfyUIClient


_FIELD_BY_NODE = dict(_MODEL_LOADERS)


def _legacy_info(node: str, field: str, options: list[str]) -> dict:
    return {node: {"input": {"required": {field: [options]}}}}


def _combo_info(node: str, field: str, options: list[str]) -> dict:
    return {node: {"input": {"required": {field: ["COMBO", {"multiselect": False, "options": options}]}}}}


@pytest.mark.asyncio
async def test_model_names_parses_legacy_format(monkeypatch: pytest.MonkeyPatch):
    c = ComfyUIClient("http://x")

    async def fake(node: str) -> dict:
        return _legacy_info(node, _FIELD_BY_NODE[node], ["a.safetensors", "b.pth"])

    monkeypatch.setattr(c, "object_info", fake)
    names = await c.model_names()
    assert {"a.safetensors", "b.pth"} <= names


@pytest.mark.asyncio
async def test_model_names_parses_combo_widget_format(monkeypatch: pytest.MonkeyPatch):
    c = ComfyUIClient("http://x")

    async def fake(node: str) -> dict:
        return _combo_info(node, _FIELD_BY_NODE[node], ["4x-UltraSharp.pth", "RealESRGAN_x2plus.pth"])

    monkeypatch.setattr(c, "object_info", fake)
    names = await c.model_names()
    assert {"4x-UltraSharp.pth", "RealESRGAN_x2plus.pth"} <= names


def test_upscale_model_loader_in_model_loaders():
    from app.comfy.client import _MODEL_LOADERS

    assert ("UpscaleModelLoader", "model_name") in _MODEL_LOADERS
