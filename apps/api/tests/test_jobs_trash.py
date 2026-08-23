"""回收站(2026-08-23)测试:
  ① 入桶:软删后 /api/jobs 隐藏、/api/jobs/trash 可见(带 deleted_at/剩余恢复时间)
  ② 归属隔离:他人回收站不可见;恢复/彻底删除他人作品一律 404
  ③ 恢复:restore 后回归作品库、回收站清空;重复 restore 404
  ④ 彻底删除:permanent 立即物理删除(DB 行消失),不可再恢复
  ⑤ 过期:超过保留期不列出、restore 410、purge_expired_trash 物理清理
"""
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, select

from app.audit import UNDO_TTL_SECONDS, purge_expired_trash
from app.db import get_session
from app.main import app
from app.models import Job, Tenant, User
from app.security import create_token, hash_password


@pytest.fixture()
def ctx():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    SQLModel.metadata.create_all(engine)

    def override():
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override
    with Session(engine) as s:
        t = Tenant(name="s")
        s.add(t)
        s.commit()
        s.refresh(t)
        u = User(email="s@toiv.ai", hashed_password=hash_password("p1"), tenant_id=t.id)
        other = User(email="o@toiv.ai", hashed_password=hash_password("p1"), tenant_id=t.id)
        s.add(u)
        s.add(other)
        s.commit()
        s.refresh(u)
        s.refresh(other)
        j = Job(tenant_id=t.id, user_id=u.id, prompt_id="pid-a", worker="w", kind="txt2img",
                status="done", prompt="一只猫")
        s.add(j)
        s.commit()
        s.refresh(j)
        yield TestClient(app), create_token(u.id), create_token(other.id), j.id, engine
    app.dependency_overrides.clear()


def _h(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def _set_deleted_at(engine, job_id: str, dt: datetime) -> None:
    """直接把 deleted_at 拨到指定时间(构造过期/排序场景)。"""
    with Session(engine) as s:
        job = s.exec(select(Job).where(Job.id == job_id)).first()
        job.deleted_at = dt
        s.add(job)
        s.commit()


# ── ① 入桶 ────────────────────────────────────────────────────────

def test_trash_after_delete(ctx):
    client, token, _, job_id, _ = ctx
    H = _h(token)
    assert client.delete(f"/api/jobs/{job_id}", headers=H).status_code == 200
    # 作品库隐藏
    assert client.get("/api/jobs", headers=H).json() == []
    # 回收站可见:字段与 /api/jobs 对齐 + deleted_at/恢复截止/剩余秒数
    rows = client.get("/api/jobs/trash", headers=H).json()
    assert len(rows) == 1
    item = rows[0]
    assert item["id"] == job_id and item["prompt"] == "一只猫"
    assert item["deleted_at"] and item["restore_expires_at"]
    assert 0 < item["restore_remaining_seconds"] <= UNDO_TTL_SECONDS


def test_trash_pagination(ctx):
    client, token, _, job_id, engine = ctx
    H = _h(token)
    with Session(engine) as s:
        uid = s.exec(select(Job).where(Job.id == job_id)).first().user_id
        tid = s.exec(select(Job).where(Job.id == job_id)).first().tenant_id
        for i in range(2):
            s.add(Job(tenant_id=tid, user_id=uid, prompt_id=f"pid-x{i}", worker="w",
                      kind="txt2img", status="done", prompt=f"图{i}"))
        s.commit()
        ids = [j.id for j in s.exec(select(Job)).all()]
    for jid in ids:
        assert client.delete(f"/api/jobs/{jid}", headers=H).status_code == 200
    page1 = client.get("/api/jobs/trash?limit=2&offset=0", headers=H).json()
    page2 = client.get("/api/jobs/trash?limit=2&offset=2", headers=H).json()
    assert len(page1) == 2 and len(page2) == 1
    assert {r["id"] for r in page1 + page2} == set(ids)


# ── ② 归属隔离 ────────────────────────────────────────────────────

def test_trash_isolation(ctx):
    client, token, other_token, job_id, _ = ctx
    assert client.delete(f"/api/jobs/{job_id}", headers=_h(token)).status_code == 200
    OH = _h(other_token)
    # 他人回收站看不到
    assert client.get("/api/jobs/trash", headers=OH).json() == []
    # 他人恢复/彻底删除一律 404(不泄露存在性)
    assert client.post(f"/api/jobs/{job_id}/restore", headers=OH).status_code == 404
    assert client.delete(f"/api/jobs/{job_id}/permanent", headers=OH).status_code == 404


# ── ③ 恢复 ────────────────────────────────────────────────────────

def test_restore_returns_to_library(ctx):
    client, token, _, job_id, _ = ctx
    H = _h(token)
    client.delete(f"/api/jobs/{job_id}", headers=H)
    r = client.post(f"/api/jobs/{job_id}/restore", headers=H)
    assert r.status_code == 200 and r.json()["restored"] is True
    # 回归作品库,回收站清空
    jobs = client.get("/api/jobs", headers=H).json()
    assert len(jobs) == 1 and jobs[0]["id"] == job_id
    assert client.get("/api/jobs/trash", headers=H).json() == []
    # 不在回收站的作业 restore → 404
    assert client.post(f"/api/jobs/{job_id}/restore", headers=H).status_code == 404


# ── ④ 彻底删除 ────────────────────────────────────────────────────

def test_permanent_delete(ctx):
    client, token, _, job_id, engine = ctx
    H = _h(token)
    # 未进回收站的作品不可彻底删除
    assert client.delete(f"/api/jobs/{job_id}/permanent", headers=H).status_code == 404
    client.delete(f"/api/jobs/{job_id}", headers=H)
    r = client.delete(f"/api/jobs/{job_id}/permanent", headers=H)
    assert r.status_code == 200 and r.json()["ok"] is True
    # DB 行已物理删除
    with Session(engine) as s:
        assert s.exec(select(Job).where(Job.id == job_id)).first() is None
    # 回收站/恢复/二次彻底删除均不可达
    assert client.get("/api/jobs/trash", headers=H).json() == []
    assert client.post(f"/api/jobs/{job_id}/restore", headers=H).status_code == 404
    assert client.delete(f"/api/jobs/{job_id}/permanent", headers=H).status_code == 404


# ── ⑤ 过期 ────────────────────────────────────────────────────────

def test_expired_not_listed_and_purged(ctx):
    client, token, _, job_id, engine = ctx
    H = _h(token)
    client.delete(f"/api/jobs/{job_id}", headers=H)
    _set_deleted_at(
        engine, job_id,
        datetime.now(timezone.utc) - timedelta(seconds=UNDO_TTL_SECONDS + 60),
    )
    # 过期条目不列出
    assert client.get("/api/jobs/trash", headers=H).json() == []
    # 过期不可恢复(410)
    assert client.post(f"/api/jobs/{job_id}/restore", headers=H).status_code == 410
    # 定期清理任务物理删除;未过期行不受影响
    with Session(engine) as s:
        keep = Job(tenant_id="t", user_id="u", prompt_id="pid-keep", worker="w",
                   kind="txt2img", status="done", prompt="保留",
                   deleted_at=datetime.now(timezone.utc))
        s.add(keep)
        s.commit()
    assert purge_expired_trash(engine) == 1
    with Session(engine) as s:
        rows = s.exec(select(Job)).all()
        assert len(rows) == 1 and rows[0].prompt_id == "pid-keep"
