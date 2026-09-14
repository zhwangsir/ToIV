"""应用市场 M1(/api/apps CRUD + fork)测试。

覆盖:
  - 鉴权:list 401 / create 非 admin 403
  - 创建:字段回读 / id 撞车 409 / 非法 category 422 / 坏图(缺 class_type)422
        / 绑定悬空(节点不在图内)422 / 绑定 key 不在 schema 422
  - 三区可见性:公共(admin 建)全员可见;个人应用仅属主(他人列表不见、详情 404)
  - NSFW 门控:无 X-NSFW 列表不见/详情 404,带 X-NSFW 可见
  - 详情 workflow_json 对所有可见用户透出(2026-09-02 产品决策:工作流模式展现给用户)
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
    # 列表 slim:不下发图 schema(1166 张 rh-* 否则数 MB)
    assert pub["params_schema"] == []
    assert pub["bindings"] == {}
    assert pub["required_nodes"] == []

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


def test_list_slim_omits_schema_detail_keeps_it(ctx):
    """列表 slim:params_schema/bindings/required_nodes 清空;详情仍完整。"""
    c, tokens, _, engine = ctx
    with Session(engine) as s:
        _seed_app(
            s, id="slim-app", user_id="", is_public=True, name="种子应用",
            description="slim 列表测", icon="sparkles", category="image",
            output_kind="image", sort=10,
            required_nodes=["CLIPTextEncode"],
        )
    listed = next(
        a for a in c.get("/api/apps", headers=_h(tokens, "user")).json() if a["id"] == "slim-app"
    )
    assert listed["params_schema"] == []
    assert listed["bindings"] == {}
    assert listed["required_nodes"] == []
    assert listed["workflow_json"] is None
    assert listed["id"] == "slim-app"
    assert listed["name"] == "种子应用"
    assert listed["description"] == "slim 列表测"
    assert listed["icon"] == "sparkles"
    assert listed["category"] == "image"
    assert listed["output_kind"] == "image"
    assert listed["is_nsfw"] is False
    assert listed["sort"] == 10
    detail = c.get("/api/apps/slim-app", headers=_h(tokens, "user")).json()
    assert detail["params_schema"][0]["key"] == "prompt"
    assert detail["bindings"]["prompt"]["node"] == "3"
    assert detail["required_nodes"] == ["CLIPTextEncode"]
    assert detail["workflow_json"]["3"]["class_type"] == "CLIPTextEncode"


# --------------------------------------------------------------------------- #
# 详情:workflow_json 对所有可见用户透出(2026-09-02 产品决策:工作流模式展现给用户)
# --------------------------------------------------------------------------- #
def test_detail_workflow_json_visibility(ctx):
    c, tokens, _, _ = ctx
    c.post("/api/apps", headers=_h(tokens, "admin"), json=_create_body())
    # 普通用户(非属主):workflow_json 也透出(产品决策:最可控)
    r = c.get("/api/apps/t2i-basic", headers=_h(tokens, "user"))
    assert r.status_code == 200
    assert r.json()["workflow_json"]["3"]["inputs"]["text"] == "default prompt"
    assert r.json()["params_schema"][0]["key"] == "prompt"
    # admin:同样透出
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


def test_admin_can_unhide_soft_hidden_catalog_and_builtin(ctx):
    """soft-hide 后普通用户 404;admin 仍可见并可 is_public=true 再上架。"""
    c, tokens, _, engine = ctx
    with Session(engine) as s:
        _seed_app(s, id="dead-card", user_id="", is_public=False, is_builtin=False)
        _seed_app(s, id="builtin-hid", user_id="", is_public=False, is_builtin=True)
    assert c.get("/api/apps/dead-card", headers=_h(tokens, "user")).status_code == 404
    assert c.get("/api/apps/dead-card", headers=_h(tokens, "admin")).status_code == 200
    r = c.put("/api/apps/dead-card", headers=_h(tokens, "admin"), json={"is_public": True})
    assert r.status_code == 200, r.text
    assert r.json()["is_public"] is True
    assert c.get("/api/apps/dead-card", headers=_h(tokens, "user")).status_code == 200
    # 内置仅允许调 is_public/sort
    r2 = c.put("/api/apps/builtin-hid", headers=_h(tokens, "admin"), json={"is_public": True})
    assert r2.status_code == 200, r2.text
    assert r2.json()["is_public"] is True


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

def test_open_in_comfy_uploads_ui_and_returns_workflow_name(ctx, monkeypatch):
    """可见用户:API 图转 UI → 上传画布 worker userdata → 回 workflow_name。"""
    c, tokens, ids, engine = ctx
    with Session(engine) as s:
        _seed_app(s, id="pub", name="公开", user_id="")

    posted: list[str] = []
    bodies: list[dict] = []

    class _Resp:
        status_code = 200
        text = "ok"
        content = b"{}"

        def json(self):
            return {"backends": [{"id": "gpu0", "url": "http://127.0.0.1:8196", "healthy": True}]}

    class _Client:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def get(self, url):
            return _Resp()

        async def post(self, url, json=None):
            posted.append(url)
            bodies.append(json or {})
            return _Resp()

    import app.routes.apps as apps_route
    monkeypatch.setattr(apps_route.httpx, "AsyncClient", _Client)
    monkeypatch.setattr(
        apps_route,
        "get_settings",
        lambda: type("S", (), {"canvas_comfy_url": "http://canvas-test:8188"})(),
    )

    r = c.post("/api/apps/pub/open-in-comfy", headers=_h(tokens, "user"))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["workflow_name"] == "toiv_app_pub.json"
    assert body["app_id"] == "pub"
    assert body["node_count"] >= 1
    assert body["save_back"] == "not_implemented"
    assert any("workflows%2Ftoiv_app_pub.json" in u for u in posted)
    # fan-out: LB + rewritten localhost backend + :8196 alt
    assert any(":8188/" in u for u in posted) and any(":8196/" in u for u in posted)
    assert isinstance(bodies[0].get("nodes"), list)
    assert bodies[0].get("links") is not None


def test_open_in_comfy_requires_auth_and_visible(ctx):
    c, tokens, ids, engine = ctx
    assert c.post("/api/apps/pub/open-in-comfy").status_code == 401
    with Session(engine) as s:
        _seed_app(s, id="pub", name="公开", user_id="")
    assert c.post("/api/apps/nope/open-in-comfy", headers=_h(tokens, "user")).status_code == 404


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

def test_build_graph_normalizes_comfy_literals_int_value_to_number():
    """RH 包装的 Int(value=int) 在提交前须改成 ComfyLiterals Number=str。"""
    from app.routes.apps import _build_graph

    workflow = {
        "1": {"class_type": "Int", "inputs": {"value": 24}},
        "2": {"class_type": "JWInteger", "inputs": {"value": 480}},
    }
    bindings = {
        "int_value": {"node": "1", "field": "inputs.value"},
        "jw": {"node": "2", "field": "inputs.value"},
    }
    graph = _build_graph(workflow, bindings, {"int_value": 32, "jw": 512})
    assert graph["1"]["inputs"] == {"Number": "32"}
    assert "value" not in graph["1"]["inputs"]
    assert graph["2"]["inputs"]["value"] == 512


def test_build_graph_normalizes_comfy_literals_float_value_to_number():
    """RH 包装的 Float(value=float) 同 Int:须改成 ComfyLiterals Number=str。"""
    from app.routes.apps import _build_graph

    workflow = {
        "122": {"class_type": "Float", "inputs": {"value": 2.5}},
        "117": {
            "class_type": "LatentUpscaleBy",
            "inputs": {"scale_by": ["122", 0], "upscale_method": "nearest-exact", "samples": ["1", 0]},
        },
    }
    bindings = {"float_value": {"node": "122", "field": "inputs.value"}}
    graph = _build_graph(workflow, bindings, {"float_value": 1.75})
    assert graph["122"]["inputs"] == {"Number": "1.75"}
    assert "value" not in graph["122"]["inputs"]
    # 未提供表单值时仍应把模板 value 改写成 Number
    graph2 = _build_graph(workflow, bindings, {})
    assert graph2["122"]["inputs"] == {"Number": "2.5"}


def test_build_graph_backfills_image_scale_resolution_steps():
    """ImageScaleToTotalPixels 缺 resolution_steps 时回填 Comfy 默认 1。"""
    from app.routes.apps import _build_graph

    workflow = {
        "59": {
            "class_type": "ImageScaleToTotalPixels",
            "inputs": {"image": ["60", 0], "megapixels": 1.5, "upscale_method": "nearest-exact"},
        },
        "60": {"class_type": "LoadImage", "inputs": {"image": "a.png"}},
    }
    graph = _build_graph(workflow, {}, {})
    assert graph["59"]["inputs"]["resolution_steps"] == 1
    # 已有值不覆盖
    workflow2 = {
        "59": {
            "class_type": "ImageScaleToTotalPixels",
            "inputs": {
                "image": ["60", 0],
                "megapixels": 1.5,
                "upscale_method": "nearest-exact",
                "resolution_steps": 8,
            },
        }
    }
    graph2 = _build_graph(workflow2, {}, {})
    assert graph2["59"]["inputs"]["resolution_steps"] == 8


def test_build_graph_remaps_wan_animate_model_name():
    """RH Animate …fp8_scaled_e4m3fn…_v2 → 本地 …fp8_e4m3fn_scaled…(无 v2)。"""
    from app.routes.apps import _build_graph

    workflow = {
        "47": {
            "class_type": "WanVideoModelLoader",
            "inputs": {
                "model": "Wan22Animate/Wan2_2-Animate-14B_fp8_scaled_e4m3fn_KJ_v2.safetensors",
                "base_precision": "fp16_fast",
                "quantization": "disabled",
                "load_device": "offload_device",
            },
        }
    }
    graph = _build_graph(workflow, {}, {})
    assert (
        graph["47"]["inputs"]["model"]
        == "Wan22Animate/Wan2_2-Animate-14B_fp8_e4m3fn_scaled_KJ.safetensors"
    )
    # 已是本地名不动
    workflow2 = {
        "47": {
            "class_type": "WanVideoModelLoader",
            "inputs": {
                "model": "Wan22Animate/Wan2_2-Animate-14B_fp8_e4m3fn_scaled_KJ.safetensors",
                "base_precision": "fp16_fast",
                "quantization": "fp8_e4m3fn_scaled",
                "load_device": "offload_device",
            },
        }
    }
    graph2 = _build_graph(workflow2, {}, {})
    assert (
        graph2["47"]["inputs"]["model"]
        == "Wan22Animate/Wan2_2-Animate-14B_fp8_e4m3fn_scaled_KJ.safetensors"
    )


def test_build_graph_remaps_easy_image_rembg_mode():
    """easy imageRemBg RMBG-2.0 → RMBG-1.4(本地 2.0 config 缺 model_type)。"""
    from app.routes.apps import _build_graph

    workflow = {
        "155": {
            "class_type": "easy imageRemBg",
            "inputs": {
                "rem_mode": "RMBG-2.0",
                "images": ["1", 0],
                "image_output": "Hide",
                "save_prefix": "ComfyUI",
                "torchscript_jit": False,
                "add_background": "white",
                "refine_foreground": False,
            },
        }
    }
    graph = _build_graph(workflow, {}, {})
    assert graph["155"]["inputs"]["rem_mode"] == "RMBG-1.4"
    # 其它 mode 不动
    workflow2 = {
        "155": {
            "class_type": "easy imageRemBg",
            "inputs": {
                "rem_mode": "Inspyrenet",
                "images": ["1", 0],
                "image_output": "Hide",
                "save_prefix": "ComfyUI",
                "torchscript_jit": False,
                "add_background": "none",
                "refine_foreground": False,
            },
        }
    }
    graph2 = _build_graph(workflow2, {}, {})
    assert graph2["155"]["inputs"]["rem_mode"] == "Inspyrenet"


def test_build_graph_remaps_scheduler_beta57():
    """KSampler scheduler beta57 → beta。"""
    from app.routes.apps import _build_graph

    workflow = {
        "45": {
            "class_type": "KSampler",
            "inputs": {
                "scheduler": "beta57",
                "sampler_name": "euler",
                "steps": 8,
                "cfg": 1,
                "denoise": 1,
                "seed": 1,
            },
        }
    }
    graph = _build_graph(workflow, {}, {})
    assert graph["45"]["inputs"]["scheduler"] == "beta"
    workflow2 = {
        "45": {
            "class_type": "KSampler",
            "inputs": {"scheduler": "karras", "sampler_name": "euler", "steps": 8},
        }
    }
    assert _build_graph(workflow2, {}, {})["45"]["inputs"]["scheduler"] == "karras"


def test_build_graph_clamps_vhs_skip_first_frames():
    """VHS_LoadVideo skip >= frame_load_cap → 0。"""
    from app.routes.apps import _build_graph

    workflow = {
        "14": {
            "class_type": "VHS_LoadVideo",
            "inputs": {
                "video": "a.mp4",
                "skip_first_frames": 109,
                "frame_load_cap": 81,
                "select_every_nth": 1,
                "force_rate": 0,
                "custom_width": 0,
                "custom_height": 0,
                "force_size": "Disabled",
            },
        },
        "15": {
            "class_type": "VHS_LoadVideo",
            "inputs": {
                "video": "b.mp4",
                "skip_first_frames": 10,
                "frame_load_cap": 81,
                "select_every_nth": 1,
                "force_rate": 0,
                "custom_width": 0,
                "custom_height": 0,
                "force_size": "Disabled",
            },
        },
    }
    graph = _build_graph(workflow, {}, {})
    assert graph["14"]["inputs"]["skip_first_frames"] == 0
    assert graph["15"]["inputs"]["skip_first_frames"] == 10


def test_build_graph_vhs_combine_frame_rate_and_save_output():
    """VHS_VideoCombine 补 frame_rate;全 False 时打开 save_output。"""
    from app.routes.apps import _build_graph

    workflow = {
        "64": {
            "class_type": "VHS_VideoCombine",
            "inputs": {
                "images": ["1", 0],
                "frame_rate": 24,
                "format": "video/h264-mp4",
                "save_output": False,
                "filename_prefix": "A",
                "pingpong": False,
                "loop_count": 0,
            },
        },
        "65": {
            "class_type": "VHS_VideoCombine",
            "inputs": {
                "images": ["2", 0],
                "format": "video/h264-mp4",
                "save_output": False,
                "filename_prefix": "B",
                "pingpong": False,
                "loop_count": 0,
            },
        },
    }
    graph = _build_graph(workflow, {}, {})
    assert graph["65"]["inputs"]["frame_rate"] == 16
    assert graph["64"]["inputs"]["save_output"] is True
    workflow2 = {
        "64": {
            "class_type": "VHS_VideoCombine",
            "inputs": {
                "images": ["1", 0],
                "frame_rate": 12,
                "format": "video/h264-mp4",
                "save_output": False,
                "filename_prefix": "A",
            },
        },
        "65": {
            "class_type": "VHS_VideoCombine",
            "inputs": {
                "images": ["2", 0],
                "frame_rate": 12,
                "format": "video/h264-mp4",
                "save_output": True,
                "filename_prefix": "B",
            },
        },
    }
    g2 = _build_graph(workflow2, {}, {})
    assert g2["64"]["inputs"]["save_output"] is False
    assert g2["65"]["inputs"]["save_output"] is True


def test_build_graph_layermask_abs_paths_to_basename():
    """LayerMask Segformer/BiRefNet 绝对路径 → basename。"""
    from app.routes.apps import _build_graph

    workflow = {
        "665": {
            "class_type": "LayerMask: SegformerClothesPipelineLoader",
            "inputs": {
                "model": "/home/merlin/ComfyUI-longcat/models/segformer_b3_clothes",
                "face": False,
                "hair": False,
            },
        },
        "219": {
            "class_type": "LayerMask: LoadBiRefNetModelV2",
            "inputs": {
                "version": "/home/merlin/ComfyUI-longcat/models/BiRefNet/BiRefNet-General",
            },
        },
        "220": {
            "class_type": "LayerMask: LoadBiRefNetModelV2",
            "inputs": {"version": "BiRefNet-General"},
        },
    }
    graph = _build_graph(workflow, {}, {})
    assert graph["665"]["inputs"]["model"] == "segformer_b3_clothes"
    assert graph["219"]["inputs"]["version"] == "BiRefNet-General"
    assert graph["220"]["inputs"]["version"] == "BiRefNet-General"


def test_build_graph_wan_sampler_empty_add_noise_to_false():
    """WanVideoSampler 空串 add_noise_to_samples → False。"""
    from app.routes.apps import _build_graph

    workflow = {
        "27": {
            "class_type": "WanVideoSampler",
            "inputs": {
                "add_noise_to_samples": "",
                "scheduler": "unipc",
                "steps": 20,
                "cfg": 1,
                "shift": 5,
                "seed": 1,
                "force_offload": True,
                "riflex_freq_index": 0,
            },
        }
    }
    graph = _build_graph(workflow, {}, {})
    assert graph["27"]["inputs"]["add_noise_to_samples"] is False


def test_build_graph_vae_decode_tiled_backfills_vae():
    """VAEDecodeTiled 缺 vae → 借用已有 VAEDecode 的 vae 引用。"""
    from app.routes.apps import _build_graph

    workflow = {
        "49": {
            "class_type": "CheckpointLoaderSimple",
            "inputs": {"ckpt_name": "ltx-2.3-22b-distilled-1.1.safetensors"},
        },
        "24": {
            "class_type": "VAEDecodeTiled",
            "inputs": {
                "samples": ["14", 0],
                "tile_size": 768,
                "overlap": 64,
                "temporal_size": 64,
                "temporal_overlap": 8,
            },
        },
        "66": {
            "class_type": "VAEDecode",
            "inputs": {"vae": ["49", 2], "samples": ["14", 0]},
        },
    }
    graph = _build_graph(workflow, {}, {})
    assert graph["24"]["inputs"]["vae"] == ["49", 2]
    workflow2 = {
        "24": {
            "class_type": "VAEDecodeTiled",
            "inputs": {
                "vae": ["10", 0],
                "samples": ["14", 0],
                "tile_size": 512,
                "overlap": 32,
                "temporal_size": 64,
                "temporal_overlap": 8,
            },
        }
    }
    assert _build_graph(workflow2, {}, {})["24"]["inputs"]["vae"] == ["10", 0]



def test_build_graph_easy_prompt_line_remove_empty_lines():
    """easy promptLine 缺 remove_empty_lines → True。"""
    from app.routes.apps import _build_graph

    workflow = {
        "141": {
            "class_type": "easy promptLine",
            "inputs": {
                "start_index": 0,
                "max_rows": 1000,
                "prompt": ["143", 0],
            },
        },
        "142": {
            "class_type": "easy promptLine",
            "inputs": {
                "start_index": 1,
                "max_rows": 10,
                "prompt": "a\nb",
                "remove_empty_lines": False,
            },
        },
    }
    graph = _build_graph(workflow, {}, {})
    assert graph["141"]["inputs"]["remove_empty_lines"] is True
    assert graph["142"]["inputs"]["remove_empty_lines"] is False


def test_build_graph_inpaint_expand_mask_blur_type():
    """INPAINT_ExpandMask 缺 blur_type → gaussian。"""
    from app.routes.apps import _build_graph

    workflow = {
        "122": {
            "class_type": "INPAINT_ExpandMask",
            "inputs": {"grow": 0, "blur": 40, "mask": ["76", 1]},
        },
        "133": {
            "class_type": "INPAINT_ExpandMask",
            "inputs": {
                "grow": 8,
                "blur": 7,
                "mask": ["127", 1],
                "blur_type": "box",
            },
        },
    }
    graph = _build_graph(workflow, {}, {})
    assert graph["122"]["inputs"]["blur_type"] == "gaussian"
    assert graph["133"]["inputs"]["blur_type"] == "box"


def test_build_graph_inpaint_crop_improved_device_mode():
    """InpaintCropImproved 缺 device_mode → cpu (compatible)。"""
    from app.routes.apps import _build_graph

    workflow = {
        "124": {
            "class_type": "InpaintCropImproved",
            "inputs": {
                "image": ["76", 0],
                "mask": ["122", 0],
                "downscale_algorithm": "bilinear",
                "upscale_algorithm": "bicubic",
            },
        },
        "134": {
            "class_type": "InpaintCropImproved",
            "inputs": {
                "image": ["127", 0],
                "mask": ["133", 0],
                "device_mode": "gpu (much faster)",
            },
        },
    }
    graph = _build_graph(workflow, {}, {})
    assert graph["124"]["inputs"]["device_mode"] == "cpu (compatible)"
    assert graph["134"]["inputs"]["device_mode"] == "gpu (much faster)"


def test_build_graph_wan_vace_start_end_frame_num_frames():
    """WanVideoVACEStartToEndFrame 缺 num_frames → 81。"""
    from app.routes.apps import _build_graph

    workflow = {
        "15": {
            "class_type": "WanVideoVACEStartToEndFrame",
            "inputs": {
                "empty_frame_level": 0.5,
                "start_image": ["26", 0],
            },
        },
        "16": {
            "class_type": "WanVideoVACEStartToEndFrame",
            "inputs": {
                "num_frames": ["12", 0],
                "empty_frame_level": 0.5,
                "start_image": ["26", 0],
            },
        },
    }
    graph = _build_graph(workflow, {}, {})
    assert graph["15"]["inputs"]["num_frames"] == 81
    assert graph["16"]["inputs"]["num_frames"] == ["12", 0]


def test_build_graph_vhs_combine_drops_orphan_missing_images():
    """VHS_VideoCombine 无 images 的孤儿节点删除;有 images 的保留并补 frame_rate。"""
    from app.routes.apps import _build_graph

    workflow = {
        "11": {
            "class_type": "VHS_VideoCombine",
            "inputs": {
                "images": ["10", 0],
                "format": "video/h264-mp4",
                "save_output": True,
                "filename_prefix": "ok",
                "pingpong": False,
                "loop_count": 0,
            },
        },
        "40": {
            "class_type": "VHS_VideoCombine",
            "inputs": {
                "format": "video/h264-mp4",
                "save_output": True,
                "filename_prefix": "orphan",
                "frame_rate": 16,
                "pingpong": False,
                "loop_count": 0,
            },
        },
        "42": {
            "class_type": "VHS_VideoCombine",
            "inputs": {
                "format": "video/h264-mp4",
                "save_output": True,
                "filename_prefix": "orphan2",
                "frame_rate": 16,
                "pingpong": False,
                "loop_count": 0,
            },
        },
    }
    graph = _build_graph(workflow, {}, {})
    assert "40" not in graph
    assert "42" not in graph
    assert "11" in graph
    assert graph["11"]["inputs"]["frame_rate"] == 16
    assert graph["11"]["inputs"]["images"] == ["10", 0]
