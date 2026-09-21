"""批量删除端点(POST /api/jobs/bulk-delete,作品库文件夹整组删除 P1 2026-09-22)测试:
  ① 软删+审计:终态作业批量入回收站,逐件独立 undo_token(可逐件/全部撤销,与单删同语义)
  ② 归属隔离:他人作业/不存在 id 静默进 failed(不 404 整批,不泄露存在性)
  ③ 非终态跳过:queued/running 进 failed 且仍在作品库(整组删除只清终态成员)
  ④ 上限与幂等:>200 422;空列表空分组;重复 id 只处理一次
"""
import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

from app.db import get_session
from app.main import app
from app.models import AuditLog, Job, Tenant, User
from app.security import create_token, hash_password


@pytest.fixture
def ctx():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)

    def override() -> Session:
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override

    with Session(engine) as s:
        tenant = Tenant(name="t")
        s.add(tenant)
        s.commit()
        s.refresh(tenant)
        user = User(email="b@toiv.ai", hashed_password=hash_password("password1"), tenant_id=tenant.id)
        other = User(email="o@toiv.ai", hashed_password=hash_password("password1"), tenant_id=tenant.id)
        s.add(user)
        s.add(other)
        s.commit()
        s.refresh(user)
        s.refresh(other)
        ids = {}
        for pid, status in [("p-done1", "done"), ("p-done2", "done"), ("p-queued", "queued"), ("p-other", "done")]:
            owner = other if pid == "p-other" else user
            j = Job(
                tenant_id=tenant.id,
                user_id=owner.id,
                prompt_id=pid,
                worker="http://w",
                prompt=f"job-{pid}",
                seed=1,
                status=status,
            )
            s.add(j)
            s.commit()
            s.refresh(j)
            ids[pid] = j.id
        uid = user.id

    yield TestClient(app), create_token(uid), ids, engine
    app.dependency_overrides.clear()


def _h(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


# ── ① 软删 + 逐件审计/undo_token ────────────────────────────────
def test_bulk_delete_soft_deletes_with_per_job_undo(ctx):
    client, token, ids, engine = ctx
    H = _h(token)
    r = client.post("/api/jobs/bulk-delete", json={"ids": [ids["p-done1"], ids["p-done2"]]}, headers=H)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True and body["failed"] == []
    assert sorted(d["id"] for d in body["done"]) == sorted([ids["p-done1"], ids["p-done2"]])
    tokens = {d["id"]: d["undo_token"] for d in body["done"]}
    assert all(tokens.values()), "每件成功都应带独立 undo_token"
    assert all(d["undo_expires_at"] for d in body["done"])

    # 作品库只剩 queued 那件(他人作业本就不列);回收站可见两件
    remaining = client.get("/api/jobs", headers=H).json()
    assert [j["id"] for j in remaining] == [ids["p-queued"]]
    assert len(client.get("/api/jobs/trash", headers=H).json()) == 2

    # 审计:两条 job.delete(与单删同一 action,undo_token 落库)
    with Session(engine) as s:
        logs = s.exec(select(AuditLog).where(AuditLog.action == "job.delete")).all()
        assert len(logs) == 2
        assert {l.target_id for l in logs} == {ids["p-done1"], ids["p-done2"]}
        assert all(l.undo_token for l in logs)

    # 全部撤销:逐 token undo → 两件回库(连 queued 共 3 件)
    for tok in tokens.values():
        ur = client.post(f"/api/undo/{tok}", headers=H)
        assert ur.status_code == 200 and ur.json()["restored"] is True
    assert len(client.get("/api/jobs", headers=H).json()) == 3


# ── ② 归属隔离 ──────────────────────────────────────────────────
def test_bulk_delete_ownership_and_missing_go_failed(ctx):
    client, token, ids, engine = ctx
    H = _h(token)
    r = client.post(
        "/api/jobs/bulk-delete",
        json={"ids": [ids["p-other"], "does-not-exist", ids["p-done1"]]},
        headers=H,
    )
    assert r.status_code == 200
    body = r.json()
    assert [d["id"] for d in body["done"]] == [ids["p-done1"]]
    assert sorted(body["failed"]) == sorted([ids["p-other"], "does-not-exist"])
    # 他人作业未被软删
    with Session(engine) as s:
        other_job = s.exec(select(Job).where(Job.id == ids["p-other"])).first()
        assert other_job.deleted_at is None


# ── ③ 非终态跳过 ────────────────────────────────────────────────
def test_bulk_delete_skips_nonterminal(ctx):
    client, token, ids, engine = ctx
    H = _h(token)
    r = client.post("/api/jobs/bulk-delete", json={"ids": [ids["p-queued"], ids["p-done1"]]}, headers=H)
    assert r.status_code == 200
    body = r.json()
    assert [d["id"] for d in body["done"]] == [ids["p-done1"]]
    assert body["failed"] == [ids["p-queued"]]
    # queued 作业仍在作品库(未软删;done2 本就没删)
    remaining = [j["id"] for j in client.get("/api/jobs", headers=H).json()]
    assert ids["p-queued"] in remaining and ids["p-done1"] not in remaining
    # 审计只记成功件
    with Session(engine) as s:
        logs = s.exec(select(AuditLog).where(AuditLog.action == "job.delete")).all()
        assert len(logs) == 1 and logs[0].target_id == ids["p-done1"]


# ── ④ 上限与幂等 ────────────────────────────────────────────────
def test_bulk_delete_limit_empty_and_duplicates(ctx):
    client, token, ids, engine = ctx
    H = _h(token)
    # >200 → 422
    assert client.post("/api/jobs/bulk-delete", json={"ids": [f"x{i}" for i in range(201)]}, headers=H).status_code == 422
    # 空列表 → 幂等空分组
    r = client.post("/api/jobs/bulk-delete", json={"ids": []}, headers=H)
    assert r.status_code == 200 and r.json()["done"] == [] and r.json()["failed"] == []
    # 重复 id 只处理一次
    r = client.post("/api/jobs/bulk-delete", json={"ids": [ids["p-done1"], ids["p-done1"]]}, headers=H)
    assert r.status_code == 200
    assert len(r.json()["done"]) == 1 and r.json()["failed"] == []
    # 已删除的再删 → failed(幂等不误伤)
    r = client.post("/api/jobs/bulk-delete", json={"ids": [ids["p-done1"]]}, headers=H)
    assert r.json()["done"] == [] and r.json()["failed"] == [ids["p-done1"]]
    # 未认证 → 401
    assert client.post("/api/jobs/bulk-delete", json={"ids": []}).status_code == 401
