"""视频编辑(OpenCut 风格时间线)—— 剪辑计划 + 媒体文件 → ffmpeg 渲染成片。

  POST /api/video-edit/render         multipart(plan JSON + media[])
                                      → 媒体落 NAS imports → 探测原声 → ssh workstation 跑 ffmpeg
                                      → {job_id, url, duration, ...}
  GET  /api/video-edit/output/{name}  回成片(白名单文件名 ^[a-z0-9]{12}\\.mp4$,NAS outputs/video-edit)

剪辑计划(plan JSON):
  width/height/fps     输出画布与帧率(奇数尺寸向下取偶)
  clips:   [{file, in, duration, volume}]  视频轨(顺序串接;file=media[] 下标;
           in/duration 秒;volume 0=丢弃原声,>0 且源含音轨时保留原声)
  audios:  [{file, in, duration, start, volume}]  音频轨(start=时间线起点秒)
  texts:   [{text, start, end, position, fontSize, color}]  文字叠加
           (position: top|center|bottom;color: #rrggbb)

算力边界(AGENTS.md 第七节):core 只跑应用层,ffprobe/ffmpeg 一律 ssh 到 workstation
执行;两侧经同一 NAS 共享盘交换文件,路径按挂载点换算(同 animatic.py)。
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
from typing import Any

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse

from app.deps import get_current_user
from app.models import User
from app.ratelimit import enforce_generation_rate_limit

logger = logging.getLogger(__name__)

router = APIRouter()

# ── 路径与执行目标(env 可覆盖;测试 monkeypatch 模块常量到 tmp_path)──
_IMPORT_DIR = Path(os.environ.get("TOIV_VIDEO_EDIT_IMPORT_DIR", "/mnt/toiv-nas/toiv/imports/video-edit"))
_OUTPUT_DIR = Path(os.environ.get("TOIV_VIDEO_EDIT_OUTPUT_DIR", "/mnt/toiv-nas/toiv/outputs/video-edit"))
_WS_IMPORT_DIR = os.environ.get("TOIV_VIDEO_EDIT_WS_IMPORT_DIR", "/home/merlin/nas_mount/toiv/imports/video-edit")
_WS_OUTPUT_DIR = os.environ.get("TOIV_VIDEO_EDIT_WS_OUTPUT_DIR", "/home/merlin/nas_mount/toiv/outputs/video-edit")
_SSH_TARGET = os.environ.get("TOIV_VIDEO_EDIT_SSH_TARGET", "merlin@192.168.71.127")
# drawtext 中文字体(workstation 侧路径;fonts-noto-cjk)
_FONT_PATH = os.environ.get(
    "TOIV_VIDEO_EDIT_FONT",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
)

_FFMPEG_TIMEOUT = 1800  # 重编码比静帧串接重,10 分钟 1080p 以内足够
_PROBE_TIMEOUT = 60
_MAX_MEDIA = 30
_MAX_BYTES = 500 * 1024 * 1024  # 单个媒体 ≤ 500MB
_CHUNK = 1024 * 1024
_VIDEO_EXT = {".mp4", ".webm", ".mov", ".mkv"}
_AUDIO_EXT = {".mp3", ".wav", ".m4a", ".ogg", ".aac"}
_OUT_RE = re.compile(r"^[a-z0-9]{12}\.mp4$")
_COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")
_POSITIONS = ("top", "center", "bottom")

# 计划上限:防失控渲染
_MAX_CLIPS = 20
_MAX_AUDIOS = 10
_MAX_TEXTS = 20
_MAX_TOTAL_SEC = 600.0


# ────────────────────────────────
# 计划校验(纯函数,单测覆盖)
# ────────────────────────────────

def _fmt_sec(d: float) -> str:
    """时长格式化成 ffmpeg 接受的紧凑秒数(3.0 → "3",2.5 → "2.5")。"""
    s = f"{d:.3f}".rstrip("0").rstrip(".")
    return s or "0"


def _num(v: Any, key: str, *, lo: float, hi: float) -> float:
    """数值字段校验:bool/非数/nan/inf/越界一律 422。"""
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        raise HTTPException(status_code=422, detail=f"{key} 必须是数字")
    f = float(v)
    if not lo <= f <= hi:  # nan/inf 比较恒 False,一并被拦
        raise HTTPException(status_code=422, detail=f"{key} 须在 {lo:g}-{hi:g} 之间")
    return f


def _file_idx(v: Any, count: int) -> int:
    """file 下标校验:必须是 [0, count) 的整数。"""
    if isinstance(v, bool) or not isinstance(v, int) or not 0 <= v < count:
        raise HTTPException(status_code=422, detail=f"file 下标越界(媒体共 {count} 个)")
    return v


def parse_plan(raw: str, media_count: int) -> dict[str, Any]:
    """解析并校验剪辑计划;合法返回规范化 dict,非法抛 422。

    返回:{width, height, fps, clips, audios, texts, total}
    clips/audios/texts 元素已做类型与范围校验,可直接编译 ffmpeg 命令。
    """
    try:
        data = json.loads(raw)
    except ValueError:
        raise HTTPException(status_code=422, detail="plan 必须是 JSON 对象") from None
    if not isinstance(data, dict):
        raise HTTPException(status_code=422, detail="plan 必须是 JSON 对象")
    if media_count < 1:
        raise HTTPException(status_code=422, detail="缺少媒体文件")

    width = int(_num(data.get("width", 1920), "width", lo=256, hi=4096))
    height = int(_num(data.get("height", 1080), "height", lo=256, hi=4096))
    fps = int(_num(data.get("fps", 30), "fps", lo=12, hi=60))
    # h264/yuv420p 要求偶数尺寸:奇数向下取偶
    width -= width % 2
    height -= height % 2

    raw_clips = data.get("clips")
    if not isinstance(raw_clips, list) or not 1 <= len(raw_clips) <= _MAX_CLIPS:
        raise HTTPException(status_code=422, detail=f"clips 须为 1-{_MAX_CLIPS} 段")
    clips: list[dict[str, Any]] = []
    total = 0.0
    for i, c in enumerate(raw_clips):
        if not isinstance(c, dict):
            raise HTTPException(status_code=422, detail=f"clips[{i}] 必须是对象")
        dur = _num(c.get("duration"), f"clips[{i}].duration", lo=0.1, hi=_MAX_TOTAL_SEC)
        clips.append({
            "file": _file_idx(c.get("file"), media_count),
            "in": _num(c.get("in", 0), f"clips[{i}].in", lo=0, hi=86400),
            "duration": dur,
            "volume": _num(c.get("volume", 1), f"clips[{i}].volume", lo=0, hi=1),
        })
        total += dur
    if total > _MAX_TOTAL_SEC:
        raise HTTPException(status_code=422, detail=f"成片总时长超过 {_MAX_TOTAL_SEC:g}s 上限")

    raw_audios = data.get("audios", [])
    if not isinstance(raw_audios, list) or len(raw_audios) > _MAX_AUDIOS:
        raise HTTPException(status_code=422, detail=f"audios 须为 0-{_MAX_AUDIOS} 段")
    audios: list[dict[str, Any]] = []
    for i, a in enumerate(raw_audios):
        if not isinstance(a, dict):
            raise HTTPException(status_code=422, detail=f"audios[{i}] 必须是对象")
        audios.append({
            "file": _file_idx(a.get("file"), media_count),
            "in": _num(a.get("in", 0), f"audios[{i}].in", lo=0, hi=86400),
            "duration": _num(a.get("duration"), f"audios[{i}].duration", lo=0.1, hi=_MAX_TOTAL_SEC),
            "start": _num(a.get("start", 0), f"audios[{i}].start", lo=0, hi=_MAX_TOTAL_SEC),
            "volume": _num(a.get("volume", 1), f"audios[{i}].volume", lo=0, hi=1),
        })

    raw_texts = data.get("texts", [])
    if not isinstance(raw_texts, list) or len(raw_texts) > _MAX_TEXTS:
        raise HTTPException(status_code=422, detail=f"texts 须为 0-{_MAX_TEXTS} 条")
    texts: list[dict[str, Any]] = []
    for i, t in enumerate(raw_texts):
        if not isinstance(t, dict):
            raise HTTPException(status_code=422, detail=f"texts[{i}] 必须是对象")
        content = t.get("text")
        if not isinstance(content, str) or not 1 <= len(content.strip()) <= 200:
            raise HTTPException(status_code=422, detail=f"texts[{i}].text 须为 1-200 字")
        start = _num(t.get("start", 0), f"texts[{i}].start", lo=0, hi=_MAX_TOTAL_SEC)
        end = _num(t.get("end"), f"texts[{i}].end", lo=0.1, hi=_MAX_TOTAL_SEC)
        if end <= start:
            raise HTTPException(status_code=422, detail=f"texts[{i}].end 须大于 start")
        position = t.get("position", "bottom")
        if position not in _POSITIONS:
            raise HTTPException(status_code=422, detail=f"texts[{i}].position 仅支持 {'/'.join(_POSITIONS)}")
        color = t.get("color", "#ffffff")
        if not isinstance(color, str) or not _COLOR_RE.match(color):
            raise HTTPException(status_code=422, detail=f"texts[{i}].color 须为 #rrggbb")
        texts.append({
            "text": content.strip(),
            "start": start,
            "end": end,
            "position": position,
            "fontSize": int(_num(t.get("fontSize", 48), f"texts[{i}].fontSize", lo=12, hi=200)),
            "color": color.lower(),
        })

    return {
        "width": width, "height": height, "fps": fps,
        "clips": clips, "audios": audios, "texts": texts, "total": total,
    }


# ────────────────────────────────
# ffmpeg 命令构造(纯函数,单测覆盖)
# ────────────────────────────────

def _escape_drawtext(text: str) -> str:
    """drawtext text 转义:反斜杠优先,再转 filtergraph 与 drawtext 的特殊字符。

    换行/回车直接去掉(单行字幕);其余按 ffmpeg filter 语法转义。
    """
    t = text.replace("\r", " ").replace("\n", " ")
    out: list[str] = []
    for ch in t:
        if ch in "\\'`:,;%[]":
            out.append("\\" + ch)
        else:
            out.append(ch)
    return "".join(out)


def build_render_plan_cmd(
    media_ws_paths: list[str],
    plan: dict[str, Any],
    clip_has_audio: list[bool],
    *,
    font_path: str,
    out_path: str,
) -> str:
    """按校验后的 plan 构造完整 ffmpeg 命令(amix 在 filters 内收尾)。

    media_ws_paths:全部媒体(视频段与音频段引用同一数组,按 file 下标取)。
    """
    clips, audios, texts = plan["clips"], plan["audios"], plan["texts"]
    width, height, fps = plan["width"], plan["height"], plan["fps"]

    # 去重收集实际用到的输入:视频段按序 + 音频段按序(可能指向同一文件,各开一路输入,
    # 让 -ss/-t 互不影响;文件小重复开销可接受,换来命令结构简单确定)
    video_paths = [media_ws_paths[c["file"]] for c in clips]
    audio_paths = [media_ws_paths[a["file"]] for a in audios]
    n, m = len(video_paths), len(audio_paths)

    parts: list[str] = ["ffmpeg", "-hide_banner", "-loglevel", "error"]
    for path, c in zip(video_paths, clips):
        parts += ["-ss", _fmt_sec(c["in"]), "-t", _fmt_sec(c["duration"]), "-i", shlex.quote(path)]
    for path, a in zip(audio_paths, audios):
        parts += ["-ss", _fmt_sec(a["in"]), "-t", _fmt_sec(a["duration"]), "-i", shlex.quote(path)]

    filters: list[str] = []
    for i in range(n):
        filters.append(
            f"[{i}:v]scale={width}:{height}:force_original_aspect_ratio=decrease,"
            f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=black,"
            f"fps={fps},format=yuv420p,setsar=1[v{i}]"
        )
    filters.append("".join(f"[v{i}]" for i in range(n)) + f"concat=n={n}:v=1:a=0[vcat]")

    vlabel = "[vcat]"
    for k, t in enumerate(texts):
        text = _escape_drawtext(t["text"])
        if t["position"] == "top":
            y = "h*0.08"
        elif t["position"] == "center":
            y = "(h-text_h)/2"
        else:
            y = "h-text_h-h*0.08"
        nxt = "[vout]" if k == len(texts) - 1 else f"[vt{k}]"
        filters.append(
            f"{vlabel}drawtext=fontfile={font_path}:text='{text}':"
            f"fontsize={t['fontSize']}:fontcolor={t['color']}:"
            f"x=(w-text_w)/2:y={y}:"
            f"borderw=2:bordercolor=black@0.6:"
            f"enable='between(t,{_fmt_sec(t['start'])},{_fmt_sec(t['end'])})'{nxt}"
        )
        vlabel = nxt
    if not texts:
        filters.append("[vcat]null[vout]")

    achains: list[str] = []
    start = 0.0
    for i, c in enumerate(clips):
        if c["volume"] > 0 and clip_has_audio[i]:
            ms = int(round(start * 1000))
            filters.append(
                f"[{i}:a]asetpts=PTS-STARTPTS,volume={c['volume']:g},"
                f"adelay={ms}|{ms}[a{len(achains)}]"
            )
            achains.append(f"[a{len(achains)}]")
        start += c["duration"]
    for j, a in enumerate(audios):
        ms = int(round(a["start"] * 1000))
        filters.append(
            f"[{n + j}:a]asetpts=PTS-STARTPTS,volume={a['volume']:g},"
            f"adelay={ms}|{ms}[a{len(achains)}]"
        )
        achains.append(f"[a{len(achains)}]")

    parts += ["-filter_complex", shlex.quote(";".join(filters))]
    parts += ["-map", shlex.quote("[vout]")]
    if achains:
        total = plan["total"]
        amix = (
            "".join(achains)
            + f"amix=inputs={len(achains)}:duration=longest:normalize=0[amix];"
            + f"[amix]apad,atrim=duration={_fmt_sec(total)}[aout]"
        )
        # amix 属于 filtergraph:重建 -filter_complex 参数(在已 quote 的 filters 尾部追加)
        # parts 尾部为 [..., "-filter_complex", quoted_filters, "-map", quoted_vout]
        parts[-3] = shlex.quote(";".join(filters) + ";" + amix)
        parts += ["-map", shlex.quote("[aout]"), "-c:a", "aac", "-b:a", "192k"]
    else:
        parts += ["-an"]
    parts += [
        "-c:v", "libx264", "-preset", "medium", "-crf", "18",
        "-pix_fmt", "yuv420p", "-movflags", "+faststart",
        "-y", shlex.quote(out_path),
    ]
    return " ".join(parts)


def _run_ssh(remote_cmd: str, timeout: int, label: str) -> subprocess.CompletedProcess:
    """ssh 到 workstation 执行命令(core 禁跑算力负载,AGENTS.md 第七节)。

    失败抛 HTTPException(502),stderr 尾 500 字符随 detail 返回,便于排障。
    """
    try:
        proc = subprocess.run(
            ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", _SSH_TARGET, remote_cmd],
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired as e:
        raise HTTPException(status_code=502, detail=f"{label} 执行超时({timeout}s)") from e
    if proc.returncode != 0:
        tail = (proc.stderr or "")[-500:]
        raise HTTPException(status_code=502, detail=f"{label} 执行失败:{tail}")
    return proc


def _probe_audio_streams(ws_paths: list[str]) -> list[bool]:
    """批量探测各输入是否含音轨:一次 ssh 循环 ffprobe,按行回 0/1。

    探测失败(ffprobe 缺失/文件损坏)不 502:该文件按无音轨处理(丢原声保渲染)。
    """
    if not ws_paths:
        return []
    loop = (
        "for f in " + " ".join(shlex.quote(p) for p in ws_paths) + "; do "
        "if ffprobe -v error -select_streams a:0 -show_entries stream=index "
        "-of csv=p=0 \"$f\" 2>/dev/null | grep -q .; then echo 1; else echo 0; fi; done"
    )
    try:
        proc = _run_ssh(loop, _PROBE_TIMEOUT, "ffprobe 原声探测")
    except HTTPException:
        logger.warning("video-edit 原声探测失败,按全部无音轨降级", exc_info=True)
        return [False] * len(ws_paths)
    flags = proc.stdout.split()
    out: list[bool] = []
    for i in range(len(ws_paths)):
        out.append(i < len(flags) and flags[i] == "1")
    return out


# ────────────────────────────────
# 上传校验
# ────────────────────────────────

def _check_media_filename(name: str | None) -> str:
    """校验上传文件名并返回规范化扩展名;非法一律 422。

    落盘文件名由服务端按下标生成(001.mp4...),用户文件名仅用于判断格式,
    但仍拒绝路径分隔符/`..` 穿越企图,安全语义显式化。
    """
    if not name:
        raise HTTPException(status_code=422, detail="缺少文件名")
    if "/" in name or "\\" in name or ".." in name:
        raise HTTPException(status_code=422, detail="非法文件名(禁止路径穿越)")
    ext = Path(name).suffix.lower()
    if ext not in _VIDEO_EXT and ext not in _AUDIO_EXT:
        raise HTTPException(
            status_code=422,
            detail=f"不支持的媒体格式(视频 {', '.join(sorted(_VIDEO_EXT))};音频 {', '.join(sorted(_AUDIO_EXT))})",
        )
    return ext


# ────────────────────────────────
# 路由
# ────────────────────────────────

@router.post("/video-edit/render")
async def render_video_edit(
    plan: str = Form(...),
    media: list[UploadFile] = File(...),
    user: User = Depends(get_current_user),
) -> dict[str, object]:
    enforce_generation_rate_limit(user)

    if not 1 <= len(media) <= _MAX_MEDIA:
        raise HTTPException(status_code=422, detail=f"媒体数量须在 1-{_MAX_MEDIA} 个之间")
    spec = parse_plan(plan, len(media))

    job_id = uuid.uuid4().hex[:12]
    job_dir = _IMPORT_DIR / job_id

    # 1) 媒体按下标编号落 NAS(core 侧路径);NAS 不可达 → 503
    saved_names: list[str] = []
    try:
        job_dir.mkdir(parents=True, exist_ok=True)
        for idx, item in enumerate(media, start=1):
            ext = _check_media_filename(item.filename)
            name = f"{idx:03d}{ext}"
            dest = job_dir / name
            size = 0
            too_big = False
            with dest.open("wb") as f:
                while chunk := await item.read(_CHUNK):
                    size += len(chunk)
                    if size > _MAX_BYTES:
                        too_big = True
                        break
                    f.write(chunk)
            if too_big:
                raise HTTPException(status_code=422, detail="单个媒体超过 500MB 上限")
            if size == 0:
                raise HTTPException(status_code=422, detail=f"第 {idx} 个媒体为空文件")
            saved_names.append(name)
    except HTTPException:
        shutil.rmtree(job_dir, ignore_errors=True)
        raise
    except OSError as e:
        shutil.rmtree(job_dir, ignore_errors=True)
        logger.warning("video-edit NAS 写入失败: %s", e)
        raise HTTPException(status_code=503, detail=f"NAS 存储不可达:{e}") from e

    # 2) 原声探测 + 构造 ffmpeg 命令(同 NAS,挂载点换算)→ ssh 执行
    ws_paths = [f"{_WS_IMPORT_DIR}/{job_id}/{n}" for n in saved_names]
    ws_out = f"{_WS_OUTPUT_DIR}/{job_id}.mp4"
    try:
        clip_files = [spec["clips"][i]["file"] for i in range(len(spec["clips"]))]
        probe = await asyncio.to_thread(
            _probe_audio_streams, [ws_paths[i] for i in clip_files]
        )
        remote_cmd = (
            f"mkdir -p {shlex.quote(_WS_OUTPUT_DIR)} && "
            + build_render_plan_cmd(
                ws_paths, spec, probe, font_path=_FONT_PATH, out_path=ws_out
            )
        )
        await asyncio.to_thread(_run_ssh, remote_cmd, _FFMPEG_TIMEOUT, "ffmpeg")
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
        logger.warning("video-edit NAS 读取失败: %s", e)
    if not ok:
        shutil.rmtree(job_dir, ignore_errors=True)
        raise HTTPException(status_code=502, detail="ffmpeg 未产出成片(NAS 挂载异常?)")

    return {
        "job_id": job_id,
        "url": f"/api/video-edit/output/{job_id}.mp4",
        "clips": len(spec["clips"]),
        "audios": len(spec["audios"]),
        "texts": len(spec["texts"]),
        "duration": round(spec["total"], 3),
        "fps": spec["fps"],
        "width": spec["width"],
        "height": spec["height"],
    }


@router.get("/video-edit/output/{filename}")
async def video_edit_output(
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
        logger.warning("video-edit NAS 读取失败: %s", e)
        raise HTTPException(status_code=503, detail=f"NAS 存储不可达:{e}") from e
    if not exists:
        raise HTTPException(status_code=404, detail="成片不存在")
    return FileResponse(
        path,
        media_type="video/mp4",
        filename=filename,
        headers={"Cache-Control": "public, max-age=86400"},
    )
