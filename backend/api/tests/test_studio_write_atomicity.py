"""#64:分镜写入原子性——内容/修订/删镜/阶段失效同事务 + 列表前置条件。

锁定:
  · PUT shots 携带 expected_shot_ids:列表基线不符 → 409,零写入(不丢并发新增)
  · 中途失败(建修订冲突)→ 内容/修订/删镜/阶段失效全部回滚,不留半写
  · 阶段 CAS 冲突 → 同事务内容与修订一并回滚(不再先提交内容)
  · 事务内插入的意外行不在基线内 → 约束删除绝不误删
  · reflow 携带 expected_revision:陈旧基线 → 409;成功时内容+修订+失效同提交
  · 独立连接:陈旧列表基线不得覆盖并发新增
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import update as sa_update
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

import app.db as db_mod
from app.db import get_session
from app.main import app
from app.models import (
    StudioProject,
    StudioShot,
    StudioShotRevision,
    StudioStageConfirmation,
    Tenant,
    User,
)
from app.security import create_token, hash_password
from app.services.studio import revisions as rev_svc
from app.services.studio import stages as stages_svc


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
    monkeypatch.setattr(db_mod, "engine", engine)
    with Session(engine) as s:
        t = Tenant(name="atomic"); s.add(t); s.commit(); s.refresh(t)
        u = User(email="atomic@toiv.ai", hashed_password=hash_password("p"), tenant_id=t.id)
        s.add(u); s.commit(); s.refresh(u)
        uid = u.id
    yield TestClient(app), create_token(uid), uid, engine
    app.dependency_overrides.clear()


def _h(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def _mk_project(client, H, title="原子", premise="雨夜重逢") -> str:
    r = client.post("/api/studio/projects", headers=H,
                    json={"title": title, "premise": premise})
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _put(client, H, pid, shots, expected_ids=None):
    body: dict = {"shots": shots}
    if expected_ids is not None:
        body["expected_shot_ids"] = expected_ids
    return client.put(f"/api/studio/projects/{pid}/shots", headers=H, json=body)


def _shots(client, H, pid):
    r = client.get(f"/api/studio/projects/{pid}", headers=H)
    assert r.status_code == 200, r.text
    return {s["id"]: s for s in r.json()["shots"]}


def _revs(client, H, sid):
    r = client.get(f"/api/studio/shots/{sid}/revisions", headers=H)
    assert r.status_code == 200, r.text
    return r.json()["revisions"]


def _transition(client, H, pid, stage, action, note=""):
    r = client.post(f"/api/studio/projects/{pid}/stage-transition", headers=H,
                    json={"stage": stage, "action": action, "note": note})
    assert r.status_code == 200, r.text


def _confirm_storyboard(client, H, pid):
    _transition(client, H, pid, "script", "confirm", "剧本定稿")
    _transition(client, H, pid, "assets", "skip", "无角色,跳过")
    _transition(client, H, pid, "storyboard", "confirm", "分镜定稿")


def _stage(client, H, pid, stage):
    r = client.get(f"/api/studio/projects/{pid}", headers=H)
    assert r.status_code == 200, r.text
    return r.json()["stage_states"][stage]["state"]


# ── 列表前置条件 ────────────────────────────────────────────────────────────


def test_expected_shot_ids_mismatch_409_zero_write(ctx):
    client, token, _, _ = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    r = _put(client, H, pid, [
        {"scene": "A", "prompt": "a"},
        {"scene": "B", "prompt": "b"},
    ])
    assert r.status_code == 200, r.text
    shots = r.json()["shots"]
    a, b = shots[0], shots[1]

    # 客户端基线只看到 A;B 是并发新增 → 整单拒绝,不得删 B
    r = _put(client, H, pid,
             [{"id": a["id"], "scene": "A", "prompt": "a-改",
               "expected_revision": a["current_revision_id"]}],
             expected_ids=[a["id"]])
    assert r.status_code == 409, r.text
    assert "列表" in r.json()["detail"]
    after = _shots(client, H, pid)
    assert set(after) == {a["id"], b["id"]}
    assert after[a["id"]]["prompt"] == "a"
    assert len(_revs(client, H, a["id"])) == 1


def test_expected_shot_ids_duplicates_rejected(ctx):
    client, token, _, _ = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    a = _put(client, H, pid, [{"scene": "A", "prompt": "a"}]).json()["shots"][0]
    r = _put(client, H, pid, [{"id": a["id"], "scene": "A", "prompt": "a"}],
             expected_ids=[a["id"], a["id"]])
    assert r.status_code == 422, r.text


# ── 中途失败全量回滚 ────────────────────────────────────────────────────────


def test_mid_failure_rolls_back_content_revision_delete_and_stage(ctx, monkeypatch):
    client, token, _, engine = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    r = _put(client, H, pid, [
        {"scene": "A", "prompt": "a"},
        {"scene": "B", "prompt": "b"},
    ])
    assert r.status_code == 200, r.text
    shots = r.json()["shots"]
    a, b = shots[0], shots[1]
    _confirm_storyboard(client, H, pid)
    assert _stage(client, H, pid, "storyboard") == "confirmed"

    real = rev_svc.ensure_content_revision

    def fail_on_boom(session, shot, *, source, created_by, force=False):
        if shot.prompt == "boom":
            raise rev_svc.RevisionConflictError("模拟第二镜修订冲突")
        return real(session, shot, source=source, created_by=created_by, force=force)

    monkeypatch.setattr(rev_svc, "ensure_content_revision", fail_on_boom)

    # 同一请求:B 改名(新增修订)+ 新镜 C(失败点)+ A 被删
    r = _put(client, H, pid, [
        {"id": b["id"], "scene": "B", "prompt": "b-改",
         "expected_revision": b["current_revision_id"]},
        {"scene": "C", "prompt": "boom"},
    ], expected_ids=[a["id"], b["id"]])
    assert r.status_code == 409, r.text

    after = _shots(client, H, pid)
    assert set(after) == {a["id"], b["id"]}, "删镜与新镜都不得落库"
    assert after[b["id"]]["prompt"] == "b", "先成功的镜也不得留下半写内容"
    assert len(_revs(client, H, b["id"])) == 1, "已建修订须随事务回滚"
    assert _stage(client, H, pid, "storyboard") == "confirmed", "失败请求不得失效阶段"
    with Session(engine) as s:
        audits = s.exec(select(StudioStageConfirmation).where(
            StudioStageConfirmation.to_state == "needs_review")).all()
        assert audits == []


def test_stage_conflict_rolls_back_content_and_revision(ctx, monkeypatch):
    client, token, _, engine = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    shot = _put(client, H, pid, [{"scene": "A", "prompt": "a"}]).json()["shots"][0]
    _confirm_storyboard(client, H, pid)
    base_rev = shot["current_revision_id"]

    real = rev_svc.ensure_content_revision

    def advance_stage_midway(session, target, *, source, created_by, force=False):
        rev = real(session, target, source=source, created_by=created_by, force=force)
        # 模拟并发请求在本次读-写间隙推进了 stage_revision:DB 已变、ORM 仍持旧值
        session.exec(sa_update(StudioProject)
                     .where(StudioProject.id == pid)
                     .values(stage_revision=999)
                     .execution_options(synchronize_session=False))
        return rev

    monkeypatch.setattr(rev_svc, "ensure_content_revision", advance_stage_midway)

    r = _put(client, H, pid,
             [{"id": shot["id"], "scene": "A", "prompt": "a-改",
               "expected_revision": base_rev}],
             expected_ids=[shot["id"]])
    assert r.status_code == 409, r.text
    after = _shots(client, H, pid)
    assert after[shot["id"]]["prompt"] == "a", "阶段 CAS 冲突须回滚内容"
    assert after[shot["id"]]["current_revision_id"] == base_rev
    assert len(_revs(client, H, shot["id"])) == 1
    assert _stage(client, H, pid, "storyboard") == "confirmed"
    with Session(engine) as s:
        assert s.get(StudioProject, pid).stage_revision < 999


def test_unexpected_row_outside_baseline_is_never_deleted(ctx, monkeypatch):
    client, token, _, _ = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    r = _put(client, H, pid, [
        {"scene": "A", "prompt": "a"},
        {"scene": "B", "prompt": "b"},
    ])
    assert r.status_code == 200, r.text
    a, b = r.json()["shots"]

    real = rev_svc.ensure_content_revision
    slipped = {"done": False}

    def slip_in_row(session, shot, *, source, created_by, force=False):
        rev = real(session, shot, source=source, created_by=created_by, force=force)
        if not slipped["done"]:
            slipped["done"] = True
            session.add(StudioShot(project_id=pid, scene="竞态", prompt="sneak"))
            session.flush()
        return rev

    monkeypatch.setattr(rev_svc, "ensure_content_revision", slip_in_row)

    # 基线=[A,B],本次只保留 A:B 应删;事务内插入的 C 不在基线 → 必须保留
    r = _put(client, H, pid,
             [{"id": a["id"], "scene": "A", "prompt": "a"}],
             expected_ids=[a["id"], b["id"]])
    assert r.status_code == 200, r.text
    after = _shots(client, H, pid)
    assert a["id"] in after
    assert b["id"] not in after
    assert any(s["prompt"] == "sneak" for s in after.values()), "基线外的并发行不得被删除"


# ── reflow 原子性 ───────────────────────────────────────────────────────────


def _beat_shot(client, H, pid):
    beat = {"text": "你来了", "cues": [], "anchor_words": "", "kind": "d", "block": 0}
    r = _put(client, H, pid, [
        {"scene": "A", "prompt": "a", "dialogue": "你来了", "beats": [beat]},
    ])
    assert r.status_code == 200, r.text
    return r.json()["shots"][0]


def test_reflow_stale_expected_revision_409_zero_write(ctx):
    client, token, _, _ = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    shot = _beat_shot(client, H, pid)
    stale = shot["current_revision_id"]

    current = _put(client, H, pid, [
        {"id": shot["id"], "scene": "A-new", "prompt": "a",
         "dialogue": "你来了", "expected_revision": stale,
         "beats": [{"text": "你来了", "cues": [], "anchor_words": "",
                    "kind": "d", "block": 0}]},
    ]).json()["shots"][0]
    before = _shots(client, H, pid)[shot["id"]]

    r = client.post(f"/api/studio/shots/{shot['id']}/reflow-beats", headers=H,
                    json={"texts": ["你终于来了"], "persist": True,
                          "expected_revision": stale})
    assert r.status_code == 409, r.text
    after = _shots(client, H, pid)[shot["id"]]
    assert after["beats"] == before["beats"]
    assert after["duration_sec"] == before["duration_sec"]
    assert after["current_revision_id"] == current["current_revision_id"]
    assert len(_revs(client, H, shot["id"])) == 2


def test_reflow_success_commits_content_revision_and_invalidation(ctx):
    client, token, _, _ = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    shot = _beat_shot(client, H, pid)
    _confirm_storyboard(client, H, pid)

    r = client.post(f"/api/studio/shots/{shot['id']}/reflow-beats", headers=H,
                    json={"texts": ["你终于来了"], "total_sec": 9, "persist": True,
                          "expected_revision": shot["current_revision_id"]})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["dialogue"] == "你终于来了"
    assert body["duration_sec"] == 9
    assert body["current_revision_id"] != shot["current_revision_id"]
    assert len(_revs(client, H, shot["id"])) == 2
    assert _stage(client, H, pid, "storyboard") == "needs_review"


def test_reflow_stage_conflict_rolls_back_beats(ctx, monkeypatch):
    client, token, _, _ = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    shot = _beat_shot(client, H, pid)
    _confirm_storyboard(client, H, pid)

    real = rev_svc.ensure_content_revision

    def advance_stage_midway(session, target, *, source, created_by, force=False):
        rev = real(session, target, source=source, created_by=created_by, force=force)
        session.exec(sa_update(StudioProject)
                     .where(StudioProject.id == pid)
                     .values(stage_revision=999)
                     .execution_options(synchronize_session=False))
        return rev

    monkeypatch.setattr(rev_svc, "ensure_content_revision", advance_stage_midway)

    r = client.post(f"/api/studio/shots/{shot['id']}/reflow-beats", headers=H,
                    json={"texts": ["你终于来了"], "persist": True,
                          "expected_revision": shot["current_revision_id"]})
    assert r.status_code == 409, r.text
    after = _shots(client, H, pid)[shot["id"]]
    assert after["beats"] == shot["beats"]
    assert after["duration_sec"] == shot["duration_sec"]
    assert after["current_revision_id"] == shot["current_revision_id"]
    assert _stage(client, H, pid, "storyboard") == "confirmed"


# ── 服务层:commit=False 不落库 ─────────────────────────────────────────────


def test_invalidate_commit_false_leaves_transaction_to_caller(ctx):
    client, token, _, engine = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    _put(client, H, pid, [{"scene": "A", "prompt": "a"}])
    _confirm_storyboard(client, H, pid)

    s = Session(engine)
    try:
        project = s.get(StudioProject, pid)
        changed = stages_svc.invalidate_stages(
            s, project, stages=["storyboard"], source="system",
            note="测试原子失效", created_by="u", commit=False,
        )
        assert changed == ["storyboard"]
        s.rollback()
    finally:
        s.close()
    with Session(engine) as s:
        project = s.get(StudioProject, pid)
        assert stages_svc.load_store(project)["storyboard"] == "confirmed"
        rows = s.exec(select(StudioStageConfirmation).where(
            StudioStageConfirmation.to_state == "needs_review")).all()
        assert rows == [], "commit=False 的失效审计须随调用方回滚"


# ── 独立连接:陈旧列表基线不得覆盖并发新增 ──────────────────────────────────


def test_stale_list_baseline_does_not_overwrite_concurrent_add(tmp_path):
    from fastapi import HTTPException

    from app.routes.studio import save_shots
    from app.services.studio.schemas import ShotInput, ShotsSaveRequest

    url = f"sqlite:///{tmp_path / 'atomic.db'}"
    engine_a = create_engine(url)
    engine_b = create_engine(url)
    SQLModel.metadata.create_all(engine_a)
    with Session(engine_a) as s:
        t = Tenant(name="conn"); s.add(t); s.commit(); s.refresh(t)
        u = User(email="conn@toiv.ai", hashed_password=hash_password("p"),
                 tenant_id=t.id)
        s.add(u); s.commit(); s.refresh(u)
        p = StudioProject(tenant_id=t.id, user_id=u.id, title="conn", premise="x")
        s.add(p); s.commit(); s.refresh(p)
        a = StudioShot(project_id=p.id, scene="A", prompt="a")
        s.add(a); s.commit(); s.refresh(a)
        pid, uid, sid, rev_a = p.id, u.id, a.id, a.current_revision_id

    with Session(engine_b) as s2:
        s2.add(StudioShot(project_id=pid, scene="取巧", prompt="concurrent"))
        s2.commit()

    sa_ = Session(engine_a)
    try:
        user = sa_.get(User, uid)
        with pytest.raises(HTTPException) as ei:
            save_shots(
                pid,
                ShotsSaveRequest(
                    shots=[ShotInput(id=sid, scene="A", prompt="a-改",
                                     expected_revision=rev_a)],
                    expected_shot_ids=[sid],
                ),
                user=user, session=sa_,
            )
        assert ei.value.status_code == 409
        sa_.rollback()
    finally:
        sa_.close()
        engine_a.dispose()
        engine_b.dispose()

    check = create_engine(url)
    try:
        with Session(check) as s:
            rows = s.exec(select(StudioShot).where(StudioShot.project_id == pid)).all()
            assert {r.prompt for r in rows} == {"a", "concurrent"}
            assert len(s.exec(select(StudioShotRevision)).all()) == 0
    finally:
        check.dispose()
