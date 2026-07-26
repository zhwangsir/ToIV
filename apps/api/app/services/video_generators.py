"""视频生成模型聚合层 —— 抽象 VideoGenerator 接口,支持多模型可选。

对标 liblib.tv 的多模型聚合(Seedance/Kling)。当前只有 LTX 实际可用实现,
Seedance/Kling 为 stub(返回占位错误响应),预留接口供后续接入。

设计要点:
  · VideoGenerator 抽象基类统一 generate() 签名,各实现按需翻译参数
  · LtxVideoGenerator 封装 build_ltx_t2v_graph + pool.pick + queue_prompt + spawn_tracker
  · 实际等待(wait_for_jobs)由调用方决定,生成器只负责提交 + 返回 job_id
  · list_generators() / get_generator() 工厂供路由层与前端选择器使用
"""
from __future__ import annotations

import uuid
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any

from app.comfy.client import ComfyUIError
from app.comfy.pool import WorkerPool
from app.comfy.tracker import spawn as spawn_tracker
from app.config import get_settings
from app.workflows.ltx_video import LtxT2VParams, build_ltx_t2v_graph


@dataclass
class VideoGenResult:
    """视频生成统一结果。"""

    success: bool
    video_url: str = ""
    job_id: str = ""
    model: str = ""
    error: str = ""
    raw: dict | None = None


class VideoGenerator(ABC):
    """视频生成器抽象接口。"""

    name: str = "base"
    display_name: str = "基础"
    supports_image2video: bool = False
    supports_text2video: bool = True

    @abstractmethod
    async def generate(
        self,
        prompt: str,
        *,
        negative: str = "",
        width: int = 768,
        height: int = 384,
        duration_sec: int = 6,
        fps: int = 16,
        seed: int | None = None,
        image_url: str = "",
        worker: str | None = None,
        **kwargs: Any,
    ) -> VideoGenResult:
        """提交一次视频生成作业,返回结果(stub 实现直接返回失败)。"""
        ...


class LtxVideoGenerator(VideoGenerator):
    """LTX 2.3 视频生成器(当前唯一实际可用实现)。

    复用 drama_studio.generate_shot_video 的核心链路:
      LtxT2VParams → build_ltx_t2v_graph → pool.pick → queue_prompt → spawn_tracker
    只提交不等待,调用方拿 job_id 自行决定是否同步 wait_for_jobs。
    """

    name = "ltx"
    display_name = "LTX 2.3"
    supports_image2video = True
    supports_text2video = True

    def __init__(self, pool: WorkerPool | None = None, tracker=spawn_tracker) -> None:
        self._pool = pool
        self._tracker = tracker  # 测试时可注入 mock

    async def generate(
        self,
        prompt: str,
        *,
        negative: str = "",
        width: int = 768,
        height: int = 384,
        duration_sec: int = 6,
        fps: int = 16,
        seed: int | None = None,
        image_url: str = "",
        worker: str | None = None,
        **kwargs: Any,
    ) -> VideoGenResult:
        if not prompt.strip():
            return VideoGenResult(success=False, model=self.name, error="提示词为空")
        if self._pool is None:
            return VideoGenResult(success=False, model=self.name, error="未注入 WorkerPool")

        # 选 worker:优先走指定 worker,否则 pool.pick 路由 ltx_t2v 所需模型/节点
        from app.capabilities import required_models, required_nodes
        from app.deps import resolve_worker

        if worker:
            try:
                client = resolve_worker(worker)
            except Exception as e:  # resolve_worker 抛 HTTPException(未知 worker 等)
                return VideoGenResult(success=False, model=self.name, error=str(e))
        else:
            try:
                client = await self._pool.pick(
                    required=required_models("ltx_t2v"),
                    required_nodes=required_nodes("ltx_t2v"),
                )
            except ComfyUIError as e:
                return VideoGenResult(success=False, model=self.name, error=str(e))

        settings = get_settings()
        seed_used = seed if seed is not None else LtxT2VParams(positive="").seed
        params = LtxT2VParams(
            positive=prompt,
            negative=negative,
            unet_name=settings.nsfw_default_video_ckpt,
            gemma_name=settings.nsfw_default_gemma,
            vae_name=settings.nsfw_default_vae,
            width=width,
            height=height,
            length=max(9, int(fps * duration_sec)),
            fps=fps,
            steps=kwargs.get("steps", 20),
            cfg=kwargs.get("cfg", 1.0),
            seed=seed_used,
            use_upscale=kwargs.get("use_upscale", False),
            use_rife=kwargs.get("use_rife", False),
            filename_prefix=kwargs.get("filename_prefix", "ToIV_drama_video"),
        )
        graph = build_ltx_t2v_graph(params)
        client_id = uuid.uuid4().hex
        try:
            prompt_id = await client.queue_prompt(graph, client_id)
        except ComfyUIError as e:
            return VideoGenResult(success=False, model=self.name, error=str(e))

        # 后台追踪结果(独立于客户端 SSE)
        self._tracker(client, prompt_id)

        return VideoGenResult(
            success=True,
            job_id=prompt_id,
            model=self.name,
            raw={
                "prompt_id": prompt_id,
                "client_id": client_id,
                "worker": client.base_url,
                "seed": seed_used,
            },
        )


class SeedanceVideoGenerator(VideoGenerator):
    """Seedance 视频生成器(stub,接口预留,未接入)。"""

    name = "seedance"
    display_name = "Seedance"
    supports_image2video = True
    supports_text2video = True

    async def generate(self, *args: Any, **kwargs: Any) -> VideoGenResult:
        return VideoGenResult(
            success=False,
            model=self.name,
            error="Seedance 生成器尚未接入,当前为 stub",
        )


class KlingVideoGenerator(VideoGenerator):
    """Kling 视频生成器(stub,接口预留,未接入)。"""

    name = "kling"
    display_name = "Kling"
    supports_image2video = True
    supports_text2video = True

    async def generate(self, *args: Any, **kwargs: Any) -> VideoGenResult:
        return VideoGenResult(
            success=False,
            model=self.name,
            error="Kling 生成器尚未接入,当前为 stub",
        )


# 工厂注册表
_REGISTRY: dict[str, type[VideoGenerator]] = {
    "ltx": LtxVideoGenerator,
    "seedance": SeedanceVideoGenerator,
    "kling": KlingVideoGenerator,
}


def list_generators() -> list[dict]:
    """返回所有已注册生成器的元信息(供前端渲染选择器)。"""
    return [
        {
            "name": cls.name,
            "display_name": cls.display_name,
            "supports_image2video": cls.supports_image2video,
            "supports_text2video": cls.supports_text2video,
        }
        for cls in _REGISTRY.values()
    ]


def get_generator(name: str, pool: WorkerPool | None = None, tracker=spawn_tracker) -> VideoGenerator:
    """按名称获取生成器实例。未知名称抛 ValueError。"""
    cls = _REGISTRY.get(name)
    if cls is None:
        raise ValueError(f"未知视频生成器: {name},可选: {list(_REGISTRY.keys())}")
    if name == "ltx":
        return cls(pool, tracker)
    return cls()
