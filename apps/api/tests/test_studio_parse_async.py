"""Studio 剧本拆解异步化(2026-08-29):提交→Job→轮询,根治长文本撞前端 120s 墙。

覆盖:提交建档+后台完成、LLM 失败 error 落库、取消不回写、reconcile 收口、归属 404。
"""
from __future__ import annotations

import json
import time

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

from app.db import get_session
from app.main import app
from app.models import Job, Tenant, User
from app.security import create_token, hash_password
from app.services.studio import storyboard
from app.services.studio.schemas import CharacterDraft, ShotDraft


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
    # _run_script_parse 用模块级 engine 开独立 Session,patch 到测试库
    import app.db as db_mod

    with __import__("unittest.mock", fromlist=["patch"]).patch.object(db_mod, "engine", engine):
        with Session(engine) as s:
            tenant = Tenant(name="studio")
            s.add(tenant)
            s.commit()
            s.refresh(tenant)
            user = User(
                email="parse@toiv.ai",
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


def _mk_project(client: TestClient, H: dict) -> str:
    r = client.post("/api/studio/projects", headers=H, json={"title": "雨夜", "premise": "重逢"})
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _fake_parse_ok(characters=None, shots=None):
    async def fake(premise, num_shots=8, style="", known_characters=None):
        return (
            characters
            if characters is not None
            else [CharacterDraft(name="楚生", description="落魄青年", visual_prompt="1boy")],
            shots
            if shots is not None
            else [
                ShotDraft(
                    scene="雨夜小巷", prompt="rainy alley", camera="推镜",
                    dialogue="", speaker="", duration_sec=6,
                    characters=["楚生"], render_mode="video",
                )
            ],
        )

    return fake


def _poll_until_terminal(client: TestClient, H: dict, pid: str, job_id: str, timeout=10.0) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        r = client.get(f"/api/studio/projects/{pid}/script/parse/{job_id}", headers=H)
        assert r.status_code == 200, r.text
        st = r.json()
        if st["status"] in ("done", "error", "canceled"):
            return st
        time.sleep(0.1)
    raise AssertionError("拆解任务 10s 内未终态")


def test_parse_submit_and_poll_done(ctx, monkeypatch):
    """提交 → 建档 queued → 后台 LLM 完成 → 轮询拿到角色+分镜。"""
    monkeypatch.setattr(storyboard, "parse_script", _fake_parse_ok())
    client, token, engine = ctx
    H = _h(token)
    pid = _mk_project(client, H)

    r = client.post(
        f"/api/studio/projects/{pid}/script/parse",
        headers=H,
        json={"premise": "一段雨夜重逢的故事", "num_shots": 8},
    )
    assert r.status_code == 200, r.text
    job_id = r.json()["job_id"]
    assert r.json()["status"] == "queued"

    st = _poll_until_terminal(client, H, pid, job_id)
    assert st["status"] == "done"
    assert st["characters"][0]["name"] == "楚生"
    assert st["shots"][0]["render_mode"] == "video"

    # Job 落库口径:prompt 截断存档,kind 供任务中心显示
    with Session(engine) as s:
        job = s.get(Job, job_id)
        assert job.kind == "studio_script_parse"
        assert job.prompt.startswith("一段雨夜重逢")
        assert job.prompt_id == f"parse-{job_id}"


def test_parse_llm_failure_marks_error(ctx, monkeypatch):
    """LLM 不可解析 → error + 错误文案进 result,轮询透出。"""
    async def fake_fail(premise, num_shots=8, style="", known_characters=None):
        raise storyboard.StoryboardError("LLM 返回不可解析")

    monkeypatch.setattr(storyboard, "parse_script", fake_fail)
    client, token, _ = ctx
    H = _h(token)
    pid = _mk_project(client, H)

    job_id = client.post(
        f"/api/studio/projects/{pid}/script/parse",
        headers=H,
        json={"premise": "x"},
    ).json()["job_id"]
    st = _poll_until_terminal(client, H, pid, job_id)
    assert st["status"] == "error"
    assert "不可解析" in st["error"]


def test_parse_canceled_not_overwritten(ctx, monkeypatch):
    """后台完成前用户中止 → canceled 终态不被 done 覆盖;轮询报「已中止」。"""
    gate = []

    async def fake_slow(premise, num_shots=8, style="", known_characters=None):
        # 等取消发生后再返回(模拟长 LLM 调用)
        deadline = time.monotonic() + 10
        while not gate and time.monotonic() < deadline:
            import asyncio

            await asyncio.sleep(0.05)
        return await _fake_parse_ok()(premise, num_shots, style, known_characters)

    monkeypatch.setattr(storyboard, "parse_script", fake_slow)
    client, token, _ = ctx
    H = _h(token)
    pid = _mk_project(client, H)

    job_id = client.post(
        f"/api/studio/projects/{pid}/script/parse",
        headers=H,
        json={"premise": "长" * 100},
    ).json()["job_id"]

    rc = client.post(f"/api/jobs/{job_id}/cancel", headers=H)
    assert rc.status_code == 200, rc.text
    assert rc.json()["worker_action"] == "skipped"  # 空 worker 不碰 ComfyUI
    gate.append(True)  # 放行后台任务

    st = _poll_until_terminal(client, H, pid, job_id)
    assert st["status"] == "canceled"
    assert st["error"] == "已中止"


def test_parse_status_owner_only_404(ctx):
    """他人轮询拆解任务 404(不泄露存在性)。"""
    client, token, engine = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    with Session(engine) as s:
        t = s.exec(select(Tenant)).first()
        u2 = User(
            email="other@toiv.ai",
            hashed_password=hash_password("password1"),
            tenant_id=t.id,
        )
        s.add(u2)
        s.commit()
        s.refresh(u2)
        # 直接造一个属于 u2 的拆解作业(不走提交,避开后台协程)
        job = Job(
            tenant_id=t.id, user_id=u2.id, prompt_id="parse-x",
            worker="", kind="studio_script_parse", status="running", prompt="x",
        )
        s.add(job)
        s.commit()
        s.refresh(job)
        jid = job.id

    # 首位用户(非作业主)轮询 u2 的拆解任务 → 404
    r = client.get(f"/api/studio/projects/{pid}/script/parse/{jid}", headers=H)
    assert r.status_code == 404


def test_reconcile_parse_jobs_marks_interrupted(ctx):
    """api 重启收口:queued/running 的拆解作业标 error(允许重试),终态不动。"""
    from app.routes.studio import reconcile_parse_jobs

    _, _, engine = ctx
    with Session(engine) as s:
        t = s.exec(select(Tenant)).first()
        u = s.exec(select(User)).first()
        for i, st in enumerate(("queued", "running", "done")):
            s.add(Job(
                tenant_id=t.id, user_id=u.id, prompt_id=f"parse-r{i}",
                worker="", kind="studio_script_parse", status=st, prompt="x",
            ))
        s.commit()

    n = reconcile_parse_jobs()
    assert n == 2
    with Session(engine) as s:
        rows = s.exec(select(Job).where(Job.kind == "studio_script_parse")).all()
        by_pid = {j.prompt_id: j for j in rows}
        assert by_pid["parse-r0"].status == "error"
        assert "服务重启" in json.loads(by_pid["parse-r0"].result)["error"]
        assert by_pid["parse-r1"].status == "error"
        assert by_pid["parse-r2"].status == "done"  # 终态不动
