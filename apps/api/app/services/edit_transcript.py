"""媒体转录索引：生成视频 → 词级 ASR → packed md 入库，供媒体库文本检索（FU2）。

ASR 复用 board_film 的三级链(集群 whisper → 内置 faster-whisper → 均分兜底)，
不新造客户端；packed 视图用 edit_pack(video-use MIT 并码)。
检索面=packed_md 的 ILIKE + 命中行回显，UI 归 F11 媒体库收编波。
"""
from __future__ import annotations

import json
import logging
import re
from pathlib import Path

from sqlmodel import Session, select

from app.models import MediaTranscript
from app.services import edit_pack

log = logging.getLogger("toiv.edit")


def _norm_url(url: str) -> str:
    return (url or "").split("?")[0].strip()


async def _local_path(url: str) -> Path:
    cand = Path(_norm_url(url))
    if cand.is_file():
        return cand
    if url.startswith(("http://", "https://")):
        import tempfile

        from app.services.eval_scorers import default_fetch_bytes

        data = await default_fetch_bytes(url)
        tmp = Path(tempfile.mkdtemp(prefix="toiv_tx_")) / url.rsplit("/", 1)[-1].split("?")[0][:60]
        tmp.write_bytes(data)
        return tmp
    raise ValueError(f"无法解析的媒体来源: {url[:80]}")


async def index_media(session: Session, url: str) -> dict:
    """转录+打包+upsert(同 url 覆盖)。返回索引摘要。"""
    from app.services.board_film import _probe_duration, _transcribe_words

    key = _norm_url(url)
    path = await _local_path(url)
    dur = await _probe_duration(path) or 0.0
    words, tag = await _transcribe_words(path, 0.0, dur, "")
    words = words or []
    md = edit_pack.pack_takes([{"name": Path(key).stem or key, "words": words}])
    row = session.exec(
        select(MediaTranscript).where(MediaTranscript.media_url == key)
    ).first()
    if row is None:
        row = MediaTranscript(media_url=key)
        session.add(row)
    row.packed_md = md
    row.words_json = json.dumps(words, ensure_ascii=False)
    row.duration_sec = dur
    row.source_tag = tag
    from datetime import datetime

    row.updated_at = datetime.utcnow()
    session.commit()
    session.refresh(row)
    return {"id": row.id, "media_url": key, "duration_sec": dur,
            "source_tag": tag, "phrases": md.count("\n  ["), "words": len(words)}


def search(session: Session, q: str, limit: int = 20) -> list[dict]:
    """packed_md 检索;回显命中短语行(带 [start-end])。

    归一:packed md 里词间有空格(「微 信」),用户搜自然词(「微信」)必须去空格比对;
    SQL 侧用首字符 contains 粗筛,精确比对在 Python 侧做(免加列免迁移)。
    """
    needle = (q or "").strip()
    if not needle:
        return []
    needle_flat = re.sub(r"\s+", "", needle)
    rows = session.exec(
        select(MediaTranscript).where(MediaTranscript.packed_md.contains(needle[0]))
    ).all()
    out: list[dict] = []
    for r in rows:
        if needle_flat not in re.sub(r"\s+", "", r.packed_md or ""):
            continue
        hits = [ln.strip() for ln in (r.packed_md or "").splitlines()
                if ln.strip().startswith("[") and needle_flat in re.sub(r"\s+", "", ln)]
        out.append({"media_url": r.media_url, "duration_sec": r.duration_sec,
                    "source_tag": r.source_tag, "hits": hits[:8]})
        if len(out) >= limit:
            break
    return out
