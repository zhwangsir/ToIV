"""出处门控 + 内置 AI 知识图谱最小切片测试。"""
from __future__ import annotations

from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel

from app.db import get_session
from app.deps import get_pool
from app.main import app
from app.models import App, ModelCard, Tenant, User
from app.security import create_token, hash_password
from app.services.provenance import (
    build_app_source_links,
    extract_rh_webapp_id,
    public_app_description,
    redact_engine_source,
    redact_wiki_card,
    rh_webapp_url,
    strip_rh_webapp_id,
)

_GRAPH = {
    "1": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "a.safetensors"}},
}


def test_strip_and_extract_rh_webapp_id():
    raw = "Wan图生 · Alice · 上传首帧图 · RH:1950219582398185474"
    assert extract_rh_webapp_id(raw) == "1950219582398185474"
    assert "RH:" not in strip_rh_webapp_id(raw)
    assert "Alice" in strip_rh_webapp_id(raw)
    assert public_app_description(raw, is_admin=True) == raw
    assert "RH:" not in public_app_description(raw, is_admin=False)


def test_redact_wiki_and_engine_source():
    card = {
        "label": "x",
        "civitai_url": "https://civitai.com/models/1",
        "civitai_id": "1",
        "huggingface_url": "https://huggingface.co/org/model",
    }
    assert redact_wiki_card(card, is_admin=True)["civitai_url"].startswith("http")
    assert redact_wiki_card(card, is_admin=True)["huggingface_url"].startswith("http")
    assert redact_wiki_card(card, is_admin=False)["civitai_url"] == ""
    assert redact_wiki_card(card, is_admin=False)["huggingface_url"] == ""
    src = {"name": "HF", "url": "https://huggingface.co/x", "author": "a"}
    assert "url" in redact_engine_source(src, is_admin=True)
    assert "url" not in (redact_engine_source(src, is_admin=False) or {})


def test_rh_webapp_url_and_source_links():
    assert rh_webapp_url("1950219582398185474") == (
        "https://www.runninghub.ai/ai-detail/1950219582398185474"
    )
    assert rh_webapp_url("") == ""
    assert rh_webapp_url("abc") == ""
    links = build_app_source_links(
        app_id="ltx-nsfw-i2v",
        description="demo · RH:1234567890123456789 · https://example.com/x",
        rh_webapp_id="1234567890123456789",
        is_admin=True,
    )
    urls = [x["url"] for x in links]
    assert "https://www.runninghub.ai/ai-detail/1234567890123456789" in urls
    assert "https://example.com/x" in urls
    assert build_app_source_links(
        app_id="ltx-nsfw-i2v", description="RH:1", rh_webapp_id="1", is_admin=False,
    ) == []


class _FakePool:
    clients = []


def _setup():
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)

    def override():
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override
    app.dependency_overrides[get_pool] = lambda: _FakePool()
    with Session(engine) as s:
        tu = Tenant(name="u")
        ta = Tenant(name="a")
        s.add_all([tu, ta])
        s.commit()
        s.refresh(tu)
        s.refresh(ta)
        u = User(email="u@toiv.ai", hashed_password=hash_password("p1"), tenant_id=tu.id)
        admin = User(
            email="a@toiv.ai", hashed_password=hash_password("p1"),
            tenant_id=ta.id, role="admin",
        )
        s.add_all([u, admin])
        s.add(
            App(
                id="rh-wan-demo",
                name="Demo RH",
                description="Wan图生 · Bob · 上传首帧图 · RH:1234567890123456789",
                category="video",
                workflow_json=_GRAPH,
                params_schema=[],
                bindings={},
                is_builtin=True,
                author="Bob",
            )
        )
        s.add(
            ModelCard(
                id="abcd1234abcd1234",
                filename="demo.safetensors",
                model_type="checkpoints",
                label="Demo",
                description="d",
                civitai_id="99",
                civitai_url="https://civitai.red/models/99",
            )
        )
        s.commit()
        s.refresh(u)
        s.refresh(admin)
        return u.id, admin.id


def test_app_description_gated_for_user():
    uid, aid = _setup()
    try:
        client = TestClient(app)
        r = client.get("/api/apps/rh-wan-demo", headers={"Authorization": f"Bearer {create_token(uid)}"})
        assert r.status_code == 200, r.text
        body = r.json()
        assert "RH:" not in (body.get("description") or "")
        assert body.get("rh_webapp_id") in (None, "")
        r2 = client.get("/api/apps/rh-wan-demo", headers={"Authorization": f"Bearer {create_token(aid)}"})
        assert r2.status_code == 200, r2.text
        b2 = r2.json()
        assert "RH:1234567890123456789" in (b2.get("description") or "")
        assert b2.get("rh_webapp_id") == "1234567890123456789"
        assert b2.get("rh_webapp_url") == (
            "https://www.runninghub.ai/ai-detail/1234567890123456789"
        )
        sl = b2.get("source_links") or []
        assert any(
            (x.get("url") or "").startswith("https://www.runninghub.ai/ai-detail/")
            for x in sl
        ), sl
        assert body.get("rh_webapp_url") in (None, "")
        assert body.get("source_links") in (None, [])
    finally:
        app.dependency_overrides.clear()


def test_admin_knowledge_graph_export_and_query():
    uid, aid = _setup()
    try:
        client = TestClient(app)
        deny = client.get(
            "/api/admin/knowledge-graph",
            headers={"Authorization": f"Bearer {create_token(uid)}"},
        )
        assert deny.status_code == 403
        ok = client.get(
            "/api/admin/knowledge-graph",
            headers={"Authorization": f"Bearer {create_token(aid)}"},
        )
        assert ok.status_code == 200, ok.text
        g = ok.json()
        assert g["mode"] == "export"
        assert g["counts"]["nodes"] >= 1
        types = set(g["counts"]["by_type"])
        assert "engine" in types
        q = client.get(
            "/api/admin/knowledge-graph",
            params={"entity": "rh-wan-demo"},
            headers={"Authorization": f"Bearer {create_token(aid)}"},
        )
        assert q.status_code == 200, q.text
        sub = q.json()
        assert sub["mode"] == "query"
        assert sub["counts"]["nodes"] >= 1
    finally:
        app.dependency_overrides.clear()
