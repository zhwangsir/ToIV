"""ForgeClient —— 封装 Stable Diffusion WebUI reForge 的 /sdapi/v1 访问。

与 ComfyUI 的本质区别:Forge 的 `/sdapi/v1/txt2img` 是**同步阻塞**——POST 后
一直等到出图完成才返回(响应体含 base64 图),没有 ComfyUI 的 prompt_id / 队列 /
WebSocket 概念。进度需另起 `/sdapi/v1/progress` 轮询(全局当前任务)。

故 ToIV 侧需要一个「引擎适配层」(见 app/forge/engine.py)把这套同步 API 包装成
ToIV 统一的异步 Job:后台 task 调 txt2img(阻塞)→ 存图 → 落库;另把 /progress
轮询桥接到既有的 SSE 进度通道。本文件只负责「裸 HTTP 客户端」,不掺业务。

所有网络错误统一抛 ForgeError(携带用户可读信息),绝不静默吞掉 —— 与 ComfyUIClient 同风格。
"""
from __future__ import annotations

import httpx


class ForgeError(RuntimeError):
    """与 Forge(reForge)交互失败时抛出。"""


# txt2img 阻塞出图可能几十秒(高分辨率 / 多步),给足超时;progress/models 用短超时。
_GEN_TIMEOUT = 600.0
_META_TIMEOUT = 15.0


class ForgeClient:
    def __init__(self, base_url: str, timeout: float = _GEN_TIMEOUT):
        self.base_url = base_url.rstrip("/")
        self._timeout = timeout

    # ---------- 出图(同步阻塞)----------
    async def txt2img(self, payload: dict) -> dict:
        """POST /sdapi/v1/txt2img —— 阻塞到出图完成,返回 {images:[b64...], info, parameters}。"""
        return await self._post_json("/sdapi/v1/txt2img", payload, timeout=self._timeout)

    async def img2img(self, payload: dict) -> dict:
        """POST /sdapi/v1/img2img —— payload 需含 init_images:[b64];阻塞返回同 txt2img。"""
        return await self._post_json("/sdapi/v1/img2img", payload, timeout=self._timeout)

    # ---------- 进度(全局当前任务)----------
    async def progress(self, skip_current_image: bool = True) -> dict:
        """GET /sdapi/v1/progress —— 当前任务进度。

        返回 {progress: 0..1, eta_relative, state:{sampling_step, sampling_steps,
        job_count, job_no, ...}, textinfo}。Forge 无 per-job 进度,这是全局当前任务,
        ToIV 单实例串行出图时可直接当本 job 的进度。
        """
        q = "?skip_current_image=true" if skip_current_image else ""
        return await self._get_json(f"/sdapi/v1/progress{q}", timeout=_META_TIMEOUT)

    async def interrupt(self) -> None:
        """POST /sdapi/v1/interrupt —— 中断当前出图。"""
        await self._post_json("/sdapi/v1/interrupt", {}, timeout=_META_TIMEOUT)

    # ---------- 元信息 / 模型 ----------
    async def sd_models(self) -> list[dict]:
        """GET /sdapi/v1/sd-models —— [{title, model_name, hash, filename, ...}]。"""
        data = await self._get_json("/sdapi/v1/sd-models", timeout=_META_TIMEOUT)
        return data if isinstance(data, list) else []

    async def samplers(self) -> list[dict]:
        data = await self._get_json("/sdapi/v1/samplers", timeout=_META_TIMEOUT)
        return data if isinstance(data, list) else []

    async def get_options(self) -> dict:
        return await self._get_json("/sdapi/v1/options", timeout=_META_TIMEOUT)

    async def set_options(self, opts: dict) -> None:
        """POST /sdapi/v1/options —— 设全局项(如切换 sd_model_checkpoint)。"""
        await self._post_json("/sdapi/v1/options", opts, timeout=_META_TIMEOUT)

    async def model_titles(self) -> set[str]:
        """该实例可用底模标题集合(供 pool 路由 / 前端列表)。失败返回空集。"""
        try:
            return {m.get("title", "") for m in await self.sd_models() if m.get("title")}
        except ForgeError:
            return set()

    async def ping(self) -> bool:
        """探活:能取到 progress 即视为在线(也顺带反映是否在忙)。"""
        try:
            await self.progress()
            return True
        except ForgeError:
            return False

    # ---------- 内部 ----------
    async def _post_json(self, path: str, payload: dict, timeout: float) -> dict:
        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                resp = await client.post(f"{self.base_url}{path}", json=payload)
                resp.raise_for_status()
                return resp.json()
        except httpx.HTTPStatusError as e:
            detail = ""
            try:
                detail = e.response.json().get("detail") or e.response.text[:300]
            except Exception:  # noqa: BLE001
                detail = e.response.text[:300]
            raise ForgeError(f"Forge {path} 返回 {e.response.status_code}: {detail}") from e
        except httpx.HTTPError as e:
            raise ForgeError(f"请求 Forge {path} 失败: {e}") from e

    async def _get_json(self, path: str, timeout: float):
        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                resp = await client.get(f"{self.base_url}{path}")
                resp.raise_for_status()
                return resp.json()
        except httpx.HTTPError as e:
            raise ForgeError(f"请求 Forge {path} 失败: {e}") from e
