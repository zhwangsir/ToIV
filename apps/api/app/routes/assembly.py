"""POST /api/manju/assemble —— 漫剧自动剪辑:把每镜视频片段拼成成片。

漫剧每镜先出图、再"关键帧转视频"得到一个视频片段(videoUrl)。本端点把这些
片段按顺序下载到临时目录,用 ffmpeg 拼接成一条 mp4,可选:转场(crossfade)、
烧录字幕(每镜文案)、混入 BGM。产出落到 /data 下,再由 GET /api/manju/output/{name}
取回。

健壮性:
- clip URL 仅允许指向本 API(相对路径或同源)或白名单 worker,防 SSRF。
- 任一 clip 下载失败 / ffmpeg 非零退出 → 抛清晰错误,不静默吞。
"""
from __future__ import annotations

import asyncio
import re
import shutil
import tempfile
import uuid
from pathlib import Path
from urllib.parse import urlsplit

import httpx
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from app.config import get_settings
from app.deps import get_current_user
from app.models import User
from app.ratelimit import enforce_generation_rate_limit

router = APIRouter()

# 成片输出目录:容器挂了 toiv-data:/data;无 /data(本地)则回落到临时目录。
_OUTPUT_DIR = (
    Path("/data") / "manju"
    if Path("/data").is_dir()
    else Path(tempfile.gettempdir()) / "toiv-manju"
)

_TRANSITIONS = {"none", "crossfade"}
_OUTPUT_NAME_RE = re.compile(r"^manju-[0-9a-f]{32}\.mp4$")
_DEFAULT_FPS = 16
_CROSSFADE_SEC = 0.5  # 相邻片段交叠时长
_CLIP_EST_SEC = 2.0  # xfade offset 估计:每片段约 2s(漫剧片段普遍偏短)
_DOWNLOAD_TIMEOUT = 120.0
_LOCAL_API_BASE = "http://127.0.0.1:8080"


class AssembleOptions(BaseModel):
    transition: str = Field(default="none")
    bgm_url: str | None = Field(default=None, max_length=2000)
    subtitles: list[str] = Field(default_factory=list)
    fps: int = Field(default=_DEFAULT_FPS, ge=1, le=60)


class AssembleRequest(BaseModel):
    clips: list[str] = Field(min_length=1, max_length=48)
    # 逐镜配音 URL,与 clips 对齐(空串=该镜无配音);成片时对齐混入对白轨。
    voice_urls: list[str] = Field(default_factory=list, max_length=48)
    options: AssembleOptions = Field(default_factory=AssembleOptions)


class AssembleResponse(BaseModel):
    url: str
    name: str


def _is_allowed_clip(url: str) -> bool:
    """clip 来源白名单:相对路径(本 API)或同源 / 白名单 worker host,防 SSRF。"""
    if url.startswith("/"):
        return True
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https"):
        return False
    host = parts.hostname or ""
    settings = get_settings()
    allowed_hosts = {
        urlsplit(w).hostname for w in settings.worker_urls if urlsplit(w).hostname
    }
    # 同源(经反代回到本 API)也允许:本 API 的图片代理 /api/images 会带 host。
    return host in allowed_hosts or host in {"127.0.0.1", "localhost"}


def _resolve_clip_url(url: str) -> str:
    """相对路径补全成可下载的绝对 URL(指回本 API 自身)。"""
    if url.startswith("http://") or url.startswith("https://"):
        return url
    if url.startswith("/"):
        return _LOCAL_API_BASE + url
    return f"{_LOCAL_API_BASE}/{url}"


async def _download_clip(client: httpx.AsyncClient, url: str, dest: Path) -> None:
    try:
        resp = await client.get(_resolve_clip_url(url))
        resp.raise_for_status()
    except httpx.HTTPError as e:
        raise HTTPException(
            status_code=502, detail=f"片段下载失败:{url}({e})"
        ) from e
    if not resp.content:
        raise HTTPException(status_code=502, detail=f"片段为空:{url}")
    dest.write_bytes(resp.content)


async def _probe_duration(path: Path) -> float:
    """ffprobe 测片段实际时长(秒),供逐镜配音偏移对齐;失败回落估计值。"""
    if shutil.which("ffprobe") is None:
        return _CLIP_EST_SEC
    proc = await asyncio.create_subprocess_exec(
        "ffprobe", "-v", "error", "-show_entries", "format=duration",
        "-of", "default=nw=1:nk=1", str(path),
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    out, _ = await proc.communicate()
    try:
        return float(out.decode().strip())
    except (ValueError, AttributeError):
        return _CLIP_EST_SEC


def _escape_drawtext(text: str) -> str:
    """转义 drawtext 文案里的特殊字符(ffmpeg 滤镜语法敏感)。"""
    return (
        text.replace("\\", "\\\\")
        .replace(":", "\\:")
        .replace("'", "’")  # 单引号在 filtergraph 里难转义,直接换成排版引号
        .replace("%", "\\%")
        .replace("[", "\\[")
        .replace("]", "\\]")
        .replace(",", "\\,")
        .replace(";", "\\;")
        .replace("\n", " ")
    )


def _subtitle_filter(text: str) -> str:
    """单镜烧录字幕:底部居中、半透明描边盒。"""
    safe = _escape_drawtext(text.strip())
    if not safe:
        return ""
    return (
        "drawtext=text='" + safe + "'"
        ":fontcolor=white:fontsize=28:line_spacing=6"
        ":box=1:boxcolor=black@0.45:boxborderw=14"
        ":x=(w-text_w)/2:y=h-text_h-40"
    )


def _build_ffmpeg_command(
    clips: list[Path],
    options: AssembleOptions,
    bgm: Path | None,
    voices: list[Path | None],
    durations: list[float],
    out: Path,
) -> list[str]:
    """构造 ffmpeg 命令。

    - 字幕:逐 clip drawtext。
    - 转场 none:用 concat 滤镜首尾相接;crossfade:用 xfade 链式交叠。
    - 音频:有配音则逐镜按片段起始偏移 adelay 对齐成对白轨,叠可选 BGM(降音垫底)amix;
      无配音仅 BGM 时沿用原单轨逻辑(漫剧片段普遍无声)。
    """
    has_voice = any(v is not None for v in voices)
    cmd: list[str] = ["ffmpeg", "-y"]
    for clip in clips:
        cmd += ["-i", str(clip)]
    bgm_idx = len(clips)
    if bgm is not None:
        cmd += ["-i", str(bgm)]
    # 配音输入排在 clips(+BGM)之后,记录每个 present 配音的 (镜序, 输入索引)
    voice_inputs: list[tuple[int, int]] = []
    _next_idx = len(clips) + (1 if bgm is not None else 0)
    for i, vp in enumerate(voices):
        if vp is not None:
            cmd += ["-i", str(vp)]
            voice_inputs.append((i, _next_idx))
            _next_idx += 1

    subs = options.subtitles
    filters: list[str] = []
    # 每镜先 fps 归一 + 像素格式标准化 + 可选烧字幕,产出 [vN]
    vlabels: list[str] = []
    for i in range(len(clips)):
        chain = [f"fps={options.fps}", "format=yuv420p"]
        sub = _subtitle_filter(subs[i]) if i < len(subs) and subs[i].strip() else ""
        if sub:
            chain.append(sub)
        label = f"v{i}"
        filters.append(f"[{i}:v]" + ",".join(chain) + f"[{label}]")
        vlabels.append(label)

    if options.transition == "crossfade" and len(clips) > 1:
        prev = vlabels[0]
        offset = 0.0
        for i in range(1, len(clips)):
            out_label = f"xf{i}"
            # offset 近似:每片段约 _CLIP_EST_SEC,交叠落在上一段尾部。
            offset += _CLIP_EST_SEC - _CROSSFADE_SEC
            filters.append(
                f"[{prev}][{vlabels[i]}]xfade=transition=fade"
                f":duration={_CROSSFADE_SEC}:offset={max(offset, 0.1):.2f}[{out_label}]"
            )
            prev = out_label
        vout = prev
    elif len(clips) > 1:
        concat_inputs = "".join(f"[{label}]" for label in vlabels)
        filters.append(f"{concat_inputs}concat=n={len(clips)}:v=1:a=0[vout]")
        vout = "vout"
    else:
        vout = vlabels[0]

    # ---- 音频:逐镜配音对齐 + 可选 BGM ----
    aout: str | None = None
    if has_voice:
        offsets: list[float] = []
        acc = 0.0
        for d in durations:
            offsets.append(acc)
            acc += d
        total = acc or _CLIP_EST_SEC
        dia_labels: list[str] = []
        for clip_i, in_idx in voice_inputs:
            off_ms = int(offsets[clip_i] * 1000) if clip_i < len(offsets) else 0
            lbl = f"d{clip_i}"
            # 延迟到该镜起始 + 统一声道布局,便于 amix
            filters.append(
                f"[{in_idx}:a]adelay={off_ms}|{off_ms},aformat=channel_layouts=stereo[{lbl}]"
            )
            dia_labels.append(f"[{lbl}]")
        mix_labels = list(dia_labels)
        if bgm is not None:
            filters.append(f"[{bgm_idx}:a]volume=0.35,aformat=channel_layouts=stereo[bg]")
            mix_labels.append("[bg]")
        if len(mix_labels) == 1:
            filters.append(f"{mix_labels[0]}apad,atrim=0:{total:.2f}[aout]")
        else:
            filters.append(
                f"{''.join(mix_labels)}amix=inputs={len(mix_labels)}:normalize=0:dropout_transition=0[mix];"
                f"[mix]apad,atrim=0:{total:.2f}[aout]"
            )
        aout = "aout"

    cmd += ["-filter_complex", ";".join(filters), "-map", f"[{vout}]"]

    if aout is not None:
        cmd += ["-map", f"[{aout}]"]
    elif bgm is not None:
        cmd += ["-map", f"{bgm_idx}:a", "-shortest"]

    cmd += [
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-r",
        str(options.fps),
        "-movflags",
        "+faststart",
    ]
    if aout is not None or bgm is not None:
        cmd += ["-c:a", "aac", "-b:a", "192k"]
    cmd.append(str(out))
    return cmd


async def _run_ffmpeg(cmd: list[str]) -> None:
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    _, stderr = await proc.communicate()
    if proc.returncode != 0:
        tail = (stderr or b"").decode("utf-8", "replace")[-800:]
        raise HTTPException(status_code=500, detail=f"合成失败(ffmpeg):{tail}")


@router.post("/manju/assemble", response_model=AssembleResponse)
async def assemble_manju(
    body: AssembleRequest,
    user: User = Depends(get_current_user),
) -> AssembleResponse:
    enforce_generation_rate_limit(user)

    if body.options.transition not in _TRANSITIONS:
        raise HTTPException(status_code=422, detail="未知的转场类型")
    for clip in body.clips:
        if not _is_allowed_clip(clip):
            raise HTTPException(status_code=400, detail="片段来源不在白名单内")
    if body.options.bgm_url and not _is_allowed_clip(body.options.bgm_url):
        raise HTTPException(status_code=400, detail="BGM 来源不在白名单内")
    for v in body.voice_urls:
        if v and not _is_allowed_clip(v):
            raise HTTPException(status_code=400, detail="配音来源不在白名单内")

    if shutil.which("ffmpeg") is None:
        raise HTTPException(status_code=500, detail="服务端未安装 ffmpeg")

    _OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    name = f"manju-{uuid.uuid4().hex}.mp4"
    out_path = _OUTPUT_DIR / name

    with tempfile.TemporaryDirectory(prefix="manju-asm-") as tmp:
        tmp_dir = Path(tmp)
        clip_paths: list[Path] = []
        voice_paths: list[Path | None] = [None] * len(body.clips)
        async with httpx.AsyncClient(
            timeout=_DOWNLOAD_TIMEOUT, follow_redirects=True
        ) as client:
            for i, url in enumerate(body.clips):
                dest = tmp_dir / f"clip-{i:03d}.mp4"
                await _download_clip(client, url, dest)
                clip_paths.append(dest)

            bgm_path: Path | None = None
            if body.options.bgm_url:
                bgm_path = tmp_dir / "bgm.audio"
                await _download_clip(client, body.options.bgm_url, bgm_path)

            # 逐镜配音(与 clips 对齐;空串=该镜无配音)
            for i, vurl in enumerate(body.voice_urls[: len(body.clips)]):
                if vurl:
                    vdest = tmp_dir / f"voice-{i:03d}.wav"
                    await _download_clip(client, vurl, vdest)
                    voice_paths[i] = vdest

        durations = [await _probe_duration(p) for p in clip_paths]
        cmd = _build_ffmpeg_command(
            clip_paths, body.options, bgm_path, voice_paths, durations, out_path
        )
        await _run_ffmpeg(cmd)

    if not out_path.exists() or out_path.stat().st_size == 0:
        raise HTTPException(status_code=500, detail="合成产物为空")

    return AssembleResponse(url=f"/api/manju/output/{name}", name=name)


@router.get("/manju/output/{name}")
async def get_manju_output(
    name: str,
    user: User = Depends(get_current_user),
) -> FileResponse:
    if not _OUTPUT_NAME_RE.match(name):
        raise HTTPException(status_code=400, detail="非法文件名")
    path = _OUTPUT_DIR / name
    if not path.is_file():
        raise HTTPException(status_code=404, detail="成片不存在")
    return FileResponse(
        path,
        media_type="video/mp4",
        filename=name,
        headers={"Cache-Control": "public, max-age=86400"},
    )
