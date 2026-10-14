"""Studio 域 SVML 导入端点测试(FU1-b):与 script/parse 同构、不落库、长度守卫。"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.db import get_session
from app.main import app
from app.models import StudioProject, Tenant, User
from app.security import create_token, hash_password


@pytest.fixture()
def ctx():
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    SQLModel.metadata.create_all(engine)

    def override() -> Session:
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override
    with Session(engine) as s:
        tenant = Tenant(name="d")
        s.add(tenant)
        s.commit()
        s.refresh(tenant)
        user = User(email="d@toiv.ai", hashed_password=hash_password("password1"), tenant_id=tenant.id)
        s.add(user)
        s.commit()
        s.refresh(user)
        uid = user.id
    yield TestClient(app), create_token(uid)
    app.dependency_overrides.clear()


def _h(tok: str) -> dict:
    return {"Authorization": f"Bearer {tok}"}


def test_studio_import_svml_shape(ctx):
    client, tok = ctx
    pid = client.post(
        "/api/studio/projects", headers=_h(tok), json={"title": "SVML"}
    ).json()["id"]
    script = """[scene:雨夜巷口][mood:紧张]
<林夏> 别跟着我。||我说了,别跟着我。
镜头缓推 || 霓虹闪烁

[scene:天台]
<阿凯> 你还是来了。"""
    r = client.post(f"/api/studio/projects/{pid}/import-svml", headers=_h(tok), json={"script": script})
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["count"] == 2
    assert set(data["shots"][0]) >= {"scene", "prompt", "dialogue", "speaker", "duration_sec", "characters", "render_mode"}
    assert data["shots"][0]["speaker"] == "林夏"
    assert data["shots"][0]["characters"] == ["林夏"]
    assert data["shots"][0]["render_mode"] == "video"
    assert set(data["characters"]) == {"阿凯", "林夏"}
    # 不落库:项目 shots 仍空(save_shots 才写)
    detail = client.get(f"/api/studio/projects/{pid}", headers=_h(tok)).json()
    shots = detail.get("shots") or []
    assert shots == []


def test_studio_import_svml_guards(ctx):
    client, tok = ctx
    pid = client.post(
        "/api/studio/projects", headers=_h(tok), json={"title": "G"}
    ).json()["id"]
    # 语法错 422
    r = client.post(
        f"/api/studio/projects/{pid}/import-svml", headers=_h(tok), json={"script": "@{a}未闭合"}
    )
    assert r.status_code == 422 and "SVML 解析失败" in r.json()["detail"]
    # 空/超长 422
    assert client.post(
        f"/api/studio/projects/{pid}/import-svml", headers=_h(tok), json={"script": "  "}
    ).status_code == 422
    assert client.post(
        f"/api/studio/projects/{pid}/import-svml", headers=_h(tok), json={"script": "字" * 50001}
    ).status_code == 422
    # 未登录
    assert client.post(
        f"/api/studio/projects/{pid}/import-svml", json={"script": "x"}
    ).status_code in (401, 403)
