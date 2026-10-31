"""作业提交前的宿主机资源预算预检(宿主机 RAM / 通用 VRAM)。

2026-08-21 事故的制度化防线:多引擎并跑耗尽 workstation 183G RAM,OOM killer
杀掉 H3、14 个作业 error。此前只有显存预检(h3.ensure_h3_vram / wan_video.ensure_wan_vram),
宿主机 RAM 毫无护栏。同一宿主机上所有 ComfyUI 实例的 /system_stats 报告同一份
system.ram_free(字节),经任一实例读取即代表整机水位。

本模块抛出的 503 自 2026-08-23 起由提交收口(services/h3、longcat、routes/wan_studio)
经 services/hold_queue 转为 hold 排队(资源释放后自动放行);仅 hold 开关关闭时
才以 503 直达调用方。

降级原则与既有显存预检完全一致:
  · /system_stats 读取失败 → 放行(降级不预检,由 ComfyUI 自身错误兜底);
  · 阈值 ≤ 0 → 显式关闭预检;
  · 仅在实例队列空闲时驱逐自身模型缓存(在跑作业绝不动,/free 会直接杀死它)。
"""
from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable

from fastapi import HTTPException

from app.comfy.client import ComfyUIClient, ComfyUIError

logger = logging.getLogger(__name__)

_GIB = 1 << 30

# /free 卸载模型是异步的(权重释放需数秒),复查前等释放实际落地,否则读到旧值
# 误报 503(2026-08-21 竞态实证,与 h3._VRAM_SETTLE_SEC 同一教训)
_SETTLE_SEC = 5.0


def ram_free_gib(stats: dict) -> float | None:
    """从 /system_stats 提取宿主机空闲内存(GiB);无 system 段/无 ram_free → None
    (容错风格同 h3._cuda_free_gib:解析不出 = 不确定,由调用方放行)。"""
    system = stats.get("system")
    if not isinstance(system, dict):
        return None
    free = system.get("ram_free")
    if isinstance(free, (int, float)):
        return free / _GIB
    return None


def vram_free_gib(stats: dict) -> float | None:
    """从 /system_stats 提取首个 CUDA 设备的空闲显存(GiB);无设备 → None。

    与 h3._cuda_free_gib 同一解析逻辑;此处独立一份,避免 services 模块间循环依赖
    (h3/wan_video/longcat 均 import 本模块)。
    """
    for dev in stats.get("devices") or []:
        if dev.get("type") == "cuda" or str(dev.get("name", "")).startswith("cuda"):
            free = dev.get("vram_free")
            if isinstance(free, (int, float)):
                return free / _GIB
    return None


async def _evict_then_recheck(
    client: ComfyUIClient, parse: Callable[[dict], float | None], engine: str, label: str
) -> float | None:
    """队列空闲才驱逐实例自身模型缓存,落定后复查;任何读取失败 → None(放行)。"""
    try:
        if await client.queue_len() == 0:
            await client.free_memory()
            logger.info("已驱逐 %s 实例自身模型缓存(%s预检)", engine, label)
            await asyncio.sleep(_SETTLE_SEC)
        else:
            logger.info("%s 队列非空闲,不驱逐自身缓存(%s预检)", engine, label)
        return parse(await client.get_system_stats())
    except ComfyUIError as e:
        logger.warning("%s %s复查读取失败,跳过预检: %s", engine, label, e)
        return None


async def ensure_host_ram(client: ComfyUIClient, min_free_gb: float, engine: str) -> None:
    """宿主机 RAM 预检:ram_free ≥ 阈值放行;不足且队列空闲 → 驱逐自身模型缓存 +
    落定复查;仍不足 → 503(含当前值与阈值)。stats 读取失败放行(降级不预检)。"""
    if min_free_gb <= 0:  # 阈值设为 0 = 显式关闭预检
        return
    try:
        free = ram_free_gib(await client.get_system_stats())
    except ComfyUIError as e:
        logger.warning("%s 内存预检读取失败,跳过预检: %s", engine, e)
        return
    if free is None or free >= min_free_gb:
        return

    logger.warning(
        "%s 宿主机内存不足(空闲 %.1fG < 阈值 %.1fG),尝试驱逐实例自身模型缓存",
        engine, free, min_free_gb,
    )
    free = await _evict_then_recheck(client, ram_free_gib, engine, "内存")
    if free is not None and free < min_free_gb:
        raise HTTPException(
            status_code=503,
            detail=f"{engine} 宿主机内存不足:当前可用 {free:.1f}GiB,需要 ≥{min_free_gb:.0f}GiB",
        )


async def ensure_vram(client: ComfyUIClient, min_free_gb: float, engine: str) -> None:
    """通用显存预检:语义同 ensure_host_ram,作用于实例首个 CUDA 设备。
    供无专属预检的共卡引擎(LongCat 等)复用;h3/wan 保留各自的协调驱逐逻辑。"""
    if min_free_gb <= 0:
        return
    try:
        free = vram_free_gib(await client.get_system_stats())
    except ComfyUIError as e:
        logger.warning("%s 显存预检读取失败,跳过预检: %s", engine, e)
        return
    if free is None or free >= min_free_gb:
        return

    logger.warning(
        "%s 显存不足(空闲 %.1fG < 阈值 %.1fG),尝试驱逐实例自身模型缓存",
        engine, free, min_free_gb,
    )
    free = await _evict_then_recheck(client, vram_free_gib, engine, "显存")
    if free is not None and free < min_free_gb:
        raise HTTPException(
            status_code=503,
            detail=(
                f"{engine} 显卡空闲显存不足:当前 {free:.1f}GiB,需要 ≥{min_free_gb:.0f}GiB"
                "(与同卡其他服务错峰,或释放其模型缓存后重试)"
            ),
        )
