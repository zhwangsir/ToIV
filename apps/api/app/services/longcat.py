"""LongCat-Video 长视频引擎服务 —— 专用 ComfyUI 实例(独立于 WorkerPool 集群)。

LongCat 跑在 workstation GPU2 的独立实例(TOIV_LONGCAT_BASE_URL,默认 :8197,
systemd comfyui-longcat.service 托管),不走 ComfyUI-LB 集群/WorkerPool
(WanVideo 系节点仅该实例装有)。与 app/services/h3.py 同一模式:
  · get_longcat_client:实例客户端(与 pool worker 同一 ComfyUIClient 协议)
  · ensure_longcat_ready:提交前就绪检查(在线 + 装有 WanVideo 节点),失败 503 + 原因
  · submit_longcat_job:queue_prompt → 落 Job → spawn_tracker 后台轮询落库;
    产物经 /api/images 代理进作品库,与 h3/ltx2 完全同一条路

GPU2 与 ASR(:9210)/H3 worker 共卡,但 LongCat 全程 offload(实测 480p49f 峰值 ~21GB),
不做 H3 那样的显存预检/驱逐协调;实例真挤爆时由 ComfyUI 自身错误兜底。
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

# LongCat 管线核心节点(实例 /object_info 实测);缺此节点 = 实例未装 WanVideo 节点包
LONGCAT_NODE = "WanVideoModelLoader"


def get_longcat_client() -> ComfyUIClient:
    settings = get_settings()
    return ComfyUIClient(settings.longcat_base, timeout=settings.request_timeout)


def ensure_longcat_enabled() -> None:
    """若 LongCat 被配置关闭,统一 503 并给出原因(前端引擎注册表同步标不可用)。"""
    if not get_settings().longcat_enabled:
        raise HTTPException(
            status_code=503, detail="LongCat 视频生成引擎已禁用(TOIV_LONGCAT_ENABLED=false)"
        )


async def ensure_longcat_ready(client: ComfyUIClient) -> None:
    """确认实例在线且装有 WanVideo 节点;不可达/缺节点一律 503 + 清晰原因。"""
    try:
        await client.object_info(LONGCAT_NODE)
    except ComfyUIError as e:
        if e.status_code is not None:  # 实例在线但无该节点
            raise HTTPException(
                status_code=503,
                detail=f"LongCat 实例 {client.base_url} 缺少 {LONGCAT_NODE} 节点(需装有 WanVideo 节点包的实例)",
            ) from e
        raise HTTPException(
            status_code=503, detail=f"LongCat 实例不可达({client.base_url}): {e}"
        ) from e


async def submit_longcat_job(
    graph: dict,
    *,
    kind: str,
    positive: str,
    seed: int,
    req: BaseModel,
    user: User,
    session: Session,
    client: ComfyUIClient | None = None,
) -> dict:
    """提交 LongCat 作业:开关检查 → 就绪检查 → queue_prompt → 落 Job → 后台追踪(结果落库进作品库)。"""
    ensure_longcat_enabled()
    client = client or get_longcat_client()
    await ensure_longcat_ready(client)

    client_id = uuid.uuid4().hex
    try:
        prompt_id = await client.queue_prompt(graph, client_id)
    except ComfyUIError as e:
        if e.status_code is None:  # 网络层失败 = 实例不可达
            raise HTTPException(
                status_code=503, detail=f"LongCat 实例不可达({client.base_url}): {e}"
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
            nsfw=False,
            params=params_snapshot(req, seed=seed),
        )
    )
    session.commit()

    # 服务端后台追踪:前端 SSE 断开后仍可把结果落库(与 h3/ltx2 同一机制)
    spawn_tracker(client, prompt_id)

    return {
        "prompt_id": prompt_id,
        "client_id": client_id,
        "worker": client.base_url,
        "seed": seed,
    }
