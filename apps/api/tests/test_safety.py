"""操作防护体系(SAFETY,2026-08-17)测试:
  ① 作品软删除:列表隐藏 + 10 分钟 undo 恢复 + 二次 undo 409 + 过期 410 + 越权 404
  ② 审计日志:删除落 log(带 undo_token);admin 可查 /admin/audit-logs;普通用户 403
  ③ 关键删除端点全部落审计(drama/studio 项目与角色、agent 会话、admin 删用户)
  ④ 社区配方:R18 门控(主站剔除 nsfw 配方)+ engine 过滤
"""
from sqlmodel import Session, SQLModel, select
from sqlalchemy import create_engine
from sqlalchemy.pool import StaticPool

from app.db import get_session
from app.main import app
from app.models import AuditLog, Job, Tenant, User
from app.security import hash_password, create_token
from fastapi.testclient import TestClient

import pytest
from unittest.mock import patch


@pytest.fixture()
def ctx():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    SQLModel.metadata.create_all(engine)

    def override():
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override
    with patch.object(__import__("app.db", fromlist=["engine"]), "engine", engine):
        with Session(engine) as s:
            t = Tenant(name="s")
            s.add(t)
            s.commit()
            s.refresh(t)
            u = User(email="s@toiv.ai", hashed_password=hash_password("p1"), tenant_id=t.id)
            s.add(u)
            s.commit()
            s.refresh(u)
            admin = User(email="admin@toiv.ai", hashed_password=hash_password("p1"), tenant_id=t.id, role="admin")
            s.add(admin)
            s.commit()
            s.refresh(admin)
            j = Job(tenant_id=t.id, user_id=u.id, prompt_id="pid-a", worker="w", kind="txt2img",
                    status="done", prompt="一只猫")
            s.add(j)
            s.commit()
            s.refresh(j)
            yield TestClient(app), create_token(u.id), create_token(admin.id), u.id, j.id, engine
    app.dependency_overrides.clear()


def _h(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


# ── ① 软删除 + 撤销 ──────────────────────────────────────────────

def test_job_delete_soft_and_undo(ctx):
    client, token, _, _, job_id, engine = ctx
    H = _h(token)
    # 删除:返回 undo 凭据
    r = client.delete(f"/api/jobs/{job_id}", headers=H)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["undo_token"] and body["undo_ttl"] == 600
    # 列表隐藏
    assert client.get("/api/jobs", headers=H).json() == []
    # undo 恢复
    r = client.post(f"/api/undo/{body['undo_token']}", headers=H)
    assert r.status_code == 200 and r.json()["restored"] is True
    jobs = client.get("/api/jobs", headers=H).json()
    assert len(jobs) == 1 and jobs[0]["id"] == job_id


def test_job_undo_twice_conflict(ctx):
    client, token, _, _, job_id, engine = ctx
    H = _h(token)
    tok = client.delete(f"/api/jobs/{job_id}", headers=H).json()["undo_token"]
    assert client.post(f"/api/undo/{tok}", headers=H).status_code == 200
    # 已被 undo 的凭据再次使用 → 409
    assert client.post(f"/api/undo/{tok}", headers=H).status_code == 409


def test_job_undo_expired(ctx):
    """过期 410:直接把 undo_expires_at 拨到过去。"""
    from datetime import datetime, timedelta, timezone

    client, token, _, _, job_id, engine = ctx
    H = _h(token)
    tok = client.delete(f"/api/jobs/{job_id}", headers=H).json()["undo_token"]
    with Session(engine) as s:
        log = s.exec(select(AuditLog).where(AuditLog.undo_token == tok)).first()
        log.undo_expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
        s.add(log)
        s.commit()
    assert client.post(f"/api/undo/{tok}", headers=H).status_code == 410


def test_job_undo_other_user_forbidden(ctx):
    """undo token 属主校验:他人 token 一律 404(不泄露存在性)。"""
    client, token, _, _, job_id, engine = ctx
    tok = client.delete(f"/api/jobs/{job_id}", headers=_h(token)).json()["undo_token"]
    with Session(engine) as s:
        t = Tenant(name="s2")
        s.add(t)
        s.commit()
        s.refresh(t)
        other = User(email="o@toiv.ai", hashed_password=hash_password("p1"), tenant_id=t.id)
        s.add(other)
        s.commit()
        s.refresh(other)
        oid = other.id
    assert client.post(f"/api/undo/{tok}", headers=_h(create_token(oid))).status_code == 404


# ── ② 审计查询权限 ──────────────────────────────────────────────

def test_audit_logs_admin_only(ctx):
    client, token, admin_token, uid, job_id, engine = ctx
    client.delete(f"/api/jobs/{job_id}", headers=_h(token))
    # 普通用户 403
    assert client.get("/api/admin/audit-logs", headers=_h(token)).status_code == 403
    # admin 可见,含 job.delete 记录
    rows = client.get("/api/admin/audit-logs", headers=_h(admin_token)).json()
    assert any(r["action"] == "job.delete" for r in rows)
    # undo 也落审计
    tok = [r for r in rows if r["action"] == "job.delete"][0]["undo_token"]
    client.post(f"/api/undo/{tok}", headers=_h(token))
    rows2 = client.get("/api/admin/audit-logs?action=job.undo", headers=_h(admin_token)).json()
    assert len(rows2) >= 1


# ── ③ 关键删除端点落审计 ────────────────────────────────────────

def test_drama_project_delete_audited(ctx):
    client, token, admin_token, _, _, engine = ctx
    H = _h(token)
    pid = client.post("/api/drama/projects", headers=H,
                      json={"title": "审计短剧", "script": "x"}).json()["id"]
    assert client.delete(f"/api/drama/projects/{pid}", headers=H).status_code == 200
    rows = client.get("/api/admin/audit-logs?action=project.delete", headers=_h(admin_token)).json()
    assert any(r["target_type"] == "drama_project" for r in rows)


def test_studio_project_delete_audited(ctx):
    client, token, admin_token, _, _, engine = ctx
    H = _h(token)
    pid = client.post("/api/studio/projects", headers=H,
                      json={"title": "S1"}).json()["id"]
    assert client.delete(f"/api/studio/projects/{pid}", headers=H).status_code == 200
    rows = client.get("/api/admin/audit-logs?action=project.delete", headers=_h(admin_token)).json()
    assert any(r["target_type"] == "studio_project" for r in rows)


def test_agent_session_delete_audited(ctx):
    client, token, admin_token, uid, _, engine = ctx
    from app.models import AgentSession

    with Session(engine) as s:
        sess = AgentSession(user_id=uid, title="审计会话")
        s.add(sess)
        s.commit()
        s.refresh(sess)
        sid = sess.id
    assert client.delete(f"/api/agent/sessions/{sid}", headers=_h(token)).status_code == 200
    rows = client.get("/api/admin/audit-logs?action=session.delete", headers=_h(admin_token)).json()
    assert len(rows) >= 1


# ── ④ 社区配方门控 ──────────────────────────────────────────────

def test_recipes_nsfw_gating(ctx):
    client, token, _, _, _, engine = ctx
    H = _h(token)
    r = client.get("/api/models/recipes", headers=H)
    assert r.status_code == 200
    rows = r.json()["recipes"]
    # 主站(无 X-NSFW)只有 SFW 配方
    assert all(not x["nsfw"] for x in rows)
    assert any(x["id"] == "ltx25-vlog-dialogue" for x in rows)
    # /nsfw 上下文可见 R18 配方
    rows2 = client.get("/api/models/recipes", headers={**H, "X-NSFW": "1"}).json()["recipes"]
    assert any(x["id"] == "wan-kenpechi-missionary" for x in rows2)
    # engine 过滤
    rows3 = client.get("/api/models/recipes?engine=ltx25-t2v", headers=H).json()["recipes"]
    assert all(x["engine_id"] == "ltx25-t2v" for x in rows3)
