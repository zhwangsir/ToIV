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

    async def pick(self, required=(), required_nodes=None):  # noqa: ANN001
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
        db_mod._run_column_migrations()  # 第一次:补列
        db_mod._run_column_migrations()  # 第二次:幂等,不应报错
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


def test_models_nsfw_only_when_nsfw_enabled(client):
    """新语义:R18 放行看 X-NSFW 请求头(/nsfw 专页)。
    /nsfw 专页只展示成人向模型,SFW 底模(DreamShaper_8)不混入。"""
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "r18user", nsfw_enabled=True)
    app.dependency_overrides[get_pool] = lambda: _FakePool()
    token = create_token(uid)
    r = c.get("/api/models", headers={"Authorization": f"Bearer {token}", "X-NSFW": "1"})
    assert r.status_code == 200
    body = r.json()
    # NSFW 专页:仅保留 NSFW 底模,SFW 的 DreamShaper_8 被剔除
    assert body["checkpoints"] == ["ponyRealism.safetensors"]
    assert body["modes"]["image"]["models"] == ["ponyRealism.safetensors"]
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
        "/api/models/local",
        headers={"Authorization": f"Bearer {create_token(uid_on)}", "X-NSFW": "1"},
    ).json()
    assert "ponyRealism.safetensors" in on["checkpoints"]
    assert "nsfw_boost.safetensors" in on["loras"]


# --------------------------------------------------------------------------- #
# 5) marketplace 门槛:统一读 X-NSFW 请求上下文(nsfw_enabled 账户开关已废弃)
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
    # 即便客户端显式传 nsfw=true,无 X-NSFW 头(主站)也必须被强制成 "false"
    r = c.get(
        "/api/marketplace/search?source=civitai&nsfw=true",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 200
    assert captured["nsfw"] == "false"


def test_marketplace_account_flag_no_longer_allows_nsfw(client, monkeypatch):
    """语义统一:账户开关 nsfw_enabled 已废弃,即使为 True,不带 X-NSFW 头仍强制 SFW。"""
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "mktlegacy", nsfw_enabled=True)  # 账户开关已废弃

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
    assert captured["nsfw"] == "false"


def test_marketplace_allows_nsfw_when_enabled(client, monkeypatch):
    """带 X-NSFW 头(/nsfw 专页)时,nsfw 参数原样透传给 Civitai。"""
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "mkton", nsfw_enabled=False)  # 账户开关不再参与

    captured: dict = {}

    async def fake_get_json(url, params, headers=None):  # noqa: ANN001
        captured.update(params)
        return {"items": []}

    monkeypatch.setattr(marketplace_route, "_get_json", fake_get_json)
    token = create_token(uid)
    r = c.get(
        "/api/marketplace/search?source=civitai&nsfw=true",
        headers={"Authorization": f"Bearer {token}", "X-NSFW": "1"},
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
    """新语义:带 X-NSFW 头(/nsfw 专页)才能看到 R18 作品。"""
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "jobson", nsfw_enabled=True)
        user = s.get(User, uid)
        _seed_jobs(s, user)
    r = c.get(
        "/api/jobs",
        headers={"Authorization": f"Bearer {create_token(uid)}", "X-NSFW": "1"},
    )
    assert r.status_code == 200
    prompts = {j["prompt"] for j in r.json()}
    assert prompts == {"sfw work", "r18 work"}
    # 条目携带 nsfw 标记:/nsfw 专区作品库据此过滤出 R18 作品
    flags = {j["prompt"]: j["nsfw"] for j in r.json()}
    assert flags == {"sfw work": False, "r18 work": True}


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
        headers={"Authorization": f"Bearer {token}", "X-NSFW": "1"},
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


# --------------------------------------------------------------------------- #
# 7b) sfw_intent 预设(2026-08-08):底模命中 hints 但定位主站,豁免 R18 门槛
# --------------------------------------------------------------------------- #


def test_generate_sfw_intent_preset_bypasses_hints_gate(client, monkeypatch):
    """style_preset=anime(底模 waiIllustrious,命中 is_nsfw hints):主站放行且不打 nsfw 标。"""
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "genpreset", nsfw_enabled=False)
    app.dependency_overrides[get_pool] = lambda: _FakePool()
    monkeypatch.setattr(generate_route, "spawn_tracker", lambda client, prompt_id: None)
    token = create_token(uid)
    r = c.post(
        "/api/generate/txt2img",
        headers={"Authorization": f"Bearer {token}"},
        json={"positive": "a girl, school uniform", "style_preset": "anime"},
    )
    assert r.status_code == 200, r.text
    with Session(engine) as s:
        job = s.exec(select(Job).where(Job.user_id == uid)).first()
        assert job is not None and job.nsfw is False


def test_generate_sfw_intent_preset_does_not_shield_explicit_ckpt(client, monkeypatch):
    """显式 ckpt 优先于预设:style_preset=anime + 显式 R18 底模仍走硬门槛 403。"""
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "genshield", nsfw_enabled=False)
    app.dependency_overrides[get_pool] = lambda: _FakePool()
    monkeypatch.setattr(generate_route, "spawn_tracker", lambda client, prompt_id: None)
    token = create_token(uid)
    r = c.post(
        "/api/generate/txt2img",
        headers={"Authorization": f"Bearer {token}"},
        json={
            "positive": "a cat",
            "style_preset": "anime",
            "ckpt_name": "ponyRealism.safetensors",
        },
    )
    assert r.status_code == 403, r.text


def test_generate_nsfw_preset_still_gated_on_main_site(client, monkeypatch):
    """真 NSFW 预设(nsfw_anime→autismmix):主站(无 X-NSFW)仍 403;带 X-NSFW 放行并打标。"""
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "gennsfwpreset", nsfw_enabled=False)
    app.dependency_overrides[get_pool] = lambda: _FakePool()
    monkeypatch.setattr(generate_route, "spawn_tracker", lambda client, prompt_id: None)
    token = create_token(uid)
    body = {"positive": "a girl", "style_preset": "nsfw_anime"}

    r = c.post("/api/generate/txt2img", headers={"Authorization": f"Bearer {token}"}, json=body)
    assert r.status_code == 403, r.text

    r2 = c.post(
        "/api/generate/txt2img",
        headers={"Authorization": f"Bearer {token}", "X-NSFW": "1"},
        json=body,
    )
    assert r2.status_code == 200, r2.text
    with Session(engine) as s:
        job = s.exec(select(Job).where(Job.user_id == uid)).first()
        assert job is not None and job.nsfw is True


def test_generate_nextgen_ckpt_ok(client, monkeypatch):
    """A 期回归:次世代底模(z_image)走 UNET 图分支必须 200 出图。

    抓的真 bug:generate_txt2img 的 nextgen 分支不建 `params`,残留的 `params.seed`
    引用会 UnboundLocalError→500(builder 单测抓不到,只有端点级测试能抓)。
    """
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "gennext", nsfw_enabled=False)
    app.dependency_overrides[get_pool] = lambda: _FakePool()
    monkeypatch.setattr(generate_route, "spawn_tracker", lambda client, prompt_id: None)
    token = create_token(uid)
    r = c.post(
        "/api/generate/txt2img",
        headers={"Authorization": f"Bearer {token}"},
        json={"positive": "a red fox in snow", "ckpt_name": "z_image_turbo_bf16.safetensors"},
    )
    assert r.status_code == 200, r.text
    assert r.json().get("seed") is not None  # nextgen 分支 seed_used 正确回传
    with Session(engine) as s:
        job = s.exec(select(Job).where(Job.user_id == uid)).first()
        assert job is not None and job.kind == "txt2img"


# --------------------------------------------------------------------------- #
# 8) 漫剧单镜 / raw 工作流:与其它端点同一 R18 门槛(header-only)
# --------------------------------------------------------------------------- #


def test_manju_shot_nsfw_ckpt_gated_and_tagged(client, monkeypatch):
    """漫剧单镜:R18 底模主站 403;/nsfw(带头)放行并打 Job.nsfw 标。"""
    import app.routes.manju as manju_route

    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "manjugate", nsfw_enabled=False)
    app.dependency_overrides[get_pool] = lambda: _FakePool()
    monkeypatch.setattr(manju_route, "spawn_tracker", lambda *a, **k: None)
    token = create_token(uid)
    body = {"positive": "a cat", "ckpt_name": "ponyRealism.safetensors"}

    r = c.post("/api/manju/shot", headers={"Authorization": f"Bearer {token}"}, json=body)
    assert r.status_code == 403  # 主站无 X-NSFW 头 → 拒

    r2 = c.post(
        "/api/manju/shot",
        headers={"Authorization": f"Bearer {token}", "X-NSFW": "1"},
        json=body,
    )
    assert r2.status_code == 200, r2.text
    with Session(engine) as s:
        job = s.exec(select(Job).where(Job.user_id == uid)).first()
        assert job is not None and job.nsfw is True  # 打标 → 主站作品库/版本链可滤


def test_raw_gate_uses_header_not_account_flag(client, monkeypatch):
    """raw 工作流门槛已切 header-only:遗留账户开关不放行,X-NSFW 头才放行。"""
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "rawgate", nsfw_enabled=True)  # 账户开关已废弃
    app.dependency_overrides[get_pool] = lambda: _FakePool()
    monkeypatch.setattr(generate_route, "spawn_tracker", lambda *a, **k: None)
    token = create_token(uid)
    graph = {
        "1": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "ponyRealism.safetensors"}},
        "2": {"class_type": "SaveImage", "inputs": {}},
    }

    r = c.post("/api/generate/raw", headers={"Authorization": f"Bearer {token}"}, json={"graph": graph})
    assert r.status_code == 403  # 无头 → 拒(即使账户开关为 True)

    r2 = c.post(
        "/api/generate/raw",
        headers={"Authorization": f"Bearer {token}", "X-NSFW": "1"},
        json={"graph": graph},
    )
    assert r2.status_code == 200, r2.text


# --------------------------------------------------------------------------- #
# 9) NSFW 推荐清单:10Eros 配套 LoRA(P1-7,已在 NAS)入清单
# --------------------------------------------------------------------------- #


def test_nsfw_recommendations_include_10eros_loras(client):
    """推荐清单含 10Eros/LTX2.3 配套 NSFW 运动 LoRA(已在 NAS);端点仅需登录。"""
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "recs")
    token = create_token(uid)
    r = c.get("/api/models/nsfw-recommendations", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200
    items = r.json()["items"]
    names = {it["name"] for it in items}
    assert "LTX2.3 NSFW Motion" in names
    assert "Sulphur Better NSFW Motion" in names
    # 每项结构完整(name/type/civitai_url/category)
    for it in items:
        assert it["name"] and it["type"] and it["civitai_url"] and it["category"]


def test_nsfw_recommendations_include_h3_loras(client):
    """推荐清单含 MiniMax H3 LoRA(category=h3,真实 civitai ID,desc 注明文件名/强度/需安装)。

    2026-08-08 首批 4 个 + 生态扩充 4 个(Deepthroat/Vagina/NaughtyTimes/lightx2v Turbo)
    + 2026-08-10 再扩 3 个(HMNSFW AIO/AI Girl Series30/Turbo 850 合并版)
    + 2026-08-11 创作者作品集调研再扩 2 个(HMPussy/Stomach Bulge)。
    """
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "recs-h3")
    token = create_token(uid)
    r = c.get("/api/models/nsfw-recommendations", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200
    items = [it for it in r.json()["items"] if it["category"] == "h3"]
    by_name = {it["name"]: it for it in items}
    assert len(items) == 13
    expected = {
        "H3 Riding POV (I2V)": ("2446218", "riding_pose_H3_i2v_v1.0.safetensors"),
        "H3 Footjob": ("2839680", "H3_footjob_v0_step1000_fixed.safetensors"),
        "H3 Cxy Kiss Lora": ("2842199", "cxy_kiss_lora_h3_v01_step1500.safetensors"),
        "H3 Innie Pussy": ("2841940", "h3_musubi_v4-000040.safetensors"),
        "Daring's Deepthroat H3": ("2476698", "deepthroat_v1.safetensors"),
        "H3 Vagina": ("2835594", "minimax_vag_000002500.safetensors"),
        "SexGod's NaughtyTimes H3": ("2836176", "SexGod-NaughtyTimes-lora-MINIMAXH3.safetensors"),
        "Minimax H3 lightx2v Turbo(加速)": ("2837571", "minimax_h3_fl2v_lightx2v_turbo_4step_v0.1_comfy.safetensors"),
        "HMNSFW AIO Sex LoRA": ("2834417", "HMNSFW_AIO_V2.safetensors"),
        "AI Girl: Fictional Women Series30 H3": ("2845077", "AI_Girl_Fictional_Women_Series30_H3.safetensors"),
        "MiniMAX H3 Turbo 850 步加速(合并剪枝版)": ("2838852", "minimax_h3_turbo_4step_ema_ckpt850_pruned_comfyui.safetensors"),
        "HMPussy (Pussy/Anus) H3": ("2846342", "vagassist_e40.safetensors"),
        "Stomach Bulge H3 (I2V)": ("1445226", "stomach_bulge_H3_i2v_v1.0.safetensors"),
    }
    for name, (civitai_id, filename) in expected.items():
        it = by_name[name]
        assert it["type"] == "lora" and it["base"] == "MiniMax H3"
        assert f"models/{civitai_id}" in it["civitai_url"]
        assert filename in it["desc"]
        assert "需安装" in it["desc"]
        # 多版本模型须带 version_id 精确指定 H3 版
        assert it.get("version_id"), f"{name} 缺 version_id"
