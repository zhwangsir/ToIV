"""视频译制·智能剪辑工坊 —— 已有长视频的处理入口。

  POST /api/dub/upload        multipart(video) → 大文件流式落盘 → {name, url, size}
  GET  /api/dub/source/{name} 回服务上传的源视频(供前端预览 / 后端管线下载)

译制/剪辑全链路(自动剪辑 → 多语言配音 → 对口型 → 成片)都以这里上传的源视频为起点。
落盘到 /data/dub(与 /data/manju 同卷),后续 ffmpeg / ASR / 对口型直接读本地文件。
"""
from __future__ import annotations

import asyncio
import re
import shutil
import tempfile
import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from app.deps import get_current_user
from app.models import User
from app.ratelimit import enforce_generation_rate_limit

router = APIRouter()

_DUB_DIR = (
    Path("/data") / "dub"
    if Path("/data").is_dir()
    else Path(tempfile.gettempdir()) / "toiv-dub"
)
_MAX_BYTES = 600 * 1024 * 1024  # 600MB(~12 分钟 1080p 留余量)
_CHUNK = 1024 * 1024  # 1MB 流式分块,避免整片进内存
_EXT_OK = {".mp4", ".mov", ".webm", ".mkv"}
_NAME_RE = re.compile(r"^dub-[0-9a-f]{32}\.(mp4|mov|webm|mkv)$")


@router.post("/dub/upload")
async def dub_upload(
    video: UploadFile,
    user: User = Depends(get_current_user),
) -> dict[str, object]:
    enforce_generation_rate_limit(user)
    ext = Path(video.filename or "").suffix.lower()
    if ext not in _EXT_OK:
        raise HTTPException(
            status_code=400,
            detail=f"不支持的视频格式(仅 {', '.join(sorted(_EXT_OK))})",
        )

    _DUB_DIR.mkdir(parents=True, exist_ok=True)
    name = f"dub-{uuid.uuid4().hex}{ext}"
    dest = _DUB_DIR / name
    size = 0
    try:
        with dest.open("wb") as f:
            while chunk := await video.read(_CHUNK):
                size += len(chunk)
                if size > _MAX_BYTES:
                    raise HTTPException(status_code=413, detail="视频过大(上限 600MB)")
                f.write(chunk)
    except HTTPException:
        dest.unlink(missing_ok=True)
        raise
    except Exception as e:  # noqa: BLE001 — 落盘失败兜底清理
        dest.unlink(missing_ok=True)
        raise HTTPException(status_code=500, detail=f"保存失败:{e}") from e

    if size == 0:
        dest.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail="空文件")

    return {"name": name, "url": f"/api/dub/source/{name}", "size": size}


@router.get("/dub/source/{name}")
async def dub_source(
    name: str,
    user: User = Depends(get_current_user),
) -> FileResponse:
    if not _NAME_RE.match(name):
        raise HTTPException(status_code=400, detail="非法文件名")
    path = _DUB_DIR / name
    if not path.is_file():
        raise HTTPException(status_code=404, detail="源视频不存在")
    return FileResponse(path, media_type="video/mp4", filename=name)


# ── 自动化剪辑:把长视频按场景切 / 静音切句,得到带时间轴的片段 ────────────
# 纯 ffmpeg(场景检测 scene / 静音检测 silencedetect),无模型依赖。
# 产出的片段时间轴是后续逐句配音对齐、对口型分段、精剪重排的骨架。


async def _ffmpeg_stderr(args: list[str]) -> str:
    proc = await asyncio.create_subprocess_exec(
        "ffmpeg", "-hide_banner", *args,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.PIPE,
    )
    _, err = await proc.communicate()
    return err.decode("utf-8", "ignore")


async def _probe_duration(path: Path) -> float:
    proc = await asyncio.create_subprocess_exec(
        "ffprobe", "-v", "error", "-show_entries", "format=duration",
        "-of", "default=nw=1:nk=1", str(path),
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
    )
    out, _ = await proc.communicate()
    try:
        return float(out.decode().strip())
    except (ValueError, AttributeError):
        return 0.0


_PTS_RE = re.compile(r"pts_time:([0-9.]+)")
_SIL_END_RE = re.compile(r"silence_end:\s*([0-9.]+)")


async def _scene_cuts(path: Path, thr: float) -> list[float]:
    """场景切点:select 出场景跳变帧,showinfo 打 pts_time。"""
    err = await _ffmpeg_stderr([
        "-i", str(path), "-filter:v", f"select='gt(scene,{thr})',showinfo",
        "-f", "null", "-",
    ])
    return [float(m) for m in _PTS_RE.findall(err)]


async def _silence_cuts(path: Path, noise_db: float, min_sil: float) -> list[float]:
    """静音结束点 = 下一句开始,作为切句点。"""
    err = await _ffmpeg_stderr([
        "-i", str(path), "-af", f"silencedetect=noise={noise_db}dB:d={min_sil}",
        "-f", "null", "-",
    ])
    return [float(m) for m in _SIL_END_RE.findall(err)]


def _build_segments(cuts: list[float], duration: float, min_seg: float) -> list[dict]:
    """切点 → 片段;过短的并入下一段,保证每段 ≥ min_seg。"""
    points = [0.0] + sorted(c for c in cuts if 0.0 < c < duration) + [duration]
    segs: list[dict] = []
    i = 0
    while i < len(points) - 1:
        start = points[i]
        j = i + 1
        end = points[j]
        while end - start < min_seg and j < len(points) - 1:
            j += 1
            end = points[j]
        segs.append({
            "index": len(segs),
            "start": round(start, 3),
            "end": round(end, 3),
            "duration": round(end - start, 3),
        })
        i = j
    return segs


class AutoCutRequest(BaseModel):
    name: str = Field(min_length=1, max_length=200)  # /dub/upload 返回的 name
    mode: str = Field(default="scene")  # scene(场景切) / silence(静音切句)
    threshold: float = Field(default=0.4)  # scene:0~1 灵敏度 / silence:噪声(传正数,内部取负 dB)
    min_seg: float = Field(default=1.5, ge=0.2, le=60.0)


@router.post("/dub/autocut")
async def dub_autocut(
    body: AutoCutRequest,
    user: User = Depends(get_current_user),
) -> dict[str, object]:
    enforce_generation_rate_limit(user)
    if shutil.which("ffmpeg") is None:
        raise HTTPException(status_code=500, detail="服务端未安装 ffmpeg")
    if not _NAME_RE.match(body.name):
        raise HTTPException(status_code=400, detail="非法文件名")
    path = _DUB_DIR / body.name
    if not path.is_file():
        raise HTTPException(status_code=404, detail="源视频不存在")

    duration = await _probe_duration(path)
    if duration <= 0:
        raise HTTPException(status_code=422, detail="无法读取视频时长")

    if body.mode == "silence":
        cuts = await _silence_cuts(path, -abs(body.threshold or 30.0), 0.5)
    else:
        thr = min(max(body.threshold, 0.05), 0.95)
        cuts = await _scene_cuts(path, thr)

    segments = _build_segments(cuts, duration, body.min_seg)
    return {
        "segments": segments,
        "count": len(segments),
        "source_duration": round(duration, 3),
        "mode": body.mode,
    }
