"""LongCat-Video 长视频引擎服务 —— 专用 ComfyUI 实例(独立于 WorkerPool 集群)。

LongCat 跑在 workstation GPU2 的独立实例(TOIV_LONGCAT_BASE_URL,默认 :8197,
systemd comfyui-longcat.service 托管),不走 ComfyUI-LB 集群/WorkerPool
(WanVideo 系节点仅该实例装有)。与 app/services/h3.py 同一模式:
  · get_longcat_client:实例客户端(与 pool worker 同一 ComfyUIClient 协议)
  · ensure_longcat_ready:提交前就绪检查(在线 + 装有 WanVideo 节点),失败 503 + 原因
  · transfer_ref_image:i2v 参考图从上传落点 pool worker 转运到 LongCat 实例 input 目录
  · prepare_continue_first_frame:续写源视频(产物 URL 或上传视频)→ ffmpeg 抽末帧
    → 上传到实例 input,返回首帧文件名 + 源视频元信息(宽高/帧率,供参数对齐)
  · submit_longcat_job:queue_prompt → 落 Job → spawn_tracker 后台轮询落库;
    产物经 /api/images 代理进作品库,与 h3/ltx2 完全同一条路

GPU2 与 ASR(:9210)/H3 worker 共卡。LongCat 全程 offload(实测 480p49f 峰值 ~21GB);
提交前经 services/resource_budget 做显存 + 宿主机 RAM 双预检(2026-08-21 多引擎
并跑耗尽 183G RAM、OOM killer 杀 H3 的防线),不足 → 503 错峰,不做 H3 那样的
同卡协调驱逐。
"""
from __future__ import annotations

import asyncio
import logging
import shutil
import tempfile
import uuid
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from fastapi import HTTPException
from pydantic import BaseModel
from sqlmodel import Session

from app.comfy.client import ComfyUIClient, ComfyUIError
from app.comfy.tracker import spawn as spawn_tracker
from app.config import get_settings
from app.deps import resolve_worker
from app.models import Job, User
from app.routes.video import _raise_from_comfy_error
from app.services import hold_queue
from app.services.resource_budget import ensure_host_ram, ensure_vram
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


async def transfer_ref_image(client: ComfyUIClient, source: ComfyUIClient, image: str) -> str:
    """把参考图从上传落点的 pool worker 转运到 LongCat 实例 input 目录,返回实例侧文件名。

    LongCat 实例独立于集群,前端经 /api/upload 上传的参考图落在 pool worker 上,
    提交 i2v 前须搬过去(读 /view → POST /upload/image)。与 h3.transfer_ref_image 同模式。
    """
    try:
        content, _ = await source.get_image_bytes(image, "", "input")
    except ComfyUIError as e:
        raise HTTPException(status_code=502, detail=f"从参考图所在 worker 读取失败: {e}") from e
    try:
        return await client.upload_image(content, image)
    except ComfyUIError as e:
        raise HTTPException(status_code=502, detail=f"参考图上传到 LongCat 实例失败: {e}") from e


async def transfer_ref_audio(client: ComfyUIClient, source: ComfyUIClient, audio: str) -> str:
    """把驱动音频从上传落点的 pool worker 转运到 LongCat 实例 input 目录,返回实例侧文件名。

    与 transfer_ref_image 同一机制(ComfyUI /upload/image 接受任意文件,
    LoadAudio 从 input 目录读取;lipsync/dub 链路上传 wav/mp4 也走此接口)。
    """
    try:
        content, _ = await source.get_image_bytes(audio, "", "input")
    except ComfyUIError as e:
        raise HTTPException(status_code=502, detail=f"从音频所在 worker 读取失败: {e}") from e
    try:
        return await client.upload_image(content, audio)
    except ComfyUIError as e:
        raise HTTPException(status_code=502, detail=f"音频上传到 LongCat 实例失败: {e}") from e


async def _fetch_source_video_bytes(video: str, worker: str | None) -> bytes:
    """取续写源视频字节:/api/images?... 产物 URL(worker 在 query 里)或上传视频文件名
    (worker 必填,即上传落点)。走 resolve_worker 白名单校验(防 SSRF)。"""
    if video.startswith("/api/images?"):
        qs = parse_qs(urlsplit(video).query)
        filename = qs.get("filename", [""])[0]
        subfolder = qs.get("subfolder", [""])[0]
        type_ = qs.get("type", ["output"])[0]
        src_worker = qs.get("worker", [""])[0]
        if not filename or not src_worker:
            raise HTTPException(status_code=422, detail="无效的产物 URL(缺 filename/worker 参数)")
    else:
        name = video.strip().replace("\\", "/")
        if ".." in name or name.startswith("/"):
            raise HTTPException(status_code=422, detail="视频文件名不允许路径穿越")
        if not worker:
            raise HTTPException(status_code=422, detail="上传视频续写需提供 worker 参数(上传落点)")
        filename, subfolder, type_, src_worker = name, "", "input", worker
    source = resolve_worker(src_worker)
    try:
        content, _ = await source.get_image_bytes(filename, subfolder, type_)
    except ComfyUIError as e:
        raise HTTPException(status_code=502, detail=f"读取续写源视频失败: {e}") from e
    return content


async def _probe_video_meta(path: Path) -> tuple[int, int, int] | None:
    """ffprobe 探测 (width, height, fps);失败返回 None(调用方回落默认参数)。

    续写段分辨率/帧率默认向源视频实测值对齐(与 drama continue-video 同一原则:
    项目/请求默认值可能与源视频不一致,直接用会做出参数跳变的下一段)。
    """
    if shutil.which("ffprobe") is None:
        return None
    proc = await asyncio.create_subprocess_exec(
        "ffprobe", "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=width,height,avg_frame_rate", "-of", "csv=p=0", str(path),
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    out, _ = await proc.communicate()
    try:
        w_s, h_s, rate = out.decode().strip().split(",")[:3]
        num, den = rate.split("/")
        fps = max(1, round(int(num) / max(1, int(den))))
        return int(w_s), int(h_s), fps
    except (ValueError, AttributeError):
        return None


async def prepare_continue_first_frame(
    client: ComfyUIClient, video: str, worker: str | None
) -> tuple[str, tuple[int, int, int] | None]:
    """续写前置:取源视频字节 → ffmpeg 抽末帧为 jpg → 上传到 LongCat 实例 input。

    返回 (实例侧首帧文件名, 源视频元信息 (width, height, fps) 或 None)。
    """
    from app.routes.assembly import _run_ffmpeg

    content = await _fetch_source_video_bytes(video, worker)
    with tempfile.TemporaryDirectory(prefix="longcat-cont-") as tmp:
        tmp_dir = Path(tmp)
        src = tmp_dir / "source.mp4"
        src.write_bytes(content)
        meta = await _probe_video_meta(src)
        frame = tmp_dir / "last_frame.jpg"
        # -sseof 倒 seek 定位末帧,避免全片解码(与 drama _extract_last_frame 同参数)
        await _run_ffmpeg([
            "ffmpeg", "-y", "-sseof", "-0.1", "-i", str(src),
            "-frames:v", "1", "-q:v", "2", str(frame),
        ])
        if not frame.exists() or frame.stat().st_size == 0:
            raise HTTPException(status_code=500, detail="续写末帧抽取失败(ffmpeg 产物为空)")
        frame_bytes = frame.read_bytes()
    try:
        name = await client.upload_image(frame_bytes, f"longcat_continue_{uuid.uuid4().hex[:12]}.jpg")
    except ComfyUIError as e:
        raise HTTPException(status_code=502, detail=f"续写首帧上传到 LongCat 实例失败: {e}") from e
    return name, meta


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
    nsfw: bool = False,
    prechecked: bool = False,
    hold_exc: HTTPException | None = None,
) -> dict:
    """提交 LongCat 作业:开关检查 → 就绪检查 → 资源预算预检 → queue_prompt → 落 Job
    → 后台追踪(结果落库进作品库)。

    nsfw=True 时 Job 打 R18 标(进 /nsfw 专区作品库);调用方须先过 R18 门控
    (routes 层用 nsfw_allowed(user) 判定,含未成年硬阻断),此处不重复校验。
    prechecked=True 表示调用方已做过显存/RAM 预检(Wan 路由的 ensure_wan_vram,
    阈值语义独立),此处跳过避免重复拦截。
    hold_exc:调用方预检已失败(Wan 路由 ensure_wan_vram 的 503)且 hold 开关开时
    传入,直接转 hold 排队(engine=wan,放行时重跑 ensure_wan_vram);
    自身预检失败同理转 hold(engine=longcat)。见 services/hold_queue。
    """
    ensure_longcat_enabled()
    client = client or get_longcat_client()
    await ensure_longcat_ready(client)
    settings = get_settings()
    if hold_exc is not None:
        return hold_queue.place_hold(
            engine="wan", graph=graph, kind=kind, positive=positive, seed=seed,
            req=req, user=user, session=session, client=client,
            reason=str(hold_exc.detail),
            needs={
                "vram_gb": settings.wan_min_free_vram_gb,
                "ram_gb": settings.wan_min_free_ram_gb,
            },
            nsfw=nsfw,
        )
    if not prechecked:
        # 资源预算预检:LongCat 与 H3/Wan 共 GPU2、同宿主机 RAM(2026-08-21 OOM 防线)
        try:
            await ensure_vram(client, settings.longcat_min_free_vram_gb, "LongCat")
            await ensure_host_ram(client, settings.longcat_min_free_ram_gb, "LongCat")
        except HTTPException as e:
            # 资源预算二期:预检不足转 hold 排队(资源释放后自动放行);
            # 开关关闭维持一期 503 行为
            if hold_queue.holdable(e):
                return hold_queue.place_hold(
                    engine="longcat", graph=graph, kind=kind, positive=positive,
                    seed=seed, req=req, user=user, session=session, client=client,
                    reason=str(e.detail),
                    needs={
                        "vram_gb": settings.longcat_min_free_vram_gb,
                        "ram_gb": settings.longcat_min_free_ram_gb,
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
            nsfw=nsfw,
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
