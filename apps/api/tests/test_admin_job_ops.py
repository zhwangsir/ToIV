"""Admin P1 作业队列域后端旁路 + 说明书批量生成 + 画板删除审计(2026-09-22)测试:
  ① admin 行内操作全员作业:delete/cancel/restore/permanent 旁路;普通用户仍 404(不泄露)
  ② 全员口径透出属主:/jobs?all=1 与 /jobs/trash?all=1 带 user_email;active all=1 同
  ③ 说明书批量生成:目标选择(only_missing)+单飞 409+逐项失败不中断+status 汇总
  ④ 画板删除落审计 board.delete(与 Job 删除审计范式对齐)
"""
import asyncio
import time

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

from app.db import get_session
from app.main import app
from app.models import App, AppGuide, AuditLog, Board, BoardItem, Job, Tenant, User
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
        admin = User(email="a@toiv.ai", hashed_password=hash_password("password1"),
                     tenant_id=tenant.id, role="admin")
        plain = User(email="u@toiv.ai", hashed_password=hash_password("password1"),
                     tenant_id=tenant.id)
        s.add(admin)
        s.add(plain)
        s.commit()
        s.refresh(admin)
        s.refresh(plain)
        ids = {}
        # plain 的两件作业(一跑一完成)+ admin 自己的两件(一跑一完成)
        for pid, status, owner in [
            ("p-other-run", "running", plain),
            ("p-other-done", "done", plain),
            ("p-admin-run", "running", admin),
            ("p-admin-done", "done", admin),
        ]:
            j = Job(tenant_id=tenant.id, user_id=owner.id, prompt_id=pid,
                    worker="http://w", prompt=f"job-{pid}", seed=1, status=status)
            s.add(j)
            s.commit()
            s.refresh(j)
            ids[pid] = j.id
        aid, uid = admin.id, plain.id

    yield TestClient(app), create_token(aid), create_token(uid), ids, engine
    app.dependency_overrides.clear()


def _h(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


# ── ① admin 行内操作旁路 ────────────────────────────────────────
def test_admin_delete_others_job_with_audit(ctx):
    client, atok, utok, ids, engine = ctx
    # 普通用户删他人作业仍 404(不泄露存在性)
    assert client.delete(f"/api/jobs/{ids['p-admin-done']}", headers=_h(utok)).status_code == 404
    # admin 删他人作业:200 + undo_token + 审计操作者为 admin
    r = client.delete(f"/api/jobs/{ids['p-other-done']}", headers=_h(atok))
    assert r.status_code == 200 and r.json()["undo_token"]
    with Session(engine) as s:
        log = s.exec(select(AuditLog).where(AuditLog.action == "job.delete")).first()
        assert log.user_email == "a@toiv.ai" and log.target_id == ids["p-other-done"]
    # admin 回收站 restore 他人作品
    r = client.post(f"/api/jobs/{ids['p-other-done']}/restore", headers=_h(atok))
    assert r.status_code == 200 and r.json()["restored"] is True
    # admin 再删后 permanent 物理删除
    client.delete(f"/api/jobs/{ids['p-other-done']}", headers=_h(atok))
    r = client.delete(f"/api/jobs/{ids['p-other-done']}/permanent", headers=_h(atok))
    assert r.status_code == 200
    with Session(engine) as s:
        assert s.exec(select(Job).where(Job.id == ids["p-other-done"])).first() is None


def test_admin_cancel_others_running_job(ctx):
    client, atok, utok, ids, engine = ctx
    # 普通用户取消他人(admin 的)作业 404(不泄露存在性)
    assert client.post(f"/api/jobs/{ids['p-admin-run']}/cancel", headers=_h(utok)).status_code == 404
    # admin 取消他人 running 作业:落 canceled(worker 不可达不阻塞)
    r = client.post(f"/api/jobs/{ids['p-other-run']}/cancel", headers=_h(atok))
    assert r.status_code == 200 and r.json()["status"] == "canceled"
    with Session(engine) as s:
        log = s.exec(select(AuditLog).where(AuditLog.action == "job.cancel")).first()
        assert log.user_email == "a@toiv.ai"


# ── ② 全员口径属主透出 ──────────────────────────────────────────
def test_all_jobs_and_trash_carry_user_email(ctx):
    client, atok, utok, ids, engine = ctx
    rows = client.get("/api/jobs?all=1&limit=10", headers=_h(atok)).json()
    by_prompt = {r["prompt"]: r for r in rows}
    assert by_prompt["job-p-other-run"]["user_email"] == "u@toiv.ai"
    assert by_prompt["job-p-admin-done"]["user_email"] == "a@toiv.ai"
    # 本人口径不透出(空串)
    mine = client.get("/api/jobs?limit=10", headers=_h(atok)).json()
    assert all(r["user_email"] == "" for r in mine)
    # 回收站 all=1:admin 删他人一件+自己一件后可见全员桶+属主
    client.delete(f"/api/jobs/{ids['p-other-done']}", headers=_h(atok))
    client.delete(f"/api/jobs/{ids['p-admin-done']}", headers=_h(atok))
    trash = client.get("/api/jobs/trash?all=1", headers=_h(atok)).json()
    hit = [t for t in trash if t["id"] == ids["p-other-done"]]
    assert hit and hit[0]["user_email"] == "u@toiv.ai"
    # 普通用户 trash?all=1 静默回落本人:只看到自己的,看不到 admin 的
    mine = client.get("/api/jobs/trash?all=1", headers=_h(utok)).json()
    mine_ids = {t["id"] for t in mine}
    assert ids["p-other-done"] in mine_ids and ids["p-admin-done"] not in mine_ids


def test_active_all_carries_user_email(ctx):
    client, atok, _, ids, _ = ctx
    body = client.get("/api/jobs/active?all=1", headers=_h(atok)).json()
    hit = [i for i in body["items"] if i["id"] == ids["p-other-run"]]
    assert hit and hit[0]["user_email"] == "u@toiv.ai"


# ── ③ 说明书批量生成 ────────────────────────────────────────────
def test_guides_batch_generate(ctx, monkeypatch):
    client, atok, _, ids, engine = ctx
    with Session(engine) as s:
        t = s.exec(select(Tenant)).first()
        a1 = App(id="app-m1", tenant_id=t.id, name="缺卡应用", is_public=True, workflow="{}")
        a2 = App(id="app-m2", tenant_id=t.id, name="已有草稿", is_public=True, workflow="{}")
        s.add(a1)
        s.add(a2)
        s.add(AppGuide(app_id="app-m2", purpose="旧草稿", status="draft"))
        s.commit()

    from app.routes import app_guides

    async def fake_draft(app_obj):
        return {"purpose": f"用途-{app_obj.name}", "steps": ["一步"]}

    monkeypatch.setattr(app_guides, "generate_guide_draft", fake_draft)
    # 批量后台任务独立开会话(app.db engine,请求路径的 get_session 覆盖不到)——指到测试库
    monkeypatch.setattr(app_guides, "engine", engine)
    # 单飞闸:已在运行 → 409(确定性打桩,不依赖批次竞态)
    monkeypatch.setattr(app_guides, "_batch_state", {"running": True, "summary": None})
    assert client.post("/api/admin/app-guides/generate", json={}, headers=_h(atok)).status_code == 409
    monkeypatch.setattr(app_guides, "_batch_state", {"running": False, "summary": None})
    # only_missing=True:app-m1 必入待做(app-m2 已有行,不动;lifespan 种子应用可能同在)
    r = client.post("/api/admin/app-guides/generate", json={"limit": 50}, headers=_h(atok))
    assert r.status_code == 200 and r.json()["started"] is True and r.json()["planned"] >= 1
    planned = r.json()["planned"]
    for _ in range(50):
        st = client.get("/api/admin/app-guides/generate/status").json()
        if not st["running"]:
            break
        time.sleep(0.1)
    assert st["running"] is False and st["summary"]["done"] == planned and st["summary"]["failed"] == []
    with Session(engine) as s:
        g = s.get(AppGuide, "app-m1")
        assert g and g.purpose == "用途-缺卡应用" and g.status == "draft"
        # only_missing 不动已有行
        g2 = s.get(AppGuide, "app-m2")
        assert g2 and g2.purpose == "旧草稿"
    # only_missing=False:含 draft 重生成(app-m1/app-m2 均重生)
    r = client.post("/api/admin/app-guides/generate", json={"limit": 50, "only_missing": False}, headers=_h(atok))
    assert r.json()["planned"] >= 2
    planned2 = r.json()["planned"]
    for _ in range(50):
        st = client.get("/api/admin/app-guides/generate/status").json()
        if not st["running"]:
            break
        time.sleep(0.1)
    assert st["summary"]["done"] == planned2
    with Session(engine) as s:
        assert s.get(AppGuide, "app-m2").purpose == "用途-已有草稿"
    # 审计:app.guides_batch 落两条
    with Session(engine) as s:
        logs = s.exec(select(AuditLog).where(AuditLog.action == "app.guides_batch")).all()
        assert len(logs) == 2
    # 无目标时 started=False
    monkeypatch.setattr(app_guides, "_batch_state", {"running": False, "summary": None})
    with Session(engine) as s:
        for g in s.exec(select(AppGuide)).all():
            g.status = "published"
            s.add(g)
        s.commit()
    r = client.post("/api/admin/app-guides/generate", json={"limit": 10}, headers=_h(atok))
    assert r.json() == {"started": False, "planned": 0, "reason": "无待生成目标"}
    # 非 admin 403
    assert client.post("/api/admin/app-guides/generate", json={}).status_code in (401, 403)


# ── ⑤ LB 后端健康代理(Admin P0 设备域) ──────────────────────────
def test_comfy_backends_proxy(ctx, monkeypatch):
    client, atok, utok, ids, engine = ctx
    from app.routes import system as system_route

    class _FakeResp:
        def raise_for_status(self):
            pass

        def json(self):
            return {"backends": [
                {"id": "b1", "url": "http://127.0.0.1:8196", "gpu": 0, "healthy": True},
                {"id": "b2", "url": "http://192.168.71.116:8188", "gpu": 0, "healthy": False},
            ]}

    class _FakeClient:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def get(self, url):
            return _FakeResp()

    class _S:
        comfy_workers_registry_url = "http://192.168.71.127:8188/admin/backends"

    monkeypatch.setattr(system_route, "get_settings", lambda: _S())
    monkeypatch.setattr(system_route.httpx, "AsyncClient", _FakeClient)
    r = client.get("/api/system/comfy-backends", headers=_h(atok))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["source"] == _S.comfy_workers_registry_url and len(body["backends"]) == 2
    assert body["backends"][1]["healthy"] is False
    # 未配置注册表地址 → 404;普通用户 → 403
    monkeypatch.setattr(system_route, "get_settings", lambda: type("_S2", (), {"comfy_workers_registry_url": ""})())
    assert client.get("/api/system/comfy-backends", headers=_h(atok)).status_code == 404
    monkeypatch.setattr(system_route, "get_settings", lambda: _S())
    assert client.get("/api/system/comfy-backends", headers=_h(utok)).status_code == 403


# ── ⑥ 画板删除审计 ──────────────────────────────────────────────
def test_board_delete_writes_audit(ctx):
    client, atok, _, ids, engine = ctx
    H = _h(atok)
    r = client.post("/api/boards", json={"name": "审计验证板"}, headers=H)
    assert r.status_code == 200, r.text
    bid = r.json()["id"]
    r = client.delete(f"/api/boards/{bid}", headers=H)
    assert r.status_code == 200 and r.json()["deleted"] is True
    with Session(engine) as s:
        log = s.exec(select(AuditLog).where(AuditLog.action == "board.delete")).first()
        assert log is not None and log.target_id == bid and "审计验证板" in log.summary
