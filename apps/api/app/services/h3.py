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

import asyncio
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
from app.services.resource_budget import ensure_host_ram
from app.versioning import params_snapshot
from app.workflows.h3_video import apply_nsfw_unet

logger = logging.getLogger(__name__)

# 驱逐模型缓存(/free)是异步操作:41G 级权重释放需数秒,复查前等显存实际落地
_VRAM_SETTLE_SEC = 5.0

# H3 管线核心节点(评测 /object_info 实测);实例缺此节点 = ComfyUI 版本不支持 H3
H3_NODE = "MiniMaxH3ImageToVideo"

# 已知 H3 NSFW LoRA 文件名(civitai 调研,base 均 MiniMax H3;详见 routes/models.py
# NSFW_RECOMMENDATIONS 的 h3 分类)。请求引用其中任一 → 须过 R18 门控(nsfw_allowed),
# 与 ltx_studio 的 _NSFW_UNETS 同款名单制。engine_registry 的 LoRA 选项也按此打 nsfw 标。
H3_NSFW_LORAS: frozenset[str] = frozenset(
    {
        "riding_pose_H3_i2v_v1.0.safetensors",  # civitai 2446218 Riding POV (I2V)
        "H3_footjob_v0_step1000_fixed.safetensors",  # civitai 2839680 Footjob
        "h3_musubi_v4-000040.safetensors",  # civitai 2841940 Innie Pussy
        "deepthroat_v1.safetensors",  # civitai 2476698 Daring's Deepthroat H3
        "minimax_vag_000002500.safetensors",  # civitai 2835594 H3 Vagina v0.2
        "SexGod-NaughtyTimes-lora-MINIMAXH3.safetensors",  # civitai 2836176 NaughtyTimes
        "HMNSFW_AIO_V2.safetensors",  # civitai 2834417 HMNSFW AIO (I2V/T2V,1.9w 下载)
        "vagassist_e40.safetensors",  # civitai 2846342 HMPussy v0.5 (Pussy/Anus)
        "stomach_bulge_H3_i2v_v1.0.safetensors",  # civitai 1445226 Stomach Bulge (I2V,3.6w 下载)
    }
)


def is_h3_nsfw_lora(name: str) -> bool:
    """判定 LoRA 名(可带子目录前缀)是否已知 NSFW;按 basename 精确匹配。"""
    return name.replace("\\", "/").rsplit("/", 1)[-1] in H3_NSFW_LORAS

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

    0. **实例自身队列非空(有 H3 作业在跑/等待)→ 直接放行,走 ComfyUI 原生排队**
       —— 此时模型必已驻留显存(上个/当前作业加载过),串行执行无需显存增量,
       排队等待属正常调度而非故障(QUEUE-2026-08-18 用户诉求);
    1. H3 自身队列空闲时,先驱逐自身模型缓存
       —— 上一作业的驻留缓存(实测 ~39GiB)是占卡大头,驱逐后本次重新加载即可跑;
    2. 协调驱逐同卡 pool worker(settings.h3_co_workers)的模型缓存
       —— 仅在其队列完全空闲时(有作业在跑绝不动,否则会杀死在跑作业);
    3. 复查仍不足 → 503 + 错峰提示(清晰原因,而非 ComfyUI 裸崩 VRAM grow failed);
    4. 显存通过后追加宿主机 RAM 预检(resource_budget.ensure_host_ram)
       —— 2026-08-21 多引擎并跑耗尽 183G RAM、OOM killer 杀 H3 的防线。

    注:Wan 实例(wan_video.ensure_wan_vram)不做第 0 步——其队列忙时低显存成因
    常是 H3 邻居占卡(跨实例不共队列),排队执行时会 OOM,503 错峰是正确行为。
    /system_stats 读取失败时放行(降级为不预检,由 ComfyUI 自身错误兜底)。
    """
    settings = get_settings()
    threshold = settings.h3_min_free_vram_gb
    if threshold <= 0:  # 阈值设为 0 = 显式关闭预检
        return
    try:
        if await client.queue_len() > 0:
            logger.info("H3 实例队列非空,跳过显存预检(ComfyUI 原生排队,模型已驻留)")
            return
    except ComfyUIError as e:
        logger.warning("H3 队列读取失败,继续显存预检: %s", e)
    try:
        free = _cuda_free_gib(await client.get_system_stats())
    except ComfyUIError as e:
        logger.warning("H3 显存预检读取失败,跳过预检: %s", e)
        return
    if free is None or free >= threshold:
        await ensure_host_ram(client, settings.h3_min_free_ram_gb, "H3")
        return

    # 1) H3 自身驻留缓存(队列空闲才可驱逐)
    logger.warning("H3 显存不足(空闲 %.1fG < 阈值 %.1fG),尝试驱逐 H3 自身缓存", free, threshold)
    try:
        if await client.queue_len() == 0:
            await client.free_memory()
            logger.info("已驱逐 H3 自身模型缓存")
            # /free 卸载是异步的(41G 级权重释放需数秒),立即复查会读到旧值
            # 误报 503(2026-08-21 竞态实证:驱逐后 9ms 复查仍 26.1G → 误杀批量补段)
            await asyncio.sleep(_VRAM_SETTLE_SEC)
            free = _cuda_free_gib(await client.get_system_stats())
            if free is None or free >= threshold:
                await ensure_host_ram(client, settings.h3_min_free_ram_gb, "H3")
                return
        else:
            logger.info("H3 队列非空闲,不驱逐自身缓存")
    except ComfyUIError as e:
        logger.warning("驱逐 H3 自身缓存失败(忽略,继续协调同卡 worker): %s", e)

    # 2) 同卡 pool worker 空闲缓存
    logger.warning("H3 显存仍不足,尝试驱逐同卡 worker 缓存")
    evicted_any = False
    for url in settings.h3_co_worker_urls:
        co = ComfyUIClient(url, timeout=settings.request_timeout)
        try:
            if await co.queue_len() > 0:
                logger.info("同卡 worker %s 队列非空闲,不驱逐", url)
                continue
            await co.free_memory()
            evicted_any = True
            logger.info("已驱逐同卡 worker %s 的模型缓存", url)
        except ComfyUIError as e:
            logger.warning("驱逐同卡 worker %s 缓存失败(忽略,继续复查): %s", url, e)
    try:
        if evicted_any:
            await asyncio.sleep(_VRAM_SETTLE_SEC)
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
    # 显存预检通过 → 宿主机 RAM 预检(2026-08-21 OOM 防线)
    await ensure_host_ram(client, settings.h3_min_free_ram_gb, "H3")


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

    # NSFW 场景(X-NSFW 专区)默认换 10Eros-Max H3 嫁接版 UNET(TOIV_H3_NSFW_UNET);
    # SFW 保持模板底模不动。在预检/hold 分支之前完成替换:hold 时 graph 直接入库,
    # 放行由 hold_queue 原样提交,不再经过本函数。
    if nsfw:
        nsfw_unet = getattr(get_settings(), "h3_nsfw_unet", "")
        if nsfw_unet:
            apply_nsfw_unet(graph, nsfw_unet)

    try:
        await ensure_h3_vram(client)
    except HTTPException as e:
        # 资源预算二期:预检不足不再直接 503,转 hold 排队(资源释放后自动放行);
        # 开关关闭则维持一期 503 行为(见 services/hold_queue)
        if hold_queue.holdable(e):
            settings = get_settings()
            return hold_queue.place_hold(
                engine="h3", graph=graph, kind=kind, positive=positive, seed=seed,
                req=req, user=user, session=session, client=client,
                reason=str(e.detail),
                needs={
                    "vram_gb": settings.h3_min_free_vram_gb,
                    "ram_gb": settings.h3_min_free_ram_gb,
                },
                nsfw=nsfw,
            )
        raise

    # 排队位次提示(QUEUE-2026-08-18):提交前统计 pending 数,让前端明确告知
    # 「已排队,前方还有 N 个」——排队等待是正常调度而非技术性故障。
    # 读取失败静默归 0(提示降级,不影响提交本身)。
    queued_behind = 0
    try:
        _running, queued_behind = await client.queue_counts()
    except ComfyUIError:
        queued_behind = 0

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
        "queued_behind": queued_behind,
    }
