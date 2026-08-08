"""MiniMax H3 视频生成服务 —— 专用 ComfyUI 实例(独立于 WorkerPool 集群)。

H3 需要 ComfyUI ≥ 0.30 的独立实例(TOIV_H3_BASE_URL,默认 workstation :8195,
systemd 托管),不走 ComfyUI-LB 集群/WorkerPool。本模块封装:
  · get_h3_client:实例客户端(与 pool worker 同一 ComfyUIClient 协议)
  · ensure_h3_ready:提交前就绪检查(在线 + 装有 H3 节点),失败 503 + 原因,不吞异常
  · ensure_h3_vram:提交前显存预检(int8 档增量峰值 ~30-33GiB,见评测文档);
    不足时协调驱逐同卡 pool worker 的空闲缓存,仍不足 → 503 错峰提示
    (2026-08-04 实发:不预检则 ComfyUI 以 "VRAM grow failed" 裸崩,job 只有 error 无原因)
  · transfer_ref_image:i2v 参考图从上传落点 pool worker 转运到 H3 实例 input 目录
  · submit_h3_job:queue_prompt → 落 Job → spawn_tracker 后台轮询落库;
    产物经 /api/images 代理进作品库,与 ltx2 完全同一条路
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
from app.versioning import params_snapshot

logger = logging.getLogger(__name__)

# H3 管线核心节点(评测 /object_info 实测);实例缺此节点 = ComfyUI 版本不支持 H3
H3_NODE = "MiniMaxH3ImageToVideo"

_GIB = 1 << 30


def get_h3_client() -> ComfyUIClient:
    settings = get_settings()
    return ComfyUIClient(settings.h3_base, timeout=settings.request_timeout)


def ensure_h3_enabled() -> None:
    """若 H3 被配置关闭,统一 503 并给出原因(前端引擎注册表同步标不可用)。"""
    if not get_settings().h3_enabled:
        raise HTTPException(status_code=503, detail="H3 视频生成引擎已禁用(TOIV_H3_ENABLED=false)")


async def ensure_h3_ready(client: ComfyUIClient) -> None:
    """确认实例在线且装有 H3 节点;不可达/缺节点一律 503 + 清晰原因。"""
    try:
        await client.object_info(H3_NODE)
    except ComfyUIError as e:
        if e.status_code is not None:  # 实例在线但无该节点(ComfyUI < 0.30 等)
            raise HTTPException(
                status_code=503,
                detail=f"H3 实例 {client.base_url} 缺少 {H3_NODE} 节点(需 ComfyUI ≥ 0.30 的 H3 实例)",
            ) from e
        raise HTTPException(status_code=503, detail=f"H3 实例不可达({client.base_url}): {e}") from e


def _cuda_free_gib(stats: dict) -> float | None:
    """从 /system_stats 提取首个 CUDA 设备的空闲显存(GiB);无设备 → None。"""
    for dev in stats.get("devices") or []:
        if dev.get("type") == "cuda" or str(dev.get("name", "")).startswith("cuda"):
            free = dev.get("vram_free")
            if isinstance(free, (int, float)):
                return free / _GIB
    return None


async def ensure_h3_vram(client: ComfyUIClient) -> None:
    """提交前显存预检:H3 int8 档增量峰值 ~30-33GiB(评测实测),空闲不足则:

    1. H3 自身队列空闲时先驱逐自身模型缓存
       —— 上一作业的驻留缓存(实测 ~39GiB)是占卡大头,驱逐后本次重新加载即可跑;
    2. 协调驱逐同卡 pool worker(settings.h3_co_workers)的模型缓存
       —— 仅在其队列完全空闲时(有作业在跑绝不动,否则会杀死在跑作业);
    3. 复查仍不足 → 503 + 错峰提示(清晰原因,而非 ComfyUI 裸崩 VRAM grow failed)。

    /system_stats 读取失败时放行(降级为不预检,由 ComfyUI 自身错误兜底)。
    """
    settings = get_settings()
    threshold = settings.h3_min_free_vram_gb
    if threshold <= 0:  # 阈值设为 0 = 显式关闭预检
        return
    try:
        free = _cuda_free_gib(await client.get_system_stats())
    except ComfyUIError as e:
        logger.warning("H3 显存预检读取失败,跳过预检: %s", e)
        return
    if free is None or free >= threshold:
        return

    # 1) H3 自身驻留缓存(队列空闲才可驱逐)
    logger.warning("H3 显存不足(空闲 %.1fG < 阈值 %.1fG),尝试驱逐 H3 自身缓存", free, threshold)
    try:
        if await client.queue_len() == 0:
            await client.free_memory()
            logger.info("已驱逐 H3 自身模型缓存")
            free = _cuda_free_gib(await client.get_system_stats())
            if free is None or free >= threshold:
                return
        else:
            logger.info("H3 队列非空闲,不驱逐自身缓存")
    except ComfyUIError as e:
        logger.warning("驱逐 H3 自身缓存失败(忽略,继续协调同卡 worker): %s", e)

    # 2) 同卡 pool worker 空闲缓存
    logger.warning("H3 显存仍不足,尝试驱逐同卡 worker 缓存")
    for url in settings.h3_co_worker_urls:
        co = ComfyUIClient(url, timeout=settings.request_timeout)
        try:
            if await co.queue_len() > 0:
                logger.info("同卡 worker %s 队列非空闲,不驱逐", url)
                continue
            await co.free_memory()
            logger.info("已驱逐同卡 worker %s 的模型缓存", url)
        except ComfyUIError as e:
            logger.warning("驱逐同卡 worker %s 缓存失败(忽略,继续复查): %s", url, e)
    try:
        free = _cuda_free_gib(await client.get_system_stats())
    except ComfyUIError as e:
        logger.warning("H3 显存复查读取失败,跳过预检: %s", e)
        return
    if free is not None and free < threshold:
        raise HTTPException(
            status_code=503,
            detail=(
                f"H3 显卡空闲显存不足:当前 {free:.1f}GiB,需要 ≥{threshold:.0f}GiB"
                "(与同卡其他服务错峰,或释放其模型缓存后重试)"
            ),
        )


async def transfer_ref_image(client: ComfyUIClient, source: ComfyUIClient, image: str) -> str:
    """把参考图从上传落点的 pool worker 转运到 H3 实例 input 目录,返回 H3 侧文件名。

    H3 实例独立于集群,前端经 /api/upload 上传的参考图落在 pool worker 上,
    提交 i2v 前须搬过去(读 /view → POST /upload/image)。
    """
    try:
        content, _ = await source.get_image_bytes(image, "", "input")
    except ComfyUIError as e:
        raise HTTPException(status_code=502, detail=f"从参考图所在 worker 读取失败: {e}") from e
    try:
        return await client.upload_image(content, image)
    except ComfyUIError as e:
        raise HTTPException(status_code=502, detail=f"参考图上传到 H3 实例失败: {e}") from e


async def submit_h3_job(
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
) -> dict:
    """提交 H3 作业:开关检查 → 就绪检查 → queue_prompt → 落 Job → 后台追踪(结果落库进作品库)。

    nsfw=True 时 Job 打 R18 标(进 /nsfw 专区作品库);调用方须先过 R18 门控
    (routes 层用 nsfw_allowed(user) 判定,含未成年硬阻断),此处不重复校验。
    """
    ensure_h3_enabled()
    client = client or get_h3_client()
    await ensure_h3_ready(client)
    await ensure_h3_vram(client)

    client_id = uuid.uuid4().hex
    try:
        prompt_id = await client.queue_prompt(graph, client_id)
    except ComfyUIError as e:
        if e.status_code is None:  # 网络层失败 = 实例不可达
            raise HTTPException(status_code=503, detail=f"H3 实例不可达({client.base_url}): {e}") from e
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

    # 服务端后台追踪:前端 SSE 断开后仍可把结果落库(与 ltx2 同一机制)
    spawn_tracker(client, prompt_id)

    return {
        "prompt_id": prompt_id,
        "client_id": client_id,
        "worker": client.base_url,
        "seed": seed,
    }
