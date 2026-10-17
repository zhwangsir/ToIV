"""FU2 深化件 2:Packed Transcript 入库自动产出(钩子+核心逻辑+读取端点)。

覆盖:sidecar 命名(<产物名>.transcript.md,drama 输出根内)、幂等(已有不重算)、
失败只记日志不阻断、非视频过滤、spawn 可注入、mark_done 接线(纯钩子、可替换)、
whisper 兜底不产伪 transcript、/api/fusion/transcript/of-video 读取与路径安全闸。
"""
from __future__ import annotations

import asyncio
import json

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

from app.db import get_session
from app.main import app
from app.models import Job, Tenant, User
from app.security import create_token, hash_password
from app.services.media import artifact_transcript as at


@pytest.fixture
def drama_root(monkeypatch, tmp_path):
    root = tmp_path / "drama"
    root.mkdir()
    import app.storage as storage

    monkeypatch.setattr(storage, "drama_output_root", lambda: root)
    return root


WORDS = [{"start": 0.0, "end": 0.4, "text": "夜色"}, {"start": 2.0, "end": 2.4, "text": "灯亮"}]


def _ok_transcribe(words=None):
    seen = []

    async def _t(path):
        seen.append(path)
        return [dict(w) for w in (words if words is not None else WORDS)]

    return _t, seen


# ---------------------------------------------------------------- 核心逻辑

def test_artifact_filename_and_video_filter():
    assert at.artifact_filename("/api/images?filename=clip.mp4&subfolder=&type=output&worker=http://w") == "clip.mp4"
    assert at.artifact_filename("/api/boards/film/board-film-abc.mp4?token=x") == "board-film-abc.mp4"
    assert at.is_video_artifact("/api/images?filename=a.mp4&worker=http://w")
    assert not at.is_video_artifact("/api/images?filename=a.png&worker=http://w")
    assert not at.is_video_artifact("")


def test_sidecar_lives_in_drama_root(drama_root):
    assert at.sidecar_path("clip.mp4") == drama_root / "clip.transcript.md"
    video = drama_root / "sub" / "clip.mp4"
    assert at.sidecar_candidates(video)[0] == drama_root / "clip.transcript.md"  # 钩子统一落点优先


def test_produce_for_url_local_video_writes_packed_md(drama_root):
    clip = drama_root / "clip.mp4"
    clip.write_bytes(b"x")
    t, seen = _ok_transcribe()
    side = asyncio.run(at.produce_for_url(str(clip), transcribe=t))
    assert side == drama_root / "clip.transcript.md"
    assert seen == [clip]                       # 本地产物直读,不下载
    md = side.read_text(encoding="utf-8")
    assert "[000.00-000.40] 夜色" in md         # pack_transcript 的 [start-end] 口径


def test_produce_idempotent_skips_existing_transcript(drama_root):
    clip = drama_root / "clip.mp4"
    clip.write_bytes(b"x")
    (drama_root / "clip.transcript.md").write_text("已有", encoding="utf-8")
    t, seen = _ok_transcribe()
    side = asyncio.run(at.produce_for_url(str(clip), transcribe=t))
    assert side.read_text(encoding="utf-8") == "已有"   # 不重算不覆盖
    assert seen == []


def test_produce_failure_logged_not_raised(drama_root):
    clip = drama_root / "clip.mp4"
    clip.write_bytes(b"x")

    async def _boom(path):
        raise RuntimeError("whisper 挂了")

    assert asyncio.run(at.produce_for_url(str(clip), transcribe=_boom)) is None
    assert not (drama_root / "clip.transcript.md").exists()


def test_produce_remote_artifact_fetches_bytes(drama_root):
    fetched = []
    seen_bytes = []

    async def _fetch(url):
        fetched.append(url)
        return b"video-bytes"

    async def _t(path):
        seen_bytes.append(path.read_bytes())   # 临时文件喂 ASR 后即清,当调用时读
        assert drama_root not in path.parents
        return [dict(w) for w in WORDS]

    side = asyncio.run(at.produce_for_url(
        "/api/images?filename=wan_a.mp4&worker=http://w", transcribe=_t, fetch=_fetch))
    assert side == drama_root / "wan_a.transcript.md"
    assert fetched and seen_bytes == [b"video-bytes"]


def test_on_artifacts_done_filters_and_spawn_injectable():
    jobs: list[list[str]] = []

    def _spawn(work):
        jobs.append(work)  # 不真跑:接线可注入

    at.on_artifacts_done(
        ["/api/images?filename=a.mp4&worker=http://w", "/api/images?filename=b.png&worker=http://w"],
        spawn=_spawn,
    )
    assert len(jobs) == 1   # 非视频产物被过滤
    at.on_artifacts_done([], spawn=_spawn)
    at.on_artifacts_done(["/api/images?filename=c.png"], spawn=_spawn)
    assert len(jobs) == 1


def test_default_transcribe_rejects_even_split_fallback(monkeypatch, tmp_path):
    """均分兜底不是真转写:当失败抛出,不产出伪 transcript。"""
    import app.services.board_film as bf

    clip = tmp_path / "c.mp4"
    clip.write_bytes(b"x")

    async def _pd(path):
        return 2.0

    async def _tw_even(path, s0, s1, fb):
        return [{"start": 0.0, "end": 1.0, "text": "x"}], "even-split"

    async def _tw_ok(path, s0, s1, fb):
        return [{"start": 0.0, "end": 1.0, "text": "x"}], "external"

    monkeypatch.setattr(bf, "_probe_duration", _pd)
    monkeypatch.setattr(bf, "_transcribe_words", _tw_even)
    with pytest.raises(RuntimeError):
        asyncio.run(at.default_transcribe(clip))
    monkeypatch.setattr(bf, "_transcribe_words", _tw_ok)
    assert asyncio.run(at.default_transcribe(clip))[0]["text"] == "x"


# ---------------------------------------------------------------- tracker 接线

def _job_engine(monkeypatch):
    eng = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    SQLModel.metadata.create_all(eng)
    import app.comfy.tracker as tracker

    monkeypatch.setattr(tracker, "engine", eng)
    with Session(eng) as s:
        s.add(Job(tenant_id="t", user_id="u", prompt_id="p1", worker="w", kind="h3_t2v",
                  status="running"))
        s.commit()
    return eng


def test_mark_done_fires_transcript_hook(monkeypatch):
    """Job done→产物 URL 落库处(mark_done)挂的钩子=纯接线,可整体替换。"""
    import app.comfy.tracker as tracker

    _job_engine(monkeypatch)
    calls: list[list[str]] = []
    monkeypatch.setattr(tracker, "video_transcript_hook", lambda urls: calls.append(list(urls)))
    urls = ["/api/images?filename=a.mp4&worker=http://w"]
    tracker.mark_done("p1", urls)
    assert calls == [urls]
    tracker.mark_done("p1", urls)   # 幂等:done 终态不再触发
    assert len(calls) == 1


def test_mark_done_canceled_skips_hook(monkeypatch):
    import app.comfy.tracker as tracker

    eng = _job_engine(monkeypatch)
    with Session(eng) as s:
        row = s.exec(select(Job).where(Job.prompt_id == "p1")).first()
        row.status = "canceled"
        s.add(row)
        s.commit()
    calls: list[list[str]] = []
    monkeypatch.setattr(tracker, "video_transcript_hook", lambda urls: calls.append(list(urls)))
    tracker.mark_done("p1", ["/api/images?filename=a.mp4&worker=http://w"])
    assert calls == []


# ---------------------------------------------------------------- 读取端点

@pytest.fixture
def ctx(drama_root):
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    SQLModel.metadata.create_all(engine)

    def override():
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override
    with Session(engine) as s:
        t = Tenant(name="t"); s.add(t); s.commit(); s.refresh(t)
        s.add(User(id="u1", email="a@t.iv", hashed_password=hash_password("x"), tenant_id=t.id, role="user"))
        s.commit()
        h = {"Authorization": "Bearer " + create_token("u1")}
    yield TestClient(app), h, drama_root
    app.dependency_overrides.clear()


def test_transcript_of_video_reads_sidecar(ctx):
    client, h, root = ctx
    (root / "clip.transcript.md").write_text("# Packed transcript", encoding="utf-8")
    (root / "clip.mp4").write_bytes(b"x")
    r = client.get("/api/fusion/transcript/of-video", params={"path": str(root / "clip.mp4")}, headers=h)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["markdown"].startswith("# Packed transcript")
    assert body["transcript"] == "clip.transcript.md"
    # 裸产物名同样可读(远程产物视频不在盘,sidecar 在 drama 根)
    (root / "wan_a.transcript.md").write_text("md", encoding="utf-8")
    r = client.get("/api/fusion/transcript/of-video", params={"path": "wan_a.mp4"}, headers=h)
    assert r.status_code == 200 and r.json()["markdown"] == "md"


def test_transcript_of_video_missing_and_guard(ctx):
    client, h, root = ctx
    (root / "noc.mp4").write_bytes(b"x")
    r = client.get("/api/fusion/transcript/of-video", params={"path": str(root / "noc.mp4")}, headers=h)
    assert r.status_code == 404           # 视频在、尚无 transcript
    r = client.get("/api/fusion/transcript/of-video", params={"path": "/etc/hostname"}, headers=h)
    assert r.status_code == 403           # 安全闸:限 drama 输出根内
    r = client.get("/api/fusion/transcript/of-video", params={"path": "../etc/hostname"})
    assert r.status_code == 401           # 鉴权


def test_studio_writeback_fires_transcript_hook(tmp_path, monkeypatch):
    """studio 管线回写(挑候选)必须触发转写钩子——tracker.mark_done 不是 studio 落库路径。"""
    from app.services.studio import orchestrator as orch

    fired = []
    monkeypatch.setattr(orch, "_fire_video_transcript", lambda url: fired.append(url))
    from app.models import StudioShot
    import json as _json

    shot = StudioShot(project_id="p", idx=0, render_mode="video", candidates_json=_json.dumps([
        {"id": "c1", "status": "done", "url": "/api/studio/files/v.mp4"},
    ]))
    from sqlmodel import Session, SQLModel, create_engine
    from sqlalchemy.pool import StaticPool
    eng = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    SQLModel.metadata.create_all(eng)
    with Session(eng) as s:
        s.add(shot); s.commit(); s.refresh(shot)
        orch.pick_candidate(s, shot, "c1")
    assert fired == ["/api/studio/files/v.mp4"]
