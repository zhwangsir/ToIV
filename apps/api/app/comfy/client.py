"""ComfyUIClient —— 封装单个 ComfyUI 后端的 REST / WebSocket 访问。

每个实例对应一个 ComfyUI 进程（P0 单进程；P2 起每张 GPU 一个进程）。
所有网络错误统一抛 ComfyUIError，携带用户可读信息，绝不静默吞掉。
"""
from __future__ import annotations

import time
from urllib.parse import urlencode, urlsplit

import httpx


class ComfyUIError(RuntimeError):
    """与 ComfyUI 交互失败时抛出。"""


# 各类模型加载器的 (节点, 字段),用于汇总该 worker 实际拥有的模型文件名
_MODEL_LOADERS = [
    ("CheckpointLoaderSimple", "ckpt_name"),
    ("UNETLoader", "unet_name"),
    ("VAELoader", "vae_name"),
    ("CLIPLoader", "clip_name"),
    ("LoraLoaderModelOnly", "lora_name"),
    ("ControlNetLoader", "control_net_name"),
]
_MODELS_TTL = 120.0


class ComfyUIClient:
    def __init__(self, base_url: str, timeout: float = 30.0):
        self.base_url = base_url.rstrip("/")
        self._timeout = timeout
        self._models_cache: set[str] | None = None
        self._models_ts = 0.0

    # ---------- 工作流提交与结果 ----------
    async def queue_prompt(self, graph: dict, client_id: str) -> str:
        data = await self._post_json("/prompt", {"prompt": graph, "client_id": client_id})
        prompt_id = data.get("prompt_id")
        if not prompt_id:
            detail = data.get("node_errors") or data.get("error") or data
            raise ComfyUIError(f"ComfyUI 拒绝了工作流: {detail}")
        return prompt_id

    async def get_history(self, prompt_id: str) -> dict:
        return await self._get_json(f"/history/{prompt_id}")

    async def get_images(self, prompt_id: str) -> list[dict]:
        """从 history 提取图片引用 [{filename, subfolder, type}]。未完成则返回空列表。"""
        history = await self.get_history(prompt_id)
        entry = history.get(prompt_id)
        if not entry:
            return []
        images: list[dict] = []
        for node_out in entry.get("outputs", {}).values():
            for img in node_out.get("images", []):
                images.append(
                    {
                        "filename": img["filename"],
                        "subfolder": img.get("subfolder", ""),
                        "type": img.get("type", "output"),
                    }
                )
        return images

    async def upload_image(self, content: bytes, filename: str) -> str:
        """上传图片到 ComfyUI input 目录，返回其文件名(供 LoadImage 使用)。"""
        files = {"image": (filename, content, "application/octet-stream")}
        try:
            async with httpx.AsyncClient(timeout=self._timeout) as client:
                resp = await client.post(
                    f"{self.base_url}/upload/image", files=files, data={"overwrite": "false"}
                )
                resp.raise_for_status()
                return resp.json()["name"]
        except (httpx.HTTPError, KeyError) as e:
            raise ComfyUIError(f"上传图片失败: {e}") from e

    async def get_result_files(self, prompt_id: str) -> list[dict]:
        """提取 history 中所有产物文件(图片/动图/3D glb/音频…),扫描全部输出键。"""
        history = await self.get_history(prompt_id)
        entry = history.get(prompt_id)
        if not entry:
            return []
        files: list[dict] = []
        for node_out in entry.get("outputs", {}).values():
            for value in node_out.values():
                if not isinstance(value, list):
                    continue
                for item in value:
                    if isinstance(item, dict) and "filename" in item:
                        files.append(
                            {
                                "filename": item["filename"],
                                "subfolder": item.get("subfolder", ""),
                                "type": item.get("type", "output"),
                            }
                        )
        return files

    async def get_image_bytes(self, filename: str, subfolder: str, type_: str) -> tuple[bytes, str]:
        qs = urlencode({"filename": filename, "subfolder": subfolder, "type": type_})
        try:
            async with httpx.AsyncClient(timeout=self._timeout) as client:
                resp = await client.get(f"{self.base_url}/view?{qs}")
                resp.raise_for_status()
                return resp.content, resp.headers.get("content-type", "image/png")
        except httpx.HTTPError as e:
            raise ComfyUIError(f"读取图片失败: {e}") from e

    # ---------- 调度与元信息 ----------
    async def queue_len(self) -> int:
        # 短超时:死/挂起的 worker 快速降级,避免拖慢 pick 调度
        data = await self._get_json("/queue", timeout=4.0)
        return len(data.get("queue_running", [])) + len(data.get("queue_pending", []))

    async def object_info(self, node: str) -> dict:
        return await self._get_json(f"/object_info/{node}")

    async def model_names(self) -> set[str]:
        """该 worker 实际拥有的所有模型文件名(跨类型汇总,缓存 120s)。"""
        now = time.monotonic()
        if self._models_cache is not None and now - self._models_ts < _MODELS_TTL:
            return self._models_cache
        names: set[str] = set()
        for node, field in _MODEL_LOADERS:
            try:
                info = await self.object_info(node)
                opts = info.get(node, {}).get("input", {}).get("required", {}).get(field, [[]])
                if opts and isinstance(opts[0], list):
                    names.update(opts[0])
            except ComfyUIError:
                pass
        self._models_cache = names
        self._models_ts = now
        return names

    def ws_url(self, client_id: str) -> str:
        parts = urlsplit(self.base_url)
        scheme = "wss" if parts.scheme == "https" else "ws"
        return f"{scheme}://{parts.netloc}/ws?clientId={client_id}"

    # ---------- 内部 ----------
    async def _post_json(self, path: str, payload: dict) -> dict:
        try:
            async with httpx.AsyncClient(timeout=self._timeout) as client:
                resp = await client.post(f"{self.base_url}{path}", json=payload)
                resp.raise_for_status()
                return resp.json()
        except httpx.HTTPError as e:
            raise ComfyUIError(f"请求 {path} 失败: {e}") from e

    async def _get_json(self, path: str, timeout: float | None = None) -> dict:
        try:
            async with httpx.AsyncClient(timeout=timeout or self._timeout) as client:
                resp = await client.get(f"{self.base_url}{path}")
                resp.raise_for_status()
                return resp.json()
        except httpx.HTTPError as e:
            raise ComfyUIError(f"请求 {path} 失败: {e}") from e
