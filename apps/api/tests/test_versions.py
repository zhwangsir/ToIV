"""版本树:参数快照 / 版本链查询 / 重生端点(POST /jobs/{key}/rerun)。"""
from __future__ import annotations

import json
import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

import app.routes.generate as generate_mod
from app.db import get_session
from app.deps import get_pool
from app.main import app
from app.models import Job, Tenant, User
from app.security import create_token, hash_password


class _FakeClient:
    base_url = "http://fake-worker:1"

    async def queue_prompt(self, graph: dict, client_id: str) -> str:
        return uuid.uuid4().hex


class _FakePool:
    async def pick(self, required=None, required_nodes=None):
        return _FakeClient()


@pytest.fixture
def ctx(monkeypatch):
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
    app.dependency_overrides[get_pool] = lambda: _FakePool()
    # 后台结果追踪会真连 worker,测试里掐掉
    monkeypatch.setattr(generate_mod, "spawn_tracker", lambda *a, **k: None)

    with Session(engine) as s:
        tenant = Tenant(name="t")
        s.add(tenant)
        s.commit()
        s.refresh(tenant)
        user = User(
            email="v@toiv.ai",
            hashed_password=hash_password("password1"),
            tenant_id=tenant.id,
        )
        s.add(user)
        s.commit()
        s.refresh(user)
        uid, tid = user.id, tenant.id

    yield TestClient(app), create_token(uid), engine, uid, tid
    app.dependency_overrides.clear()


def _mk_job(engine, uid: str, tid: str, **kw) -> Job:
    defaults = dict(
        prompt_id=uuid.uuid4().hex,
        worker="http://fake-worker:1",
        kind="txt2img",
        status="done",
        prompt="a cat",
        seed=123,
    )
    defaults.update(kw)
    with Session(engine) as s:
        job = Job(tenant_id=tid, user_id=uid, **defaults)
        s.add(job)
        s.commit()
        s.refresh(job)
        return job


# txt2img 完整参数快照(重生端点用它重建请求)
_SNAPSHOT = json.dumps(
    {
        "positive": "a cat",
        "negative": "lowres",
        "ckpt_name": "test-model.safetensors",
        "width": 512,
        "height": 512,
        "steps": 8,
        "cfg": 7.0,
        "sampler": "euler",
        "scheduler": "normal",
        "seed": 123,
        "batch_size": 1,
        "loras": [],
        "engine": "comfyui",
    }
)


def test_txt2img_saves_params_snapshot(ctx):
    """出图建档时保存完整参数快照(含实际 seed),而非只有 prompt+seed。"""
    client, token, engine, uid, _ = ctx
    r = client.post(
        "/api/generate/txt2img",
        json={
            "positive": "hello snapshot",
            "negative": "bad quality",
            "ckpt_name": "test-model.safetensors",
            "steps": 9,
        },
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 200, r.text
    seed = r.json()["seed"]
    with Session(engine) as s:
        job = s.exec(select(Job).where(Job.user_id == uid)).first()
    assert job is not None and job.params
    snap = json.loads(job.params)
    assert snap["negative"] == "bad quality"
    assert snap["ckpt_name"] == "test-model.safetensors"
    assert snap["steps"] == 9
    assert snap["seed"] == seed  # 快照存实际使用的 seed,支撑锁 seed 精确重生


def test_rerun_keep_seed_links_parent(ctx):
    """rerun(keep)锁 seed 重生,新作业挂进版本链;链式 rerun 根不漂移。"""
    client, token, engine, uid, tid = ctx
    H = {"Authorization": f"Bearer {token}"}
    src = _mk_job(engine, uid, tid, params=_SNAPSHOT)

    r = client.post(f"/api/jobs/{src.id}/rerun", json={"seed_mode": "keep"}, headers=H)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["parent_id"] == src.id
    with Session(engine) as s:
        new = s.get(Job, body["job_id"])
    assert new is not None
    assert new.parent_id == src.id
    assert new.root_id == src.id
    assert new.seed == 123  # 锁 seed
    assert new.kind == "txt2img"
    assert new.params  # rerun 产物自身也有快照(可继续 rerun)

    # 链式:从新版本再 rerun,root 仍是最初的根
    r2 = client.post(f"/api/jobs/{new.id}/rerun", json={"seed_mode": "keep"}, headers=H)
    assert r2.status_code == 200, r2.text
    with Session(engine) as s:
        third = s.get(Job, r2.json()["job_id"])
    assert third.parent_id == new.id
    assert third.root_id == src.id


def test_rerun_tweak_overrides_prompt(ctx):
    """微调:改提示词 + 锁 seed → 只有词变,seed 不变。"""
    client, token, engine, uid, tid = ctx
    src = _mk_job(engine, uid, tid, params=_SNAPSHOT)
    r = client.post(
        f"/api/jobs/{src.id}/rerun",
        json={"seed_mode": "keep", "overrides": {"positive": "a red cat"}},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 200, r.text
    with Session(engine) as s:
        new = s.get(Job, r.json()["job_id"])
    assert new.prompt == "a red cat"
    assert new.seed == 123


def test_rerun_random_seed(ctx):
    """重抽:random 模式换 seed。"""
    client, token, engine, uid, tid = ctx
    src = _mk_job(engine, uid, tid, params=_SNAPSHOT)
    r = client.post(
        f"/api/jobs/{src.id}/rerun",
        json={"seed_mode": "random"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 200, r.text
    with Session(engine) as s:
        new = s.get(Job, r.json()["job_id"])
    assert new.seed != 123
    assert new.parent_id == src.id


def test_rerun_addressable_by_prompt_id(ctx):
    """前端结果卡只有 prompt_id → rerun 支持按 prompt_id 寻址。"""
    client, token, engine, uid, tid = ctx
    src = _mk_job(engine, uid, tid, params=_SNAPSHOT)
    r = client.post(
        f"/api/jobs/{src.prompt_id}/rerun",
        json={"seed_mode": "keep"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["parent_id"] == src.id


def test_rerun_without_snapshot_400(ctx):
    """旧数据无快照 → 400 明确报错,不静默出错图。"""
    client, token, engine, uid, tid = ctx
    src = _mk_job(engine, uid, tid)  # params 空
    r = client.post(
        f"/api/jobs/{src.id}/rerun",
        json={"seed_mode": "keep"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 400


def test_rerun_unsupported_kind_400(ctx):
    client, token, engine, uid, tid = ctx
    src = _mk_job(engine, uid, tid, kind="agent_image", params="{}")
    r = client.post(
        f"/api/jobs/{src.id}/rerun",
        json={"seed_mode": "keep"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 400


def test_rerun_nsfw_source_hidden_on_main_site(ctx):
    """主站(无 X-NSFW 头)对 R18 作业 rerun → 404,不泄露存在性。"""
    client, token, engine, uid, tid = ctx
    src = _mk_job(engine, uid, tid, nsfw=True, params=_SNAPSHOT)
    r = client.post(
        f"/api/jobs/{src.id}/rerun",
        json={"seed_mode": "keep"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 404


def test_versions_chain_and_nsfw_gate(ctx):
    """版本链:同根全列(时间升序);主站过滤 R18 版本,/nsfw 专页可见。"""
    client, token, engine, uid, tid = ctx
    H = {"Authorization": f"Bearer {token}"}
    a = _mk_job(engine, uid, tid, params=_SNAPSHOT)
    b = _mk_job(engine, uid, tid, parent_id=a.id, root_id=a.id, nsfw=True)
    c = _mk_job(engine, uid, tid, parent_id=a.id, root_id=a.id)

    r = client.get(f"/api/jobs/{c.id}/versions", headers=H)
    assert r.status_code == 200, r.text
    ids = [v["id"] for v in r.json()]
    assert ids == [a.id, c.id]  # 主站不见 R18 版本

    r2 = client.get(f"/api/jobs/{c.id}/versions", headers={**H, "X-NSFW": "1"})
    assert [v["id"] for v in r2.json()] == [a.id, b.id, c.id]

    # 从根寻址得到同一条链;版本条目带 has_params 标记
    r3 = client.get(f"/api/jobs/{a.id}/versions", headers=H)
    rows = r3.json()
    assert [v["id"] for v in rows] == [a.id, c.id]
    assert rows[0]["has_params"] is True
    assert rows[1]["has_params"] is False


def test_list_jobs_includes_version_fields(ctx):
    """作品库列表带 parent_id/root_id/has_params(前端版本徽章用)。"""
    client, token, engine, uid, tid = ctx
    a = _mk_job(engine, uid, tid, params=_SNAPSHOT)
    b = _mk_job(engine, uid, tid, parent_id=a.id, root_id=a.id)
    r = client.get("/api/jobs", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200
    by_id = {j["id"]: j for j in r.json()}
    assert by_id[a.id]["root_id"] == a.id  # 根:root_id 归一为自身 id
    assert by_id[a.id]["has_params"] is True
    assert by_id[b.id]["parent_id"] == a.id
    assert by_id[b.id]["root_id"] == a.id
