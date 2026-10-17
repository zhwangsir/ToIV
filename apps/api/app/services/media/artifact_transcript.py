"""视频产物 Packed Transcript 自动产出(FU2 深化件 2 核心逻辑)。

接线:Job done→产物 URL 落库处(comfy/tracker.mark_done)调 on_artifacts_done
(纯钩子、可整体替换);本模块负责:
  1. 过滤视频产物(按产物文件名后缀);
  2. whisper 词级转写(自家集群,core env TOIV_WHISPER_URL 四址故障转移链,
     word_timestamps verbatim 口径,复用 board_film 三级链不新造客户端);
  3. media.packed_transcript.pack_transcript → 存 <产物名>.transcript.md
     (drama 输出根内,产物名=文件名去扩展名);
  4. 失败只记日志不阻断回写;同一产物幂等(已有 transcript 不重算)。
"""
from __future__ import annotations

import asyncio
import logging
import tempfile
import threading
from collections.abc import Awaitable, Callable
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

log = logging.getLogger("toiv.transcript")

VIDEO_SUFFIXES = frozenset({".mp4", ".webm", ".mov", ".mkv", ".m4v", ".avi"})
SIDE_SUFFIX = ".transcript.md"

# 产物 URL 前缀 → drama 根内落点(与 board_film._download_clip 同一映射)
_PREFIX_ROOTS = (
    ("/api/boards/film/", ""),
    ("/api/drama/output/", ""),
    ("/api/studio/files/", "studio"),
)


# ---------------------------------------------------------------- 命名/过滤

def artifact_filename(url: str) -> str:
    """产物文件名:Comfy 代理 URL 取 filename 参数,其余取 URL path 末段(去 query)。"""
    parts = urlsplit(url or "")
    if parts.query:
        name = (parse_qs(parts.query).get("filename") or [""])[0]
        if name:
            return Path(name).name
    return Path(parts.path).name or "artifact"


def is_video_artifact(url: str) -> bool:
    return Path(artifact_filename(url)).suffix.lower() in VIDEO_SUFFIXES


def sidecar_name(name: str) -> str:
    return f"{Path(name).stem}{SIDE_SUFFIX}"


def sidecar_path(name: str) -> Path:
    """<产物名>.transcript.md —— 统一落 drama 输出根内(远程产物视频不在盘)。"""
    from app.storage import drama_output_root

    return drama_output_root() / sidecar_name(name)


def sidecar_candidates(video: Path) -> list[Path]:
    """读取端点的查找序:先 drama 根(钩子统一落点),再视频同目录。"""
    from app.storage import drama_output_root

    root = drama_output_root()
    name = sidecar_name(video.name)
    out = [root / name]
    beside = video.parent / name
    if beside != out[0]:
        out.append(beside)
    return out


def resolve_local_video(url: str) -> Path | None:
    """产物 URL → 本地文件(限 drama 输出根内映射/本地路径);解析不到走字节下载。"""
    from app.storage import drama_output_root

    raw = (url or "").split("?")[0].strip()
    root = drama_output_root()
    for prefix, sub in _PREFIX_ROOTS:
        if raw.startswith(prefix):
            cand = root / sub / raw[len(prefix):]
            return cand if cand.is_file() else None
    p = Path(raw)
    return p if p.is_file() else None


# ---------------------------------------------------------------- 转写/产出

async def default_transcribe(path: Path) -> list[dict]:
    """whisper 词级转写(自家集群链,词表 [{start,end,text}])。

    均分兜底(even-split)不是真转写:当失败抛出,不产出伪 transcript。
    """
    import math

    from app.services.board_film import _probe_duration, _transcribe_words

    dur = await _probe_duration(path) or math.inf
    words, tag = await _transcribe_words(path, 0.0, dur, "")
    if tag == "even-split":
        raise RuntimeError("whisper 链不可用(均分兜底不产出 transcript)")
    return words or []


async def _produce(video: Path, side: Path, transcribe: Callable[[Path], Awaitable[list[dict]]]) -> Path | None:
    if side.is_file():  # 幂等:已有 transcript 不重算
        return side
    words = await transcribe(video)
    from app.services.media.packed_transcript import pack_transcript

    md = pack_transcript(words or []).to_markdown()
    side.parent.mkdir(parents=True, exist_ok=True)
    side.write_text(md, encoding="utf-8")
    log.info("transcript 已产出: %s(词 %d)", side.name, len(words or []))
    return side


async def produce_for_url(
    url: str,
    *,
    transcribe: Callable[[Path], Awaitable[list[dict]]] = default_transcribe,
    fetch: Callable[[str], Awaitable[bytes]] | None = None,
) -> Path | None:
    """单产物产出 sidecar;任何失败只记日志返回 None(绝不向回写链抛错)。"""
    try:
        side = sidecar_path(artifact_filename(url))
        if side.is_file():
            return side
        local = resolve_local_video(url)
        if local is not None:
            return await _produce(local, side, transcribe)
        if fetch is None:
            from app.services.eval_scorers import default_fetch_bytes as fetch  # noqa: F811
        data = await fetch(url)
        # ACT: 远程产物只落临时文件喂 ASR(大件按 P-4 不进 /tmp tmpfs),sidecar 统一进 drama 根
        tmpdir = Path(tempfile.mkdtemp(prefix="toiv_tx_", dir="/var/tmp" if Path("/var/tmp").is_dir() else None))
        tmp = tmpdir / artifact_filename(url)
        tmp.write_bytes(data)
        try:
            return await _produce(tmp, side, transcribe)
        finally:
            for f in tmpdir.iterdir():
                f.unlink(missing_ok=True)
            tmpdir.rmdir()
    except Exception:  # noqa: BLE001 — 转写钩子失败只记日志,不阻断回写
        log.warning("transcript 产出失败 %s", (url or "")[:120], exc_info=True)
        return None


# ---------------------------------------------------------------- 接线钩子

def _spawn_thread(work: Callable[[], Awaitable[None]]) -> None:
    """fire-and-forget:独立线程跑一个一次性事件循环,生命周期与 tracker 作业解耦(E-7)。"""

    def _run() -> None:
        try:
            asyncio.run(work())
        except Exception:  # noqa: BLE001
            log.warning("transcript 产出线程异常", exc_info=True)

    threading.Thread(target=_run, daemon=True, name="toiv-transcript").start()


def on_artifacts_done(
    urls: list[str],
    *,
    spawn: Callable[[Callable[[], Awaitable[None]]], None] | None = None,
) -> None:
    """纯接线入口:过滤视频产物→后台产出 sidecar(spawn 可注入;失败只记日志)。"""
    targets = [u for u in (urls or []) if is_video_artifact(u)]
    if not targets:
        return
    spawn = spawn or _spawn_thread
    for url in targets:

        def _work(u: str = url) -> Awaitable[None]:
            return _swallow(u)

        spawn(_work)


async def _swallow(url: str) -> None:
    await produce_for_url(url)
