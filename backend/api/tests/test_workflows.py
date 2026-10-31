"""工作流模板路由安全测试:全组认证 + deploy 管理鉴权 + 模板 id 白名单(防路径穿越)。"""
from __future__ import annotations

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.db import get_session
from app.main import app
from app.models import Tenant, User
from app.routes.workflows import _check_template_id
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
        admin = User(
            email="admin",
            hashed_password=hash_password("x"),
            tenant_id=tenant.id,
            role="admin",
        )
        user = User(
            email="user",
            hashed_password=hash_password("x"),
            tenant_id=tenant.id,
        )
        s.add_all([admin, user])
        s.commit()
        s.refresh(admin)
        s.refresh(user)
        tokens = {"admin": create_token(admin.id), "user": create_token(user.id)}
    yield TestClient(app), tokens
    app.dependency_overrides.clear()


def _h(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


class TestAuth:
    """全组端点必须认证;deploy 另需 admin。"""

    def test_templates_requires_auth(self, ctx):
        client, _ = ctx
        assert client.get("/api/workflows/templates").status_code == 401

    def test_download_requires_auth(self, ctx):
        client, _ = ctx
        assert client.get("/api/workflows/txt2img_basic/download").status_code == 401

    def test_deploy_requires_auth(self, ctx):
        client, _ = ctx
        assert client.post("/api/workflows/txt2img_basic/deploy").status_code == 401

    def test_deploy_non_admin_forbidden(self, ctx):
        client, tokens = ctx
        r = client.post("/api/workflows/txt2img_basic/deploy", headers=_h(tokens["user"]))
        assert r.status_code == 403


class TestTemplates:
    def test_templates_list_200(self, ctx):
        client, tokens = ctx
        r = client.get("/api/workflows/templates", headers=_h(tokens["user"]))
        assert r.status_code == 200
        ids = [t["id"] for t in r.json()["templates"]]
        assert "txt2img_basic" in ids

    def test_download_existing_200(self, ctx):
        client, tokens = ctx
        r = client.get("/api/workflows/txt2img_basic/download", headers=_h(tokens["user"]))
        assert r.status_code == 200
        assert "nodes" in r.json()

    def test_download_missing_404(self, ctx):
        client, tokens = ctx
        r = client.get("/api/workflows/no_such_template/download", headers=_h(tokens["user"]))
        assert r.status_code == 404

    def test_deploy_missing_404(self, ctx):
        client, tokens = ctx
        r = client.post("/api/workflows/no_such_template/deploy", headers=_h(tokens["admin"]))
        assert r.status_code == 404


class TestTemplateIdWhitelist:
    """template_id 白名单:.. 等穿越片段在触文件系统前被 400 拦截。"""

    @pytest.mark.parametrize("bad_id", ["a" * 65, "bad id", "bad.json", "a.b", "id~1"])
    def test_invalid_id_rejected_400(self, ctx, bad_id):
        client, tokens = ctx
        r = client.get(f"/api/workflows/{bad_id}/download", headers=_h(tokens["user"]))
        assert r.status_code == 400, f"template_id={bad_id!r} 应 400"
        r = client.post(f"/api/workflows/{bad_id}/deploy", headers=_h(tokens["admin"]))
        assert r.status_code == 400, f"template_id={bad_id!r} 应 400"

    def test_dotdot_rejected_400(self):
        """".." 直接单测校验函数(HTTP 层 .. 会被客户端规范化,不到路由)。"""
        with pytest.raises(HTTPException) as exc:
            _check_template_id("..")
        assert exc.value.status_code == 400
        with pytest.raises(HTTPException):
            _check_template_id("../secret")

    def test_encoded_dotdot_rejected_400(self, ctx):
        """%2E%2E 到服务端解码后为 "..",必须被白名单拦截。"""
        client, tokens = ctx
        r = client.get("/api/workflows/%2E%2E/download", headers=_h(tokens["user"]))
        assert r.status_code == 400
