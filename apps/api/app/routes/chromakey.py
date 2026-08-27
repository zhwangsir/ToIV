"""POST /api/video/chromakey —— 绿幕抠像合成(数字人 M6)。

M1 形象库(ReferenceAsset kind=avatar)的 green_screen 标记数字人产出绿幕视频
(avatar-talk/LongCat),本端点把绿幕抠掉后叠加到任意背景(纯色/图片),
让绿幕形象可直接进二创场景。借鉴 aigcpanel 绿幕形象用法。

链路:前景 URL(作品库产物 /api/images 或本地产物,复用 video_upscale 的
来源白名单 + 归属校验)→ 下载 → ffprobe 验视频 → ffmpeg chromakey+overlay
(背景图 loop 输入按前景时长裁剪)→ mp4 落 content_subdir("chromakey")
→ Job(kind=chromakey, status=done) 建档 → 返回 {job_id, url}。

ffmpeg 封装/错误风格复用 services.studio.ffmpeg_ops(ensure_ffmpeg/run_ffmpeg,
FFmpegError 带 stderr 尾部);同步执行(单遍滤镜,秒级),不挂后台管线。
产物由本路由 /video/chromakey/output/{name} 服务(Range),与 video_upscale
产物服务端点同口径,不经 /api/images worker 代理。
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import shutil
import tempfile
import uuid
from pathlib import Path
from typing import Literal

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response
from pydantic import BaseModel, Field, field_validator
from sqlmodel import Session

from app.db import get_session
from app.deps import get_current_user
from app.models import Job, User
from app.ratelimit import enforce_generation_rate_limit
from app.routes.audio_orchestrate import _allowed_source, _check_redirect, _resolve_url
from app.routes.images import _ranged_response
from app.services import video_upscale as upscale_svc
from app.services.studio.ffmpeg_ops import FFmpegError, ensure_ffmpeg, run_ffmpeg
from app.storage import content_subdir
from app.versioning import params_snapshot

logger = logging.getLogger(__name__)

router = APIRouter()

_OUT_NAME_RE = re.compile(r"^chromakey-[0-9a-f]{32}\.mp4$")
# ffmpeg 颜色字面量:0xRRGGBB 或命名色(black/green/...),防 filtergraph 注入
_KEY_COLOR_RE = re.compile(r"^0x[0-9a-fA-F]{6}$")
_BG_COLOR_RE = re.compile(r"^(0x[0-9a-fA-F]{6}|[a-zA-Z]{2,20})$")
_FPS_RE = re.compile(r"^[0-9]+(/[0-9]+)?$")
_MAX_BG_BYTES = 20 * 1024 * 1024  # 背景图上限 20MB(防内存撑爆,同 audio_orchestrate 纪律)
_BG_TIMEOUT = 60.0
_FF_TIMEOUT = 600.0  # 单遍滤镜,秒级~分钟级;600s 兜底长片

# 常见图片魔数(背景图合法性校验;非图早 400,不落进 ffmpeg 变 500)
_IMG_MAGIC = (
    b"\x89PNG\r\n\x1a\n",  # png
    b"\xff\xd8\xff",  # jpeg
    b"GIF87a",
    b"GIF89a",
    b"BM",  # bmp
    b"RIFF",  # webp(RIFF....WEBP,粗判即可,ffmpeg 终裁)
)


class ChromakeyRequest(BaseModel):
    """绿幕抠像请求:foreground_url 为绿幕视频(作品库产物 URL);
    背景二选一:color(纯色,默认黑)或 image(背景图 URL,白名单来源)。"""

    foreground_url: str = Field(min_length=1, max_length=2048)
    background_type: Literal["image", "color"] = "color"
    background_url: str | None = Field(default=None, max_length=2048)
    background_color: str = Field(default="black", max_length=24)
    key_color: str = Field(default="0x00FF00", max_length=8)
    similarity: float = Field(default=0.18, ge=0.01, le=1.0)
    blend: float = Field(default=0.08, ge=0.0, le=1.0)

    @field_validator("key_color")
    @classmethod
    def _v_key_color(cls, v: str) -> str:
        if not _KEY_COLOR_RE.fullmatch(v):
            raise ValueError("key_color 须为 0xRRGGBB(如 0x00FF00)")
        return "0x" + v[2:].upper()

    @field_validator("background_color")
    @classmethod
    def _v_bg_color(cls, v: str) -> str:
        if not _BG_COLOR_RE.fullmatch(v):
            raise ValueError("background_color 须为颜色名或 0xRRGGBB")
        return v


def product_root() -> Path:
    """抠像产物根目录(content_dir/chromakey;prod 可指 NAS 挂载点)。"""
    return content_subdir("chromakey")


async def _probe_video(path: Path) -> dict[str, object]:
    """ffprobe 探测前景视频:width/height/rate(供纯色画布/背景图缩放)。

    非视频(探测失败或无视频流)→ 400;ffprobe 缺失 → 500。
    """
    if shutil.which("ffprobe") is None:
        raise HTTPException(status_code=500, detail="服务端缺少 ffprobe,无法校验前景视频")
    proc = await asyncio.create_subprocess_exec(
        "ffprobe", "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=width,height,r_frame_rate",
        "-of", "json", str(path),
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    out, _ = await proc.communicate()
    if proc.returncode != 0:
        raise HTTPException(status_code=400, detail="前景不是有效视频文件")
    try:
        stream = (json.loads(out).get("streams") or [])[0]
        width, height = int(stream["width"]), int(stream["height"])
    except (IndexError, KeyError, TypeError, ValueError):
        raise HTTPException(status_code=400, detail="前景不是有效视频文件") from None
    rate = str(stream.get("r_frame_rate") or "25/1")
    if not _FPS_RE.fullmatch(rate):
        rate = "25/1"
    return {"width": width, "height": height, "rate": rate}


def build_chromakey_cmd(
    fg: Path,
    out: Path,
    *,
    width: int,
    height: int,
    rate: str,
    key_color: str,
    similarity: float,
    blend: float,
    background_type: str,
    background_color: str = "black",
    background_path: Path | None = None,
) -> list[str]:
    """构造抠像合成 ffmpeg 命令(纯函数,单测直接断言滤镜串)。

    图像背景:-loop 1 图片输入缩放到前景尺寸(充满裁边),overlay shortest=1
    按前景时长裁剪;纯色背景:lavfi color 画布同尺寸同帧率。
    音轨透传前景(数字人 TTS 对白),无音轨则静音出片。
    """
    key = f"chromakey={key_color}:{similarity:g}:{blend:g}"
    cmd = ["ffmpeg", "-y"]
    if background_type == "image":
        assert background_path is not None
        cmd += ["-loop", "1", "-framerate", rate, "-i", str(background_path)]
        cmd += ["-i", str(fg)]
        filters = (
            f"[1:v]{key}[keyed];"
            f"[0:v]scale={width}:{height}:force_original_aspect_ratio=increase,"
            f"crop={width}:{height}[bg];"
            f"[bg][keyed]overlay=shortest=1[out]"
        )
        audio_map = "1:a?"
    else:
        cmd += ["-i", str(fg)]
        cmd += ["-f", "lavfi", "-i", f"color=c={background_color}:s={width}x{height}:r={rate}"]
        filters = f"[0:v]{key}[keyed];[1:v][keyed]overlay=shortest=1[out]"
        audio_map = "0:a?"
    cmd += [
        "-filter_complex", filters,
        "-map", "[out]", "-map", audio_map,
        "-c:v", "libx264", "-preset", "medium", "-crf", "18",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "192k",
        "-shortest", "-movflags", "+faststart",
        str(out),
    ]
    return cmd


async def _download_background(client: httpx.AsyncClient, url: str, dest: Path) -> None:
    """下载背景图(白名单已校验):失败/超大/非图 → 400。"""
    resolved = _resolve_url(url)
    try:
        rr = await client.get(resolved)
        _check_redirect(rr, resolved)
        rr.raise_for_status()
    except httpx.HTTPError as e:
        raise HTTPException(status_code=400, detail=f"背景图下载失败:{e}") from e
    if len(rr.content) > _MAX_BG_BYTES:
        raise HTTPException(status_code=413, detail="背景图过大(上限 20MB)")
    if not rr.content or not any(rr.content.startswith(m) for m in _IMG_MAGIC):
        raise HTTPException(status_code=400, detail="背景不是有效图片文件")
    dest.write_bytes(rr.content)


@router.post("/video/chromakey")
async def chromakey_compose(
    body: ChromakeyRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict[str, object]:
    """绿幕抠像合成:前景绿幕视频 + 纯色/图片背景 → mp4 产物(同步,秒级)。

    错误纪律:背景图类型必填缺失/下载失败/非图 400;前景来源非法 422、
    无归属 404、R18 无专区上下文 403、下载失败/非视频 400;
    ffmpeg 缺失/失败 500(detail 带 stderr 尾部)。
    """
    enforce_generation_rate_limit(user)
    if body.background_type == "image":
        if not body.background_url or not body.background_url.strip():
            raise HTTPException(status_code=400, detail="background_type=image 需提供 background_url")
        if not _allowed_source(body.background_url.strip()):
            raise HTTPException(status_code=400, detail="背景图来源不在白名单内")

    # 前景来源白名单 + 归属校验(继承源 nsfw 标记;404/403/422 由 helper 抛出)
    job_nsfw = upscale_svc.resolve_source_ownership(session, user, body.foreground_url.strip())

    name = f"chromakey-{uuid.uuid4().hex}.mp4"
    out_path = product_root() / name
    with tempfile.TemporaryDirectory() as td:
        fg_path = Path(td) / "fg.mp4"
        try:
            await upscale_svc._fetch_source_local(body.foreground_url.strip(), fg_path)
        except HTTPException:
            raise
        except Exception as e:  # VideoUpscaleError 等下载失败 → 400(客户端源问题)
            raise HTTPException(status_code=400, detail=f"前景视频下载失败:{e}") from e
        meta = await _probe_video(fg_path)

        bg_path: Path | None = None
        if body.background_type == "image":
            bg_path = Path(td) / "bg.img"
            async with httpx.AsyncClient(
                timeout=_BG_TIMEOUT, follow_redirects=True, trust_env=False
            ) as client:
                await _download_background(client, body.background_url.strip(), bg_path)

        try:
            ensure_ffmpeg()
            product_root().mkdir(parents=True, exist_ok=True)
            cmd = build_chromakey_cmd(
                fg_path, out_path,
                width=int(meta["width"]), height=int(meta["height"]),
                rate=str(meta["rate"]),
                key_color=body.key_color,
                similarity=body.similarity, blend=body.blend,
                background_type=body.background_type,
                background_color=body.background_color,
                background_path=bg_path,
            )
            await run_ffmpeg(cmd, timeout=_FF_TIMEOUT)
        except FFmpegError as e:
            raise HTTPException(status_code=500, detail=str(e)) from e
        except OSError as e:
            raise HTTPException(status_code=500, detail=f"产物目录不可写:{e}") from e

    if not out_path.is_file() or out_path.stat().st_size == 0:
        raise HTTPException(status_code=500, detail="ffmpeg 未产出成片")
    url = f"/api/video/chromakey/output/{name}"

    # 建档(同 audio_orchestrate 纪律:产物已落盘,建档失败不炸主流程)
    job_id: str | None = None
    try:
        job = Job(
            tenant_id=user.tenant_id,
            user_id=user.id,
            prompt_id=f"chromakey-{uuid.uuid4().hex}",
            worker="local",
            kind="chromakey",
            status="done",
            prompt=f"绿幕抠像合成(key={body.key_color} sim={body.similarity:g} blend={body.blend:g})",
            seed=0,
            nsfw=job_nsfw,
            result=json.dumps([url], ensure_ascii=False),
            params=params_snapshot(body),
        )
        session.add(job)
        session.commit()
        session.refresh(job)
        job_id = job.id
    except Exception:
        session.rollback()
        logger.warning("抠像产物建档失败(视频已落盘 %s)", name, exc_info=True)

    return {"job_id": job_id, "url": url, "kind": "chromakey"}


@router.get("/video/chromakey/output/{name}")
async def chromakey_output(
    name: str,
    request: Request,
    user: User = Depends(get_current_user),  # <video> 走 ?token= 查询参数(deps 内置回退)
) -> Response:
    """回读抠像产物(手动 Range,同 audio_orchestrate 文件服务)。"""
    if not _OUT_NAME_RE.fullmatch(name):
        raise HTTPException(status_code=400, detail="非法文件名")
    path = product_root() / name
    if not path.is_file():
        raise HTTPException(status_code=404, detail="产物不存在")
    return _ranged_response(path.read_bytes(), "video/mp4", request.headers.get("range"))
