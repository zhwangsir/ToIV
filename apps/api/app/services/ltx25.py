"""LTX-2.5 视频引擎服务 —— 专用 ComfyUI 实例(独立于 WorkerPool 集群)。

LTX-2.5 跑在 workstation GPU0 的独立实例(TOIV_LTX25_BASE_URL,默认 :8198,
systemd comfyui-ltx25.service 托管,ComfyUI 0.32.x),不走 ComfyUI-LB 集群
/WorkerPool(生产 :8189 为 0.27,无 LTX-2.5 节点)。与 app/services/longcat.py
同一模式:
  · get_ltx25_client:实例客户端(与 pool worker 同一 ComfyUIClient 协议)
  · ensure_ltx25_ready:提交前就绪检查(在线 + 含 LTX-2.5 节点),失败 503 + 原因
  · transfer_ref_image:i2v 参考图从上传落点 pool worker 转运到实例 input 目录
  · submit_ltx25_job:queue_prompt → 落 Job → spawn_tracker 后台轮询落库;
    产物经 /api/images 代理进作品库,与 h3/ltx2/longcat 完全同一条路

GPU0 与 ComfyUI #1(:8189)/IndexTTS2/H3 共卡:nvfp4 蒸馏 transformer(18.7GB)
+ gemma4 int8(15.4GB)常驻量级可控,不做 H3 那样的显存预检/驱逐协调;
实例真挤爆时由 ComfyUI 自身错误兜底(同 longcat 原则)。
"""
from __future__ import annotations

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

# LTX-2.5 链路核心节点(音视频文本编码器,ComfyUI 0.32+ 的 comfy/text_encoders/lt.py);
# 缺此节点 = 实例 ComfyUI 版本过低,不支持 LTX-2.5
LTX25_NODE = "LTXAVTextEncoderLoader"


def get_ltx25_client() -> ComfyUIClient:
    settings = get_settings()
    return ComfyUIClient(settings.ltx25_base, timeout=settings.request_timeout)


def ensure_ltx25_enabled() -> None:
    """若 LTX-2.5 被配置关闭,统一 503 并给出原因(前端引擎注册表同步标不可用)。"""
    if not get_settings().ltx25_enabled:
        raise HTTPException(
            status_code=503, detail="LTX-2.5 视频生成引擎已禁用(TOIV_LTX25_ENABLED=false)"
        )


async def ensure_ltx25_ready(client: ComfyUIClient) -> None:
    """确认实例在线且含 LTX-2.5 节点;不可达/缺节点一律 503 + 清晰原因。"""
    try:
        await client.object_info(LTX25_NODE)
    except ComfyUIError as e:
        if e.status_code is not None:  # 实例在线但无该节点
            raise HTTPException(
                status_code=503,
                detail=f"LTX-2.5 实例 {client.base_url} 缺少 {LTX25_NODE} 节点(需 ComfyUI ≥ 0.32)",
            ) from e
        raise HTTPException(
            status_code=503, detail=f"LTX-2.5 实例不可达({client.base_url}): {e}"
        ) from e


async def transfer_ref_image(client: ComfyUIClient, source: ComfyUIClient, image: str) -> str:
    """把参考图从上传落点的 pool worker 转运到 LTX-2.5 实例 input 目录,返回实例侧文件名。

    LTX-2.5 实例独立于集群,前端经 /api/upload 上传的参考图落在 pool worker 上,
    提交 i2v 前须搬过去(读 /view → POST /upload/image)。与 longcat.transfer_ref_image 同模式。
    """
    try:
        content, _ = await source.get_image_bytes(image, "", "input")
    except ComfyUIError as e:
        raise HTTPException(status_code=502, detail=f"从参考图所在 worker 读取失败: {e}") from e
    try:
        return await client.upload_image(content, image)
    except ComfyUIError as e:
        raise HTTPException(status_code=502, detail=f"参考图上传到 LTX-2.5 实例失败: {e}") from e


async def submit_ltx25_job(
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
    """提交 LTX-2.5 作业:开关检查 → 就绪检查 → queue_prompt → 落 Job → 后台追踪(结果落库进作品库)。

    LTX-2.5 为 SFW 主力视频链路,无 nsfw 标(NSFW 仍走 LTX-2.3 + 10Eros 链路)。
    """
    ensure_ltx25_enabled()
    client = client or get_ltx25_client()
    await ensure_ltx25_ready(client)

    client_id = uuid.uuid4().hex
    try:
        prompt_id = await client.queue_prompt(graph, client_id)
    except ComfyUIError as e:
        if e.status_code is None:  # 网络层失败 = 实例不可达
            raise HTTPException(
                status_code=503, detail=f"LTX-2.5 实例不可达({client.base_url}): {e}"
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

    # 服务端后台追踪:前端 SSE 断开后仍可把结果落库(与 h3/ltx2/longcat 同一机制)
    spawn_tracker(client, prompt_id)

    return {
        "prompt_id": prompt_id,
        "client_id": client_id,
        "worker": client.base_url,
        "seed": seed,
    }
