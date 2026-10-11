"""S9(2026-10-11):字幕对齐——台词↔whisper 时间轴,SRT 内嵌/外挂双出。

流程:取镜头配音(voice_url)→外部 whisper 逐词(openclaw 四址集群,复用
board_film._words_external)→词级时间轴聚合成句(按静默间隙分段)→与镜头
dialogue 台词做文本对齐(词重叠评分)→SRT 条目(起止=whisper 实测,
文本=剧本台词优先,ASR 文本兜底)。整片 SRT=按镜头序拼接(全局时间轴=
前序镜头配音时长累计)。

内嵌(ffmpeg subtitles 滤镜,输出 _sub.mp4)/外挂(.srt 文件)双出,
均落 Studio 文件域 /api/studio/files/。
"""
from __future__ import annotations

import logging
import re
from pathlib import Path

from sqlmodel import Session, select

from app.models import StudioShot

logger = logging.getLogger(__name__)

# 句间静默阈值(秒):超过则切分 SRT 条目
_GAP = 0.6
# 单条字幕最长展示秒数
_MAX_CUE = 6.0


def _fmt_ts(sec: float) -> str:
    ms = int(round(max(0.0, sec) * 1000))
    h, rem = divmod(ms, 3600_000)
    m, rem = divmod(rem, 60_000)
    s, ms2 = divmod(rem, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms2:03d}"


def words_to_cues(words: list[dict], *, gap: float = _GAP) -> list[dict]:
    """词级时间轴 → 句级 cue(静默切分 + 最长钳制)。"""
    cues: list[dict] = []
    cur: list[dict] = []
    for w in words:
        if cur and (w["start"] - cur[-1]["end"]) >= gap:
            cues.append(_mk(cur))
            cur = []
        cur.append(w)
        if w["end"] - cur[0]["start"] >= _MAX_CUE:
            cues.append(_mk(cur))
            cur = []
    if cur:
        cues.append(_mk(cur))
    return cues


def _mk(ws: list[dict]) -> dict:
    return {
        "start": ws[0]["start"],
        "end": ws[-1]["end"],
        "asr": "".join(w["text"] + (" " if _ascii(w["text"]) else "") for w in ws).strip(),
    }


def _ascii(t: str) -> bool:
    return bool(re.fullmatch(r"[A-Za-z0-9,.!?']+", t))


def _norm(t: str) -> set[str]:
    """中英混合的最简对齐键:CJK 逐字,英文小写词。"""
    out: set[str] = set()
    for ch in (t or "").lower():
        if "\u4e00" <= ch <= "\u9fff":
            out.add(ch)
    out.update(w for w in re.findall(r"[a-z0-9]+", (t or "").lower()) if len(w) > 1)
    return out


def align_cue_to_dialogue(cue_asr: str, dialogues: list[str]) -> tuple[int, float]:
    """返回 (最佳台词下标, 重叠分);无重叠 → (-1, 0)。"""
    a = _norm(cue_asr)
    if not a:
        return -1, 0.0
    best, score = -1, 0.0
    for i, d in enumerate(dialogues):
        dn = _norm(d)
        if not dn:
            continue
        ov = len(a & dn) / max(1, min(len(a), len(dn)))
        if ov > score:
            best, score = i, ov
    return best, score


def build_srt_for_shots(items: list[dict], *, offset: float = 0.0) -> str:
    """items=[{start,end,text}] → SRT 文本(全局 offset 用于整片拼接)。"""
    blocks = []
    for i, it in enumerate(items, 1):
        text = (it.get("text") or "").strip() or "…"
        blocks.append(
            f"{i}\n{_fmt_ts(it['start'] + offset)} --> {_fmt_ts(it['end'] + offset)}\n{text}\n"
        )
    return "\n".join(blocks)


def _save_studio_text(content: str, name: str) -> str:
    from app.storage import drama_output_root

    out = drama_output_root() / "studio"
    out.mkdir(parents=True, exist_ok=True)
    (out / name).write_text(content, encoding="utf-8")
    return f"/api/studio/files/{name}"


def _local_media(url: str) -> Path | None:
    """studio 文件域或 /api/images 产物(经 NAS 输出根解析,后者含 worker 参数)。"""
    from app.services.studio.orchestrator import _studio_local_path

    p = _studio_local_path(url)
    if p is not None:
        return p
    # /api/images?filename=X&subfolder=Y&type=output → NAS 输出根/Y/X
    if url.startswith("/api/images"):
        from urllib.parse import parse_qs, urlparse

        q = parse_qs(urlparse(url).query)
        fn = (q.get("filename") or [""])[0]
        sub = (q.get("subfolder") or [""])[0]
        if fn:
            for root in ("/mnt/toiv-nas/toiv/outputs", "/mnt/toiv-nas/toiv"):
                cand = Path(root) / sub / fn
                if cand.is_file():
                    return cand
    return None


async def _audio_duration(path: Path) -> float:
    """ffprobe 时长(秒);失败按 0。"""
    import asyncio

    try:
        p = await asyncio.create_subprocess_exec(
            "ffprobe", "-v", "quiet", "-show_entries", "format=duration",
            "-of", "csv=p=0", str(path),
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        out, _ = await p.communicate()
        return float(out.decode().strip() or 0)
    except (OSError, ValueError):
        return 0.0


async def transcribe_words(path: Path) -> list[dict] | None:
    """外部 whisper 逐词(复用 board_film 集群多址)。"""
    from app.services.board_film import _words_external

    try:
        return await _words_external(path)
    except Exception:  # noqa: BLE001
        return None


async def build_project_subtitles(session: Session, pid: str) -> dict:
    """整片字幕:按镜头序,配音镜走 ASR+台词对齐,未配音镜跳过。

    返回 {srt_url, cues, shots_covered, total_duration}。
    """
    shots = session.exec(
        select(StudioShot).where(StudioShot.project_id == pid).order_by(StudioShot.idx)
    ).all()
    all_cues: list[dict] = []
    offset = 0.0
    covered = 0
    for sh in shots:
        voice = (sh.voice_url or "").strip()
        if not voice:
            continue
        path = _local_media(voice)
        if path is None:
            logger.info("字幕跳过(配音文件不可达): shot=%s url=%s", str(sh.id)[:8], voice[:40])
            continue
        words = await transcribe_words(path)
        if not words:
            continue
        covered += 1
        cues = words_to_cues(words)
        dialogue = (sh.dialogue or "").strip()
        # 单镜内:所有 cue 对同一句台词对齐评分;命中则用台词文本
        for c in cues:
            text = c["asr"]
            if dialogue:
                _, score = align_cue_to_dialogue(c["asr"], [dialogue])
                if score >= 0.5:
                    text = dialogue if abs(len(cues) - 1) < 1 else text  # 单 cue 才整体换台词
            all_cues.append({"start": c["start"] + offset, "end": c["end"] + offset, "text": text})
        dur = await _audio_duration(path)
        offset += dur if dur > 0 else (cues[-1]["end"] if cues else 0.0)
    srt = build_srt_for_shots(all_cues)
    url = _save_studio_text(srt, f"subs_{pid[:12]}.srt")
    return {
        "srt_url": url,
        "cues": all_cues,
        "shots_covered": covered,
        "total_duration": round(offset, 2),
    }


async def burn_subtitles(video_url: str, srt_url: str, out_name: str) -> str:
    """内嵌:ffmpeg subtitles 滤镜 → _sub.mp4(Studio 文件域)。"""
    import asyncio

    from app.storage import drama_output_root

    vp = _local_media(video_url)
    sp = _local_media(srt_url)
    if vp is None or sp is None:
        raise RuntimeError("视频或字幕文件不可达(仅支持 studio 文件域)")
    out_dir = drama_output_root() / "studio"
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / out_name
    escaped = str(sp).replace("\\", "/").replace(":", "\\:").replace("'", "\\'")
    p = await asyncio.create_subprocess_exec(
        "ffmpeg", "-y", "-v", "error", "-i", str(vp),
        "-vf", f"subtitles='{escaped}'",
        "-c:a", "copy", str(out),
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    _, err = await p.communicate()
    if p.returncode != 0:
        raise RuntimeError(f"ffmpeg 内嵌失败: {err.decode()[:200]}")
    return f"/api/studio/files/{out_name}"
