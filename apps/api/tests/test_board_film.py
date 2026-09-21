"""一键成片(M3)——字幕纯函数/成片端点/编排管线(全 fake)/reconcile。"""
from __future__ import annotations

import asyncio
import json
import uuid
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

import app.routes.boards as boards_route
import app.services.board_film as film
from app.db import get_session
from app.main import app
from app.models import Job, Tenant, User
from app.security import create_token, hash_password


# ---------------------------------------------------------------------------
# 纯函数
# ---------------------------------------------------------------------------


def test_even_split_words_cjk_and_latin():
    ws = film.even_split_words("夜雨寄北", 1.0, 5.0)
    assert len(ws) == 4
    assert ws[0] == {"start": 1.0, "end": 2.0, "text": "夜"}
    assert ws[-1]["end"] == 5.0
    ws2 = film.even_split_words("hello brave world", 0.0, 3.0)
    assert [w["text"] for w in ws2] == ["hello", "brave", "world"]
    assert film.even_split_words("", 0, 3) == []
    assert film.even_split_words("x", 3, 3) == []


def test_clamp_words_trims_to_slot():
    ws = [
        {"start": 0.5, "end": 1.0, "text": "a"},  # 钳后零长 → 丢弃
        {"start": 1.2, "end": 2.0, "text": "ok"},
        {"start": 4.5, "end": 7.0, "text": "b"},  # 越槽尾(mlx padding 虚高)→ 截到槽尾
        {"start": 5.2, "end": 5.4, "text": ""},   # 空词丢弃
    ]
    out = film.clamp_words(ws, 1.0, 5.0)
    assert out == [
        {"start": 1.2, "end": 2.0, "text": "ok"},
        {"start": 4.5, "end": 5.0, "text": "b"},
    ]


def test_build_karaoke_ass_structure():
    ass = film.build_karaoke_ass(
        [
            {"start": 0.0, "end": 4.0, "speaker": "林凡", "text": "我一定要走出这座山",
             "words": [
                 {"start": 0.0, "end": 0.5, "text": "我"},
                 {"start": 0.5, "end": 1.2, "text": "一定"},
             ]},
            {"start": 4.0, "end": 6.0, "speaker": "", "text": "纯旁白行"},
        ],
        1280, 720,
    )
    assert "PlayResX: 1280" in ass and "PlayResY: 720" in ass
    assert "【林凡】" in ass
    assert "{\\k50}我" in ass and "{\\k70}一定" in ass  # 0.5s/0.7s → 50/70 cs
    assert "Dialogue: 0,0:00:00.00,0:00:04.00" in ass
    assert "纯旁白行" in ass and "【旁白】" not in ass.split("纯旁白行")[0].split("Dialogue")[-1]


def test_words_to_srt():
    srt = film.words_to_srt([
        {"start": 0.0, "end": 2.5, "speaker": "小雪", "text": "谁在那里?"},
        {"start": 2.5, "end": 4.0, "speaker": "", "text": ""},  # 空文本跳过
    ])
    assert srt.startswith("1\n00:00:00,000 --> 00:00:02,500\n【小雪】谁在那里?")


# ---------------------------------------------------------------------------
# 端点
# ---------------------------------------------------------------------------


@pytest.fixture
def ctx():
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)

    def override():
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override
    with Session(engine) as s:
        tenant = Tenant(name="t")
        s.add(tenant)
        s.commit()
        s.refresh(tenant)
        u1 = User(email="f1@t.io", hashed_password=hash_password("x1"), tenant_id=tenant.id)
        u2 = User(email="f2@t.io", hashed_password=hash_password("x2"), tenant_id=tenant.id)
        s.add(u1); s.add(u2)
        s.commit()
        s.refresh(u1); s.refresh(u2)
        t1 = create_token(u1.id)
        t2 = create_token(u2.id)
    client = TestClient(app)
    yield client, t1, t2, engine
    app.dependency_overrides.pop(get_session, None)


@pytest.fixture(autouse=True)
def _patch_film_engine(request, ctx, monkeypatch):
    """编排管线直连 app.db.engine(短 Session 纪律),测试统一换到夹具内存库。"""
    _, _, _, engine = ctx
    monkeypatch.setattr(film, "db_engine", engine)


def _mk_board(ctx, rows: list[dict]) -> tuple[str, object]:
    c, t1, _, _ = ctx
    H = {"Authorization": f"Bearer {t1}"}
    bid = c.post("/api/boards", json={"name": "成片测试板"}, headers=H).json()["id"]
    items = [
        {"job_id": "", "shot_text": r.get("shot_text", ""),
         "shot_meta": json.dumps(r.get("meta", {}), ensure_ascii=False)}
        for r in rows
    ]
    r = c.put(f"/api/boards/{bid}/items", json={"items": items}, headers=H)
    assert r.status_code == 200, r.text
    return bid, H


def test_assemble_endpoint_creates_job(ctx, monkeypatch):
    c, t1, t2, _ = ctx
    bid, H = _mk_board(ctx, [
        {"meta": {"prompt": "p1", "duration_sec": 4, "dialogue": "台词一", "speaker": "林凡"}},
        {"shot_text": "手动行文本"},
    ])
    spawned = []
    monkeypatch.setattr(boards_route, "spawn_film", lambda pid: spawned.append(pid))

    r = c.post(f"/api/boards/{bid}/assemble", json={"engine": "h3-t2v"}, headers=H)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["kind"] == "board_film" and body["prompt_id"].startswith("film-")
    assert spawned == [body["prompt_id"]]

    _, _, _, engine = ctx
    from sqlmodel import select
    with Session(engine) as s:
        job = s.exec(select(Job).where(Job.prompt_id == body["prompt_id"])).first()
    assert job.worker == "" and job.kind == "board_film" and job.status == "queued"
    plan = json.loads(job.params)
    assert plan["board_id"] == bid and plan["engine"] == "h3-t2v"
    assert len(plan["shots"]) == 2
    assert plan["shots"][0]["dialogue"] == "台词一"
    # 手动行:shot_text → meta.scene 兜底
    assert plan["shots"][1]["meta"]["scene"] == "手动行文本"

    # film-jobs 形状
    fj = c.get(f"/api/boards/{bid}/film-jobs", headers=H).json()
    assert len(fj) == 1 and fj[0]["prompt_id"] == body["prompt_id"]
    assert fj[0]["status"] == "queued"

    # 防重:活跃期再发 → 409
    r = c.post(f"/api/boards/{bid}/assemble", json={}, headers=H)
    assert r.status_code == 409

    # 空板 422;他人 404
    bid2, _ = _mk_board(ctx, [])
    assert c.post(f"/api/boards/{bid2}/assemble", json={}, headers=H).status_code == 422
    assert c.post(f"/api/boards/{bid}/assemble", json={},
                  headers={"Authorization": f"Bearer {t2}"}).status_code == 404


def test_film_file_endpoint_guard(ctx, tmp_path, monkeypatch):
    c, t1, _, _ = ctx
    H = {"Authorization": f"Bearer {t1}"}
    monkeypatch.setattr(boards_route, "drama_output_root", lambda: tmp_path)
    assert c.get("/api/boards/film/evil.txt", headers=H).status_code == 400
    assert c.get(f"/api/boards/film/board-film-{'0' * 32}.mp4", headers=H).status_code == 404
    (tmp_path / f"board-film-{'a' * 32}.srt").write_text("1\n00:00:00,000 --> 00:00:01,000\nx\n")
    r = c.get(f"/api/boards/film/board-film-{'a' * 32}.srt", headers=H)
    assert r.status_code == 200 and "x" in r.text


# ---------------------------------------------------------------------------
# 编排管线(全 fake)
# ---------------------------------------------------------------------------


def _install_fakes(monkeypatch, tmp_path: Path, *, fail_items: set[int] | None = None):
    """接管一切外部依赖:引擎提交/等待/TTS/对齐/听写/下载/ffmpeg。"""
    monkeypatch.setattr(film, "drama_output_root", lambda: tmp_path)
    calls = {"submit": []}
    fail_items = fail_items or set()

    async def fake_submit(session, pool, user, meta, engine, seed=None, fps=16):
        calls["submit"].append(meta.get("scene") or meta.get("prompt"))
        item_id = len(calls["submit"])
        if item_id in fail_items:
            raise RuntimeError("引擎不可用(测试注入)")
        # 真实引擎路由会落 Job;fake 补一行供换挂(_attach_job_to_row 按 prompt_id 反查)
        pid = f"eng-{item_id}"
        session.add(Job(id=uuid.uuid4().hex, prompt_id=pid, tenant_id=user.tenant_id,
                        user_id=user.id, worker="w", kind="h3_t2v", status="done",
                        prompt="fake", seed=1, result=f'["/api/images?filename={pid}.mp4&worker=w"]'))
        session.commit()
        return {"prompt_id": pid}

    async def fake_wait(pid, deadline):
        return [f"/api/images?filename={pid}.mp4&worker=w"]

    async def fake_synth(text, speaker, entities):
        wav = tmp_path / "studio" / f"{uuid.uuid4().hex}.wav"
        wav.parent.mkdir(parents=True, exist_ok=True)
        wav.write_bytes(b"RIFFfake")
        return f"/api/studio/files/{wav.name}", 3.0, "default"

    async def fake_fit(url, slot, tmp_dir, index):
        return tmp_path / "studio" / url.rsplit("/", 1)[-1], min(3.0, slot)

    async def fake_words(path, start, end, text):
        return ([{"start": start, "end": start + 0.5, "text": "台"},
                 {"start": start + 0.5, "end": end, "text": "词"}], "builtin")

    async def fake_download(pool, url, dest):
        dest.write_bytes(b"MP4fake")

    async def fake_assemble(clips, out_mp4, ass_path, fps):
        out_mp4.write_bytes(b"MP4OUT")
        return 1280, 720

    monkeypatch.setattr(film, "submit_shot_generation", fake_submit)
    monkeypatch.setattr(film, "_wait_job_done", fake_wait)
    monkeypatch.setattr(film, "_synth_voice", fake_synth)
    monkeypatch.setattr(film, "_fit_voice", fake_fit)
    monkeypatch.setattr(film, "_transcribe_words", fake_words)
    monkeypatch.setattr(film, "_download_clip", fake_download)
    monkeypatch.setattr(film, "_assemble_film", fake_assemble)
    return calls


def _mk_film_job(ctx, monkeypatch, rows: list[dict], *, engine="phantom-s2v") -> tuple[str, str, object]:
    """走端点建作业(spawn 打住),返回 (board_id, prompt_id, H)。"""
    bid, H = _mk_board(ctx, rows)
    c, _, _, _ = ctx
    monkeypatch.setattr(boards_route, "spawn_film", lambda pid: None)
    r = c.post(f"/api/boards/{bid}/assemble", json={"engine": engine}, headers=H)
    assert r.status_code == 200, r.text
    return bid, r.json()["prompt_id"], H


def _run(pid: str) -> None:
    asyncio.run(film._run_film_inner(pid))


def test_pipeline_happy_path(ctx, monkeypatch, tmp_path):
    _install_fakes(monkeypatch, tmp_path)
    rows = [
        {"meta": {"prompt": "雨夜破庙", "duration_sec": 4, "dialogue": "谁在那里?", "speaker": "小雪",
                  "characters": ["小雪"], "entity_ids": []}},
        {"meta": {"prompt": "庙门推开", "duration_sec": 3}},
    ]
    bid, pid, _ = _mk_film_job(ctx, monkeypatch, rows)
    _run(pid)

    _, _, _, engine = ctx
    from sqlmodel import select
    with Session(engine) as s:
        job = s.exec(select(Job).where(Job.prompt_id == pid)).first()
    assert job.status == "done", job.error
    urls = json.loads(job.result)
    assert urls[0].startswith("/api/boards/film/board-film-") and urls[0].endswith(".mp4")
    plan = json.loads(job.params)
    s1, s2 = plan["shots"]
    assert s1["video_status"] == "done" and s1["voice_status"] == "done"
    assert s1["words_status"] == "done" and s1["words"][0]["text"] == "台"
    assert s2["video_status"] == "done" and s2["voice_status"] == "skip"
    assert s1["start"] == 0.0 and s1["end"] == 4.0 and s2["start"] == 4.0 and s2["end"] == 7.0
    assert plan["film"]["ass_url"].endswith(".ass") and plan["film"]["width"] == 1280
    # ass/srt 侧车落盘
    stem = urls[0].rsplit("/", 1)[-1].replace(".mp4", "")
    assert (tmp_path / f"{stem}.ass").read_text(encoding="utf-8").count("\\k") >= 2
    assert (tmp_path / f"{stem}.srt").exists()
    # 行已换挂(占位行 → 新引擎作业)
    with Session(engine) as s:
        from app.models import BoardItem
        items = s.exec(select(BoardItem).where(BoardItem.board_id == bid)).all()
        assert all(it.job_id for it in items)


def test_pipeline_reuse_existing(ctx, monkeypatch, tmp_path):
    calls = _install_fakes(monkeypatch, tmp_path)
    # 行预挂 done 视频作业
    _, _, _, engine = ctx
    from sqlmodel import select
    with Session(engine) as s:
        u = s.exec(select(User).where(User.email == "f1@t.io")).first()
        vjob = Job(id=uuid.uuid4().hex, prompt_id=uuid.uuid4().hex, tenant_id=u.tenant_id,
                   user_id=u.id, worker="w", kind="h3_t2v", status="done",
                   prompt="已有视频", seed=1,
                   result='["/api/images?filename=old.mp4&worker=w"]')
        s.add(vjob)
        s.commit()
        s.refresh(vjob)
        vid = vjob.id
    c, t1, _, _ = ctx
    H = {"Authorization": f"Bearer {t1}"}
    bid = c.post("/api/boards", json={"name": "复用板"}, headers=H).json()["id"]
    meta = json.dumps({"prompt": "已有视频"}, ensure_ascii=False)
    c.put(f"/api/boards/{bid}/items", json={"items": [{"job_id": vid, "shot_meta": meta}]}, headers=H)
    monkeypatch.setattr(boards_route, "spawn_film", lambda pid: None)
    pid = c.post(f"/api/boards/{bid}/assemble", json={"engine": "h3-t2v"}, headers=H).json()["prompt_id"]
    _run(pid)

    assert calls["submit"] == []  # 复用未提交引擎
    with Session(engine) as s:
        job = s.exec(select(Job).where(Job.prompt_id == pid)).first()
    plan = json.loads(job.params)
    assert plan["shots"][0]["video_status"] == "reused"
    assert "old.mp4" in plan["shots"][0]["video_url"]


def test_pipeline_shot_failure_nonfatal(ctx, monkeypatch, tmp_path):
    calls = _install_fakes(monkeypatch, tmp_path, fail_items={1})
    rows = [{"meta": {"prompt": "会失败"}, "shot_text": ""}, {"meta": {"prompt": "能成功", "duration_sec": 2}}]
    _, pid, _ = _mk_film_job(ctx, monkeypatch, rows)
    _run(pid)

    _, _, _, engine = ctx
    from sqlmodel import select
    with Session(engine) as s:
        job = s.exec(select(Job).where(Job.prompt_id == pid)).first()
    assert job.status == "done", job.error  # 另一镜仍成片
    plan = json.loads(job.params)
    assert plan["shots"][0]["video_status"] == "error"
    assert plan["shots"][1]["video_status"] == "done"
    assert len(calls["submit"]) == 2


def test_reconcile_respawns(ctx, monkeypatch):
    _, _, _, engine = ctx
    from sqlmodel import select
    with Session(engine) as s:
        u = s.exec(select(User).where(User.email == "f1@t.io")).first()
        job = Job(id=uuid.uuid4().hex, prompt_id=f"film-{uuid.uuid4().hex[:16]}",
                  tenant_id=u.tenant_id, user_id=u.id, worker="", kind="board_film",
                  status="running", prompt="x", seed=0,
                  params=json.dumps({"board_id": "b1", "shots": []}))
        s.add(job)
        s.commit()
        s.refresh(job)
        pid = job.prompt_id
    spawned = []
    monkeypatch.setattr(film, "spawn_film", lambda p: spawned.append(p))
    n = film.reconcile_board_films()
    assert n == 1 and spawned == [pid]
