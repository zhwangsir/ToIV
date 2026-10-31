"""Admin 模型资产域只读端点(2026-09-22 D2/D6)测试:
  ① model-sources:结构(totals/items/条目字段)+admin 门控
  ② test-matrix:L0/L2 汇总+逐行(jsonl 解析容错)
  ③ 未部署路径:候选全失 → 404
"""
import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.db import get_session
from app.main import app
from app.models import Tenant, User
from app.routes import admin_model_assets as ama
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
        admin = User(email="a@toiv.ai", hashed_password=hash_password("p1"), tenant_id=tenant.id, role="admin")
        plain = User(email="u@toiv.ai", hashed_password=hash_password("p1"), tenant_id=tenant.id)
        s.add(admin)
        s.add(plain)
        s.commit()
        s.refresh(admin)
        s.refresh(plain)
        aid, uid = admin.id, plain.id
    yield TestClient(app), create_token(aid), create_token(uid)
    app.dependency_overrides.clear()


def _h(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


# ── ① model-sources ────────────────────────────────────────────
def test_model_sources_shape_and_gate(ctx):
    client, atok, utok = ctx
    r = client.get("/api/admin/model-sources", headers=_h(atok))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["updated_at"] and body["totals"]["total"] > 0
    assert body["sources_scanned"], "sources_scanned 应非空"
    items = body["items"]
    assert len(items) == body["totals"]["total"] or len(items) > 0
    entry = items[0]
    for key in ("basename", "status", "notes"):
        assert key in entry, f"条目缺字段 {key}"
    assert {i.get("status") for i in items} <= {"ok", "blocked", None}, "status 枚举越界"
    # 门控:普通用户 403;匿名 401
    assert client.get("/api/admin/model-sources", headers=_h(utok)).status_code == 403
    assert client.get("/api/admin/model-sources").status_code == 401


# ── ② test-matrix ──────────────────────────────────────────────
def test_test_matrix_shape(ctx):
    client, atok, _ = ctx
    r = client.get("/api/admin/test-matrix", headers=_h(atok))
    assert r.status_code == 200, r.text
    body = r.json()
    l0s, l2s = body["l0_summary"], body["l2_summary"]
    assert l0s and l0s["total_public"] > 0 and l0s["pass"] > 0
    assert l2s and l2s["total"] > 0 and l2s["counts"]["pass"] >= 0
    # L0 逐行:550 应用结构字段;L2 逐行:真提交回执字段
    assert len(body["l0_results"]) == l0s["total_public"]
    row = body["l0_results"][0]
    assert "l0_status" in row and "schema_keys" in row
    assert len(body["l2_results"]) == l2s["total"]
    l2row = body["l2_results"][0]
    assert "run_http" in l2row and "submit_kind" in l2row
    assert isinstance(body["l2_candidates"], list)


# ── ③ 未部署路径 → 404 ─────────────────────────────────────────
def test_model_sources_missing_404(ctx, tmp_path, monkeypatch):
    client, atok, _ = ctx
    monkeypatch.setattr(ama, "_MODEL_SOURCES_CANDIDATES", [tmp_path / "nope.json"])
    monkeypatch.setattr(ama, "_cache", {})
    assert client.get("/api/admin/model-sources", headers=_h(atok)).status_code == 404


def test_test_matrix_missing_404(ctx, tmp_path, monkeypatch):
    client, atok, _ = ctx
    monkeypatch.setattr(ama, "_MATRIX_DIR", tmp_path)
    monkeypatch.setattr(ama, "_cache", {})
    assert client.get("/api/admin/test-matrix", headers=_h(atok)).status_code == 404
