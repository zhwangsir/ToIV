"""视频译制·动漫对口型(本地自建 v0)—— LatentSync 做不了动漫,这里走经典 CV 路线。

思路(全本地、不出云、免费):
  ① ffmpeg 抽音频 → 逐帧算 RMS 能量包络 → 归一为「开口度」[0,1](响=张嘴)。
  ② lbpcascade_animeface(专训动漫脸的检测器)逐帧定位动漫脸框。
  ③ 按开口度对脸下部「嘴区」做垂直形变(remap 张嘴)→ 重组帧 → ffmpeg 混回原音轨。

局限(诚实):v0 是「音频能量驱动的嘴区张合」,近似传统动漫口型(あいうえお 嘴动),
不是真·音素级唇形;动作镜头/侧脸/快速运动下检测不稳则该帧不动。是可迭代地基,不是终点。
"""
from __future__ import annotations

import asyncio
import logging
import tempfile
import time
import uuid
import wave
from pathlib import Path

import cv2
import numpy as np
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.deps import get_current_user
from app.models import User
from app.ratelimit import enforce_generation_rate_limit
from app.routes.dub import _DUB_DIR, _NAME_RE, _ffmpeg_run

logger = logging.getLogger(__name__)
router = APIRouter()

_CASCADE_PATH = str(Path(__file__).resolve().parent.parent / "assets" / "lbpcascade_animeface.xml")
_ANIME_OUT_RE = __import__("re").compile(r"^dubanime-[0-9a-f]{32}\.mp4$")
_JOBS_KEEP = 40

_anime_jobs: dict[str, dict] = {}
_a_tasks: set[asyncio.Task] = set()


def _prune() -> None:
    if len(_anime_jobs) <= _JOBS_KEEP:
        return
    term = sorted((j for j in _anime_jobs.values() if j["status"] in ("done", "error")),
                  key=lambda j: j["started"])
    for j in term[: len(_anime_jobs) - _JOBS_KEEP]:
        _anime_jobs.pop(j["id"], None)


class AnimeLipsyncRequest(BaseModel):
    name: str = Field(min_length=1, max_length=200)  # 源视频 name
    audio_name: str | None = Field(default=None, max_length=200)  # dubvoice-*.wav;空=源自带音轨
    mouth_gain: float = Field(default=1.0, ge=0.2, le=3.0)  # 张嘴幅度倍率
    smooth: int = Field(default=3, ge=0, le=15)  # 开口度时间平滑窗(帧)


def _audio_openness(wav_path: Path, n_frames: int, fps: float, smooth: int) -> np.ndarray:
    """从 wav 算逐帧开口度 [0,1]:每视频帧取对应音频窗的 RMS,归一 + 平滑。"""
    try:
        with wave.open(str(wav_path), "rb") as w:
            sr = w.getframerate() or 16000
            n = w.getnframes()
            raw = w.readframes(n)
    except (wave.Error, OSError):
        return np.zeros(n_frames, dtype=np.float32)
    samples = np.frombuffer(raw, dtype=np.int16).astype(np.float32)
    if samples.size == 0:
        return np.zeros(n_frames, dtype=np.float32)
    win = max(1, int(sr / max(fps, 1.0)))
    out = np.zeros(n_frames, dtype=np.float32)
    for i in range(n_frames):
        a = int(i * sr / max(fps, 1.0))
        seg = samples[a:a + win]
        out[i] = float(np.sqrt(np.mean(seg * seg))) if seg.size else 0.0
    # 归一(用 90 分位抗尖峰)+ 平滑
    ref = np.percentile(out, 90) or (out.max() or 1.0)
    out = np.clip(out / (ref + 1e-6), 0.0, 1.0)
    if smooth > 1:
        k = np.ones(smooth, dtype=np.float32) / smooth
        out = np.convolve(out, k, mode="same")
    return out


# 嘴区在动漫脸框内的相对位置(框含发际/额头,嘴比真人偏低):嘴心纵向 ~0.64h,下颌 ~0.86h
_MOUTH_TOP = 0.64
_MOUTH_BOT = 0.86
_MOUTH_HALF_W = 0.30  # 嘴横向半宽 = 脸宽 30%(只动嘴区不动整脸)


def _warp_open_mouth(frame: np.ndarray, box: tuple[int, int, int, int], px: int) -> np.ndarray:
    """张嘴:以嘴心为中心,对下部做「高斯权重的向下位移」(嘴心最强、四周平滑衰减到 0),
    remap 实现。平滑权重避免硬矩形边;横向限幅只动嘴区,不牵连脸颊/头发。"""
    if px < 1:
        return frame
    h_img, w_img = frame.shape[:2]
    x, y, w, h = box
    cx = x + w / 2.0
    mouth_y = y + _MOUTH_TOP * h
    chin_y = y + _MOUTH_BOT * h
    half_w = max(_MOUTH_HALF_W * w, 4.0)
    gx = np.arange(w_img, dtype=np.float32)
    gy = np.arange(h_img, dtype=np.float32)
    # 横向:抛物线窗,嘴心=1,±half_w 处=0(窗外 0)
    hx = np.clip(1.0 - ((gx - cx) / half_w) ** 2, 0.0, 1.0)
    # 纵向:高斯,峰在嘴心~下颌中点,平滑扩散(上唇不动、下唇+下颌下沉)
    mc = (mouth_y + chin_y) / 2.0
    sig = max((chin_y - mouth_y) / 2.0, 1.0)
    vy = np.exp(-0.5 * ((gy - mc) / sig) ** 2)
    dy = (px * np.outer(vy, hx)).astype(np.float32)  # 每像素下移量
    map_x = np.broadcast_to(gx, (h_img, w_img)).astype(np.float32)
    map_y = (gy[:, None] - dy).astype(np.float32)  # 采样自上方 → 内容下移 = 张嘴
    return cv2.remap(frame, map_x, map_y, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)


def _composite_mouth(frame: np.ndarray, box: tuple[int, int, int, int], op: float) -> np.ndarray:
    """合成张开口腔:随开口度在嘴心画一枚羽化的暗色椭圆(口腔)+ 下沿一抹亮(下唇高光),
    让「说话」可见。warp 只给下颌微动,这个才给可读的开合。op∈[0,1]。"""
    if op < 0.08:
        return frame
    h_img, w_img = frame.shape[:2]
    x, y, w, h = box
    cx = int(x + w / 2.0)
    cy = int(y + 0.66 * h)  # 嘴心
    mw = int(0.19 * w)
    mh = int(op * 0.085 * h)  # 张开高度随开口度
    if mh < 2 or mw < 2 or not (0 <= cx < w_img and 0 <= cy < h_img):
        return frame
    overlay = frame.copy()
    cv2.ellipse(overlay, (cx, cy), (mw, mh), 0, 0, 360, (52, 40, 92), -1)  # BGR 暗红口腔(偏暖)
    # 顶部一抹薄上齿(浅);仅张得较大时才露
    if mh >= 6:
        cv2.ellipse(overlay, (cx, cy - mh + 2), (int(mw * 0.72), max(1, mh // 5)), 0, 0, 180,
                    (205, 205, 210), -1)
    mask = np.zeros((h_img, w_img), np.float32)
    cv2.ellipse(mask, (cx, cy), (mw, mh), 0, 0, 360, 1.0, -1)
    mask = cv2.GaussianBlur(mask, (0, 0), max(mw * 0.22, 2.0)) * (0.72 * min(op * 1.3, 1.0))
    m3 = mask[..., None]
    return (frame * (1.0 - m3) + overlay * m3).astype(np.uint8)


def _run_anime_cv(job: dict, src: Path, audio: Path, req: AnimeLipsyncRequest, out: Path) -> None:
    """阻塞 CV 管线(放线程跑):逐帧检测动漫脸 + 按开口度张嘴 → 无声视频。"""
    detector = cv2.CascadeClassifier(_CASCADE_PATH)
    if detector.empty():
        raise RuntimeError("动漫脸检测器加载失败")
    cap = cv2.VideoCapture(str(src))
    fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    n_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    w_img = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    h_img = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    if n_frames <= 0 or w_img <= 0:
        raise RuntimeError("视频读取失败(帧数/尺寸为 0)")

    openness = _audio_openness(audio, n_frames, fps, req.smooth)
    writer = cv2.VideoWriter(str(out), cv2.VideoWriter_fourcc(*"mp4v"), fps, (w_img, h_img))
    detected = 0
    i = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        # 每帧检测(动漫脸;缩小灰度图加速)
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        gray = cv2.equalizeHist(gray)
        faces = detector.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=3,
                                          minSize=(48, 48))
        if len(faces) > 0:
            detected += 1
            fx, fy, fw, fh = max(faces, key=lambda b: b[2] * b[3])  # 最大脸
            op = openness[i] if i < len(openness) else 0.0
            box = (int(fx), int(fy), int(fw), int(fh))
            px = int(op * req.mouth_gain * fh * 0.12)  # 下颌微动 ~12% 脸高
            if px >= 1:
                frame = _warp_open_mouth(frame, box, px)
            frame = _composite_mouth(frame, box, min(op * req.mouth_gain, 1.0))  # 合成口腔开合
        writer.write(frame)
        i += 1
        if i % 30 == 0:
            job["progress"] = int(i / max(n_frames, 1) * 100)
            job["elapsed"] = round(time.monotonic() - job["started"], 1)
    cap.release()
    writer.release()
    job["frames"] = i
    job["faces_detected"] = detected


async def _run_anime_lipsync(job: dict, src: Path, req: AnimeLipsyncRequest,
                             audio_src: Path) -> None:
    """后台:抽音频 → CV 张嘴(线程)→ ffmpeg 混回音轨。异常落 job.error。"""
    try:
        with tempfile.TemporaryDirectory(prefix="dub-anime-") as tmp:
            tmp_dir = Path(tmp)
            wav = tmp_dir / "a.wav"
            job["stage"] = "抽音频"
            await _ffmpeg_run(["ffmpeg", "-y", "-i", str(audio_src), "-vn", "-ac", "1",
                               "-ar", "16000", str(wav)])
            job["stage"] = "逐帧张嘴(动漫脸检测)"
            silent = tmp_dir / "silent.mp4"
            await asyncio.to_thread(_run_anime_cv, job, src, wav, req, silent)
            if not silent.is_file() or silent.stat().st_size == 0:
                job["status"], job["error"] = "error", "CV 处理产物为空"
                return
            job["stage"] = "混音"
            _DUB_DIR.mkdir(parents=True, exist_ok=True)
            out_name = f"dubanime-{uuid.uuid4().hex}.mp4"
            out_path = _DUB_DIR / out_name
            await _ffmpeg_run(["ffmpeg", "-y", "-i", str(silent), "-i", str(audio_src),
                               "-map", "0:v", "-map", "1:a?", "-c:v", "libx264",
                               "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
                               "-movflags", "+faststart", str(out_path)])
    except Exception as e:  # noqa: BLE001
        logger.warning("anime-lipsync %s 失败:%s", job["id"], e)
        job["status"], job["error"] = "error", f"动漫对口型失败:{e}"
        return
    if not out_path.exists() or out_path.stat().st_size == 0:
        job["status"], job["error"] = "error", "成片为空"
        return
    job["url"] = f"/api/dub/anime-output/{out_name}"
    job["stage"] = "完成"
    job["progress"] = 100
    job["elapsed"] = round(time.monotonic() - job["started"], 1)
    job["status"] = "done"


@router.post("/dub/anime-lipsync")
async def dub_anime_lipsync(
    body: AnimeLipsyncRequest,
    user: User = Depends(get_current_user),
) -> dict[str, object]:
    """起动漫对口型后台作业(本地 CV)。轮询 GET /dub/anime-lipsync/{job}。"""
    enforce_generation_rate_limit(user)
    if not _NAME_RE.match(body.name):
        raise HTTPException(status_code=400, detail="非法文件名")
    src = _DUB_DIR / body.name
    if not src.is_file():
        raise HTTPException(status_code=404, detail="源视频不存在")
    audio_src = src
    if body.audio_name:
        if not _ANIME_OUT_RE.match(body.audio_name) and not body.audio_name.startswith("dubvoice-"):
            raise HTTPException(status_code=400, detail="非法配音轨文件名")
        cand = _DUB_DIR / body.audio_name
        if cand.is_file():
            audio_src = cand

    job_id = uuid.uuid4().hex
    job = {"id": job_id, "status": "running", "stage": "排队", "progress": 0,
           "frames": 0, "faces_detected": 0, "url": None, "error": None,
           "started": time.monotonic(), "elapsed": 0.0}
    _anime_jobs[job_id] = job
    _prune()
    task = asyncio.create_task(_run_anime_lipsync(job, src, body, audio_src))
    _a_tasks.add(task)
    task.add_done_callback(_a_tasks.discard)
    return {"job_id": job_id}


@router.get("/dub/anime-lipsync/{job_id}")
async def dub_anime_status(job_id: str, user: User = Depends(get_current_user)) -> dict[str, object]:
    job = _anime_jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="任务不存在")
    return {k: job[k] for k in ("id", "status", "stage", "progress", "frames",
                                "faces_detected", "url", "error", "elapsed")}


@router.get("/dub/anime-output/{name}")
async def dub_anime_output(name: str, user: User = Depends(get_current_user)):
    from fastapi.responses import FileResponse
    if not _ANIME_OUT_RE.match(name):
        raise HTTPException(status_code=400, detail="非法文件名")
    path = _DUB_DIR / name
    if not path.is_file():
        raise HTTPException(status_code=404, detail="成片不存在")
    return FileResponse(path, media_type="video/mp4", filename=name,
                        headers={"Cache-Control": "public, max-age=86400"})
