"""FU2 媒体转录索引:upsert + 文本检索(ASR 打桩,真落 sqlite)。"""
from __future__ import annotations

from pathlib import Path

import pytest
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.models import MediaTranscript
from app.services import edit_transcript as et

WORDS = [{"start": 0.4, "end": 0.9, "text": "夜色 落下"}, {"start": 1.6, "end": 2.1, "text": "灯 亮了"}]


@pytest.fixture()
def session(monkeypatch, tmp_path):
    eng = create_engine("sqlite://", connect_args={"check_same_thread": False},
                        poolclass=StaticPool)
    SQLModel.metadata.create_all(eng)
    clip = tmp_path / "gen.mp4"
    clip.write_bytes(b"x")

    import app.services.board_film as bf

    async def _tw(path, s0, s1, fb):
        return [dict(w) for w in WORDS], "external"

    async def _pd(path):
        return 2.4

    monkeypatch.setattr(bf, "_transcribe_words", _tw)
    monkeypatch.setattr(bf, "_probe_duration", _pd)
    with Session(eng) as s:
        yield s, str(clip)


async def test_index_then_search(session):
    s, url = session
    summary = await et.index_media(s, url + "?token=abc")  # query 串被归一掉
    assert summary["words"] == 2 and summary["source_tag"] == "external"
    assert summary["media_url"] == url
    hits = et.search(s, "夜色")
    assert len(hits) == 1 and hits[0]["media_url"] == url
    assert any("夜色 落下" in h for h in hits[0]["hits"])
    assert et.search(s, "不存在的词") == []
    assert et.search(s, "") == []


async def test_index_upsert_not_duplicate(session):
    s, url = session
    await et.index_media(s, url)
    await et.index_media(s, url)
    from sqlmodel import select
    n = len(s.exec(select(MediaTranscript)).all())
    assert n == 1


async def test_transcribe_converts_mp4_to_wav_before_asr(monkeypatch, tmp_path):
    """mp4 直接贴给 whisper 集群=500(真机实证);必须先抽 16k 单声道 wav。"""
    import subprocess

    import app.services.board_film as bf

    mp4 = tmp_path / "take.mp4"
    subprocess.run(
        ["ffmpeg", "-y", "-f", "lavfi", "-i", "testsrc2=size=160x120:rate=24:duration=1",
         "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
         "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", str(mp4)],
        check=True, capture_output=True)
    seen: dict = {}

    async def _ext(path):
        seen["suffix"] = path.suffix
        seen["exists"] = path.is_file()
        return [{"start": 0.1, "end": 0.4, "text": "词"}]

    monkeypatch.setattr(bf, "_words_external", _ext)
    words, tag = await bf._transcribe_words(mp4, 0.0, 1.0, "")
    assert seen == {"suffix": ".wav", "exists": True}
    assert tag == "external" and words[0]["text"] == "词"
    assert not list(tmp_path.glob("*.asr16k.wav"))  # 临时 wav 用完即删
