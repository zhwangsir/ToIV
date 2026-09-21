"""一键成片(M3,2026-09-21)——分镜板 → 成片:逐镜生成编排+配音+词锚定字幕+ffmpeg 拼接。

编排骨架照抄 video_upscale/keyframe_chain/drama autorun 三范式:
- 合成 Job(kind=board_film, worker=""),tracker 自动跳过,生命周期归本管线
- params JSON 快照=重启续跑唯一事实源(逐镜状态推进即回填,每步新短 Session)
- spawn_film 幂等 fire-and-forget + _BG_TASKS 强引用;reconcile_board_films 启动重挂
- 等引擎作业走 E-7 多轮等待(wait_for_jobs 单轮窗口+预算循环,held 换名透明)

阶段:videos(Semaphore 2,单镜失败不中断) → voices(Semaphore 1,IndexTTS 单卡)
→ words(逐镜配音听写逐词) → assemble(≥1 镜就绪才拼,无视频镜跳过不进片)。
审片循环:reuse_existing=true 时行已挂 done 视频作业直接复用,重拼只补缺失/被换镜。
"""
from __future__ import annotations

import asyncio
import glob
import json
import logging
import re
import time
import uuid
from pathlib import Path
from typing import Any

import httpx
from fastapi import HTTPException
from sqlmodel import Session, select

from app.comfy.pool import WorkerPool
from app.comfy.tracker import wait_for_jobs
from app.config import get_settings
from app.db import engine as db_engine
from app.deps import get_pool
from app.models import Board, BoardItem, Entity, Job, User
from app.services.board_generate import submit_shot_generation
from app.services.board_storyboard import resolve_shot_entities
from app.services.studio.voice import synth as tts_synth
from app.storage import drama_output_root

logger = logging.getLogger(__name__)

KIND = "board_film"
_BG_TASKS: set[asyncio.Task] = set()
_ACTIVE: set[str] = set()  # 在跑 prompt_id(spawn 幂等)

_ROUND_SEC = 900.0  # E-7 单轮等待窗口
_GAP_SEC = 20.0     # 多轮等待间隙
_VIDEO_CONCURRENCY = 2
_VOICE_CONCURRENCY = 1
_VOICE_FIT_TOLERANCE = 0.3   # 与 drama 链同容差
_VOICE_FIT_TEMPO_MAX = 1.3
_SHOT_MIN_SEC, _SHOT_MAX_SEC = 1.0, 15.0
_FFMPEG_TIMEOUT = 300.0      # 与 assembly 同硬上限(长板拆解见后续项)


# ===========================================================================
# 纯函数层:字幕(ASS 卡拉 OK / SRT / 均分兜底 / 词钳制)
# ===========================================================================


def _ass_escape(text: str) -> str:
    return (
        text.replace("\\", "\\\\")
        .replace("{", "\\{")
        .replace("}", "\\}")
        .replace("\n", "\\N")
    )


def _ass_ts(sec: float) -> str:
    sec = max(0.0, sec)
    h = int(sec // 3600)
    m = int((sec % 3600) // 60)
    s = sec % 60
    return f"{h}:{m:02d}:{s:05.2f}"


def even_split_words(text: str, start: float, end: float) -> list[dict]:
    """段内均分兜底(无 ASR 时保底有字幕):拉丁按空白切词,CJK 按字切。"""
    text = text.strip()
    if not text or end <= start:
        return []
    if re.search(r"[A-Za-z0-9]", text):
        tokens = re.findall(r"\S+", text)
    else:
        tokens = [ch for ch in text if not ch.isspace()]
    if not tokens:
        return []
    step = (end - start) / len(tokens)
    return [
        {"start": round(start + i * step, 3), "end": round(start + (i + 1) * step, 3), "text": t}
        for i, t in enumerate(tokens)
    ]


def clamp_words(words: list[dict], slot_start: float, slot_end: float) -> list[dict]:
    """词时间钳到镜时槽(mlx 30s 窗 padding 尾段虚高 ~3s 对策);钳后零长词丢弃。"""
    out: list[dict] = []
    for w in words:
        st = min(max(float(w.get("start", 0.0)), slot_start), slot_end)
        en = min(max(float(w.get("end", st)), st), slot_end)
        text = str(w.get("text") or w.get("word") or "").strip()
        if text and en > st:
            out.append({"start": round(st, 3), "end": round(en, 3), "text": text})
    return out


def build_karaoke_ass(entries: list[dict], play_w: int, play_h: int) -> str:
    """全局词锚定 ASS(卡拉 OK \\k 逐词高亮 + 【speaker】前缀;无 words 退化为整段)。

    entries: [{start, end, speaker, text, words?: [{start,end,text}]}](秒,全局时间轴)。
    """
    fontsize = max(20, round(play_h * 0.048))
    header = (
        "[Script Info]\n"
        "Title: board-film karaoke\n"
        "ScriptType: v4.00+\n"
        f"PlayResX: {play_w}\n"
        f"PlayResY: {play_h}\n"
        "ScaledBorderAndShadow: yes\n"
        "WrapStyle: 2\n"
        "\n[V4+ Styles]\n"
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, "
        "BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, "
        "BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n"
        f"Style: Default,Noto Sans CJK SC,{fontsize},&H00FFFFFF,&H0000C8F0,&H80101010,"
        "&H64000000,0,0,0,0,100,100,0,0,1,2.4,1.2,2,40,40,36,1\n"
        "\n[Events]\n"
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
    )
    lines: list[str] = []
    for e in entries:
        speaker = str(e.get("speaker") or "").strip()
        prefix = f"【{_ass_escape(speaker)}】" if speaker and speaker not in ("narrator", "旁白") else (
            "【旁白】" if speaker else ""
        )
        words = e.get("words") or []
        if words:
            body = prefix + "".join(
                f"{{\\k{max(1, round((float(w['end']) - float(w['start'])) * 100))}}}"
                f"{_ass_escape(str(w['text']))}"
                for w in words
            )
        else:
            body = prefix + _ass_escape(str(e.get("text") or ""))
        if not body.strip():
            continue
        lines.append(
            f"Dialogue: 0,{_ass_ts(float(e['start']))},{_ass_ts(float(e['end']))},"
            f"Default,,0,0,0,,{body}"
        )
    return header + "\n".join(lines) + "\n"


def _srt_ts(sec: float) -> str:
    sec = max(0.0, sec)
    h = int(sec // 3600)
    m = int((sec % 3600) // 60)
    s = int(sec % 60)
    ms = round((sec - int(sec)) * 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def words_to_srt(entries: list[dict]) -> str:
    """段级 SRT 侧车(台词全文,与 ASS 同时间轴)。"""
    blocks: list[str] = []
    for i, e in enumerate(entries, 1):
        text = str(e.get("text") or "").strip()
        if not text:
            continue
        speaker = str(e.get("speaker") or "").strip()
        head = f"【{speaker}】" if speaker else ""
        blocks.append(
            f"{len(blocks) + 1}\n{_srt_ts(float(e['start']))} --> {_srt_ts(float(e['end']))}\n{head}{text}\n"
        )
    return "\n".join(blocks) + ("\n" if blocks else "")


# ===========================================================================
# 依赖层:whisper 逐词 / TTS 配音 / 片段下载 / ffmpeg
# ===========================================================================


async def _words_external(path: Path) -> list[dict] | None:
    """外部 whisper(openclaw mlx-whisper)逐词:多址按序尝试(2026-09-21 集群化),
    全不可用回 None(调用方走内置 faster-whisper 兜底)。"""
    for base in get_settings().whisper_endpoint_list:
        out = await _words_external_one(base, path)
        if out:
            return out
    return None


async def _words_external_one(base: str, path: Path) -> list[dict] | None:
    """单节点逐词:OpenAI 兼容 verbose_json+word 粒度。"""
    try:
        async with httpx.AsyncClient(timeout=120.0, trust_env=False) as client:
            with path.open("rb") as fh:
                resp = await client.post(
                    f"{base}/v1/audio/transcriptions",
                    files={"file": (path.name, fh, "audio/wav")},
                    data={"response_format": "verbose_json",
                          "timestamp_granularities[]": "word"},
                )
        if resp.status_code != 200:
            return None
        raw = resp.json().get("words") or []
        out = [
            {"start": float(w.get("start", 0.0)), "end": float(w.get("end", 0.0)),
             "text": str(w.get("word") or "").strip()}
            for w in raw
        ]
        return [w for w in out if w["text"]] or None
    except (httpx.HTTPError, ValueError, OSError) as e:
        logger.info("外部 whisper 逐词不可用(%s): %s", base, e)
        return None


async def _words_builtin(path: Path) -> list[dict] | None:
    """内置 faster-whisper word_timestamps(复用 dub_text 的模型缓存加载器)。"""
    try:
        from app.routes.dub_text import _get_whisper_model

        model = await _get_whisper_model()
    except Exception as e:  # 未装 faster-whisper 只降级,不拖累主流程
        logger.info("内置 whisper 不可用: %s", e)
        return None

    def _run() -> list[dict]:
        segments, _info = model.transcribe(str(path), vad_filter=True, word_timestamps=True)
        out: list[dict] = []
        for seg in segments:
            for w in (seg.words or []):
                text = (w.word or "").strip()
                if text:
                    out.append({"start": float(w.start), "end": float(w.end), "text": text})
        return out

    try:
        words = await asyncio.to_thread(_run)
        return words or None
    except Exception as e:
        logger.info("内置 whisper 逐词失败: %s", e)
        return None


async def _transcribe_words(
    path: Path, slot_start: float, slot_end: float, fallback_text: str
) -> tuple[list[dict], str]:
    """逐词三级链:外部 → 内置 → 均分。返回 (偏移+钳制后的 words, source_tag)。"""
    for probe in (_words_external, _words_builtin):
        words = await probe(path)
        if words:
            off = [{"start": slot_start + w["start"], "end": slot_start + w["end"], "text": w["text"]}
                   for w in words]
            tag = "external" if probe is _words_external else "builtin"
            return clamp_words(off, slot_start, slot_end), tag
    return even_split_words(fallback_text, slot_start, slot_end), "even-split"


def _resolve_local_url(url: str) -> str:
    if url.startswith(("http://", "https://")):
        return url
    base = get_settings().api_base_url.rstrip("/")
    return base + (url if url.startswith("/") else "/" + url)


async def _synth_voice(text: str, speaker: str, entities: list[Entity | None]) -> tuple[str, float, str]:
    """台词配音:speaker 严格按名命中 Entity → ref_audio 克隆;下载失败降级默认音色。

    返回 (voice_url, duration_sec, source_tag: entity:<名>|default)。
    """
    ent = next(
        (e for e in entities if e is not None and speaker and e.name == speaker), None
    )
    ref: bytes | None = None
    source = "default"
    if ent is not None and ent.ref_audio.strip():
        try:
            async with httpx.AsyncClient(timeout=30.0, trust_env=False) as client:
                r = await client.get(_resolve_local_url(ent.ref_audio.strip()))
                r.raise_for_status()
                ref = r.content
                source = f"entity:{ent.name}"
        except (httpx.HTTPError, ValueError) as e:
            logger.warning("角色参考音下载失败,降级默认音色: %s (%s)", ent.ref_audio, e)
    url = await tts_synth(text, ref)
    from app.routes.assembly import _probe_duration

    wav_path = drama_output_root() / "studio" / url.rsplit("/", 1)[-1]
    dur = await _probe_duration(wav_path)
    return url, dur, source


async def _download_clip(pool: WorkerPool, url: str, dest: Path) -> None:
    """下载片段:/api/images 产物走 pool 直读(绕 401);站内鉴权端点
    (/api/boards/film、/api/drama/output、/api/studio/files、/api/drama/voice)
    直接读本地文件(服务端自调无 token 必 401,remix 链式引用成片实证);其余 httpx 直取。
    """
    from urllib.parse import urlsplit

    path = urlsplit(url).path
    if path.startswith("/api/images"):
        from app.routes.drama_studio import _download_images_clip

        await _download_images_clip(pool, url, dest)
        return
    for prefix, root in (
        ("/api/boards/film/", drama_output_root()),
        ("/api/drama/output/", drama_output_root()),
        ("/api/studio/files/", drama_output_root() / "studio"),
        ("/api/drama/voice/", drama_output_root()),
    ):
        if path.startswith(prefix):
            src = root / path[len(prefix):]
            if not src.is_file():
                raise HTTPException(status_code=404, detail=f"本地片段不存在: {src.name}")
            content = await asyncio.to_thread(src.read_bytes)
            await asyncio.to_thread(dest.write_bytes, content)
            return
    async with httpx.AsyncClient(timeout=180.0, follow_redirects=True, trust_env=False) as client:
        r = await client.get(_resolve_local_url(url))
        r.raise_for_status()
        await asyncio.to_thread(dest.write_bytes, r.content)


_FFMPEG_BIN = "ffmpeg"
_libass_cache: bool | None = None


async def _has_libass() -> bool:
    global _libass_cache
    if _libass_cache is not None:
        return _libass_cache
    try:
        proc = await asyncio.create_subprocess_exec(
            _FFMPEG_BIN, "-hide_banner", "-filters",
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        out, _ = await proc.communicate()
        _libass_cache = b"\n ass " in out or b" ass " in out
    except OSError:
        _libass_cache = False
    return _libass_cache


async def _run_ffmpeg(cmd: list[str], timeout: float = _FFMPEG_TIMEOUT) -> None:
    proc = await asyncio.create_subprocess_exec(
        *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    try:
        _, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except TimeoutError:
        proc.kill()
        await proc.wait()
        raise RuntimeError(f"ffmpeg 执行超时({timeout:.0f}s)") from None
    if proc.returncode != 0:
        tail = (stderr or b"").decode("utf-8", "replace")[-800:]
        raise RuntimeError(f"ffmpeg 失败: {tail}")


async def _probe_duration(path: Path) -> float:
    from app.routes.assembly import _probe_duration as _pd

    return await _pd(path)


async def _probe_video_size(path: Path) -> tuple[int, int]:
    proc = await asyncio.create_subprocess_exec(
        "ffprobe", "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x", str(path),
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    out, _ = await proc.communicate()
    try:
        w, h = out.decode().strip().split("x")
        return int(w), int(h)
    except (ValueError, AttributeError):
        return 768, 432


def _voice_local_path(url: str) -> Path:
    return drama_output_root() / "studio" / url.rsplit("/", 1)[-1]


async def _fit_voice(url: str, slot: float, tmp_dir: Path, index: int) -> tuple[Path, float]:
    """配音对齐镜时槽(atempo ≤1.3;超长保留原样)——复用 drama 链实现。"""
    from app.routes.drama_studio import _fit_voice_to_slot

    src = _voice_local_path(url)
    fitted, rec = await _fit_voice_to_slot(src, slot, tmp_dir, index)
    return fitted, float(rec.get("final_duration") or rec.get("src_duration") or slot)


async def _assemble_film(
    clips: list[dict],
    out_mp4: Path,
    ass_path: Path | None,
    fps: int,
) -> tuple[int, int]:
    """一条 filter_complex 成片:逐镜 trim/tpad/归一 → concat → 配音 adelay+amix → 烧字。

    clips: [{path, duration(计划), voice:{path, start} | None}]
    ass_path:有台词且有内容时的 ASS 路径(libass 在才烧;否则 drawtext 段级兜底)。
    返回 (宽, 高)。
    """
    w0, h0 = await _probe_video_size(clips[0]["path"])
    # 归一目标:偶数,不过 1080p
    tw = min(w0 - (w0 % 2), 1920)
    th = min(h0 - (h0 % 2), 1080)

    cmd: list[str] = [_FFMPEG_BIN, "-y"]
    for c in clips:
        cmd += ["-i", str(c["path"])]
    voice_clips = [c for c in clips if c.get("voice")]
    for c in voice_clips:
        cmd += ["-i", str(c["voice"]["path"])]

    fc: list[str] = []
    for i, c in enumerate(clips):
        slot = float(c["duration"])
        fc.append(
            f"[{i}:v]trim=0:{slot:.3f},setpts=PTS-STARTPTS,"
            f"tpad=stop_mode=clone:stop={slot:.3f},trim=0:{slot:.3f},setpts=PTS-STARTPTS,"
            f"scale={tw}:{th}:force_original_aspect_ratio=decrease,"
            f"pad={tw}:{th}:(ow-iw)/2:(oh-ih)/2,fps={fps},format=yuv420p,setsar=1[v{i}]"
        )
    fc.append("".join(f"[v{i}]" for i in range(len(clips))) + f"concat=n={len(clips)}:v=1:a=0[vcat]")

    v_final = "vcat"
    if ass_path is not None and await _has_libass():
        safe = str(ass_path).replace("\\", "/").replace(":", "\\:")
        fc.append(f"[vcat]ass='{safe}'[vsub]")
        v_final = "vsub"

    total = sum(float(c["duration"]) for c in clips)
    n_voice_inputs = len(voice_clips)
    fc.append(f"anullsrc=r=24000:cl=mono,atrim=0:{total:.3f}[sil]")
    for j, c in enumerate(voice_clips):
        src_idx = len(clips) + j
        delay_ms = round(float(c["voice"]["start"]) * 1000)
        fc.append(f"[{src_idx}:a]aresample=24000,adelay={delay_ms}|{delay_ms}[a{j}]")
    mix_inputs = "[sil]" + "".join(f"[a{j}]" for j in range(n_voice_inputs))
    fc.append(
        f"{mix_inputs}amix=inputs={n_voice_inputs + 1}:duration=first:normalize=0,"
        f"apad,atrim=0:{total:.3f}[aout]"
    )

    filter_complex = ";".join(fc)
    cmd += [
        "-filter_complex", filter_complex,
        "-map", f"[{v_final}]", "-map", "[aout]",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
        "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart",
        str(out_mp4),
    ]
    await _run_ffmpeg(cmd)
    return tw, th


# ===========================================================================
# 编排层:逐镜状态推进(params 回填) + 四阶段管线 + reconcile
# ===========================================================================


def _write_progress(job: Job, stage: str, done: int, total: int, detail: str) -> None:
    job.progress = json.dumps(
        {"stage": stage, "done": done, "total": total, "detail": detail},
        ensure_ascii=False,
    )


def _save_plan(session: Session, job: Job, plan: dict) -> None:
    job.params = json.dumps(plan, ensure_ascii=False)
    session.add(job)
    session.commit()


def _pick_mp4(urls: list[str]) -> str:
    for u in urls:
        if re.search(r"\.(mp4|webm|mov|mkv)([?&/#]|$)", u.lower()):
            return u
    return urls[0] if urls else ""


async def _wait_job_done(prompt_id: str, deadline: float) -> list[str]:
    """E-7 多轮等待(entities 范式):单轮窗口+预算循环,held 换名透明。"""
    while True:
        with Session(db_engine) as s:
            try:
                results = await wait_for_jobs(s, [prompt_id], timeout=min(
                    _ROUND_SEC, max(30.0, deadline - time.monotonic())
                ))
                urls = results.get(prompt_id) or []
                if urls:
                    return list(urls)
            except RuntimeError:
                pass
            s.commit()  # 刷新快照再读最新状态
            job = s.exec(select(Job).where(Job.prompt_id == prompt_id)).first()
            if job is None:
                raise RuntimeError(f"引擎作业丢失: {prompt_id}")
            if job.status in ("error", "canceled"):
                raise RuntimeError(f"引擎作业失败: {job.error or job.status}")
            if job.status == "done" and job.result:
                try:
                    return list(json.loads(job.result))
                except ValueError:
                    return [job.result]
            if time.monotonic() >= deadline:
                raise RuntimeError("等待引擎作业预算耗尽")
        await asyncio.sleep(_GAP_SEC)


def _shot_meta_of(item: BoardItem | None) -> dict:
    if item is None or not item.shot_meta:
        return {}
    try:
        obj = json.loads(item.shot_meta)
        return obj if isinstance(obj, dict) else {}
    except ValueError:
        return {}


def _shot_slot(shot: dict) -> float:
    try:
        d = float(shot.get("duration_sec") or 6)
    except (ValueError, TypeError):
        d = 6.0
    return max(_SHOT_MIN_SEC, min(_SHOT_MAX_SEC, d))


def _attach_job_to_row(session: Session, shot: dict, prompt_id: str) -> None:
    """视频就绪后换挂行(仅当行仍占位或指向旧作业);行被删则跳过不炸。"""
    item_id = shot.get("item_id")
    if not item_id:
        return
    job = session.exec(select(Job).where(Job.prompt_id == prompt_id)).first()
    item = session.get(BoardItem, int(item_id))
    if job is None or item is None:
        return
    if item.job_id != job.id:
        item.job_id = job.id
        session.add(item)
        session.commit()


async def _run_film_inner(prompt_id: str) -> None:
    with Session(db_engine) as s:
        job = s.exec(select(Job).where(Job.prompt_id == prompt_id)).first()
        if job is None or job.status in ("done", "error", "canceled"):
            return
        try:
            plan = json.loads(job.params or "{}")
        except ValueError:
            job.status = "error"
            job.error = "params 快照损坏"
            s.add(job)
            s.commit()
            return
        job.status = "running"
        shots = plan.get("shots") or []
        _write_progress(job, "videos", 0, len(shots), "逐镜生成视频")
        s.add(job)
        s.commit()
        user_id = job.user_id

    board_id = str(plan.get("board_id") or "")
    engine = str(plan.get("engine") or "phantom-s2v")
    fps = int(plan.get("fps") or 16)
    reuse = bool(plan.get("reuse_existing", True))
    burn_subs = bool(plan.get("burn_subtitles", True))
    pool = get_pool()
    deadline = time.monotonic() + get_settings().job_track_timeout

    # ── 阶段 1:videos(有界并发;单镜失败不中断;复用判定先行) ──
    vsem = asyncio.Semaphore(_VIDEO_CONCURRENCY)

    async def video_one(shot: dict) -> None:
        if shot.get("video_status") in ("done", "reused"):
            return
        async with vsem:
            # 行级复用:行已挂 done 视频作业且产物含 mp4 → 不重跑(审片循环核心)
            with Session(db_engine) as s:
                job_row = s.exec(select(Job).where(Job.prompt_id == prompt_id)).first()
                plan_now = json.loads(job_row.params)
                shot_now = next((x for x in plan_now["shots"] if x["item_id"] == shot["item_id"]), shot)
                if reuse:
                    item = s.get(BoardItem, int(shot["item_id"]))
                    if item is not None and item.job_id:
                        j = s.get(Job, item.job_id)
                        if j is not None and j.status == "done" and j.result:
                            try:
                                urls = json.loads(j.result)
                            except ValueError:
                                urls = []
                            mp4 = _pick_mp4([u for u in urls if isinstance(u, str)])
                            if mp4 and re.search(r"\.(mp4|webm|mov|mkv)([?&/#]|$)", mp4.lower()):
                                shot_now.update({"video_status": "reused", "video_url": mp4,
                                                 "video_prompt_id": j.prompt_id})
                                _save_plan(s, job_row, plan_now)
                                return
                # 提交引擎
                user = s.get(User, user_id)
                meta = dict(shot_now.get("meta") or {})
                try:
                    result = await submit_shot_generation(
                        s, pool, user, meta, engine, fps=fps
                    )
                except Exception as e:
                    shot_now.update({"video_status": "error", "error": str(e)[:300]})
                    _save_plan(s, job_row, plan_now)
                    return
                pid = str(result.get("prompt_id") or "")
                shot_now["video_prompt_id"] = pid
                shot_now["video_status"] = "submitted"
                _save_plan(s, job_row, plan_now)
            try:
                urls = await _wait_job_done(pid, deadline)
                video_url = _pick_mp4([u for u in urls if isinstance(u, str)])
            except Exception as e:
                with Session(db_engine) as s:
                    job_row = s.exec(select(Job).where(Job.prompt_id == prompt_id)).first()
                    plan_now = json.loads(job_row.params)
                    shot_now = next((x for x in plan_now["shots"] if x["item_id"] == shot["item_id"]), shot)
                    shot_now.update({"video_status": "error", "error": str(e)[:300]})
                    _save_plan(s, job_row, plan_now)
                return
            with Session(db_engine) as s:
                job_row = s.exec(select(Job).where(Job.prompt_id == prompt_id)).first()
                plan_now = json.loads(job_row.params)
                shot_now = next((x for x in plan_now["shots"] if x["item_id"] == shot["item_id"]), shot)
                shot_now.update({"video_status": "done", "video_url": video_url})
                _save_plan(s, job_row, plan_now)
                _attach_job_to_row(s, shot_now, pid)
            await _tick_progress(prompt_id, "videos")

    async def _tick_progress(pid: str, stage: str) -> None:
        with Session(db_engine) as s:
            job_row = s.exec(select(Job).where(Job.prompt_id == pid)).first()
            if job_row is None:
                return
            plan_now = json.loads(job_row.params)
            done_n = sum(1 for x in plan_now["shots"] if x.get("video_status") in ("done", "reused", "error"))
            _write_progress(job_row, stage, done_n, len(plan_now["shots"]),
                            "逐镜生成视频" if stage == "videos" else stage)
            s.add(job_row)
            s.commit()

    await asyncio.gather(*(video_one(sh) for sh in shots))

    # 成片镜集合(无视频镜跳过不进片)
    with Session(db_engine) as s:
        job_row = s.exec(select(Job).where(Job.prompt_id == prompt_id)).first()
        plan = json.loads(job_row.params)
    film_shots = [x for x in plan["shots"] if x.get("video_status") in ("done", "reused")]
    if not film_shots:
        _set_job_error(prompt_id, "没有可用的分镜视频(全部生成失败或被跳过)")
        return

    # 时间轴(按 sort 序累计计划时长)——落 params(words/assemble 阶段与重启续跑的事实源)
    cursor = 0.0
    for x in film_shots:
        x["start"] = round(cursor, 3)
        cursor += _shot_slot(x)
        x["end"] = round(cursor, 3)
    with Session(db_engine) as s:
        job_row = s.exec(select(Job).where(Job.prompt_id == prompt_id)).first()
        plan_now = json.loads(job_row.params)
        for x in film_shots:
            target = next((y for y in plan_now["shots"] if y["item_id"] == x["item_id"]), None)
            if target is not None:
                target["start"], target["end"] = x["start"], x["end"]
        _save_plan(s, job_row, plan_now)

    # ── 阶段 2:voices(仅台词镜;IndexTTS 单卡串行) ──
    with Session(db_engine) as s:
        job_row = s.exec(select(Job).where(Job.prompt_id == prompt_id)).first()
        _write_progress(job_row, "voices", 0, sum(1 for x in film_shots if x.get("dialogue")),
                        "逐镜配音")
        s.add(job_row)
        s.commit()

    vosem = asyncio.Semaphore(_VOICE_CONCURRENCY)

    async def voice_one(shot: dict) -> None:
        dialogue = str(shot.get("dialogue") or "").strip()
        if dialogue and shot.get("voice_status") != "done":
            async with vosem:
                try:
                    with Session(db_engine) as s:
                        entities = resolve_shot_entities(s, user_id, shot.get("meta") or {})
                    url, dur, source = await _synth_voice(
                        dialogue, str(shot.get("speaker") or "").strip(), entities
                    )
                    slot = _shot_slot(shot)
                    tmp = drama_output_root() / ".board-film-tmp"
                    tmp.mkdir(parents=True, exist_ok=True)
                    fitted, final_dur = await _fit_voice(url, slot, tmp, int(shot.get("item_id") or 0))
                    shot.update({
                        "voice_status": "done", "voice_url": url, "voice_source": source,
                        "voice_path": str(fitted), "voice_dur": round(final_dur, 3),
                    })
                except Exception as e:
                    shot.update({"voice_status": "error", "voice_error": str(e)[:300],
                                 "words_status": "skip"})
        elif not dialogue:
            shot["voice_status"] = "skip"
        # skip/done/error 统一回填+进度(无台词镜的 skip 也须落 params)
        with Session(db_engine) as s:
            job_row = s.exec(select(Job).where(Job.prompt_id == prompt_id)).first()
            plan_now = json.loads(job_row.params)
            target = next((x for x in plan_now["shots"] if x["item_id"] == shot["item_id"]), None)
            if target is not None:
                target.update({k: v for k, v in shot.items() if k.startswith(("voice", "words"))})
            done_n = sum(1 for x in plan_now["shots"]
                         if x.get("voice_status") in ("done", "error", "skip"))
            _write_progress(job_row, "voices", done_n,
                            sum(1 for x in plan_now["shots"] if x.get("dialogue")), "逐镜配音")
            _save_plan(s, job_row, plan_now)

    await asyncio.gather(*(voice_one(sh) for sh in film_shots))

    # ── 阶段 3:words(逐镜配音听写逐词;仅配音成功镜) ──
    with Session(db_engine) as s:
        job_row = s.exec(select(Job).where(Job.prompt_id == prompt_id)).first()
        plan = json.loads(job_row.params)
        film_shots = [x for x in plan["shots"] if x.get("video_status") in ("done", "reused")]
        _write_progress(job_row, "words", 0,
                        sum(1 for x in film_shots if x.get("voice_status") == "done"), "词锚定字幕")
        s.add(job_row)
        s.commit()

    for shot in film_shots:
        if shot.get("voice_status") != "done":
            continue
        if shot.get("words_status") in ("done", "fallback"):
            continue
        words, tag = await _transcribe_words(
            Path(shot["voice_path"]),
            float(shot["start"]), float(shot["end"]),
            str(shot.get("dialogue") or ""),
        )
        shot["words"] = words
        shot["words_status"] = "done" if tag in ("external", "builtin") else "fallback"
        with Session(db_engine) as s:
            job_row = s.exec(select(Job).where(Job.prompt_id == prompt_id)).first()
            plan_now = json.loads(job_row.params)
            target = next((x for x in plan_now["shots"] if x["item_id"] == shot["item_id"]), None)
            if target is not None:
                target["words"] = words
                target["words_status"] = shot["words_status"]
            done_n = sum(1 for x in plan_now["shots"] if x.get("words_status") in ("done", "fallback"))
            _write_progress(job_row, "words", done_n,
                            sum(1 for x in plan_now["shots"] if x.get("voice_status") == "done"),
                            "词锚定字幕")
            _save_plan(s, job_row, plan_now)

    # ── 阶段 4:assemble ──
    with Session(db_engine) as s:
        job_row = s.exec(select(Job).where(Job.prompt_id == prompt_id)).first()
        plan = json.loads(job_row.params)
        film_shots = [x for x in plan["shots"] if x.get("video_status") in ("done", "reused")]
        _write_progress(job_row, "assemble", 0, 1, "ffmpeg 拼接")
        s.add(job_row)
        s.commit()

    tmp_dir = drama_output_root() / ".board-film-tmp"
    tmp_dir.mkdir(parents=True, exist_ok=True)
    clips: list[dict] = []
    for i, x in enumerate(film_shots):
        dest = tmp_dir / f"film-{prompt_id[-8:]}-{i:03d}.mp4"
        await _download_clip(pool, str(x["video_url"]), dest)
        slot = _shot_slot(x)
        clip: dict[str, Any] = {"path": dest, "duration": slot}
        if x.get("voice_status") == "done" and x.get("voice_path"):
            clip["voice"] = {"path": Path(x["voice_path"]), "start": float(x["start"])}
        clips.append(clip)

    sub_entries = []
    for x in film_shots:
        if not str(x.get("dialogue") or "").strip():
            continue
        entry: dict[str, Any] = {
            "start": float(x["start"]), "end": float(x["end"]),
            "speaker": str(x.get("speaker") or ""), "text": str(x.get("dialogue") or ""),
        }
        if x.get("words"):
            entry["words"] = x["words"]
        sub_entries.append(entry)

    stem = f"board-film-{uuid.uuid4().hex}"
    out_mp4 = drama_output_root() / f"{stem}.mp4"
    ass_path: Path | None = None
    if burn_subs and sub_entries:
        ass_text = build_karaoke_ass(sub_entries, 1280, 720)  # PlayRes 与输出分辨率在拼接后校正(见下)
        ass_path = drama_output_root() / f"{stem}.ass"
        ass_path.write_text(ass_text, encoding="utf-8")
        (drama_output_root() / f"{stem}.srt").write_text(words_to_srt(sub_entries), encoding="utf-8")

    w, h = await _assemble_film(clips, out_mp4, ass_path, fps)
    # ASS 的 PlayRes 若与真实输出不符,重写一次并重烧成本高——PlayRes 仅影响字幕缩放比例,
    # 1280x720 为 libass 参考系,与实际输出按比例自适应,不重写(误差可忽略)。

    _set_job_done(
        prompt_id,
        [f"/api/boards/film/{out_mp4.name}"],
        extra={
            "ass_url": f"/api/boards/film/{stem}.ass" if ass_path else "",
            "srt_url": f"/api/boards/film/{stem}.srt" if ass_path else "",
            "width": w, "height": h,
        },
    )


async def _run_film(prompt_id: str) -> None:
    try:
        await _run_film_inner(prompt_id)
    except Exception as e:
        logger.exception("board_film 管线异常: %s", prompt_id)
        _set_job_error(prompt_id, str(e)[:500])
    finally:
        _ACTIVE.discard(prompt_id)


def _set_job_done(prompt_id: str, urls: list[str], extra: dict | None = None) -> None:
    with Session(db_engine) as s:
        job = s.exec(select(Job).where(Job.prompt_id == prompt_id)).first()
        if job is None or job.status in ("done", "error", "canceled"):
            return
        job.status = "done"
        job.result = json.dumps(urls, ensure_ascii=False)
        if extra:
            try:
                plan = json.loads(job.params or "{}")
                plan["film"] = extra
                job.params = json.dumps(plan, ensure_ascii=False)
            except ValueError:
                pass
        _write_progress(job, "done", 1, 1, "成片完成")
        s.add(job)
        s.commit()


def _set_job_error(prompt_id: str, message: str) -> None:
    with Session(db_engine) as s:
        job = s.exec(select(Job).where(Job.prompt_id == prompt_id)).first()
        if job is None or job.status in ("done", "error", "canceled"):
            return
        job.status = "error"
        job.error = message[:500]
        s.add(job)
        s.commit()


def spawn_film(prompt_id: str) -> None:
    """幂等 spawn:同一 prompt_id 不重复起任务。"""
    if prompt_id in _ACTIVE:
        return
    _ACTIVE.add(prompt_id)
    task = asyncio.create_task(_run_film(prompt_id), name=f"board-film:{prompt_id}")
    _BG_TASKS.add(task)
    task.add_done_callback(_BG_TASKS.discard)


def reconcile_board_films() -> int:
    """启动重挂:扫非终态 board_film 作业 respawn(params 快照=续跑事实源)。"""
    n = 0
    with Session(db_engine) as s:
        rows = s.exec(
            select(Job).where(Job.kind == KIND, Job.status.in_(("queued", "running")))
        ).all()
        for job in rows:
            try:
                plan = json.loads(job.params or "{}")
            except ValueError:
                plan = {}
            if not plan.get("board_id"):
                job.status = "error"
                job.error = "params 快照缺 board_id,无法续跑"
                s.add(job)
                s.commit()
                continue
            spawn_film(job.prompt_id)
            n += 1
    if n:
        logger.info("board_film reconcile: 重挂 %d 个中断管线", n)
    return n


def build_film_plan_shots(items: list[BoardItem]) -> list[dict]:
    """端点用:从板成员构造 params.shots 快照(空 prompt 且无作业的行跳过)。"""
    shots: list[dict] = []
    for it in items:
        meta = _shot_meta_of(it)
        prompt = str(meta.get("prompt") or meta.get("scene") or "").strip() or it.shot_text.strip()
        if not prompt and not it.job_id:
            continue
        # 手动占位行无 shot_meta:shot_text 作 scene 兜底(与 generate 路由同语义)
        if not str(meta.get("scene") or "").strip() and it.shot_text.strip():
            meta = {**meta, "scene": it.shot_text.strip()}
        shots.append(
            {
                "item_id": it.id,
                "sort_order": it.sort_order,
                "duration_sec": _shot_slot(meta),
                "dialogue": str(meta.get("dialogue") or ""),
                "speaker": str(meta.get("speaker") or ""),
                "meta": meta,
                "video_status": "",
                "voice_status": "",
                "words_status": "",
            }
        )
    return shots


def start_board_film(
    session: Session,
    user: User,
    board: Board,
    engine: str,
    fps: int = 16,
    reuse_existing: bool = True,
    burn_subtitles: bool = True,
) -> Job:
    """建一键成片合成 Job + 起后台管线(assemble 路由与 agent 工具共用)。

    空板/无可成片行 422;同板已有活跃作业 409(返回文案含在跑 prompt_id)。
    """
    items = session.exec(
        select(BoardItem).where(BoardItem.board_id == board.id).order_by(BoardItem.sort_order)
    ).all()
    shots = build_film_plan_shots(items)
    if not shots:
        raise HTTPException(status_code=422, detail="没有可成片的分镜行(请先拆镜或补分镜文本)")
    active = session.exec(
        select(Job).where(Job.kind == KIND, Job.status.in_(("queued", "running")))
    ).all()
    for j in active:
        try:
            if json.loads(j.params or "{}").get("board_id") == board.id:
                raise HTTPException(
                    status_code=409,
                    detail=f"已有在跑的成片作业: {j.prompt_id}(可等完成或取消后再发)",
                )
        except ValueError:
            continue
    prompt_id = f"film-{uuid.uuid4().hex[:16]}"
    plan = {
        "board_id": board.id,
        "engine": engine,
        "fps": fps,
        "reuse_existing": reuse_existing,
        "burn_subtitles": burn_subtitles,
        "shots": shots,
    }
    job = Job(
        tenant_id=user.tenant_id,
        user_id=user.id,
        prompt_id=prompt_id,
        worker="",  # 非 ComfyUI 作业:tracker 自动跳过,生命周期归 board_film 管线
        kind=KIND,
        status="queued",
        prompt=board.name[:500],
        seed=0,
        params=json.dumps(plan, ensure_ascii=False),
    )
    session.add(job)
    session.commit()
    spawn_film(prompt_id)
    return job
