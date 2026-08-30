"""应用市场 M1(/api/apps CRUD + fork)测试。

覆盖:
  - 鉴权:list 401 / create 非 admin 403
  - 创建:字段回读 / id 撞车 409 / 非法 category 422 / 坏图(缺 class_type)422
        / 绑定悬空(节点不在图内)422 / 绑定 key 不在 schema 422
  - 三区可见性:公共(admin 建)全员可见;个人应用仅属主(他人列表不见、详情 404)
  - NSFW 门控:无 X-NSFW 列表不见/详情 404,带 X-NSFW 可见
  - 详情 workflow_json 仅属主/admin 透出(普通用户为 None)
  - 更新:内置 403 / 公共非 admin 403 / 个人属主可改 / is_builtin 不可变
  - 删除:内置 403 / 个人属主可删 / 公共非 admin 403
  - fork:复制为个人应用(is_public=False、usage_count=0、is_builtin=False、深拷贝独立)
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.db import get_session
from app.main import app
from app.models import App, Tenant, User
from app.security import create_token, hash_password

# --------------------------------------------------------------------------- #
# fixtures / helpers
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
    "3": {"class_type": "CLIPTextEncode", "inputs": {"text": "default prompt", "clip": ["1", 1]}},
    "1": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "a.safetensors"}},
    "9": {"class_type": "SaveImage", "inputs": {"images": ["8", 0]}},
}
_SCHEMA = [
    {"key": "prompt", "label": "提示词", "type": "textarea", "default": "", "required": True},
    {"key": "steps", "label": "步数", "type": "number", "default": 20, "min": 1, "max": 50},
]
_BINDINGS = {"prompt": {"node": "3", "field": "inputs.text"}}


def _create_body(**over) -> dict:
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
    return body


def _seed_app(session: Session, **over) -> App:
    """直接落库一个应用(内置/个人等 API 建不出的形态)。"""
    a = App(
        id=over.pop("id", "seeded"),
        name=over.pop("name", "种子应用"),
        workflow_json=over.pop("workflow_json", _GRAPH),
        params_schema=over.pop("params_schema", _SCHEMA),
        bindings=over.pop("bindings", _BINDINGS),
        **over,
    )
    session.add(a)
    session.commit()
    session.refresh(a)
    return a


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
        admin_id = _make_user(s, "admin@toiv.ai", role="admin")
        user_id = _make_user(s, "bob@toiv.ai", role="user")
        other_id = _make_user(s, "carol@toiv.ai", role="user")
    yield TestClient(app), {
        "admin": create_token(admin_id),
        "user": create_token(user_id),
        "other": create_token(other_id),
    }, {"admin": admin_id, "user": user_id, "other": other_id}, engine
    app.dependency_overrides.clear()


def _h(tokens: dict, who: str, nsfw: bool = False) -> dict:
    headers = {"Authorization": f"Bearer {tokens[who]}"}
    if nsfw:
        headers["X-NSFW"] = "1"
    return headers


# --------------------------------------------------------------------------- #
# 鉴权
# --------------------------------------------------------------------------- #
def test_list_requires_auth(ctx):
    c, *_ = ctx
    assert c.get("/api/apps").status_code == 401


def test_create_requires_admin(ctx):
    c, tokens, _, _ = ctx
    r = c.post("/api/apps", headers=_h(tokens, "user"), json=_create_body())
    assert r.status_code == 403


def test_create_requires_auth(ctx):
    c, *_ = ctx
    assert c.post("/api/apps", json=_create_body()).status_code == 401


# --------------------------------------------------------------------------- #
# 创建
# --------------------------------------------------------------------------- #
def test_create_ok_roundtrip(ctx):
    c, tokens, _, _ = ctx
    r = c.post("/api/apps", headers=_h(tokens, "admin"), json=_create_body(sort=10))
    assert r.status_code == 200, r.text
    a = r.json()
    assert a["id"] == "t2i-basic"
    assert a["category"] == "image"
    assert a["submit_kind"] == "app_run"  # 默认
    assert a["is_builtin"] is False  # API 创建永远非内置
    assert a["is_public"] is True
    assert a["usage_count"] == 0
    assert a["params_schema"][0]["key"] == "prompt"
    # admin 建时回读含 workflow_json
    assert a["workflow_json"]["3"]["class_type"] == "CLIPTextEncode"


def test_create_duplicate_id_409(ctx):
    c, tokens, _, _ = ctx
    assert c.post("/api/apps", headers=_h(tokens, "admin"), json=_create_body()).status_code == 200
    r = c.post("/api/apps", headers=_h(tokens, "admin"), json=_create_body())
    assert r.status_code == 409


def test_create_invalid_category_422(ctx):
    c, tokens, _, _ = ctx
    r = c.post("/api/apps", headers=_h(tokens, "admin"), json=_create_body(category="bogus"))
    assert r.status_code == 422


def test_create_bad_workflow_422(ctx):
    c, tokens, _, _ = ctx
    bad = {"1": {"inputs": {}}, "9": {"class_type": "SaveImage", "inputs": {}}}
    r = c.post("/api/apps", headers=_h(tokens, "admin"), json=_create_body(workflow_json=bad))
    assert r.status_code == 422


def test_create_dangling_binding_node_422(ctx):
    """绑定指向图内不存在的节点 → 422(防上架即坏)。"""
    c, tokens, _, _ = ctx
    r = c.post(
        "/api/apps", headers=_h(tokens, "admin"),
        json=_create_body(bindings={"prompt": {"node": "99", "field": "inputs.text"}}),
    )
    assert r.status_code == 422


def test_create_binding_key_not_in_schema_422(ctx):
    c, tokens, _, _ = ctx
    r = c.post(
        "/api/apps", headers=_h(tokens, "admin"),
        json=_create_body(bindings={"ghost": {"node": "3", "field": "inputs.text"}}),
    )
    assert r.status_code == 422


def test_create_bad_binding_field_422(ctx):
    c, tokens, _, _ = ctx
    r = c.post(
        "/api/apps", headers=_h(tokens, "admin"),
        json=_create_body(bindings={"prompt": {"node": "3", "field": "class_type"}}),
    )
    assert r.status_code == 422


# --------------------------------------------------------------------------- #
# 列表:可见性 / NSFW / 过滤 / 排序
# --------------------------------------------------------------------------- #
def test_list_public_visible_personal_hidden(ctx):
    """公共应用全员可见;他人个人应用列表不见。"""
    c, tokens, ids, engine = ctx
    c.post("/api/apps", headers=_h(tokens, "admin"), json=_create_body())
    with Session(engine) as s:
        _seed_app(s, id="mine", user_id=ids["user"], is_public=False)
    r = c.get("/api/apps", headers=_h(tokens, "user"))
    assert r.status_code == 200
    got = {a["id"] for a in r.json()}
    assert {"t2i-basic", "mine"} <= got
    mine = next(a for a in r.json() if a["id"] == "mine")
    assert mine["is_mine"] is True
    pub = next(a for a in r.json() if a["id"] == "t2i-basic")
    assert pub["is_mine"] is False
    # 列表不透出 workflow_json
    assert pub["workflow_json"] is None

    r2 = c.get("/api/apps", headers=_h(tokens, "other"))
    got2 = {a["id"] for a in r2.json()}
    assert "t2i-basic" in got2 and "mine" not in got2


def test_list_nsfw_gated(ctx):
    c, tokens, _, _ = ctx
    c.post(
        "/api/apps", headers=_h(tokens, "admin"),
        json=_create_body(id="nsfw-app", is_nsfw=True),
    )
    c.post("/api/apps", headers=_h(tokens, "admin"), json=_create_body())
    r = c.get("/api/apps", headers=_h(tokens, "user"))
    ids = {a["id"] for a in r.json()}
    assert "nsfw-app" not in ids and "t2i-basic" in ids
    r2 = c.get("/api/apps", headers=_h(tokens, "user", nsfw=True))
    assert "nsfw-app" in {a["id"] for a in r2.json()}


def test_list_category_and_q_filter(ctx):
    c, tokens, _, _ = ctx
    c.post("/api/apps", headers=_h(tokens, "admin"), json=_create_body())
    c.post(
        "/api/apps", headers=_h(tokens, "admin"),
        json=_create_body(id="vid-app", name="视频生成", category="video"),
    )
    r = c.get("/api/apps?category=video", headers=_h(tokens, "user"))
    assert {a["id"] for a in r.json()} == {"vid-app"}
    r2 = c.get("/api/apps?q=视频", headers=_h(tokens, "user"))
    assert {a["id"] for a in r2.json()} == {"vid-app"}
    r3 = c.get("/api/apps?q=不存在的东西", headers=_h(tokens, "user"))
    assert r3.json() == []


def test_list_sorted_by_sort(ctx):
    c, tokens, _, _ = ctx
    c.post("/api/apps", headers=_h(tokens, "admin"), json=_create_body(id="a1", sort=200))
    c.post("/api/apps", headers=_h(tokens, "admin"), json=_create_body(id="a2", sort=10))
    r = c.get("/api/apps", headers=_h(tokens, "user"))
    sorts = [a["sort"] for a in r.json()]
    assert sorts == sorted(sorts)
    assert r.json()[0]["id"] == "a2"


# --------------------------------------------------------------------------- #
# 详情:workflow_json 属主/admin 透出
# --------------------------------------------------------------------------- #
def test_detail_workflow_json_visibility(ctx):
    c, tokens, _, _ = ctx
    c.post("/api/apps", headers=_h(tokens, "admin"), json=_create_body())
    # 普通用户(非属主):workflow_json 不透出
    r = c.get("/api/apps/t2i-basic", headers=_h(tokens, "user"))
    assert r.status_code == 200
    assert r.json()["workflow_json"] is None
    assert r.json()["params_schema"][0]["key"] == "prompt"
    # admin:透出
    r2 = c.get("/api/apps/t2i-basic", headers=_h(tokens, "admin"))
    assert r2.json()["workflow_json"]["3"]["inputs"]["text"] == "default prompt"


def test_detail_404_and_personal_hidden(ctx):
    c, tokens, ids, engine = ctx
    assert c.get("/api/apps/nope", headers=_h(tokens, "user")).status_code == 404
    with Session(engine) as s:
        _seed_app(s, id="mine", user_id=ids["user"], is_public=False)
    # 他人个人应用 404(不泄露存在性)
    assert c.get("/api/apps/mine", headers=_h(tokens, "other")).status_code == 404
    # 属主可见
    assert c.get("/api/apps/mine", headers=_h(tokens, "user")).status_code == 200


def test_detail_nsfw_hidden_without_header(ctx):
    c, tokens, _, _ = ctx
    c.post("/api/apps", headers=_h(tokens, "admin"), json=_create_body(id="na", is_nsfw=True))
    assert c.get("/api/apps/na", headers=_h(tokens, "user")).status_code == 404
    assert c.get("/api/apps/na", headers=_h(tokens, "user", nsfw=True)).status_code == 200


# --------------------------------------------------------------------------- #
# 更新 / 删除
# --------------------------------------------------------------------------- #
def test_update_builtin_403(ctx):
    c, tokens, _, engine = ctx
    with Session(engine) as s:
        _seed_app(s, id="builtin", is_builtin=True)
    r = c.put("/api/apps/builtin", headers=_h(tokens, "admin"), json={"name": "x"})
    assert r.status_code == 403


def test_update_public_requires_admin(ctx):
    c, tokens, _, _ = ctx
    c.post("/api/apps", headers=_h(tokens, "admin"), json=_create_body())
    r = c.put("/api/apps/t2i-basic", headers=_h(tokens, "user"), json={"name": "hack"})
    assert r.status_code == 403


def test_update_personal_by_owner_ok(ctx):
    c, tokens, ids, engine = ctx
    with Session(engine) as s:
        _seed_app(s, id="mine", user_id=ids["user"], is_public=False)
    r = c.put(
        "/api/apps/mine", headers=_h(tokens, "user"),
        json={"name": "我的改名", "description": "新简介", "is_public": True},
    )
    assert r.status_code == 200, r.text
    a = r.json()
    assert a["name"] == "我的改名" and a["description"] == "新简介"
    assert a["is_public"] is True
    # 上架后他人列表可见
    got = {x["id"] for x in c.get("/api/apps", headers=_h(tokens, "other")).json()}
    assert "mine" in got


def test_update_personal_by_other_403(ctx):
    """属主上架(is_public)的个人应用,他人可见但不可改。"""
    c, tokens, ids, engine = ctx
    with Session(engine) as s:
        _seed_app(s, id="mine", user_id=ids["user"], is_public=True)
    r = c.put("/api/apps/mine", headers=_h(tokens, "other"), json={"name": "hack"})
    assert r.status_code == 403


def test_delete_builtin_403(ctx):
    c, tokens, _, engine = ctx
    with Session(engine) as s:
        _seed_app(s, id="builtin", is_builtin=True)
    assert c.delete("/api/apps/builtin", headers=_h(tokens, "admin")).status_code == 403


def test_delete_public_requires_admin(ctx):
    c, tokens, _, _ = ctx
    c.post("/api/apps", headers=_h(tokens, "admin"), json=_create_body())
    assert c.delete("/api/apps/t2i-basic", headers=_h(tokens, "user")).status_code == 403


def test_delete_personal_by_owner_ok(ctx):
    c, tokens, ids, engine = ctx
    with Session(engine) as s:
        _seed_app(s, id="mine", user_id=ids["user"])
    r = c.delete("/api/apps/mine", headers=_h(tokens, "user"))
    assert r.status_code == 200
    assert c.get("/api/apps/mine", headers=_h(tokens, "user")).status_code == 404


# --------------------------------------------------------------------------- #
# fork
# --------------------------------------------------------------------------- #
def test_fork_creates_personal_copy(ctx):
    c, tokens, ids, engine = ctx
    c.post("/api/apps", headers=_h(tokens, "admin"), json=_create_body(usage_count=0) | {"id": "pub"})
    r = c.post("/api/apps/pub/fork", headers=_h(tokens, "user"))
    assert r.status_code == 200, r.text
    a = r.json()
    assert a["id"] != "pub"
    assert a["is_mine"] is True
    assert a["is_public"] is False
    assert a["is_builtin"] is False
    assert a["usage_count"] == 0
    assert a["name"] == "文生图基础"
    # fork 者是属主 → workflow_json 透出且内容一致
    assert a["workflow_json"]["3"]["inputs"]["text"] == "default prompt"
    # 深拷贝独立:改 fork 的图不动原应用
    fid = a["id"]
    new_graph = {"3": {"class_type": "CLIPTextEncode", "inputs": {"text": "forked", "clip": ["1", 1]}},
                 "1": _GRAPH["1"], "9": _GRAPH["9"]}
    r2 = c.put(f"/api/apps/{fid}", headers=_h(tokens, "user"), json={"workflow_json": new_graph})
    assert r2.status_code == 200
    orig = c.get("/api/apps/pub", headers=_h(tokens, "admin")).json()
    assert orig["workflow_json"]["3"]["inputs"]["text"] == "default prompt"


def test_fork_404_for_invisible(ctx):
    c, tokens, ids, engine = ctx
    assert c.post("/api/apps/nope/fork", headers=_h(tokens, "user")).status_code == 404
    with Session(engine) as s:
        _seed_app(s, id="mine", user_id=ids["user"], is_public=False)
    # 他人私有应用不可 fork(404 不泄露)
    assert c.post("/api/apps/mine/fork", headers=_h(tokens, "other")).status_code == 404
    # 属主 fork 自己的可以
    assert c.post("/api/apps/mine/fork", headers=_h(tokens, "user")).status_code == 200


def test_fork_nsfw_gated(ctx):
    c, tokens, _, _ = ctx
    c.post("/api/apps", headers=_h(tokens, "admin"), json=_create_body(id="na", is_nsfw=True))
    assert c.post("/api/apps/na/fork", headers=_h(tokens, "user")).status_code == 404
    r = c.post("/api/apps/na/fork", headers=_h(tokens, "user", nsfw=True))
    assert r.status_code == 200
    assert r.json()["is_nsfw"] is True


# --------------------------------------------------------------------------- #
# db.py 幂等建表迁移(prod 既有库补建 app 表)
# --------------------------------------------------------------------------- #
def test_app_raw_migration_present_and_idempotent():
    """app 建表迁移在 raw 列表中,且对既有库可重复执行(幂等)。"""
    from sqlalchemy.pool import StaticPool
    from sqlmodel import create_engine

    from app import db

    stmts = [s for s in db._SQLITE_RAW_MIGRATIONS if "CREATE TABLE IF NOT EXISTS app" in s]
    assert stmts, "app 建表迁移缺失"
    eng = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    for _ in range(2):  # 跑两遍验证幂等
        with eng.begin() as conn:
            conn.exec_driver_sql(stmts[0])
    with eng.begin() as conn:
        cols = {r[1] for r in conn.exec_driver_sql('PRAGMA table_info("app")').fetchall()}
    assert {"id", "workflow_json", "params_schema", "bindings", "usage_count"} <= cols
