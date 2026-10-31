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


# --------------------------------------------------------------------------- #
# free_memory:ComfyUI /free 返回 200 空响应体,不得按 JSON 解析
# (回归:2026-08-04 h3_i2v 驱逐同卡缓存时 resp.json() 炸 JSONDecodeError → 500)
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_free_memory_tolerates_empty_200(monkeypatch: pytest.MonkeyPatch):
    import httpx

    import app.comfy.client as client_mod

    c = ComfyUIClient("http://x")
    posted: list[tuple[str, dict]] = []

    class _FakeResp:
        status_code = 200
        content = b""

        def raise_for_status(self) -> None:
            return None

        def json(self):  # 若被调用即失败:空 body 不可解析
            raise ValueError("empty body is not JSON")

    class _FakeHttp:
        is_closed = False

        async def post(self, url: str, json: dict) -> _FakeResp:
            posted.append((url, json))
            return _FakeResp()

    monkeypatch.setattr(client_mod, "_pooled_client", lambda base, timeout: _FakeHttp())
    await c.free_memory()  # 不抛异常即通过
    assert posted == [("http://x/free", {"unload_models": True, "free_memory": True})]


@pytest.mark.asyncio
async def test_free_memory_http_error_raises_comfy_error(monkeypatch: pytest.MonkeyPatch):
    import httpx

    import app.comfy.client as client_mod
    from app.comfy.client import ComfyUIError

    c = ComfyUIClient("http://x")

    class _FakeResp:
        status_code = 500
        text = "boom"

        def raise_for_status(self) -> None:
            raise httpx.HTTPStatusError("500", request=None, response=self)  # type: ignore[arg-type]

        def json(self):
            return {"error": "boom"}

    class _FakeHttp:
        is_closed = False

        async def post(self, url: str, json: dict) -> _FakeResp:
            return _FakeResp()

    monkeypatch.setattr(client_mod, "_pooled_client", lambda base, timeout: _FakeHttp())
    with pytest.raises(ComfyUIError):
        await c.free_memory()

def test_melband_model_loader_in_model_loaders():
    """RH LTX 对口型图硬编码 MelBandRoFormer_comfy/...;loader 必须进汇总。"""
    assert ("MelBandRoFormerModelLoader", "model_name") in _MODEL_LOADERS


def test_wan_video_vae_loader_in_model_loaders():
    """WanVideoVAELoader.model_name(Wan2.1_VAE.pth)需进 model_names,否则 VACE 图 503。"""
    assert ("WanVideoVAELoader", "model_name") in _MODEL_LOADERS


def test_model_folders_include_melband_paths():
    from app.comfy.client import _MODEL_FOLDERS

    assert "MelBandRoFormer" in _MODEL_FOLDERS
    assert "vocal_separator" in _MODEL_FOLDERS


@pytest.mark.asyncio
async def test_model_names_merges_model_folder_scan(monkeypatch: pytest.MonkeyPatch):
    """object_info 仅注册表显示名时,/models/MelBandRoFormer 扫描仍应带上 FS 相对路径。"""
    c = ComfyUIClient("http://x")

    async def fake_oi(node: str) -> dict:
        if node == "MelBandRoFormerModelLoader":
            return _legacy_info(
                node, "model_name", ["Vocals · Kim fp16 ⭐ [Kijai]"]
            )
        # 其他 loader 空列表,避免干扰
        field = _FIELD_BY_NODE.get(node, "model_name")
        return _legacy_info(node, field, [])

    async def fake_get(path: str):
        if path == "/models/MelBandRoFormer":
            return [
                "MelBandRoFormer_comfy/MelBandRoformer_fp16.safetensors",
                "MelBandRoformer_fp16.safetensors",
            ]
        if path == "/models/vocal_separator":
            return ["Kim_Vocal_2.onnx"]
        if path == "/models/LLM":
            return []
        raise AssertionError(f"unexpected path {path}")

    monkeypatch.setattr(c, "object_info", fake_oi)
    monkeypatch.setattr(c, "_get_json", fake_get)
    names = await c.model_names()
    assert "MelBandRoFormer_comfy/MelBandRoformer_fp16.safetensors" in names
    assert "MelBandRoformer_fp16.safetensors" in names
    assert "Kim_Vocal_2.onnx" in names
    assert "Vocals · Kim fp16 ⭐ [Kijai]" in names


def test_florence2_model_loader_in_model_loaders():
    """Florence2/Qwen3-VL 目录名经 Florence2ModelLoader.model 进入 model_names。"""
    assert ("Florence2ModelLoader", "model") in _MODEL_LOADERS


def test_model_folders_include_llm():
    from app.comfy.client import _MODEL_FOLDERS

    assert "LLM" in _MODEL_FOLDERS


@pytest.mark.asyncio
async def test_model_names_registers_llm_dir_basename(monkeypatch: pytest.MonkeyPatch):
    """RH LTX 图要求 Qwen3-VL-4B-Instruct 目录名;/models/LLM 列出 dir/file 分片。"""
    c = ComfyUIClient("http://x")

    async def fake_oi(node: str) -> dict:
        if node == "Florence2ModelLoader":
            return _legacy_info(node, "model", ["Qwen3-VL-4B-Instruct", "Florence-2-base"])
        field = _FIELD_BY_NODE.get(node, "model_name")
        return _legacy_info(node, field, [])

    async def fake_get(path: str):
        if path == "/models/LLM":
            return [
                "Qwen3-VL-4B-Instruct/model-00001-of-00002.safetensors",
                "Qwen3-VL-4B-Instruct\\model-00002-of-00002.safetensors",
            ]
        if path in ("/models/MelBandRoFormer", "/models/vocal_separator"):
            return []
        raise AssertionError(f"unexpected path {path}")

    monkeypatch.setattr(c, "object_info", fake_oi)
    monkeypatch.setattr(c, "_get_json", fake_get)
    names = await c.model_names()
    assert "Qwen3-VL-4B-Instruct" in names
    assert "Qwen3-VL-4B-Instruct/model-00001-of-00002.safetensors" in names
    assert "Florence-2-base" in names
