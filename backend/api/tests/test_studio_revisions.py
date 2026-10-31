"""C1a:StudioShot 修订(studio revision)与 stale 投影——领域/API 契约测试。

锁定:
  · PUT shots:真实内容变化才留 revision(重复 PUT 不造版本);expected_revision 冲突 → 409
  · reflow 改词重排同样留 revision(不绕过)
  · 历史列表 / diff / rollback(rollback 生成新 revision,不删历史)
  · 渲染快照(source=render)捕获实际生成输入;同步/异步完成都记到发起 revision,
    用户中途编辑不会让完成结果记到新 revision(在途不杀)
  · 配音失效按字段:改 dialogue/speaker → audio stale;改 prompt → 仅 visual stale
  · 旧行无历史 → unknown(不伪造已同步);旧媒体保留
  · 幂等迁移:旧库补列 + 建 studioshotrevision 表,SQLite 可重复执行
"""
from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

import app.db as db_mod
from app.db import get_session
from app.main import app
from app.models import Job, StudioProject, StudioShot, StudioShotRevision, Tenant, User
from app.security import create_token, hash_password
from app.services.studio import orchestrator as orch
from app.services.studio import render_reconcile, voice as voice_mod


@pytest.fixture()
def ctx(monkeypatch):
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    SQLModel.metadata.create_all(engine)

    def override():
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override
    # reconcile / pipeline Job 登记走 app.db.engine —— 指到测试库
    monkeypatch.setattr(db_mod, "engine", engine)
    with Session(engine) as s:
        t = Tenant(name="rev"); s.add(t); s.commit(); s.refresh(t)
        u = User(email="rev@toiv.ai", hashed_password=hash_password("p"), tenant_id=t.id)
        s.add(u); s.commit(); s.refresh(u)
        uid = u.id
        t2 = Tenant(name="rev2"); s.add(t2); s.commit(); s.refresh(t2)
        u2 = User(email="rev2@toiv.ai", hashed_password=hash_password("p"), tenant_id=t2.id)
        s.add(u2); s.commit(); s.refresh(u2)
        uid2 = u2.id
    yield TestClient(app), create_token(uid), create_token(uid2), engine
    app.dependency_overrides.clear()


def _h(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def _mk_project(client, H, title="修订") -> str:
    r = client.post("/api/studio/projects", headers=H, json={"title": title})
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _put_shots(client, H, pid, shots):
    return client.put(f"/api/studio/projects/{pid}/shots", headers=H, json={"shots": shots})


def _revisions(client, H, sid):
    r = client.get(f"/api/studio/shots/{sid}/revisions", headers=H)
    assert r.status_code == 200, r.text
    return r.json()["revisions"]


# ── 修订创建 / 去重 / 409 ────────────────────────────────────────────────────


def test_import_creates_revision_and_edit_dedup(ctx):
    client, token, _, _ = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    r = _put_shots(client, H, pid, [
        {"scene": "镜一", "prompt": "p1", "dialogue": "台词1"},
        {"scene": "镜二", "prompt": "p2"},
    ])
    assert r.status_code == 200, r.text
    shots = r.json()["shots"]
    for s in shots:
        assert s["current_revision_id"], s
        revs = _revisions(client, H, s["id"])
        assert len(revs) == 1 and revs[0]["version"] == 1
        assert revs[0]["source"] == "imported"
        assert revs[0]["visual_fingerprint"] and revs[0]["audio_fingerprint"]

    # 重复 PUT(全同内容,含 id)→ 不造新版本
    sid1 = shots[0]["id"]
    cur = shots[0]["current_revision_id"]
    r2 = _put_shots(client, H, pid, [
        {"id": sid1, "scene": "镜一", "prompt": "p1", "dialogue": "台词1"},
        {"id": shots[1]["id"], "scene": "镜二", "prompt": "p2"},
    ])
    assert r2.status_code == 200, r2.text
    assert r2.json()["shots"][0]["current_revision_id"] == cur
    assert len(_revisions(client, H, sid1)) == 1

    # 真实内容变化 → 新版本 manual-edit
    r3 = _put_shots(client, H, pid, [
        {"id": sid1, "scene": "镜一", "prompt": "p1-changed", "dialogue": "台词1"},
        {"id": shots[1]["id"], "scene": "镜二", "prompt": "p2"},
    ])
    assert r3.status_code == 200, r3.text
    s1 = r3.json()["shots"][0]
    assert s1["current_revision_id"] != cur
    revs = _revisions(client, H, sid1)
    assert len(revs) == 2
    assert revs[0]["version"] == 2 and revs[0]["source"] == "manual-edit"


def test_expected_revision_conflict_409(ctx):
    client, token, _, _ = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    shot = _put_shots(client, H, pid, [{"scene": "A", "prompt": "a"}]).json()["shots"][0]
    rid = shot["current_revision_id"]

    r = _put_shots(client, H, pid, [
        {"id": shot["id"], "scene": "A", "prompt": "a-改",
         "expected_revision": "not-this-one"},
    ])
    assert r.status_code == 409, r.text
    # 冲突 PUT 不留 revision
    assert len(_revisions(client, H, shot["id"])) == 1

    r2 = _put_shots(client, H, pid, [
        {"id": shot["id"], "scene": "A", "prompt": "a-改", "expected_revision": rid},
    ])
    assert r2.status_code == 200, r2.text
    assert len(_revisions(client, H, shot["id"])) == 2


def test_expected_revision_missing_shot_ignores_flag(ctx):
    """新分镜(无 id)带 expected_revision 无冲突可言 → 正常创建。"""
    client, token, _, _ = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    r = _put_shots(client, H, pid, [
        {"scene": "A", "prompt": "a", "expected_revision": "whatever"},
    ])
    assert r.status_code == 200, r.text


def test_reflow_creates_revision_no_bypass(ctx):
    """改词重排(reflow)修改文本/时长 → 同样留 revision,且可去重。"""
    client, token, _, _ = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    beat = {"text": "你来了", "cues": [], "anchor_words": "", "kind": "v", "block": 0}
    shot = _put_shots(client, H, pid, [
        {"scene": "A", "prompt": "a", "dialogue": "你来了", "beats": [beat]},
    ]).json()["shots"][0]
    sid = shot["id"]
    base_rev = shot["current_revision_id"]

    r = client.post(f"/api/studio/shots/{sid}/reflow-beats", headers=H,
                    json={"texts": ["你终于来了"], "persist": True})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["current_revision_id"] != base_rev
    assert len(_revisions(client, H, sid)) == 2

    # 相同词再重排 → 内容不再变化 → 不造版本
    r2 = client.post(f"/api/studio/shots/{sid}/reflow-beats", headers=H,
                     json={"texts": ["你终于来了"], "persist": True})
    assert r2.status_code == 200, r2.text
    assert len(_revisions(client, H, sid)) == 2


# ── 历史 / diff / rollback ───────────────────────────────────────────────────


def test_history_diff_and_rollback(ctx):
    client, token, _, _ = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    shot = _put_shots(client, H, pid, [{"scene": "A", "prompt": "v1"}]).json()["shots"][0]
    sid = shot["id"]
    _put_shots(client, H, pid, [{"id": sid, "scene": "A", "prompt": "v2"}])
    _put_shots(client, H, pid, [{"id": sid, "scene": "A", "prompt": "v3"}])

    revs = _revisions(client, H, sid)
    assert [r["version"] for r in revs] == [3, 2, 1]
    r3 = revs[0]

    d = client.get(f"/api/studio/shots/{sid}/revisions/{r3['id']}/diff", headers=H)
    assert d.status_code == 200, d.text
    diff = d.json()
    assert diff["fields"]["prompt"] == {"from": "v2", "to": "v3"}
    assert diff["from_version"] == 2

    # rollback 到 v1 → 生成新 revision(version 4, source=rollback),历史不删
    rb = client.post(f"/api/studio/shots/{sid}/rollback", headers=H,
                     json={"revision_id": revs[2]["id"]})
    assert rb.status_code == 200, rb.text
    body = rb.json()
    assert body["prompt"] == "v1"
    assert body["current_revision_id"] != r3["id"]
    revs_after = _revisions(client, H, sid)
    assert [r["version"] for r in revs_after] == [4, 3, 2, 1]
    assert revs_after[0]["source"] == "rollback"

    # 重复 rollback 到同一目标:内容未变 → 不重复造版本
    rb2 = client.post(f"/api/studio/shots/{sid}/rollback", headers=H,
                      json={"revision_id": revs[2]["id"]})
    assert rb2.status_code == 200, rb2.text
    assert len(_revisions(client, H, sid)) == 4


def test_rollback_cross_shot_404(ctx):
    client, token, _, _ = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    s1, s2 = _put_shots(client, H, pid, [
        {"scene": "A", "prompt": "a"}, {"scene": "B", "prompt": "b"},
    ]).json()["shots"]
    foreign = _revisions(client, H, s2["id"])[0]["id"]
    r = client.post(f"/api/studio/shots/{s1['id']}/rollback", headers=H,
                    json={"revision_id": foreign})
    assert r.status_code == 404


def test_revision_history_tenant_isolated(ctx):
    client, token, token2, _ = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    shot = _put_shots(client, H, pid, [{"scene": "A", "prompt": "a"}]).json()["shots"][0]
    H2 = _h(token2)
    assert client.get(f"/api/studio/shots/{shot['id']}/revisions", headers=H2).status_code == 404
    rev = _revisions(client, H, shot["id"])[0]
    d = client.get(f"/api/studio/shots/{shot['id']}/revisions/{rev['id']}/diff", headers=H2)
    assert d.status_code == 404
    rb = client.post(f"/api/studio/shots/{shot['id']}/rollback", headers=H2,
                     json={"revision_id": rev["id"]})
    assert rb.status_code == 404


# ── 渲染快照与 stale 投影 ────────────────────────────────────────────────────


class _FakeRenderResult:
    def __init__(self, url, meta=None):
        self.kind = "video"
        self.url = url
        self.pipeline_meta = meta or {}


def _patch_sync_renderer(monkeypatch, url="/api/studio/files/r.mp4"):
    """同步渲染替身:返回固定视频 URL,捕获传入 kw(render 快照输入)。"""
    captured: dict = {}

    class FakeRenderer:
        name = "video"

        async def render(self, shot, cast, pool, **kw):
            captured.update(kw)
            return _FakeRenderResult(url)

    monkeypatch.setattr(orch, "get_renderer", lambda shot: FakeRenderer())
    return captured


def test_render_creates_render_revision_and_current_status(ctx, monkeypatch):
    client, token, _, engine = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    shot = _put_shots(client, H, pid, [
        {"scene": "A", "prompt": "rain", "dialogue": "台词"},
    ]).json()["shots"][0]
    sid = shot["id"]
    content_rev = shot["current_revision_id"]

    captured = _patch_sync_renderer(monkeypatch)
    r = client.post(f"/api/studio/shots/{sid}/render", headers=H,
                    json={"video_model": "h3", "pipeline": "ref2va",
                          "num_candidates": 1, "seed": 42, "wait": True,
                          "force_direct": True})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["video_url"] == "/api/studio/files/r.mp4"
    assert body["rendered_revision_id"]
    assert body["visual_media_status"] == "current"
    # 发起 revision 记录进 render_kw(供 Job.params 路径接线)
    assert captured.get("revision_id") == body["rendered_revision_id"]

    revs = _revisions(client, H, sid)
    render_revs = [x for x in revs if x["source"] == "render"]
    assert len(render_revs) == 1
    assert render_revs[0]["id"] == body["rendered_revision_id"]
    assert render_revs[0]["parent_id"] == content_rev
    # 内容 revision 不被渲染 revision 顶替
    assert body["current_revision_id"] == content_rev

    # 中途改 prompt → visual stale;旧媒体保留;配音未被误伤(none→仍无配音)
    r2 = _put_shots(client, H, pid, [
        {"id": sid, "scene": "A", "prompt": "rain-heavier", "dialogue": "台词"},
    ])
    s2 = r2.json()["shots"][0]
    assert s2["video_url"] == "/api/studio/files/r.mp4", "旧媒体不得被清掉"
    assert s2["visual_media_status"] == "stale"

    # rollback 回渲染前内容 revision → 同一失效规则下恢复 current
    rb = client.post(f"/api/studio/shots/{sid}/rollback", headers=H,
                     json={"revision_id": content_rev})
    assert rb.status_code == 200, rb.text
    assert rb.json()["visual_media_status"] == "current"
    assert rb.json()["video_url"] == "/api/studio/files/r.mp4"


def test_voice_stale_only_on_audio_fields(ctx, monkeypatch):
    client, token, _, _ = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    shot = _put_shots(client, H, pid, [
        {"scene": "A", "prompt": "p", "dialogue": "原台词"},
    ]).json()["shots"][0]
    sid = shot["id"]

    monkeypatch.setattr(voice_mod, "_save_wav", lambda data: "/api/studio/files/v.wav")

    class FakeResp:
        status_code = 200
        content = b"RIFF" + b"\x00" * 64

    class FakeClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return None

        async def post(self, url, data=None, files=None):
            return FakeResp()

        async def get(self, url):
            raise AssertionError("无参考音不应下载")

    monkeypatch.setattr(voice_mod.httpx, "AsyncClient", lambda **kw: FakeClient())
    monkeypatch.setattr(voice_mod, "get_settings", lambda: type(
        "S", (), {"tts_url": "http://tts:9200", "tts_multilingual_url": ""})())

    r = client.post(f"/api/studio/shots/{sid}/voice", headers=H)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["voice_url"] == "/api/studio/files/v.wav"
    assert body["audio_media_status"] == "current"
    assert body["voiced_revision_id"]
    voice_rev = body["voiced_revision_id"]

    # 只改 prompt → 仅视觉失效,配音不得误伤
    r2 = _put_shots(client, H, pid, [
        {"id": sid, "scene": "A", "prompt": "p2", "dialogue": "原台词"},
    ])
    s2 = r2.json()["shots"][0]
    assert s2["audio_media_status"] == "current"
    assert s2["voiced_revision_id"] == voice_rev
    assert s2["voice_url"] == "/api/studio/files/v.wav"

    # 改 dialogue → audio stale
    r3 = _put_shots(client, H, pid, [
        {"id": sid, "scene": "A", "prompt": "p2", "dialogue": "新台词"},
    ])
    s3 = r3.json()["shots"][0]
    assert s3["audio_media_status"] == "stale"


def test_legacy_shot_media_status_unknown(ctx):
    """旧行(无历史)有媒体 → unknown,不得伪造已同步。"""
    client, token, _, engine = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    shot = _put_shots(client, H, pid, [{"scene": "A", "prompt": "a"}]).json()["shots"][0]
    # 模拟旧行:抹掉 revision 指针与历史
    with Session(engine) as s:
        sh = s.get(StudioShot, shot["id"])
        sh.video_url = "/api/studio/files/legacy.mp4"
        sh.voice_url = "/api/studio/files/legacy.wav"
        sh.current_revision_id = ""
        sh.rendered_revision_id = ""
        sh.voiced_revision_id = ""
        s.add(sh)
        s.commit()
        for rev in s.exec(select(StudioShotRevision)).all():
            s.delete(rev)
        s.commit()
    r = client.get(f"/api/studio/projects/{pid}", headers=H)
    s0 = [x for x in r.json()["shots"] if x["id"] == shot["id"]][0]
    assert s0["visual_media_status"] == "unknown"
    assert s0["audio_media_status"] == "unknown"


def test_async_render_done_not_attributed_to_newer_revision(ctx, monkeypatch):
    """wait=false:用户中途编辑产生新 revision;Job 完成回写仍记到发起 revision。"""
    client, token, _, engine = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    shot = _put_shots(client, H, pid, [
        {"scene": "A", "prompt": "before-edit"},
    ]).json()["shots"][0]
    sid = shot["id"]
    launch_content_rev = shot["current_revision_id"]

    class FakeRenderer:
        name = "video"

        async def render(self, shot, cast, pool, **kw):
            tenant_id = kw.get("tenant_id") or "t"
            user_id = kw.get("user_id") or "u"
            with Session(engine) as s:
                job = Job(tenant_id=tenant_id, user_id=user_id, prompt_id="pid-1",
                          worker="w", kind="studio_pipeline_c", status="queued",
                          prompt="p", params=json.dumps({"revision_id": kw.get("revision_id") or ""}))
                s.add(job)
                s.commit()
                s.refresh(job)
                job_id = job.id
            meta = {
                "waited": False,
                "db_job_id": job_id,
                "job_id": "pid-1",
                "seed": int(kw.get("seed") or 0),
                "pipeline": kw.get("pipeline") or "ref2va",
            }
            return _FakeRenderResult("", meta=meta)

    monkeypatch.setattr(orch, "get_renderer", lambda shot: FakeRenderer())

    r = client.post(f"/api/studio/shots/{sid}/render", headers=H,
                    json={"video_model": "h3", "pipeline": "ref2va",
                          "num_candidates": 1, "wait": False,
                          "force_direct": True})
    assert r.status_code == 200, r.text
    # 异步登记阶段:候选携带 revision_id(完成前不记 rendered)
    with Session(engine) as s:
        sh = s.get(StudioShot, sid)
        cands = json.loads(sh.candidates_json or "[]")
    assert cands and cands[0].get("revision_id"), cands
    cand_rev = cands[0]["revision_id"]
    job_id = cands[0]["db_job_id"]

    # 用户中途编辑(在途不杀,编辑产生新内容 revision)
    r2 = _put_shots(client, H, pid, [
        {"id": sid, "scene": "A", "prompt": "after-edit"},
    ])
    assert r2.status_code == 200
    new_content_rev = r2.json()["shots"][0]["current_revision_id"]
    assert new_content_rev != launch_content_rev

    # Job 终态 done → reconcile 回写
    with Session(engine) as s:
        job = s.get(Job, job_id)
        job.status = "done"
        job.result = json.dumps(["/api/studio/files/async.mp4"])
        s.add(job)
        s.commit()
    n = render_reconcile.reconcile_project_renders(Session(engine), pid)
    assert n == 1

    with Session(engine) as s:
        sh = s.get(StudioShot, sid)
        assert sh.video_url == "/api/studio/files/async.mp4"
        # 完成结果记到发起 revision,不是新 revision
        assert sh.rendered_revision_id == cand_rev
    r3 = client.get(f"/api/studio/projects/{pid}", headers=H)
    s3 = [x for x in r3.json()["shots"] if x["id"] == sid][0]
    assert s3["visual_media_status"] == "stale"
    assert s3["current_revision_id"] == new_content_rev


def test_pipeline_c_job_params_carry_revision_id(ctx, monkeypatch):
    """render_kw 的 revision_id 由 pipeline_c 登记进 Job.params。"""
    from app.services.studio import pipeline_c_render

    _client, token, _, engine = ctx
    snap_holder: dict = {}
    orig = pipeline_c_render._register_pipeline_c_job

    def spy(**kw):
        snap_holder.update(kw)
        return orig(**kw)

    monkeypatch.setattr(pipeline_c_render, "_register_pipeline_c_job", spy)
    with Session(engine) as s:
        t = Tenant(name="pcr"); s.add(t); s.commit(); s.refresh(t)
    new_id = spy(
        owner=(t.id, "u"),
        prompt_id="pid-x",
        worker="http://w:8264",
        seed=7,
        prompt="prompt",
        shot_id="sh1",
        pipeline="ref2va",
        clip_index=1,
        attempt=0,
        db_job_id=None,
        stage="A",
        revision_id="rev-123",
    )
    assert snap_holder.get("revision_id") == "rev-123"
    with Session(engine) as s:
        job = s.get(Job, new_id)
        assert json.loads(job.params).get("revision_id") == "rev-123"


# ── 迁移 ─────────────────────────────────────────────────────────────────────


def test_migration_adds_revision_table_and_columns_idempotent(monkeypatch, tmp_path):
    """旧库(无 revision 表/指针列)→ 迁移补齐;重复执行幂等(SQLite)。"""
    old_engine = create_engine(f"sqlite:///{tmp_path}/old.db")

    with old_engine.begin() as conn:
        conn.exec_driver_sql(
            """
            CREATE TABLE studioshot (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                idx INTEGER NOT NULL DEFAULT 0,
                prompt TEXT DEFAULT '',
                video_url TEXT DEFAULT '',
                voice_url TEXT DEFAULT '',
                status TEXT DEFAULT 'draft'
            )
            """
        )
        conn.exec_driver_sql(
            "INSERT INTO studioshot (id, project_id, prompt) VALUES ('s1', 'p1', 'legacy')"
        )
    monkeypatch.setattr(db_mod, "engine", old_engine)
    db_mod._run_column_migrations()
    db_mod._run_column_migrations()  # 幂等:二次执行不报错

    with old_engine.begin() as conn:
        cols = {row[1] for row in conn.exec_driver_sql('PRAGMA table_info("studioshot")')}
        assert {
            "current_revision_id", "rendered_revision_id", "voiced_revision_id",
            "final_visual_revision_id", "final_voice_revision_id",
        } <= cols
        tables = {
            row[0]
            for row in conn.exec_driver_sql(
                "SELECT name FROM sqlite_master WHERE type='table'"
            )
        }
        assert "studioshotrevision" in tables
        indexes = {
            row[0]
            for row in conn.exec_driver_sql(
                "SELECT name FROM sqlite_master WHERE type='index'"
            )
        }
        assert "uq_studioshotrevision_shot_version" in indexes
        rows = conn.exec_driver_sql(
            'SELECT prompt FROM studioshot WHERE id = \'s1\''
        ).fetchall()
        assert rows[0][0] == "legacy", "迁移不得破坏既有数据"


# ── 审查修复:M1 视觉输入完整性 / live 比较 ────────────────────────────────────


def _shot_via_project(client, H, pid, sid):
    r = client.get(f"/api/studio/projects/{pid}", headers=H)
    assert r.status_code == 200, r.text
    return [x for x in r.json()["shots"] if x["id"] == sid][0]


def test_m1_ref_and_engine_changes_are_visible(ctx, monkeypatch):
    """换参考(ref_images)/引擎(video_model)必须可被 stale 检测(不再失明)。"""
    client, token, _, engine = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    shot = _put_shots(client, H, pid, [{"scene": "A", "prompt": "p"}]).json()["shots"][0]
    sid = shot["id"]
    _patch_sync_renderer(monkeypatch)
    r = client.post(f"/api/studio/shots/{sid}/render", headers=H,
                    json={"num_candidates": 1, "wait": True, "force_direct": True})
    assert r.status_code == 200, r.text
    assert r.json()["visual_media_status"] == "current"

    # 换参考 → visual stale
    with Session(engine) as s:
        sh = s.get(StudioShot, sid)
        sh.ref_images_json = json.dumps(["/api/studio/files/new-ref.png"])
        s.add(sh)
        s.commit()
    assert _shot_via_project(client, H, pid, sid)["visual_media_status"] == "stale"

    # 复原参考 + 换引擎 → 仍 stale(引擎在视觉输入集内)
    with Session(engine) as s:
        sh = s.get(StudioShot, sid)
        sh.ref_images_json = "[]"
        sh.video_model = "ltx"
        s.add(sh)
        s.commit()
    assert _shot_via_project(client, H, pid, sid)["visual_media_status"] == "stale"


def test_m1_orchestrator_writeback_does_not_false_stale(ctx, monkeypatch):
    """orchestrator 回写 ref/video_model 早于渲染发起、现行内容修订指针仍是旧快照
    → live 比较不得误 stale(旧实现比对现行修订存储快照会误报)。"""
    client, token, _, engine = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    shot = _put_shots(client, H, pid, [{"scene": "A", "prompt": "p"}]).json()["shots"][0]
    sid = shot["id"]
    content_rev = shot["current_revision_id"]
    # 模拟 orchestrator 在前一轮/解析阶段合法回写(内容修订 r1 快照仍是旧值)
    with Session(engine) as s:
        sh = s.get(StudioShot, sid)
        sh.ref_images_json = json.dumps(["/api/studio/files/resolved-1.png"])
        s.add(sh)
        s.commit()
    _patch_sync_renderer(monkeypatch)
    r = client.post(f"/api/studio/shots/{sid}/render", headers=H,
                    json={"num_candidates": 1, "wait": True, "force_direct": True,
                          "ref_images": ["/api/studio/files/resolved-1.png"]})
    assert r.status_code == 200, r.text
    # 现行内容修订指针仍指旧快照 r1,但 live 输入与发起 render 修订一致 → current
    body = _shot_via_project(client, H, pid, sid)
    assert body["current_revision_id"] == content_rev
    assert body["visual_media_status"] == "current"


def test_m1_render_params_not_treated_as_user_edit(ctx, monkeypatch):
    """render 修订存档的 render_params/媒体字段不得参与编辑去重或 diff。"""
    client, token, _, _ = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    shot = _put_shots(client, H, pid, [{"scene": "A", "prompt": "p"}]).json()["shots"][0]
    sid = shot["id"]
    content_rev = shot["current_revision_id"]
    _patch_sync_renderer(monkeypatch)
    r = client.post(f"/api/studio/shots/{sid}/render", headers=H,
                    json={"num_candidates": 1, "wait": True, "force_direct": True})
    assert r.status_code == 200, r.text
    # 渲染后内容未变 → 重复相同 PUT 不造内容修订
    r2 = _put_shots(client, H, pid, [{"id": sid, "scene": "A", "prompt": "p"}])
    assert r2.status_code == 200, r2.text
    assert r2.json()["shots"][0]["current_revision_id"] == content_rev
    revs = _revisions(client, H, sid)
    assert len([x for x in revs if x["source"] != "render"]) == 1
    # diff 只含内容字段,不泄露 render_params
    render_rev = [x for x in revs if x["source"] == "render"][0]
    d = client.get(f"/api/studio/shots/{sid}/revisions/{render_rev['id']}/diff", headers=H)
    assert d.status_code == 200, d.text
    assert "render_params" not in d.json()["fields"]
    assert "video_url" not in d.json()["fields"]


# ── 审查修复:M2 render_mode 切换放弃在途候选 ────────────────────────────────


def _queued_candidate_setup(client, H, pid, engine, monkeypatch):
    """wait=false 渲染 → 候选 queued(带 db_job_id/revision_id),返回 (sid, job_id)。"""
    shot = _put_shots(client, H, pid, [{"scene": "A", "prompt": "p"}]).json()["shots"][0]
    sid = shot["id"]

    class FakeRenderer:
        name = "video"

        async def render(self, shot, cast, pool, **kw):
            with Session(engine) as s:
                job = Job(tenant_id="t", user_id="u", prompt_id="pid-1", worker="w",
                          kind="studio_pipeline_c", status="queued", prompt="p")
                s.add(job)
                s.commit()
                s.refresh(job)
                jid = job.id
            return _FakeRenderResult("", meta={
                "waited": False, "db_job_id": jid, "job_id": "pid-1",
                "seed": 1, "pipeline": "ref2va",
            })

    monkeypatch.setattr(orch, "get_renderer", lambda shot: FakeRenderer())
    r = client.post(f"/api/studio/shots/{sid}/render", headers=H,
                    json={"num_candidates": 1, "wait": False, "force_direct": True})
    assert r.status_code == 200, r.text
    with Session(engine) as s:
        cands = json.loads(s.get(StudioShot, sid).candidates_json or "[]")
    return sid, cands[0]["db_job_id"]


def test_m2_render_mode_switch_supersedes_queued(ctx, monkeypatch):
    """render_mode 切换:queued 候选本地标 superseded(不谎称 upstream canceled,
    不删文件/不动 Job);reconcile 不再回写复活。"""
    client, token, _, engine = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    sid, job_id = _queued_candidate_setup(client, H, pid, engine, monkeypatch)

    # 切换 render_mode → 在途候选被放弃
    r = _put_shots(client, H, pid, [
        {"id": sid, "scene": "A", "prompt": "p", "render_mode": "image_motion"},
    ])
    assert r.status_code == 200, r.text
    with Session(engine) as s:
        sh = s.get(StudioShot, sid)
        assert sh.video_url == "" and sh.final_clip_url == ""
        cands = json.loads(sh.candidates_json or "[]")
        assert cands and all(c["status"] == "superseded" for c in cands), cands
        assert cands[0]["db_job_id"] == job_id, "Job 归属保留(审计,不杀在途)"
        job = s.get(Job, job_id)
        assert job.status == "queued", "不得改动上游 Job"

    # Job 之后 done → reconcile 不得回写
    with Session(engine) as s:
        job = s.get(Job, job_id)
        job.status = "done"
        job.result = json.dumps(["/api/studio/files/ghost.mp4"])
        s.add(job)
        s.commit()
    render_reconcile.reconcile_project_renders(Session(engine), pid)
    with Session(engine) as s:
        sh = s.get(StudioShot, sid)
        assert sh.video_url == "", "被放弃的候选不得复活"
        assert sh.status == "draft"


# ── 审查修复:M3 final 归属与 final_media_status ──────────────────────────────


def _voice_setup(client, H, pid, monkeypatch, dialogue="台词", speaker=None):
    item = {"scene": "A", "prompt": "p", "dialogue": dialogue}
    if speaker:
        item["speaker"] = speaker
    shot = _put_shots(client, H, pid, [item]).json()["shots"][0]
    monkeypatch.setattr(voice_mod, "_save_wav", lambda data: "/api/studio/files/v.wav")

    class FakeResp:
        status_code = 200
        content = b"RIFF" + b"\x00" * 64

    class FakeClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return None

        async def post(self, url, data=None, files=None):
            return FakeResp()

        async def get(self, url):
            class _R:
                content = b"RIFF-ref"
                def raise_for_status(self):
                    return None
            return _R()

    monkeypatch.setattr(voice_mod.httpx, "AsyncClient", lambda **kw: FakeClient())
    monkeypatch.setattr(voice_mod, "get_settings", lambda: type(
        "S", (), {"tts_url": "http://tts:9200", "tts_multilingual_url": "",
                  "api_base_url": "http://api.test"})())
    return shot["id"]


def _render_shot_sync(client, H, sid, monkeypatch):
    _patch_sync_renderer(monkeypatch, url="/api/studio/files/r.mp4")
    r = client.post(f"/api/studio/shots/{sid}/render", headers=H,
                    json={"num_candidates": 1, "wait": True, "force_direct": True})
    assert r.status_code == 200, r.text
    return r.json()


def test_m3_final_media_lifecycle(ctx, monkeypatch):
    """lipsync 后 final current;重配音不清 final 文件但 final stale;重对口型恢复。"""
    from app.services.studio import lipsync as ls

    client, token, _, _ = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    sid = _voice_setup(client, H, pid, monkeypatch)

    body = _render_shot_sync(client, H, sid, monkeypatch)
    assert body["visual_media_status"] == "current"
    r = client.post(f"/api/studio/shots/{sid}/voice", headers=H)
    assert r.status_code == 200, r.text

    monkeypatch.setattr(ls, "lipsync_video", lambda shot, pool: _async_url("/api/studio/files/final.mp4"))
    r = client.post(f"/api/studio/shots/{sid}/lipsync", headers=H)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["final_clip_url"] == "/api/studio/files/final.mp4"
    assert body["final_media_status"] == "current"
    assert body["final_visual_revision_id"] == body["rendered_revision_id"]
    assert body["final_voice_revision_id"] == body["voiced_revision_id"]

    # 重配音:换台词 → final 文件保留,但 final stale(可重对口型)
    _put_shots(client, H, pid, [{"id": sid, "scene": "A", "prompt": "p", "dialogue": "新台词"}])
    r = client.post(f"/api/studio/shots/{sid}/voice", headers=H)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["voice_url"] == "/api/studio/files/v.wav"
    assert body["final_clip_url"] == "/api/studio/files/final.mp4", "旧 final 不得清空"
    assert body["audio_media_status"] == "current"
    assert body["final_media_status"] == "stale"

    # 重对口型 → final 恢复 current
    r = client.post(f"/api/studio/shots/{sid}/lipsync", headers=H)
    assert r.status_code == 200, r.text
    assert r.json()["final_media_status"] == "current"


async def _async_url(url):
    return url


def test_m3_lipsync_captures_sources_at_submit(ctx, monkeypatch):
    """在途编辑不归属到 final:lipsync 提交前快照来源,完成记快照而非后续编辑。"""
    import asyncio

    from app.services.studio import lipsync as ls

    client, token, _, _ = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    sid = _voice_setup(client, H, pid, monkeypatch)
    _render_shot_sync(client, H, sid, monkeypatch)
    client.post(f"/api/studio/shots/{sid}/voice", headers=H)
    with Session(ctx[3]) as s:
        submit_voice_rev = s.get(StudioShot, sid).voiced_revision_id

    gate = {"go": False}

    async def gated_lipsync(shot, pool):
        while not gate["go"]:
            await asyncio.sleep(0.02)
        return "/api/studio/files/final2.mp4"

    monkeypatch.setattr(ls, "lipsync_video", gated_lipsync)
    # 直接用服务层调用(路由会同步等);后台跑以便中途编辑
    import threading

    result: dict = {}

    def _run():
        from app.db import get_session

        session = next(get_session.__wrapped__()) if hasattr(get_session, "__wrapped__") else None
        with Session(ctx[3]) as s:
            sh = s.get(StudioShot, sid)
            import asyncio as _aio
            result["url"] = _aio.run(ls.lipsync_for_shot(s, sh, pool=None))
            result["fv"] = sh.final_visual_revision_id
            result["fa"] = sh.final_voice_revision_id

    t = threading.Thread(target=_run)
    t.start()
    import time as _t
    _t.sleep(0.2)
    # 在途:改台词(新内容修订,但不重配音 → voiced 指针不变)
    _put_shots(client, H, pid, [{"id": sid, "scene": "A", "prompt": "p", "dialogue": "途内改词"}])
    gate["go"] = True
    t.join(timeout=10)

    assert result["url"] == "/api/studio/files/final2.mp4"
    assert result["fa"] == submit_voice_rev, "final 配音来源=提交时快照,不记后续编辑"
    body = _shot_via_project(client, H, pid, sid)
    assert body["final_media_status"] == "stale", "在途编辑使合成来源落后 → final stale"


def test_m3_skip_lipsync_sets_final_sources(ctx, monkeypatch):
    """跳过口型(mux 成片)同属最终合成 → 一样记录来源指针。"""
    from app.services.studio import lipsync as ls

    client, token, _, _ = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    sid = _voice_setup(client, H, pid, monkeypatch)
    body = _render_shot_sync(client, H, sid, monkeypatch)
    client.post(f"/api/studio/shots/{sid}/voice", headers=H)

    async def _fake_dl(http, url):
        return b"bytes"

    async def _fake_pad(v, a):
        return a

    async def _fake_mux(v, a):
        return b"muxed"

    monkeypatch.setattr(ls, "_download", _fake_dl)
    monkeypatch.setattr(ls, "pad_audio_to_video_length", _fake_pad)
    monkeypatch.setattr(ls, "mux_voice_into_clip", _fake_mux)
    monkeypatch.setattr(ls, "_save_clip", lambda data: "/api/studio/files/skip.mp4")

    r = client.post(f"/api/studio/shots/{sid}/lipsync/skip", headers=H)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["final_clip_url"] == "/api/studio/files/skip.mp4"
    assert body["final_media_status"] == "current"
    assert body["final_visual_revision_id"] == body["rendered_revision_id"]
    assert body["final_voice_revision_id"] == body["voiced_revision_id"]


# ── 审查修复:M4 pick_candidate 归属 ─────────────────────────────────────────


def test_m4_pick_candidate_updates_or_clears_attribution(ctx, monkeypatch):
    """pick 带 revision_id 的候选 → rendered 归属更新;无归属旧候选 → 清指针(unknown)。"""
    client, token, _, engine = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    sid = _voice_setup(client, H, pid, monkeypatch)
    body = _render_shot_sync(client, H, sid, monkeypatch)
    render_rev = body["rendered_revision_id"]

    # 候选 A:带 revision_id(本轮渲染)
    cands = [{
        "id": "c-a", "url": "/api/studio/files/a.mp4", "seed": 1, "status": "done",
        "is_picked": False, "error": "", "video_model": "h3",
        "revision_id": render_rev,
    }, {
        "id": "c-old", "url": "/api/studio/files/old.mp4", "seed": 2, "status": "done",
        "is_picked": True, "error": "", "video_model": "h3",
    }]
    with Session(engine) as s:
        sh = s.get(StudioShot, sid)
        sh.candidates_json = json.dumps(cands)
        sh.rendered_revision_id = ""  # 旧候选无归属(legacy 态)
        s.add(sh)
        s.commit()

    # 旧无归属候选当前入选 → unknown(不能沿用错误旧指针)
    body = _shot_via_project(client, H, pid, sid)
    assert body["visual_media_status"] == "unknown"

    r = client.post(f"/api/studio/shots/{sid}/candidates/c-a/pick", headers=H)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["video_url"] == "/api/studio/files/a.mp4"
    assert body["rendered_revision_id"] == render_rev
    assert body["visual_media_status"] == "current"
    # 改选覆盖 final_clip(=原始视频,无合成来源指针)→ 无音频语义:final 时效由
    # 视觉线定(视觉 current → final current),不再永远 unknown
    assert body["final_clip_url"] == "/api/studio/files/a.mp4"
    assert body["final_media_status"] == "current"

    # 选回无归属旧候选 → 指针清空 → unknown
    r = client.post(f"/api/studio/shots/{sid}/candidates/c-old/pick", headers=H)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["rendered_revision_id"] == ""
    assert body["visual_media_status"] == "unknown"


# ── 审查修复:F1 音色来源 / F4 合成前快照 ────────────────────────────────────


def _mk_character(client, H, pid, name, voice_ref_url):
    r = client.post(f"/api/studio/projects/{pid}/characters", headers=H,
                    json={"name": name, "visual_prompt": "1boy"})
    assert r.status_code == 200, r.text
    cid = r.json()["id"]
    if voice_ref_url is not None:
        pr = client.patch(f"/api/studio/characters/{cid}", headers=H,
                          json={"voice_ref_url": voice_ref_url})
        assert pr.status_code == 200, pr.text
    return cid


def _voice_rev_of(engine, sid):
    with Session(engine) as s:
        sh = s.get(StudioShot, sid)
        rev = s.get(StudioShotRevision, sh.voiced_revision_id)
        return rev, json.loads(rev.content_json or "{}")


def test_f1_voice_ref_change_stales_audio(ctx, monkeypatch):
    """换音色参考(voice_ref_url)→ audio stale;角色卡可查,来源比较纳入。"""
    client, token, _, engine = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    cid = _mk_character(client, H, pid, "楚生", "/api/studio/files/ref-a.wav")
    sid = _voice_setup(client, H, pid, monkeypatch, dialogue="台词", speaker="楚生")
    r = client.post(f"/api/studio/shots/{sid}/voice", headers=H)
    assert r.status_code == 200, r.text
    assert r.json()["audio_media_status"] == "current"

    # 换音色参考 → audio stale(视觉不受影响)
    pr = client.patch(f"/api/studio/characters/{cid}", headers=H,
                      json={"voice_ref_url": "/api/studio/files/ref-b.wav"})
    assert pr.status_code == 200, pr.text
    body = _shot_via_project(client, H, pid, sid)
    assert body["audio_media_status"] == "stale"
    assert body["visual_media_status"] == "none"


def test_f1_degraded_voice_honesty(ctx, monkeypatch):
    """参考音下载失败降级默认音色:结果可用,但快照如实记 degraded 事实。"""
    client, token, _, engine = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    _mk_character(client, H, pid, "楚生", "/api/studio/files/ref-a.wav")
    sid = _voice_setup(client, H, pid, monkeypatch, dialogue="台词", speaker="楚生")

    class _DownClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return None

        async def post(self, url, data=None, files=None):
            class _R:
                status_code = 200
                content = b"RIFF" + b"\x00" * 8
            return _R()

        async def get(self, url):
            raise voice_mod.httpx.HTTPError("ref down")

    monkeypatch.setattr(voice_mod.httpx, "AsyncClient", lambda **kw: _DownClient())
    r = client.post(f"/api/studio/shots/{sid}/voice", headers=H)
    assert r.status_code == 200, r.text
    # 降级事实存档 render_params(诚实),配置来源未变 → 与配置口径一致仍 current
    rev, content = _voice_rev_of(engine, sid)
    assert content["render_params"]["voice_ref_degraded"] is True
    assert content["render_params"]["voice_ref_url"] == "/api/studio/files/ref-a.wav"
    assert r.json()["audio_media_status"] == "current"


def test_f4_voice_captures_text_at_submit(ctx, monkeypatch):
    """合成在途用户改词:voiced 修订记录提交时快照,不记后续编辑。"""
    client, token, _, engine = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    sid = _voice_setup(client, H, pid, monkeypatch, dialogue="原始台词")

    class EditDuringPost:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return None

        async def post(self, url, data=None, files=None):
            # 合成途中用户改词(直接落库,模拟并发编辑)
            with Session(engine) as s:
                sh = s.get(StudioShot, sid)
                sh.dialogue = "途内改词"
                s.add(sh)
                s.commit()
            class _R:
                status_code = 200
                content = b"RIFF" + b"\x00" * 8
            return _R()

        async def get(self, url):
            raise AssertionError("无参考音")

    monkeypatch.setattr(voice_mod.httpx, "AsyncClient", lambda **kw: EditDuringPost())
    r = client.post(f"/api/studio/shots/{sid}/voice", headers=H)
    assert r.status_code == 200, r.text
    rev, content = _voice_rev_of(engine, sid)
    assert content["dialogue"] == "原始台词", "修订必须记录发起时快照"
    assert content["render_params"]["dialogue"] == "原始台词"


# ── 审查修复:F2 唯一约束 / 冲突处理 / rollback CAS ──────────────────────────


def test_f2_unique_constraint_conflict_retry(ctx, monkeypatch):
    """(shot_id,version) 唯一;并发冲突自动取下一版本,不 500。"""
    from sqlalchemy.exc import IntegrityError

    from app.services.studio import revisions as rev_svc

    client, token, _, engine = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    shot = _put_shots(client, H, pid, [{"scene": "A", "prompt": "p"}]).json()["shots"][0]

    # 直接插重 (shot_id,version) → 约束生效
    dup = StudioShotRevision(shot_id=shot["id"], project_id=pid, version=1,
                             source="manual-edit", content_json="{}")
    with Session(engine) as s:
        s.add(dup)
        with pytest.raises(IntegrityError):
            s.commit()
        s.rollback()

    # _next_version 被并发抢占(先返回已占用版本)→ _add_revision 须重试成功
    orig_next = rev_svc._next_version
    calls = {"n": 0}

    def flaky_next(session, shot_id):
        calls["n"] += 1
        if calls["n"] == 1:
            return 1  # 已被占用
        return orig_next(session, shot_id)

    monkeypatch.setattr(rev_svc, "_next_version", flaky_next)
    with Session(engine) as s:
        sh = s.get(StudioShot, shot["id"])
        rev = rev_svc._add_revision(
            s, sh, source="manual-edit", snapshot=rev_svc.shot_content_snapshot(sh),
            created_by="u", parent_id="",
        )
        assert rev.version == 2, "冲突后重试取下一版本"


def test_f2_rollback_expected_revision_cas(ctx):
    """rollback 带 expected_revision:不符 → 409,符合 → 200。"""
    client, token, _, _ = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    shot = _put_shots(client, H, pid, [{"scene": "A", "prompt": "v1"}]).json()["shots"][0]
    sid = shot["id"]
    cur = shot["current_revision_id"]
    _put_shots(client, H, pid, [{"id": sid, "scene": "A", "prompt": "v2"}])

    r = client.post(f"/api/studio/shots/{sid}/rollback", headers=H,
                    json={"revision_id": cur, "expected_revision": "not-current"})
    assert r.status_code == 409, r.text

    r2 = client.post(f"/api/studio/shots/{sid}/rollback", headers=H,
                     json={"revision_id": cur, "expected_revision": _revisions(client, H, sid)[0]["id"]})
    assert r2.status_code == 200, r2.text
    assert r2.json()["prompt"] == "v1"


# ── 审查修复:F5 adopt-keyframe 清归属 ───────────────────────────────────────


def test_f5_adopt_keyframe_clears_rendered_attribution(ctx, monkeypatch):
    """采用外部关键帧:rendered 归属清零 → unknown,不沿用旧生成归属。"""
    client, token, _, _ = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    shot = _put_shots(client, H, pid, [{"scene": "A", "prompt": "p"}]).json()["shots"][0]
    sid = shot["id"]
    body = _render_shot_sync(client, H, sid, monkeypatch)
    assert body["visual_media_status"] == "current"

    r = client.post(f"/api/studio/shots/{sid}/adopt-keyframe", headers=H,
                    json={"url": "/api/studio/files/adopted.png"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["image_url"] == "/api/studio/files/adopted.png"
    assert body["rendered_revision_id"] == ""
    assert body["visual_media_status"] == "unknown"


# ── 冻结前修正 1:duration_sec 属视觉输入;修正 2:SAVEPOINT 冲突边界 ────────────


def test_duration_change_stales_visual(ctx, monkeypatch):
    """时长是视频/视觉输入:PUT 改时长 → visual stale;且确实留了修订。"""
    client, token, _, _ = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    shot = _put_shots(client, H, pid, [
        {"scene": "A", "prompt": "p", "duration_sec": 4},
    ]).json()["shots"][0]
    sid = shot["id"]
    body = _render_shot_sync(client, H, sid, monkeypatch)
    assert body["visual_media_status"] == "current"
    base_rev = body["current_revision_id"]

    r = _put_shots(client, H, pid, [
        {"id": sid, "scene": "A", "prompt": "p", "duration_sec": 8},
    ])
    assert r.status_code == 200, r.text
    s2 = r.json()["shots"][0]
    assert s2["duration_sec"] == 8
    assert s2["visual_media_status"] == "stale"
    assert s2["current_revision_id"] != base_rev, "时长改动必须同步留修订"
    # 纯时长改动不应误伤配音线(无配音 → none)
    assert s2["audio_media_status"] == "none"


def test_reflow_duration_change_stales_visual(ctx, monkeypatch):
    """reflow 改投影时长:留修订且视觉 stale(不绕过)。"""
    client, token, _, _ = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    beat = {"text": "你来了", "cues": [], "anchor_words": "", "kind": "v", "block": 0}
    shot = _put_shots(client, H, pid, [
        {"scene": "A", "prompt": "p", "dialogue": "你来了", "duration_sec": 4,
         "beats": [beat]},
    ]).json()["shots"][0]
    sid = shot["id"]
    body = _render_shot_sync(client, H, sid, monkeypatch)
    assert body["visual_media_status"] == "current"

    r = client.post(f"/api/studio/shots/{sid}/reflow-beats", headers=H,
                    json={"total_sec": 9, "persist": True})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["duration_sec"] == 9
    assert body["current_revision_id"], "reflow 时长变化必须留修订"
    assert body["visual_media_status"] == "stale"


def test_f2_savepoint_retry_preserves_uncommitted_content(ctx, monkeypatch):
    """冲突重试不得依赖调用方已 commit:改 prompt 未提交,首次 insert 撞唯一约束
    后重试成功 → prompt 没丢、revision 正确。"""
    from app.services.studio import revisions as rev_svc

    client, token, _, engine = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    shot = _put_shots(client, H, pid, [{"scene": "A", "prompt": "old"}]).json()["shots"][0]
    sid = shot["id"]

    orig_next = rev_svc._next_version
    calls = {"n": 0}

    def flaky(session, shot_id):
        calls["n"] += 1
        return 1 if calls["n"] == 1 else orig_next(session, shot_id)

    monkeypatch.setattr(rev_svc, "_next_version", flaky)
    with Session(engine) as s:
        sh = s.get(StudioShot, sid)
        sh.prompt = "未提交的改词"
        rev = rev_svc.ensure_content_revision(
            s, sh, source="manual-edit", created_by="u"
        )
        assert rev is not None and rev.version == 2
        # SAVEPOINT:外层未提交内容必须原样保留(旧实现整事务回滚会丢)
        assert sh.prompt == "未提交的改词", "冲突重试不得回滚调用方未提交内容"
        s.commit()
        rev_id = rev.id
    body = _shot_via_project(client, H, pid, sid)
    assert body["prompt"] == "未提交的改词"
    assert body["current_revision_id"] == rev_id


def test_f2_rollback_savepoint_preserves_uncommitted(ctx, monkeypatch):
    """rollback_to_revision 的冲突重试同样只回滚本次 insert,外层未提交运行态保留。"""
    from app.services.studio import revisions as rev_svc

    client, token, _, engine = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    shot = _put_shots(client, H, pid, [{"scene": "A", "prompt": "v1"}]).json()["shots"][0]
    sid = shot["id"]
    v1 = shot["current_revision_id"]
    _put_shots(client, H, pid, [{"id": sid, "scene": "A", "prompt": "v2"}])

    orig_next = rev_svc._next_version
    calls = {"n": 0}

    def flaky(session, shot_id):
        calls["n"] += 1
        return 1 if calls["n"] == 1 else orig_next(session, shot_id)

    monkeypatch.setattr(rev_svc, "_next_version", flaky)
    with Session(engine) as s:
        sh = s.get(StudioShot, sid)
        sh.error = "未提交的运行态"  # 非内容字段:rollback 不动它
        rev = rev_svc.rollback_to_revision(s, sh, v1, created_by="u")
        assert rev is not None and rev.version == 3
        assert sh.prompt == "v1", "回滚内容必须落到 shot"
        assert sh.error == "未提交的运行态", "SAVEPOINT 不得丢外层未提交状态"
        s.commit()
        rev_id = rev.id
    body = _shot_via_project(client, H, pid, sid)
    assert body["prompt"] == "v1"
    assert body["current_revision_id"] == rev_id


def test_f2_conflict_exhaustion_raises_domain_error(ctx, monkeypatch):
    """重试耗尽 → RevisionConflictError(路由已映射 409),不得裸 IntegrityError/500。"""
    from app.services.studio import revisions as rev_svc

    client, token, _, engine = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    shot = _put_shots(client, H, pid, [{"scene": "A", "prompt": "a"}]).json()["shots"][0]

    monkeypatch.setattr(rev_svc, "_next_version", lambda session, shot_id: 1)
    with Session(engine) as s:
        sh = s.get(StudioShot, shot["id"])
        sh.prompt = "未提交改词"
        with pytest.raises(rev_svc.RevisionConflictError):
            rev_svc.ensure_content_revision(s, sh, source="manual-edit", created_by="u")
        # 耗尽后外层状态仍可正常提交(不被破坏)
        s.commit()
    assert _shot_via_project(client, H, pid, shot["id"])["prompt"] == "未提交改词"


def test_non_version_integrity_error_not_wrapped_as_conflict(ctx):
    """非 (shot_id,version) 唯一的 IntegrityError(真实 DB 错误)必须原样上抛,
    不得被误包装成 RevisionConflictError/409。"""
    from sqlalchemy.exc import IntegrityError

    from app.services.studio import revisions as rev_svc

    client, token, _, engine = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    shot = _put_shots(client, H, pid, [{"scene": "A", "prompt": "a"}]).json()["shots"][0]

    # 真实 DB 级非版本冲突:insert 触发器 RAISE(ABORT) —— 非唯一约束错误
    with engine.begin() as conn:
        conn.exec_driver_sql(
            "CREATE TRIGGER rev_probe_err BEFORE INSERT ON studioshotrevision "
            "BEGIN SELECT RAISE(ABORT, 'probe_constraint_violation'); END"
        )
    try:
        with Session(engine) as s:
            sh = s.get(StudioShot, shot["id"])
            sh.prompt = "未提交改词"
            with pytest.raises(IntegrityError) as ei:
                rev_svc.ensure_content_revision(s, sh, source="manual-edit", created_by="u")
        # 上抛的是原始 IntegrityError,不是误包装的 409 领域错误
        assert not isinstance(ei.value, rev_svc.RevisionConflictError)
        assert "probe_constraint_violation" in str(ei.value)
    finally:
        with engine.begin() as conn:
            conn.exec_driver_sql("DROP TRIGGER IF EXISTS rev_probe_err")
