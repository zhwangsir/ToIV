"""Studio 从图片创建(F3 融合,2026-10-11):上传→VLM 解析→StudioProject+角色+分镜(异步 Job+轮询)。

覆盖:提交建档+后台建库、解析失败 error 透出、数量/归属校验、Job kind 落库口径。
"""
from __future__ import annotations

import io
import time

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

from app.db import get_session
from app.main import app
from app.models import Job, StudioCharacter, StudioProject, StudioShot, Tenant, User
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
    import app.db as db_mod

    with __import__("unittest.mock", fromlist=["patch"]).patch.object(db_mod, "engine", engine):
        with Session(engine) as s:
            tenant = Tenant(name="fromimg")
            s.add(tenant)
            s.commit()
            s.refresh(tenant)
            user = User(
                email="fromimg@toiv.ai",
                hashed_password=hash_password("password1"),
                tenant_id=tenant.id,
            )
            s.add(user)
            s.commit()
            s.refresh(user)
            uid = user.id
        yield TestClient(app), create_token(uid), engine
    app.dependency_overrides.clear()


def _h(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def _png(name: str = "board.png") -> tuple:
    # 1x1 PNG 魔数(内容不进 VLM——单测里 analyze 被 monkeypatch)
    return ("images", (name, b"\x89PNG\r\n\x1a\n" + b"0" * 32, "image/png"))


def _fake_analyze_ok():
    from app.services import drama_image

    async def fake(payloads, hint, style, num_shots):
        return {
            "title": "雨夜便利店",
            "premise": "深夜的温暖相遇",
            "script": "",
            "shots": [
                {
                    "scene": "便利店门口",
                    "prompt": "convenience store at midnight, neon",
                    "characters": ["小周"],
                    "dialogue": "欢迎光临",
                    "speaker": "小周",
                    "duration_sec": 5,
                    "seam_to_next": "hardcut",
                    "seam_anchor": "",
                },
                {
                    "scene": "货架间",
                    "prompt": "aisle shelves, warm light",
                    "characters": ["小周", "老太太"],
                    "dialogue": "",
                    "speaker": "",
                    "duration_sec": 6,
                },
            ],
            "warnings": [],
        }

    return fake


def _poll(client: TestClient, H: dict, job_id: str, timeout=10.0) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        r = client.get(f"/api/studio/projects/from-image/{job_id}", headers=H)
        assert r.status_code == 200, r.text
        st = r.json()
        if st["status"] in ("done", "error", "canceled"):
            return st
        time.sleep(0.1)
    raise AssertionError("解析任务 10s 内未终态")


def test_from_image_submit_and_build(ctx, monkeypatch):
    """提交 → Job queued → 后台建 StudioProject+角色+分镜 → 轮询 done。"""
    from app.services import drama_image

    monkeypatch.setattr(drama_image, "analyze_storyboard_images", _fake_analyze_ok())
    client, token, engine = ctx
    H = _h(token)

    r = client.post(
        "/api/studio/projects/from-image",
        headers=H,
        files=[_png("a.png"), _png("b.png")],
        data={"hint": "温暖治愈", "num_shots": "6"},
    )
    assert r.status_code == 200, r.text
    job_id = r.json()["job_id"]
    assert r.json()["status"] == "queued"

    st = _poll(client, H, job_id)
    assert st["status"] == "done", st
    pid = st["project_id"]
    assert st["shot_count"] == 2
    assert st["character_count"] == 2

    with Session(engine) as s:
        job = s.get(Job, job_id)
        assert job.kind == "studio_image_parse"
        assert job.prompt_id == f"imgparse-{job_id}"
        p = s.get(StudioProject, pid)
        assert p is not None and p.status == "storyboard"
        assert p.title == "雨夜便利店"
        shots = s.exec(select(StudioShot).where(StudioShot.project_id == pid)).all()
        assert [sh.idx for sh in shots] == [0, 1]
        assert shots[0].dialogue == "欢迎光临"
        assert shots[0].seam_to_next == "hardcut"
        chars = s.exec(select(StudioCharacter).where(StudioCharacter.project_id == pid)).all()
        assert {c.name for c in chars} == {"小周", "老太太"}


def test_from_image_analyze_failure(ctx, monkeypatch):
    """VLM 解析失败 → error + 文案透出。"""
    from fastapi import HTTPException

    from app.services import drama_image

    async def fake_fail(payloads, hint, style, num_shots):
        raise HTTPException(status_code=502, detail="图片解析失败,请重试")

    monkeypatch.setattr(drama_image, "analyze_storyboard_images", fake_fail)
    client, token, _ = ctx
    H = _h(token)
    job_id = client.post(
        "/api/studio/projects/from-image", headers=H, files=[_png()], data={}
    ).json()["job_id"]
    st = _poll(client, H, job_id)
    assert st["status"] == "error"
    assert "图片解析失败" in st["error"]


def test_from_image_count_validation(ctx):
    """图片数量越界(10 张)→ 422;缺图 → 422。"""
    client, token, _ = ctx
    H = _h(token)
    r = client.post(
        "/api/studio/projects/from-image", headers=H,
        files=[_png(f"i{i}.png") for i in range(10)], data={},
    )
    assert r.status_code == 422
    assert "1-9" in r.json()["detail"]
    r2 = client.post("/api/studio/projects/from-image", headers=H, files=[], data={})
    assert r2.status_code == 422


def test_from_image_status_owner_only_404(ctx):
    """他人轮询解析任务 404(不泄露存在性)。"""
    client, token, engine = ctx
    H = _h(token)
    with Session(engine) as s:
        t = s.exec(select(Tenant)).first()
        u2 = User(
            email="other2@toiv.ai",
            hashed_password=hash_password("password1"),
            tenant_id=t.id,
        )
        s.add(u2)
        s.commit()
        s.refresh(u2)
        job = Job(
            tenant_id=t.id, user_id=u2.id, prompt_id="imgparse-x",
            worker="", kind="studio_image_parse", status="running", prompt="x",
        )
        s.add(job)
        s.commit()
        s.refresh(job)
        jid = job.id
    r = client.get(f"/api/studio/projects/from-image/{jid}", headers=H)
    assert r.status_code == 404
