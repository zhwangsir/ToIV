"""R18 真分区门槛 —— 后端强制过滤的端到端测试。

覆盖:
  - 迁移幂等(SQLite ADD COLUMN 重复执行不报错、不丢数据)
  - GET /auth/me 含 nsfw_enabled
  - POST /api/account/nsfw 改值并持久化
  - GET /api/models、/api/models/local 关/开过滤(剔除成人底模 + 成人 LoRA)
  - GET /api/marketplace/search 关闭时强制 nsfw=false
  - GET /api/jobs 关闭时剔除 Job.nsfw==True
  - POST /api/generate/txt2img 成人底模未开→403、已开→放行并打标 Job.nsfw
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

import app.routes.generate as generate_route
import app.routes.marketplace as marketplace_route
from app.db import get_session
from app.deps import get_current_user, get_pool, resolve_worker
from app.main import app
from app.models import Job, Tenant, User
from app.security import create_token, hash_password


# --------------------------------------------------------------------------- #
# 公共 fixtures / fakes
# --------------------------------------------------------------------------- #


def _seed_user(session: Session, email: str, nsfw_enabled: bool = False) -> str:
    tenant = Tenant(name=email)
    session.add(tenant)
    session.commit()
    session.refresh(tenant)
    user = User(
        email=email,
        hashed_password=hash_password("password1"),
        tenant_id=tenant.id,
        nsfw_enabled=nsfw_enabled,
    )
    session.add(user)
    session.commit()
    session.refresh(user)
    return user.id


@pytest.fixture
def engine():
    eng = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(eng)
    yield eng


@pytest.fixture
def client(engine):
    def override() -> Session:
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override
    yield TestClient(app), engine
    app.dependency_overrides.clear()


class _FakeClient:
    """最小化 ComfyUIClient 替身:object_info 返回固定 checkpoint/lora 枚举。"""

    def __init__(self) -> None:
        self.base_url = "http://fake-worker"

    async def object_info(self, node: str) -> dict:
        if node == "CheckpointLoaderSimple":
            field = "ckpt_name"
            names = ["DreamShaper_8.safetensors", "ponyRealism.safetensors"]
        elif node == "LoraLoader":
            field = "lora_name"
            names = ["detail_tweaker.safetensors", "nsfw_boost.safetensors"]
        elif node == "KSampler":
            return {
                "KSampler": {
                    "input": {
                        "required": {
                            "sampler_name": [["euler", "dpmpp_2m"]],
                            "scheduler": [["normal", "karras"]],
                        }
                    }
                }
            }
        else:
            # 其它 loader(vae/controlnet/upscale)返回空枚举
            return {node: {"input": {"required": {}}}}
        return {node: {"input": {"required": {field: [names]}}}}

    async def queue_prompt(self, graph: dict, client_id: str) -> str:
        return "prompt-fake-123"


class _FakePool:
    def __init__(self) -> None:
        self._client = _FakeClient()

    @property
    def clients(self) -> list:
        return [self._client]

    async def pick(self, required=()):  # noqa: ANN001
        return self._client


# --------------------------------------------------------------------------- #
# 1) 迁移幂等
# --------------------------------------------------------------------------- #


def test_migration_idempotent_and_nondestructive():
    """对一个「缺新列」的旧表跑迁移:补列、可重复执行、不丢既有行。"""
    eng = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    # 建一个不含 nsfw_enabled 的旧 user 表 + 不含 nsfw 的旧 job 表,并塞一行。
    with eng.begin() as conn:
        conn.execute(
            text(
                'CREATE TABLE "user" '
                "(id TEXT PRIMARY KEY, email TEXT, hashed_password TEXT, "
                "tenant_id TEXT, role TEXT, created_at TEXT)"
            )
        )
        conn.execute(
            text(
                "CREATE TABLE job "
                "(id TEXT PRIMARY KEY, tenant_id TEXT, user_id TEXT, prompt_id TEXT, "
                "worker TEXT, kind TEXT, status TEXT, prompt TEXT, seed INTEGER, "
                "result TEXT, created_at TEXT)"
            )
        )
        conn.execute(
            text(
                'INSERT INTO "user" (id, email, hashed_password, tenant_id, role) '
                "VALUES ('u1', 'legacy', 'h', 't1', 'user')"
            )
        )

    import app.db as db_mod

    # 把全局 engine 暂时指向这个旧库,跑迁移,验证幂等。
    original = db_mod.engine
    db_mod.engine = eng
    try:
        db_mod._run_sqlite_migrations()  # 第一次:补列
        db_mod._run_sqlite_migrations()  # 第二次:幂等,不应报错
    finally:
        db_mod.engine = original

    with eng.begin() as conn:
        user_cols = {r[1] for r in conn.exec_driver_sql('PRAGMA table_info("user")').fetchall()}
        job_cols = {r[1] for r in conn.exec_driver_sql("PRAGMA table_info(job)").fetchall()}
        # 既有数据未被破坏
        row = conn.exec_driver_sql('SELECT email FROM "user" WHERE id=\'u1\'').fetchone()

    assert "nsfw_enabled" in user_cols
    assert "nsfw" in job_cols
    assert row is not None and row[0] == "legacy"


# --------------------------------------------------------------------------- #
# 2) /auth/me 含 nsfw_enabled
# --------------------------------------------------------------------------- #


def test_me_includes_nsfw_enabled(client):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "alice")
    token = create_token(uid)
    r = c.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200
    assert r.json()["user"]["nsfw_enabled"] is False


# --------------------------------------------------------------------------- #
# 3) POST /api/account/nsfw 改值
# --------------------------------------------------------------------------- #


def test_account_nsfw_toggle_persists(client):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "bob")
    token = create_token(uid)
    h = {"Authorization": f"Bearer {token}"}

    on = c.post("/api/account/nsfw", headers=h, json={"enabled": True})
    assert on.status_code == 200 and on.json()["nsfw_enabled"] is True

    # 落库:/auth/me 也应反映
    me = c.get("/api/auth/me", headers=h).json()
    assert me["user"]["nsfw_enabled"] is True

    off = c.post("/api/account/nsfw", headers=h, json={"enabled": False})
    assert off.status_code == 200 and off.json()["nsfw_enabled"] is False


def test_account_nsfw_requires_auth(client):
    c, _ = client
    assert c.post("/api/account/nsfw", json={"enabled": True}).status_code == 401


# --------------------------------------------------------------------------- #
# 4) /api/models + /api/models/local 关/开过滤
# --------------------------------------------------------------------------- #


def _override_pool(pool: _FakePool) -> None:
    app.dependency_overrides[get_pool] = lambda: pool


def test_models_filtered_when_nsfw_disabled(client):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "sfwuser", nsfw_enabled=False)
    app.dependency_overrides[get_pool] = lambda: _FakePool()
    token = create_token(uid)
    r = c.get("/api/models", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200
    body = r.json()
    # 成人底模 ponyRealism 被剔除,只剩 SFW 的 DreamShaper
    assert body["checkpoints"] == ["DreamShaper_8.safetensors"]
    assert all(not it["nsfw"] for it in body["checkpoints_tagged"])
    assert body["nsfw_models"] == []
    assert body["modes"]["image"]["models"] == ["DreamShaper_8.safetensors"]


def test_models_full_when_nsfw_enabled(client):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "r18user", nsfw_enabled=True)
    app.dependency_overrides[get_pool] = lambda: _FakePool()
    token = create_token(uid)
    r = c.get("/api/models", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200
    body = r.json()
    assert set(body["checkpoints"]) == {"DreamShaper_8.safetensors", "ponyRealism.safetensors"}
    assert "ponyRealism.safetensors" in body["nsfw_models"]


def test_local_models_filters_nsfw_loras(client):
    c, engine = client
    with Session(engine) as s:
        uid_off = _seed_user(s, "loralocal_off", nsfw_enabled=False)
        uid_on = _seed_user(s, "loralocal_on", nsfw_enabled=True)
    app.dependency_overrides[get_pool] = lambda: _FakePool()

    off = c.get(
        "/api/models/local", headers={"Authorization": f"Bearer {create_token(uid_off)}"}
    ).json()
    # 成人底模 + 成人 LoRA 均被剔除
    assert off["checkpoints"] == ["DreamShaper_8.safetensors"]
    assert off["loras"] == ["detail_tweaker.safetensors"]
    assert off["nsfw_models"] == []

    on = c.get(
        "/api/models/local", headers={"Authorization": f"Bearer {create_token(uid_on)}"}
    ).json()
    assert "ponyRealism.safetensors" in on["checkpoints"]
    assert "nsfw_boost.safetensors" in on["loras"]


# --------------------------------------------------------------------------- #
# 5) marketplace 关闭时强制 nsfw=false
# --------------------------------------------------------------------------- #


def test_marketplace_forces_sfw_when_disabled(client, monkeypatch):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "mktoff", nsfw_enabled=False)

    captured: dict = {}

    async def fake_get_json(url, params, headers=None):  # noqa: ANN001
        captured.update(params)
        return {"items": []}

    monkeypatch.setattr(marketplace_route, "_get_json", fake_get_json)
    token = create_token(uid)
    # 即便客户端显式传 nsfw=true,未开 R18 也必须被强制成 "false"
    r = c.get(
        "/api/marketplace/search?source=civitai&nsfw=true",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 200
    assert captured["nsfw"] == "false"


def test_marketplace_allows_nsfw_when_enabled(client, monkeypatch):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "mkton", nsfw_enabled=True)

    captured: dict = {}

    async def fake_get_json(url, params, headers=None):  # noqa: ANN001
        captured.update(params)
        return {"items": []}

    monkeypatch.setattr(marketplace_route, "_get_json", fake_get_json)
    token = create_token(uid)
    r = c.get(
        "/api/marketplace/search?source=civitai&nsfw=true",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 200
    assert captured["nsfw"] == "true"


# --------------------------------------------------------------------------- #
# 6) /api/jobs 关闭时剔除 nsfw 作品
# --------------------------------------------------------------------------- #


def _seed_jobs(session: Session, user: User) -> None:
    session.add(
        Job(
            tenant_id=user.tenant_id,
            user_id=user.id,
            prompt_id="sfw1",
            worker="http://w",
            prompt="sfw work",
            nsfw=False,
        )
    )
    session.add(
        Job(
            tenant_id=user.tenant_id,
            user_id=user.id,
            prompt_id="r18-1",
            worker="http://w",
            prompt="r18 work",
            nsfw=True,
        )
    )
    session.commit()


def test_jobs_filtered_when_nsfw_disabled(client):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "jobsoff", nsfw_enabled=False)
        user = s.get(User, uid)
        _seed_jobs(s, user)
    r = c.get("/api/jobs", headers={"Authorization": f"Bearer {create_token(uid)}"})
    assert r.status_code == 200
    prompts = {j["prompt"] for j in r.json()}
    assert prompts == {"sfw work"}  # r18 作品被剔除


def test_jobs_full_when_nsfw_enabled(client):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "jobson", nsfw_enabled=True)
        user = s.get(User, uid)
        _seed_jobs(s, user)
    r = c.get("/api/jobs", headers={"Authorization": f"Bearer {create_token(uid)}"})
    assert r.status_code == 200
    prompts = {j["prompt"] for j in r.json()}
    assert prompts == {"sfw work", "r18 work"}


# --------------------------------------------------------------------------- #
# 7) generate 硬门槛:成人底模未开→403、已开→放行并打标
# --------------------------------------------------------------------------- #


def test_generate_nsfw_ckpt_blocked_when_disabled(client):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "genoff", nsfw_enabled=False)
    app.dependency_overrides[get_pool] = lambda: _FakePool()
    token = create_token(uid)
    r = c.post(
        "/api/generate/txt2img",
        headers={"Authorization": f"Bearer {token}"},
        json={"positive": "a cat", "ckpt_name": "ponyRealism.safetensors"},
    )
    assert r.status_code == 403


def test_generate_nsfw_ckpt_allowed_when_enabled(client, monkeypatch):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "genon", nsfw_enabled=True)
    app.dependency_overrides[get_pool] = lambda: _FakePool()
    # 不触发真实后台追踪
    monkeypatch.setattr(generate_route, "spawn_tracker", lambda client, prompt_id: None)
    token = create_token(uid)
    r = c.post(
        "/api/generate/txt2img",
        headers={"Authorization": f"Bearer {token}"},
        json={"positive": "a cat", "ckpt_name": "ponyRealism.safetensors"},
    )
    assert r.status_code == 200, r.text
    # 作品已建档并打 nsfw 标
    with Session(engine) as s:
        job = s.exec(select(Job).where(Job.user_id == uid)).first()
        assert job is not None and job.nsfw is True


def test_generate_sfw_ckpt_marks_job_not_nsfw(client, monkeypatch):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "gensfw", nsfw_enabled=False)
    app.dependency_overrides[get_pool] = lambda: _FakePool()
    monkeypatch.setattr(generate_route, "spawn_tracker", lambda client, prompt_id: None)
    token = create_token(uid)
    r = c.post(
        "/api/generate/txt2img",
        headers={"Authorization": f"Bearer {token}"},
        json={"positive": "a cat", "ckpt_name": "DreamShaper_8.safetensors"},
    )
    assert r.status_code == 200, r.text
    with Session(engine) as s:
        job = s.exec(select(Job).where(Job.user_id == uid)).first()
        assert job is not None and job.nsfw is False
