"""动态分镜(animatic)—— N 张静态分镜图 + 每张时长 → 串成一条 MP4。

  POST /api/animatic                 multipart(images[] + durations JSON + fps/width/height)
                                     → 图片落 NAS imports → ssh workstation 跑 ffmpeg → {job_id, url, ...}
  GET  /api/animatic/output/{name}   回成片(白名单文件名 ^[a-z0-9]{12}\\.mp4$,NAS outputs/animatic)

算力边界(AGENTS.md 第七节):core 只跑应用层,ffmpeg 一律 ssh 到 workstation 执行。
两侧经同一 NAS 共享盘交换文件,路径按挂载点换算:
  core        /mnt/toiv-nas/toiv/{imports,outputs}/animatic
  workstation /home/merlin/nas_mount/toiv/{imports,outputs}/animatic
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import shlex
import shutil
import subprocess
import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse

from app.deps import get_current_user
from app.models import User
from app.ratelimit import enforce_generation_rate_limit

logger = logging.getLogger(__name__)

router = APIRouter()

# ── 路径与执行目标(env 可覆盖;测试 monkeypatch 模块常量到 tmp_path)──
_IMPORT_DIR = Path(os.environ.get("TOIV_ANIMATIC_IMPORT_DIR", "/mnt/toiv-nas/toiv/imports/animatic"))
_OUTPUT_DIR = Path(os.environ.get("TOIV_ANIMATIC_OUTPUT_DIR", "/mnt/toiv-nas/toiv/outputs/animatic"))
_WS_IMPORT_DIR = os.environ.get("TOIV_ANIMATIC_WS_IMPORT_DIR", "/home/merlin/nas_mount/toiv/imports/animatic")
_WS_OUTPUT_DIR = os.environ.get("TOIV_ANIMATIC_WS_OUTPUT_DIR", "/home/merlin/nas_mount/toiv/outputs/animatic")
_SSH_TARGET = os.environ.get("TOIV_ANIMATIC_SSH_TARGET", "merlin@192.168.71.127")

_FFMPEG_TIMEOUT = 300  # 静帧串接很轻,300s 足够 20 张 1080p
_MAX_IMAGES = 20
_MAX_BYTES = 20 * 1024 * 1024  # 单张 ≤ 20MB
_CHUNK = 1024 * 1024
_EXT_OK = {".jpg", ".jpeg", ".png", ".webp"}
_OUT_RE = re.compile(r"^[a-z0-9]{12}\.mp4$")


# ────────────────────────────────
# ffmpeg 命令构造(纯函数,单测覆盖)
# ────────────────────────────────

def _fmt_sec(d: float) -> str:
    """时长格式化成 ffmpeg -t 接受的紧凑秒数(3.0 → "3",2.5 → "2.5")。"""
    s = f"{d:.3f}".rstrip("0").rstrip(".")
    return s or "0"


def _build_ffmpeg_cmd(
    image_paths: list[str],
    durations: list[float],
    fps: int,
    width: int,
    height: int,
    out_path: str,
) -> str:
    """构造 workstation 侧单条 ffmpeg shell 命令(经 ssh 远端 bash 执行)。

    每张图 -loop 1 -t {dur} 循环成片段;scale(保比缩小)+ pad(黑边居中)统一到
    {width}x{height},fps/format/setsar 归一后 concat 串接;h264 + yuv420p + faststart。
    """
    parts: list[str] = ["ffmpeg", "-hide_banner", "-loglevel", "error"]
    for p, d in zip(image_paths, durations):
        parts += ["-loop", "1", "-t", _fmt_sec(d), "-i", shlex.quote(p)]

    filters = [
        f"[{i}:v]scale={width}:{height}:force_original_aspect_ratio=decrease,"
        f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=black,"
        f"fps={fps},format=yuv420p,setsar=1[v{i}]"
        for i in range(len(image_paths))
    ]
    filters.append(
        "".join(f"[v{i}]" for i in range(len(image_paths)))
        + f"concat=n={len(image_paths)}:v=1:a=0[outv]"
    )
    parts += [
        "-filter_complex", shlex.quote(";".join(filters)),
        "-map", shlex.quote("[outv]"),
        "-c:v", "libx264", "-preset", "medium", "-crf", "18",
        "-pix_fmt", "yuv420p", "-movflags", "+faststart",
        "-y", shlex.quote(out_path),
    ]
    return " ".join(parts)


_active_ffmpeg: dict[str, subprocess.Popen] = {}
_killed_ffmpeg: set[str] = set()


def kill_animatic_ffmpeg(job_id: str) -> None:
    """断开客户端时杀掉 ssh/ffmpeg(Popen 句柄)。"""
    if job_id:
        _killed_ffmpeg.add(job_id)
    proc = _active_ffmpeg.get(job_id)
    if proc is not None and proc.poll() is None:
        proc.kill()


def _run_ffmpeg(remote_cmd: str, job_id: str = "") -> None:
    """ssh 到 workstation 执行 ffmpeg(core 禁跑算力负载,AGENTS.md 第七节)。

    失败抛 HTTPException(502),stderr 尾 500 字符随 detail 返回,便于排障。
    job_id 非空时登记 Popen,供客户端断开时 kill。
    """
    try:
        proc = subprocess.Popen(
            [
                "ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10",
                _SSH_TARGET, remote_cmd,
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            start_new_session=True,
        )
    except OSError as e:
        raise HTTPException(status_code=502, detail=f"ffmpeg 执行失败:{e}") from e
    if job_id:
        _active_ffmpeg[job_id] = proc
    try:
        try:
            _stdout, stderr = proc.communicate(timeout=_FFMPEG_TIMEOUT)
        except subprocess.TimeoutExpired as e:
            proc.kill()
            raise HTTPException(
                status_code=502, detail=f"ffmpeg 执行超时({_FFMPEG_TIMEOUT}s)"
            ) from e
        if job_id in _killed_ffmpeg:
            raise HTTPException(status_code=400, detail="已中止")
        if proc.returncode != 0:
            tail = (stderr or "")[-500:]
            raise HTTPException(status_code=502, detail=f"ffmpeg 执行失败:{tail}")
    finally:
        _active_ffmpeg.pop(job_id, None)
        _killed_ffmpeg.discard(job_id)


# ────────────────────────────────
# 上传校验
# ────────────────────────────────

def _check_filename(name: str | None) -> str:
    """校验上传文件名并返回规范化扩展名;非法一律 422。

    落盘文件名由服务端按序号生成(001.jpg...),用户文件名仅用于判断格式,
    但仍拒绝路径分隔符/`..` 穿越企图,安全语义显式化。
    """
    if not name:
        raise HTTPException(status_code=422, detail="缺少文件名")
    if "/" in name or "\\" in name or ".." in name:
        raise HTTPException(status_code=422, detail="非法文件名(禁止路径穿越)")
    ext = Path(name).suffix.lower()
    if ext not in _EXT_OK:
        raise HTTPException(
            status_code=422,
            detail=f"不支持的图片格式(仅 {', '.join(sorted(_EXT_OK))})",
        )
    return ext


def _parse_durations(raw: str, count: int) -> list[float]:
    """解析 durations JSON 数组:长度须与图片一致,每项 0.5-30 秒。"""
    try:
        data = json.loads(raw)
    except ValueError:
        raise HTTPException(status_code=422, detail="durations 必须是 JSON 数组") from None
    if not isinstance(data, list) or len(data) != count:
        raise HTTPException(
            status_code=422,
            detail=f"durations 数量({len(data) if isinstance(data, list) else '非数组'})须与图片数量({count})一致",
        )
    out: list[float] = []
    for d in data:
        if isinstance(d, bool) or not isinstance(d, (int, float)):
            raise HTTPException(status_code=422, detail="durations 每项必须是数字(秒)")
        v = float(d)
        if not 0.5 <= v <= 30:  # nan/inf 比较恒 False,一并被拦
            raise HTTPException(status_code=422, detail="每镜时长须在 0.5-30 秒之间")
        out.append(v)
    return out


def _even(v: int) -> int:
    """h264/yuv420p 要求偶数尺寸:奇数向下取偶。"""
    return v - v % 2


# ────────────────────────────────
# 路由
# ────────────────────────────────

@router.post("/animatic")
async def create_animatic(
    images: list[UploadFile] = File(...),
    durations: str = Form(...),
    fps: int = Form(24),
    width: int = Form(1920),
    height: int = Form(1080),
    user: User = Depends(get_current_user),
    request: Request = None  # FastAPI 注入;勿标 Optional 否则当 Pydantic 字段,
) -> dict[str, object]:
    enforce_generation_rate_limit(user)

    if not 1 <= len(images) <= _MAX_IMAGES:
        raise HTTPException(
            status_code=422, detail=f"图片数量须在 1-{_MAX_IMAGES} 张之间"
        )
    durs = _parse_durations(durations, len(images))
    if not 12 <= fps <= 60:
        raise HTTPException(status_code=422, detail="fps 须在 12-60 之间")
    if not 256 <= width <= 4096 or not 256 <= height <= 4096:
        raise HTTPException(status_code=422, detail="分辨率须在 256-4096 之间")
    width, height = _even(width), _even(height)

    job_id = uuid.uuid4().hex[:12]
    job_dir = _IMPORT_DIR / job_id

    # 1) 图片按上传顺序编号落 NAS(core 侧路径);NAS 不可达 → 503
    saved_names: list[str] = []
    try:
        job_dir.mkdir(parents=True, exist_ok=True)
        for idx, image in enumerate(images, start=1):
            ext = _check_filename(image.filename)
            name = f"{idx:03d}{ext}"
            dest = job_dir / name
            size = 0
            too_big = False
            with dest.open("wb") as f:
                while chunk := await image.read(_CHUNK):
                    size += len(chunk)
                    if size > _MAX_BYTES:
                        too_big = True
                        break
                    f.write(chunk)
            if too_big:
                raise HTTPException(status_code=422, detail="单张图片超过 20MB 上限")
            if size == 0:
                raise HTTPException(status_code=422, detail=f"第 {idx} 张图片为空文件")
            saved_names.append(name)
    except HTTPException:
        shutil.rmtree(job_dir, ignore_errors=True)
        raise
    except OSError as e:
        shutil.rmtree(job_dir, ignore_errors=True)
        logger.warning("animatic NAS 写入失败: %s", e)
        raise HTTPException(status_code=503, detail=f"NAS 存储不可达:{e}") from e

    # 2) 构造 workstation 侧 ffmpeg 命令(同 NAS,挂载点换算)并 ssh 执行
    ws_inputs = [f"{_WS_IMPORT_DIR}/{job_id}/{n}" for n in saved_names]
    ws_out = f"{_WS_OUTPUT_DIR}/{job_id}.mp4"
    remote_cmd = (
        f"mkdir -p {shlex.quote(_WS_OUTPUT_DIR)} && "
        + _build_ffmpeg_cmd(ws_inputs, durs, fps, width, height, ws_out)
    )
    try:
        task = asyncio.create_task(asyncio.to_thread(_run_ffmpeg, remote_cmd, job_id))

        async def _watch_disconnect() -> None:
            if request is None:
                return
            try:
                while not task.done():
                    if await request.is_disconnected():
                        kill_animatic_ffmpeg(job_id)
                        return
                    await asyncio.sleep(0.25)
            except asyncio.CancelledError:
                return

        watcher = asyncio.create_task(_watch_disconnect())
        try:
            await task
        finally:
            watcher.cancel()
    except HTTPException:
        shutil.rmtree(job_dir, ignore_errors=True)
        (_OUTPUT_DIR / f"{job_id}.mp4").unlink(missing_ok=True)
        raise

    # 3) 确认成片经 NAS 回到 core 侧
    out_file = _OUTPUT_DIR / f"{job_id}.mp4"
    try:
        ok = out_file.is_file()
    except OSError as e:
        ok = False
        logger.warning("animatic NAS 读取失败: %s", e)
    if not ok:
        shutil.rmtree(job_dir, ignore_errors=True)
        raise HTTPException(status_code=502, detail="ffmpeg 未产出成片(NAS 挂载异常?)")

    return {
        "job_id": job_id,
        "url": f"/api/animatic/output/{job_id}.mp4",
        "count": len(saved_names),
        "duration": round(sum(durs), 3),
        "fps": fps,
        "width": width,
        "height": height,
    }


@router.get("/animatic/output/{filename}")
async def animatic_output(
    filename: str,
    user: User = Depends(get_current_user),
) -> FileResponse:
    # 白名单正则一揽子挡住路径穿越与任意文件读取;不匹配即 404(不暴露存在性)
    if not _OUT_RE.match(filename):
        raise HTTPException(status_code=404, detail="成片不存在")
    path = _OUTPUT_DIR / filename
    try:
        exists = path.is_file()
    except OSError as e:
        logger.warning("animatic NAS 读取失败: %s", e)
        raise HTTPException(status_code=503, detail=f"NAS 存储不可达:{e}") from e
    if not exists:
        raise HTTPException(status_code=404, detail="成片不存在")
    return FileResponse(
        path,
        media_type="video/mp4",
        filename=filename,
        headers={"Cache-Control": "public, max-age=86400"},
    )
