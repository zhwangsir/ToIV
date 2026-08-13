"""Wan2.2-Animate / Wan2.1-VACE 引擎服务 —— 与 LongCat 同实例(GPU2 :8197)。

复用 services/longcat.py 的 client/就绪检查/追踪/提交链路(get_longcat_client、
ensure_longcat_ready、submit_longcat_job、transfer_ref_image);
本模块只补充两条 Wan 系特有逻辑:

  · ensure_wan_vram:提交前 GPU2 显存互斥预检。Animate/VACE 与 H3 共卡
    (H3 实例 2026-08-10 起 CUDA_VISIBLE_DEVICES=2),H3 突发 ~48GB 时禁止并发。
    空闲不足先驱逐 :8197 自身模型缓存(队列空闲才动),仍不足 → 503 错峰;
    绝不驱逐 H3(硬规则:H3 必须可用),宁可 503 也不动 H3 的显存。
  · transfer_drive_video:驱动视频从上传落点 pool worker 转运到 :8197 input 目录
    (与 transfer_ref_image 同一机制,ComfyUI /upload/image 接受任意文件,
    VHS_LoadVideo 从 input 目录读取)。
"""
from __future__ import annotations

import logging

from fastapi import HTTPException

from app.comfy.client import ComfyUIClient, ComfyUIError
from app.config import get_settings
from app.services.h3 import _cuda_free_gib

logger = logging.getLogger(__name__)


async def ensure_wan_vram(client: ComfyUIClient) -> None:
    """提交前显存互斥预检(Animate fp8 峰值 ~20-24GiB,VACE fp8 峰值 ~18-22GiB):

    1. 实例卡(GPU2)空闲 ≥ 阈值(TOIV_WAN_MIN_FREE_VRAM_GB,默认 26GiB)直接放行;
    2. 不足且 :8197 队列空闲 → 驱逐自身模型缓存后复查(LongCat/Avatar 驻留缓存);
    3. 仍不足 → 503 错峰提示。典型场景:H3 作业在跑(突发 ~48GB)。

    /system_stats 读取失败时放行(降级为不预检,由 ComfyUI 自身错误兜底)。
    阈值设为 0 = 显式关闭预检。
    """
    settings = get_settings()
    threshold = settings.wan_min_free_vram_gb
    if threshold <= 0:
        return
    try:
        free = _cuda_free_gib(await client.get_system_stats())
    except ComfyUIError as e:
        logger.warning("Wan 显存预检读取失败,跳过预检: %s", e)
        return
    if free is None or free >= threshold:
        return

    logger.warning("Wan 显存不足(空闲 %.1fG < 阈值 %.1fG),尝试驱逐实例自身缓存", free, threshold)
    try:
        if await client.queue_len() == 0:
            await client.free_memory()
            logger.info("已驱逐 :8197 实例模型缓存")
            free = _cuda_free_gib(await client.get_system_stats())
        else:
            logger.info(":8197 队列非空闲,不驱逐自身缓存")
    except ComfyUIError as e:
        logger.warning("驱逐 :8197 实例缓存失败(忽略,继续复查): %s", e)
        return
    if free is not None and free < threshold:
        raise HTTPException(
            status_code=503,
            detail=(
                f"GPU2 空闲显存不足:当前 {free:.1f}GiB,需要 ≥{threshold:.0f}GiB"
                "(H3/其他作业在跑,请错峰重试)"
            ),
        )


async def transfer_drive_video(client: ComfyUIClient, source: ComfyUIClient, video: str) -> str:
    """把驱动视频从上传落点的 pool worker 转运到 :8197 实例 input 目录,返回实例侧文件名。

    与 services/longcat.transfer_ref_image 同一机制(ComfyUI /upload/image 接受任意文件,
    VHS_LoadVideo 从 input 目录读取)。
    """
    try:
        content, _ = await source.get_image_bytes(video, "", "input")
    except ComfyUIError as e:
        raise HTTPException(status_code=502, detail=f"从驱动视频所在 worker 读取失败: {e}") from e
    try:
        return await client.upload_image(content, video)
    except ComfyUIError as e:
        raise HTTPException(status_code=502, detail=f"驱动视频上传到实例失败: {e}") from e
