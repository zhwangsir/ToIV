"""ComfyUIClient —— 封装单个 ComfyUI 后端的 REST / WebSocket 访问。

每个实例对应一个 ComfyUI 进程（P0 单进程；P2 起每张 GPU 一个进程）。
所有网络错误统一抛 ComfyUIError，携带用户可读信息，绝不静默吞掉。
"""
from __future__ import annotations

import time
from urllib.parse import urlencode, urlsplit

import httpx


class ComfyUIError(RuntimeError):
    """与 ComfyUI 交互失败时抛出。

    Attributes:
        status_code: 上游 HTTP 状态码(4xx/5xx);网络错误等无响应时为 None。
        detail: 上游返回的原始 body 或结构化错误(node_errors/error 等)。
    """

    def __init__(
        self,
        message: str,
        status_code: int | None = None,
        detail: object = None,
    ):
        super().__init__(message)
        self.status_code = status_code
        self.detail = detail


# 各类模型加载器的 (节点, 字段),用于汇总该 worker 实际拥有的模型文件名
_MODEL_LOADERS = [
    ("CheckpointLoaderSimple", "ckpt_name"),
    ("UNETLoader", "unet_name"),
    ("VAELoader", "vae_name"),
    ("CLIPLoader", "clip_name"),
    ("LoraLoaderModelOnly", "lora_name"),
    ("ControlNetLoader", "control_net_name"),
    # HunyuanVideo Wrapper 自定义节点（hyvideo 模型不走红亮标准 loader）
    ("HyVideoModelLoader", "model"),
    ("HyVideoVAELoader", "model_name"),
    ("HyVideoLoraSelect", "lora"),
    # RIFE 帧插值模型(worker 节点为 FrameInterpolationModelLoader,读 frame_interpolation 目录)
    ("FrameInterpolationModelLoader", "model_name"),
    # LTXVideo 自定义节点(gemma 文本编码器从 text_encoders 目录加载,
    # 不在标准 CLIPLoader 范围内,否则 LTX 链路会被误判为缺模型 → /generate-video 503)
    ("LTXVGemmaCLIPModelLoader", "gemma_path"),
    # LTX-2.3 LipDub:AV 文本编码器(text_encoders 目录)+ latent 上采样模型(two_stage)
    ("LTXAVTextEncoderLoader", "text_encoder"),
    ("LatentUpscaleModelLoader", "model_name"),
    # 高清修复放大模型(LTX use_upscale=True 时 required_models 含 upscale_model,
    # 缺此项会误判 worker 缺模型 → /generate-video 503)
    ("UpscaleModelLoader", "model_name"),
]
_MODELS_TTL = 120.0

# 模块级 httpx.AsyncClient 连接池缓存:(base_url, timeout) → AsyncClient。
# AsyncClient 本身是连接池且线程安全,复用可避免每次调用新建 TCP 连接
# (此前 tracker 每 2-8s 轮询 /history 都现开现关)。在 main.py lifespan
# 关闭阶段经 close_clients() 统一 aclose。
_http_clients: dict[tuple[str, float], httpx.AsyncClient] = {}


def _pooled_client(base_url: str, timeout: float) -> httpx.AsyncClient:
    key = (base_url, timeout)
    client = _http_clients.get(key)
    if client is None or client.is_closed:
        client = httpx.AsyncClient(timeout=timeout, trust_env=False)
        _http_clients[key] = client
    return client


async def close_clients() -> None:
    """关闭并清空全部缓存的 AsyncClient(供 lifespan 关闭阶段调用)。"""
    clients = list(_http_clients.values())
    _http_clients.clear()
    for client in clients:
        await client.aclose()


class ComfyUIClient:
    def __init__(self, base_url: str, timeout: float = 30.0):
        self.base_url = base_url.rstrip("/")
        self._timeout = timeout
        self._models_cache: set[str] | None = None
        self._models_ts = 0.0
        self._nodes_cache: set[str] | None = None
        self._nodes_ts = 0.0

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
            client = _pooled_client(self.base_url, self._timeout)
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
            client = _pooled_client(self.base_url, self._timeout)
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

    async def get_queue(self) -> set[str]:
        """返回 queue_running + queue_pending 中的 prompt_id 集合(tracker 孤儿作业检测用)。

        ComfyUI 队列条目结构: [number, prompt_id, prompt, extra_data, outputs_to_execute]。
        短超时:死 worker 快速判不可达(调用方据此区分「网络抖动」与「作业丢失」)。
        """
        data = await self._get_json("/queue", timeout=4.0)
        ids: set[str] = set()
        for section in ("queue_running", "queue_pending"):
            for entry in data.get(section, []):
                if isinstance(entry, (list, tuple)) and len(entry) > 1:
                    ids.add(str(entry[1]))
        return ids

    async def get_system_stats(self) -> dict:
        """实例系统信息(含 devices[].vram_free/vram_total,字节)。用于显存预检。"""
        return await self._get_json("/system_stats")

    async def free_memory(self) -> None:
        """驱逐实例缓存的模型并释放显存(POST /free)。

        仅在实例队列空闲时调用 —— 正在执行的作业被驱逐会直接失败,
        调用方须先确认 queue_len() == 0(见 services/h3.ensure_h3_vram)。
        ComfyUI /free 返回 200 空响应体,不能走 _post_json 解析。
        """
        await self._post("/free", {"unload_models": True, "free_memory": True})

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
                    # 旧版格式: [[opt1, opt2, ...]]
                    names.update(opts[0])
                elif (len(opts) > 1 and isinstance(opts[0], str)
                      and isinstance(opts[1], dict)
                      and isinstance(opts[1].get("options"), list)):
                    # 新版 COMBO widget 格式: ["COMBO", {"options": [...]}]
                    names.update(opts[1]["options"])
            except ComfyUIError:
                pass
        self._models_cache = names
        self._models_ts = now
        return names

    async def node_names(self) -> set[str]:
        """该 worker 已安装的所有节点 class_type(缓存 120s)。用于按"必需节点"路由:
        某 worker 有模型但缺自定义节点(如 PC01 缺 VHS_VideoCombine)→ 视频图会 400,
        据此把视频只路由到装了对应节点的 worker。"""
        now = time.monotonic()
        if self._nodes_cache is not None and now - self._nodes_ts < _MODELS_TTL:
            return self._nodes_cache
        info = await self._get_json("/object_info")
        names = set(info.keys()) if isinstance(info, dict) else set()
        self._nodes_cache = names
        self._nodes_ts = now
        return names

    def ws_url(self, client_id: str) -> str:
        parts = urlsplit(self.base_url)
        scheme = "wss" if parts.scheme == "https" else "ws"
        return f"{scheme}://{parts.netloc}/ws?clientId={client_id}"

    # ---------- 内部 ----------
    async def _post(self, path: str, payload: dict) -> None:
        """POST 但不解析响应体(如 /free 返回 200 空 body)。"""
        try:
            client = _pooled_client(self.base_url, self._timeout)
            resp = await client.post(f"{self.base_url}{path}", json=payload)
            resp.raise_for_status()
        except httpx.HTTPStatusError as e:
            detail = None
            try:
                detail = e.response.json()
            except Exception:
                detail = e.response.text
            raise ComfyUIError(
                f"请求 {path} 失败 ({e.response.status_code}): {detail or e}",
                status_code=e.response.status_code,
                detail=detail,
            ) from e
        except httpx.HTTPError as e:
            raise ComfyUIError(f"请求 {path} 失败: {e}") from e

    async def _post_json(self, path: str, payload: dict) -> dict:
        try:
            client = _pooled_client(self.base_url, self._timeout)
            resp = await client.post(f"{self.base_url}{path}", json=payload)
            resp.raise_for_status()
            return resp.json()
        except httpx.HTTPStatusError as e:
            detail = None
            try:
                detail = e.response.json()
            except Exception:
                detail = e.response.text
            raise ComfyUIError(
                f"请求 {path} 失败 ({e.response.status_code}): {detail or e}",
                status_code=e.response.status_code,
                detail=detail,
            ) from e
        except httpx.HTTPError as e:
            raise ComfyUIError(f"请求 {path} 失败: {e}") from e

    async def _get_json(self, path: str, timeout: float | None = None) -> dict:
        try:
            client = _pooled_client(self.base_url, self._timeout)
            # 短超时(如 queue_len 的 4s)按请求覆盖,不另建缓存 client
            resp = await client.get(f"{self.base_url}{path}", timeout=timeout or self._timeout)
            resp.raise_for_status()
            return resp.json()
        except httpx.HTTPStatusError as e:
            detail = None
            try:
                detail = e.response.json()
            except Exception:
                detail = e.response.text
            raise ComfyUIError(
                f"请求 {path} 失败 ({e.response.status_code}): {detail or e}",
                status_code=e.response.status_code,
                detail=detail,
            ) from e
        except httpx.HTTPError as e:
            raise ComfyUIError(f"请求 {path} 失败: {e}") from e
