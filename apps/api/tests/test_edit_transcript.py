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
