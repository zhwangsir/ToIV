"""应用市场 RunningHub 化(cover_url/author + 封面端点)测试。

覆盖:
  - 迁移:旧 app 表(无 cover_url/author)跑 _run_column_migrations 两次幂等、不丢行
  - slim 列表:cover_url/author 随列表下发(params_schema 等仍清空)
  - fork:cover_url/author 拷贝到个人副本
  - 封面上传:401/403 鉴权、非图 415、超 8MB 413、合法 png 200 且 cover_url 写库;
    替换上传删除旧文件;GET 回读 200 + Content-Type;删除应用清理封面文件
  - seed:内置应用 author="ToIV 官方"、rh-* 社区卡 author 写库、重跑不覆盖人工封面
  - covers/generate:401/403 鉴权、admin 干跑(execute=false)回清单;
    plan_cover_targets 幂等(已有封面跳过)与 rh-* 家族按 base_id 去重
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

import app.routes.apps as apps_route
from app.db import get_session
from app.main import app
from app.models import App, Tenant, User
from app.security import create_token, hash_password
from app.services import app_covers as covers_svc
from app.services.app_seed import seed_builtin_apps

# --------------------------------------------------------------------------- #
# fixtures / helpers(同 test_apps.py 口径)
# --------------------------------------------------------------------------- #


def _make_user(session: Session, email: str, role: str = "user") -> str:
    tenant = Tenant(name=email.split("@")[0])
    session.add(tenant)
    session.commit()
    session.refresh(tenant)
    user = User(
        email=email,
        hashed_password=hash_password("password1"),
        tenant_id=tenant.id,
        role=role,
    )
    session.add(user)
    session.commit()
    session.refresh(user)
    return user.id


_GRAPH = {
    "3": {"class_type": "CLIPTextEncode", "inputs": {"text": "p", "clip": ["1", 1]}},
    "1": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "a.safetensors"}},
    "9": {"class_type": "SaveImage", "inputs": {"images": ["8", 0]}},
}
_SCHEMA = [{"key": "prompt", "label": "提示词", "type": "textarea", "default": "", "required": True}]
_BINDINGS = {"prompt": {"node": "3", "field": "inputs.text"}}

_PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64  # 魔数校验只看头部


@pytest.fixture
def ctx(tmp_path, monkeypatch):
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
    # 封面落盘指到临时目录(content_subdir 默认 /data 在测试机不可写会退到共享 tmp)
    def _subdir(name: str):
        d = tmp_path / name
        d.mkdir(parents=True, exist_ok=True)
        return d

    monkeypatch.setattr(apps_route, "content_subdir", _subdir)
    with Session(engine) as s:
        admin_id = _make_user(s, "admin@toiv.ai", role="admin")
        user_id = _make_user(s, "bob@toiv.ai", role="user")
    yield TestClient(app), {
        "admin": create_token(admin_id),
        "user": create_token(user_id),
    }, engine, tmp_path
    app.dependency_overrides.clear()


def _h(tokens: dict, who: str) -> dict:
    return {"Authorization": f"Bearer {tokens[who]}"}


def _create(client: TestClient, tokens: dict, **over) -> dict:
    body = {
        "id": "t2i-basic",
        "name": "文生图基础",
        "description": "一句话出图",
        "category": "image",
        "workflow_json": _GRAPH,
        "params_schema": _SCHEMA,
        "bindings": _BINDINGS,
        "output_kind": "image",
    }
    body.update(over)
    r = client.post("/api/apps", json=body, headers=_h(tokens, "admin"))
    assert r.status_code == 200, r.text
    return r.json()


# --------------------------------------------------------------------------- #
# 1) 迁移幂等
# --------------------------------------------------------------------------- #


def test_migration_adds_app_cover_author_idempotent():
    """旧 app 表(无 cover_url/author)跑迁移两次:补列、幂等、不丢既有行。"""
    eng = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    with eng.begin() as conn:
        conn.execute(
            text(
                "CREATE TABLE app "
                "(id TEXT PRIMARY KEY, name TEXT, description TEXT, icon TEXT)"
            )
        )
        conn.execute(
            text("INSERT INTO app (id, name) VALUES ('a1', '旧应用')")
        )

    import app.db as db_mod

    original = db_mod.engine
    db_mod.engine = eng
    try:
        db_mod._run_column_migrations()  # 第一次:补列
        db_mod._run_column_migrations()  # 第二次:幂等,不应报错
    finally:
        db_mod.engine = original

    with eng.begin() as conn:
        cols = {r[1] for r in conn.exec_driver_sql("PRAGMA table_info(app)").fetchall()}
        row = conn.exec_driver_sql(
            "SELECT name, cover_url, author FROM app WHERE id='a1'"
        ).fetchone()
    assert {"cover_url", "author"} <= cols
    assert row is not None and row[0] == "旧应用"
    assert row[1] == "" and row[2] == ""  # 默认值回填


# --------------------------------------------------------------------------- #
# 2) slim 列表 / fork / Patch
# --------------------------------------------------------------------------- #


def test_list_slim_includes_cover_url_and_author(ctx):
    client, tokens, engine, _ = ctx
    _create(client, tokens, author="ToIV 官方", cover_url="/api/apps/covers/file/appcover-0.png")
    r = client.get("/api/apps", headers=_h(tokens, "user"))
    assert r.status_code == 200
    item = next(i for i in r.json() if i["id"] == "t2i-basic")
    assert item["cover_url"] == "/api/apps/covers/file/appcover-0.png"
    assert item["author"] == "ToIV 官方"
    # slim 语义不变:重字段仍清空
    assert item["params_schema"] == [] and item["bindings"] == {}
    assert item["workflow_json"] is None


def test_patch_cover_url_and_author(ctx):
    client, tokens, engine, _ = ctx
    _create(client, tokens)
    r = client.put(
        "/api/apps/t2i-basic",
        json={"author": "运营大大", "cover_url": "/x/y.png"},
        headers=_h(tokens, "admin"),
    )
    assert r.status_code == 200, r.text
    assert r.json()["author"] == "运营大大"
    assert r.json()["cover_url"] == "/x/y.png"


def test_fork_copies_cover_url_and_author(ctx):
    client, tokens, engine, _ = ctx
    _create(client, tokens, author="原作者", cover_url="/api/apps/covers/file/appcover-a.png")
    r = client.post("/api/apps/t2i-basic/fork", headers=_h(tokens, "user"))
    assert r.status_code == 200, r.text
    forked = r.json()
    assert forked["author"] == "原作者"
    assert forked["cover_url"] == "/api/apps/covers/file/appcover-a.png"
    assert forked["is_mine"] is True


# --------------------------------------------------------------------------- #
# 3) 封面上传 / 回读 / 替换清理
# --------------------------------------------------------------------------- #


def test_upload_cover_auth_and_validation(ctx):
    client, tokens, engine, _ = ctx
    _create(client, tokens)
    files = {"file": ("c.png", _PNG, "image/png")}
    assert client.post("/api/apps/t2i-basic/cover", files=files).status_code == 401
    assert (
        client.post("/api/apps/t2i-basic/cover", files=files, headers=_h(tokens, "user")).status_code
        == 403
    )
    # 非图片(魔数不符)→ 415
    r = client.post(
        "/api/apps/t2i-basic/cover",
        files={"file": ("c.png", b"not an image at all", "image/png")},
        headers=_h(tokens, "admin"),
    )
    assert r.status_code == 415
    # Content-Type 非 image/* → 415
    r = client.post(
        "/api/apps/t2i-basic/cover",
        files={"file": ("c.png", _PNG, "application/octet-stream")},
        headers=_h(tokens, "admin"),
    )
    assert r.status_code == 415
    # 超 8MB → 413
    r = client.post(
        "/api/apps/t2i-basic/cover",
        files={"file": ("big.png", b"\x89PNG\r\n\x1a\n" + b"\x00" * (8 * 1024 * 1024), "image/png")},
        headers=_h(tokens, "admin"),
    )
    assert r.status_code == 413
    # 不存在应用 → 404
    r = client.post(
        "/api/apps/nope/cover", files=files, headers=_h(tokens, "admin"),
    )
    assert r.status_code == 404


def test_upload_cover_writes_url_and_serves_file(ctx):
    client, tokens, engine, cover_dir = ctx
    _create(client, tokens)
    r = client.post(
        "/api/apps/t2i-basic/cover",
        files={"file": ("c.png", _PNG, "image/png")},
        headers=_h(tokens, "admin"),
    )
    assert r.status_code == 200, r.text
    url = r.json()["cover_url"]
    assert url.startswith("/api/apps/covers/file/appcover-") and url.endswith(".png")
    assert (cover_dir / "app-covers" / url.rsplit("/", 1)[1]).is_file()
    # 回读:登录用户 200 + image/png;未登录 401;非法名 400;不存在 404
    r = client.get(url, headers=_h(tokens, "user"))
    assert r.status_code == 200 and r.headers["content-type"] == "image/png"
    assert r.content == _PNG
    assert client.get(url).status_code == 401
    assert (
        client.get("/api/apps/covers/file/..%2F..%2Fetc", headers=_h(tokens, "user")).status_code
        in (400, 404, 422)
    )
    assert (
        client.get(
            "/api/apps/covers/file/appcover-" + "0" * 32 + ".png", headers=_h(tokens, "user")
        ).status_code
        == 404
    )


def test_replace_cover_deletes_old_file(ctx):
    client, tokens, engine, cover_dir = ctx
    _create(client, tokens)
    files = {"file": ("c.png", _PNG, "image/png")}
    r1 = client.post("/api/apps/t2i-basic/cover", files=files, headers=_h(tokens, "admin"))
    old_name = r1.json()["cover_url"].rsplit("/", 1)[1]
    r2 = client.post("/api/apps/t2i-basic/cover", files=files, headers=_h(tokens, "admin"))
    new_name = r2.json()["cover_url"].rsplit("/", 1)[1]
    assert old_name != new_name
    assert not (cover_dir / "app-covers" / old_name).exists()
    assert (cover_dir / "app-covers" / new_name).is_file()


def test_delete_app_removes_cover_file(ctx):
    client, tokens, engine, cover_dir = ctx
    _create(client, tokens)
    r = client.post(
        "/api/apps/t2i-basic/cover",
        files={"file": ("c.png", _PNG, "image/png")},
        headers=_h(tokens, "admin"),
    )
    name = r.json()["cover_url"].rsplit("/", 1)[1]
    assert client.delete("/api/apps/t2i-basic", headers=_h(tokens, "admin")).status_code == 200
    assert not (cover_dir / "app-covers" / name).exists()


# --------------------------------------------------------------------------- #
# 4) seed 写 author / 不覆盖人工封面
# --------------------------------------------------------------------------- #


def _fresh_session():
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    SQLModel.metadata.create_all(engine)
    return engine


def test_seed_writes_author_and_keeps_cover():
    engine = _fresh_session()
    with Session(engine) as s:
        seed_builtin_apps(s)
        official = s.get(App, "txt2img-basic")
        assert official is not None and official.author == "ToIV 官方"
        rh = s.exec(select(App).where(App.id.like("rh-%"))).all()  # type: ignore[attr-defined]
        assert len(rh) >= 1000
        assert all(a.author for a in rh)  # 目录每行都有 author
        # 重跑:author 幂等;人工上传的封面不被 seed 清掉
        official.cover_url = "/api/apps/covers/file/appcover-b.png"
        s.add(official)
        s.commit()
        created = seed_builtin_apps(s)
        assert created == 0
        official = s.get(App, "txt2img-basic")
        assert official.cover_url == "/api/apps/covers/file/appcover-b.png"
        assert official.author == "ToIV 官方"


# --------------------------------------------------------------------------- #
# 5) covers/generate 鉴权 + plan 幂等/家族去重
# --------------------------------------------------------------------------- #


def test_covers_generate_auth_and_dry_run(ctx):
    client, tokens, engine, _ = ctx
    assert client.post("/api/apps/covers/generate", json={}).status_code == 401
    assert (
        client.post("/api/apps/covers/generate", json={}, headers=_h(tokens, "user")).status_code
        == 403
    )
    # 干跑:不烧 GPU,只回清单(本库无待生成应用 → planned 0)
    r = client.post(
        "/api/apps/covers/generate",
        json={"execute": False},
        headers=_h(tokens, "admin"),
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["started"] is False
    assert body["planned"] == 0 and body["total_pending"] == 0
    # status 端点同样鉴权
    assert client.get("/api/apps/covers/generate/status").status_code == 401
    r = client.get("/api/apps/covers/generate/status", headers=_h(tokens, "admin"))
    assert r.status_code == 200 and r.json()["never_run"] is True


def test_plan_cover_targets_idempotent_and_family_dedup():
    """plan:已有封面跳过;rh-* 同 base_id 家族合并为一个共享目标。"""
    from app.services.rh_h3_preset_seed import load_preset_rows

    rows = load_preset_rows()
    # 取同 base_id 的两个 rh 预制卡 id
    by_base: dict[str, list[str]] = {}
    for r in rows:
        by_base.setdefault(str(r.get("base_id") or ""), []).append(str(r.get("id") or ""))
    base_id, ids = next((b, i) for b, i in by_base.items() if len(i) >= 2)

    engine = _fresh_session()
    with Session(engine) as s:
        s.add(App(id="solo-app", name="单卡", workflow_json=_GRAPH, is_builtin=True))
        s.add(App(
            id="covered-app", name="已有封面", workflow_json=_GRAPH,
            is_builtin=True, cover_url="/api/apps/covers/file/appcover-c.png",
        ))
        for i, rid in enumerate(ids[:3]):
            s.add(App(id=rid, name=f"社区卡{i}", workflow_json=_GRAPH, is_builtin=True))
        s.commit()

        targets = covers_svc.plan_cover_targets(s)
        keys = {t.key for t in targets}
        assert "solo-app" in keys
        assert "covered-app" not in keys  # 已有封面 → 幂等跳过
        fam = [t for t in targets if t.key == base_id]
        assert len(fam) == 1  # 家族去重:一张封面共享
        assert set(fam[0].app_ids) == set(ids[:3])
        assert fam[0].prompt  # 提示词已派生
        # NSFW 家族提示词不得含成人语义(SFW 安全降级为抽象氛围)
        nsfw_targets = [t for t in targets if t.is_nsfw]
        for t in nsfw_targets:
            assert "no people" in t.prompt
