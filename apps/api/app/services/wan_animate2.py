"""Wan-Animate-2 引擎服务 —— 专用 ComfyUI 实例(workstation GPU3 :8199,原生节点)。

与 v1(services/wan_video.py,kijai wrapper 路线 :8197)完全独立:v2 走 ComfyUI
master 原生 WanAnimate2ToVideo 节点,实例/权重/链路全部分开,不动 v1。

模式与 services/longcat.py 一致:
  · get_animate2_client:实例客户端(TOIV_WAN_ANIMATE2_BASE_URL,默认 :8199)
  · ensure_animate2_ready:提交前就绪检查(在线 + 装有 WanAnimate2ToVideo 节点)
  · ensure_animate2_vram:GPU3 显存互斥预检(与 FlashTalk 共卡;空闲不足先驱逐
    :8199 自身模型缓存,仍不足 → 503;绝不驱逐 FlashTalk)+ 宿主机 RAM 预检
  · caption_reference_appearance:官方要求的「只描述外观+背景」caption 自动反推
    (positive 留空时路由层调用;走 SFW 图像反推同一条 VLM 链路)
  · submit_animate2_job:queue_prompt → 落 Job → spawn_tracker 后台轮询落库;
    产物经 /api/images 代理进作品库,与 h3/longcat/wan 完全同一条路

显存账(GPU3 与 FlashTalk 共卡,驱逐自身缓存后实测空闲 ~33.7G):默认 int8_convrot
蒸馏 DiT ~16.6G(动态加载 staged ~15.9G)+ umt5 fp8 ~6.7G + CLIP-ViT-H 1.2G +
VAE 0.25G,ComfyUI 原生动态加载兜底;蒸馏版 10 步。bf16 蒸馏(32.8G)备选。
"""
from __future__ import annotations

import logging
import uuid

from fastapi import HTTPException
from pydantic import BaseModel
from sqlmodel import Session

from app.comfy.client import ComfyUIClient, ComfyUIError
from app.comfy.tracker import spawn as spawn_tracker
from app.config import get_settings
from app.models import Job, User
from app.routes.video import _raise_from_comfy_error
from app.services import hold_queue
from app.services.h3 import _cuda_free_gib
from app.services.resource_budget import ensure_host_ram
from app.versioning import params_snapshot
from app.workflows.wan_animate2 import APPEARANCE_CAPTION_INSTRUCTION

logger = logging.getLogger(__name__)

# Animate-2 管线核心节点(ComfyUI master 原生);缺此节点 = 实例 ComfyUI 版本过旧
WAN_ANIMATE2_NODE = "WanAnimate2ToVideo"


def get_animate2_client() -> ComfyUIClient:
    settings = get_settings()
    return ComfyUIClient(settings.wan_animate2_base, timeout=settings.request_timeout)


def ensure_animate2_enabled() -> None:
    """若引擎被配置关闭,统一 503 并给出原因(前端引擎注册表同步标不可用)。"""
    if not get_settings().wan_animate2_enabled:
        raise HTTPException(
            status_code=503,
            detail="Wan-Animate-2 引擎已禁用(TOIV_WAN_ANIMATE2_ENABLED=false)",
        )


async def ensure_animate2_ready(client: ComfyUIClient) -> None:
    """确认实例在线且装有 WanAnimate2ToVideo 节点;不可达/缺节点一律 503 + 清晰原因。"""
    try:
        await client.object_info(WAN_ANIMATE2_NODE)
    except ComfyUIError as e:
        if e.status_code is not None:  # 实例在线但无该节点
            raise HTTPException(
                status_code=503,
                detail=f"Wan-Animate-2 实例 {client.base_url} 缺少 {WAN_ANIMATE2_NODE} 节点(需 ComfyUI master 原生支持)",
            ) from e
        raise HTTPException(
            status_code=503, detail=f"Wan-Animate-2 实例不可达({client.base_url}): {e}"
        ) from e


async def ensure_animate2_vram(client: ComfyUIClient) -> None:
    """提交前 GPU3 显存互斥预检(与 FlashTalk 共卡,语义同 wan_video.ensure_wan_vram):

    1. 实例卡(GPU3)空闲 ≥ 阈值(TOIV_WAN_ANIMATE2_MIN_FREE_VRAM_GB,默认 34GiB)直接放行;
    2. 不足且 :8199 队列空闲 → 驱逐自身模型缓存后复查;
    3. 仍不足 → 503 错峰提示(绝不驱逐 FlashTalk);
    4. 显存通过后追加宿主机 RAM 预检(2026-08-21 OOM 防线)。

    /system_stats 读取失败时放行(降级为不预检,由 ComfyUI 自身错误兜底)。
    阈值设为 0 = 显式关闭预检。
    """
    settings = get_settings()
    threshold = settings.wan_animate2_min_free_vram_gb
    if threshold <= 0:
        return
    try:
        free = _cuda_free_gib(await client.get_system_stats())
    except ComfyUIError as e:
        logger.warning("Wan-Animate-2 显存预检读取失败,跳过预检: %s", e)
        return
    if free is None or free >= threshold:
        await ensure_host_ram(client, settings.wan_animate2_min_free_ram_gb, "Wan-Animate-2")
        return

    logger.warning("Wan-Animate-2 显存不足(空闲 %.1fG < 阈值 %.1fG),尝试驱逐实例自身缓存", free, threshold)
    try:
        if await client.queue_len() == 0:
            await client.free_memory()
            logger.info("已驱逐 :8199 实例模型缓存")
            free = _cuda_free_gib(await client.get_system_stats())
        else:
            logger.info(":8199 队列非空闲,不驱逐自身缓存")
    except ComfyUIError as e:
        logger.warning("驱逐 :8199 实例缓存失败(忽略,继续复查): %s", e)
        return
    if free is not None and free < threshold:
        raise HTTPException(
            status_code=503,
            detail=(
                f"GPU3 空闲显存不足:当前 {free:.1f}GiB,需要 ≥{threshold:.0f}GiB"
                "(FlashTalk/其他作业在跑,请错峰重试)"
            ),
        )
    await ensure_host_ram(client, settings.wan_animate2_min_free_ram_gb, "Wan-Animate-2")


async def caption_reference_appearance(content: bytes, content_type: str) -> str:
    """参考图 → 官方要求的「只描述外观+背景,不描述动作」caption(positive 留空时调用)。

    走 SFW 图像反推同一条 VLM 链路(reverse_vlm_base_url),系统提示用官方
    Wan-Animate-2 README 的反推指令;失败原码上抛(502),不静默降级出烂提示词。
    """
    from app.routes.reverse import _chat_completion, _data_url  # 惰性 import 防环

    base_url = get_settings().reverse_vlm_base_url.strip()
    if not base_url:
        raise HTTPException(status_code=503, detail="VLM 反推服务未配置,无法自动生成外观描述")
    part = {"type": "image_url", "image_url": {"url": _data_url(content, "image", content_type)}}
    return await _chat_completion(APPEARANCE_CAPTION_INSTRUCTION, part, base_url)


async def submit_animate2_job(
    graph: dict,
    *,
    kind: str,
    positive: str,
    seed: int,
    req: BaseModel,
    user: User,
    session: Session,
    client: ComfyUIClient | None = None,
    nsfw: bool = False,
    prechecked: bool = False,
    hold_exc: HTTPException | None = None,
) -> dict:
    """提交 Wan-Animate-2 作业:开关检查 → 就绪检查 → 资源预算预检 → queue_prompt
    → 落 Job → 后台追踪(结果落库进作品库)。语义与 longcat.submit_longcat_job 一致。

    prechecked=True 表示调用方已做过 ensure_animate2_vram,此处跳过避免重复拦截。
    hold_exc:调用方预检已失败且 hold 开关开时传入,转 hold 排队(engine=wan_animate2,
    放行时重跑 ensure_animate2_vram;见 services/hold_queue)。
    """
    ensure_animate2_enabled()
    client = client or get_animate2_client()
    await ensure_animate2_ready(client)
    settings = get_settings()
    if hold_exc is not None:
        return hold_queue.place_hold(
            engine="wan_animate2", graph=graph, kind=kind, positive=positive, seed=seed,
            req=req, user=user, session=session, client=client,
            reason=str(hold_exc.detail),
            needs={
                "vram_gb": settings.wan_animate2_min_free_vram_gb,
                "ram_gb": settings.wan_animate2_min_free_ram_gb,
            },
            nsfw=nsfw,
        )
    if not prechecked:
        try:
            await ensure_animate2_vram(client)
        except HTTPException as e:
            if hold_queue.holdable(e):
                return hold_queue.place_hold(
                    engine="wan_animate2", graph=graph, kind=kind, positive=positive,
                    seed=seed, req=req, user=user, session=session, client=client,
                    reason=str(e.detail),
                    needs={
                        "vram_gb": settings.wan_animate2_min_free_vram_gb,
                        "ram_gb": settings.wan_animate2_min_free_ram_gb,
                    },
                    nsfw=nsfw,
                )
            raise

    client_id = uuid.uuid4().hex
    try:
        prompt_id = await client.queue_prompt(graph, client_id)
    except ComfyUIError as e:
        if e.status_code is None:  # 网络层失败 = 实例不可达
            raise HTTPException(
                status_code=503, detail=f"Wan-Animate-2 实例不可达({client.base_url}): {e}"
            ) from e
        _raise_from_comfy_error(e)

    session.add(
        Job(
            tenant_id=user.tenant_id,
            user_id=user.id,
            prompt_id=prompt_id,
            worker=client.base_url,
            kind=kind,
            status="queued",
            prompt=positive,
            seed=seed,
            nsfw=nsfw,
            params=params_snapshot(req, seed=seed),
        )
    )
    session.commit()

    # 服务端后台追踪:前端 SSE 断开后仍可把结果落库(与 h3/longcat 同一机制)
    spawn_tracker(client, prompt_id)

    return {
        "prompt_id": prompt_id,
        "client_id": client_id,
        "worker": client.base_url,
        "seed": seed,
    }
