"""R2.3 参考资产库(/api/assets CRUD)测试。

覆盖:
  - 创建/列表/单查/更新/删除全流程
  - kind 过滤 + NSFW 上下文过滤(SFW 上下文不含 nsfw 资产,带 X-NSFW 头可见)
  - 多用户隔离(用户 B 看不到/改不了/删不了用户 A 的资产,一律 404 防枚举)
  - 校验:kind 非法 422、images 0 张或 5 张 422、filename 含 ".." 422、name 空/超长 422
  - PATCH 部分更新不动其他字段
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.db import get_session
from app.main import app
from app.models import Tenant, User
from app.security import create_token, hash_password


# --------------------------------------------------------------------------- #
# fixtures
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
        alice_id = _make_user(s, "alice@toiv.ai")
        bob_id = _make_user(s, "bob@toiv.ai")
    yield TestClient(app), create_token(alice_id), create_token(bob_id)
    app.dependency_overrides.clear()


def _auth(token: str, nsfw: bool = False) -> dict:
    h = {"Authorization": f"Bearer {token}"}
    if nsfw:
        h["X-NSFW"] = "1"
    return h


def _img(n: int = 1) -> dict:
    return {"filename": f"ref_{n}.png", "worker": "http://192.168.71.127:8189"}


def _create(c: TestClient, token: str, **kw) -> dict:
    body = {
        "kind": "character",
        "name": "默认角色",
        "description": "",
        "images": [_img()],
    }
    body.update(kw)
    r = c.post("/api/assets", headers=_auth(token), json=body)
    assert r.status_code == 200, r.text
    return r.json()


# --------------------------------------------------------------------------- #
# 创建 + 校验
# --------------------------------------------------------------------------- #
def test_create_and_get_flow(ctx):
    """创建 → 单查:字段完整回显,images 句柄原样持久化。"""
    c, alice, _ = ctx
    a = _create(
        c,
        alice,
        name="女主林晚",
        kind="character",
        description="黑长直,红瞳,学院制服",
        images=[_img(1), _img(2), _img(3)],
    )
    assert a["id"]
    assert a["kind"] == "character"
    assert a["name"] == "女主林晚"
    assert a["description"] == "黑长直,红瞳,学院制服"
    assert a["nsfw"] is False
    assert [i["filename"] for i in a["images"]] == ["ref_1.png", "ref_2.png", "ref_3.png"]
    assert a["created_at"] and a["updated_at"]

    r = c.get(f"/api/assets/{a['id']}", headers=_auth(alice))
    assert r.status_code == 200
    assert r.json()["name"] == "女主林晚"


def test_create_invalid_kind_422(ctx):
    c, alice, _ = ctx
    r = c.post(
        "/api/assets",
        headers=_auth(alice),
        json={"kind": "vehicle", "name": "x", "images": [_img()]},
    )
    assert r.status_code == 422


def test_create_images_count_bounds(ctx):
    """images 0 张与 5 张均 422(1-4 张,≤4 是质量拐点硬上限)。"""
    c, alice, _ = ctx
    r0 = c.post(
        "/api/assets",
        headers=_auth(alice),
        json={"kind": "character", "name": "x", "images": []},
    )
    assert r0.status_code == 422
    r5 = c.post(
        "/api/assets",
        headers=_auth(alice),
        json={"kind": "character", "name": "x", "images": [_img(i) for i in range(5)]},
    )
    assert r5.status_code == 422
    # 边界:4 张合法
    a4 = _create(c, alice, images=[_img(i) for i in range(4)])
    assert len(a4["images"]) == 4


def test_create_filename_traversal_422(ctx):
    """filename 含 .. 或绝对路径 → 422(路径穿越防护)。"""
    c, alice, _ = ctx
    for bad in ("../etc/passwd", "a/../../b.png", "/abs/path.png"):
        r = c.post(
            "/api/assets",
            headers=_auth(alice),
            json={
                "kind": "character",
                "name": "x",
                "images": [{"filename": bad, "worker": "w"}],
            },
        )
        assert r.status_code == 422, bad


def test_create_name_length_bounds(ctx):
    """name 空串或 >100 字符 → 422。"""
    c, alice, _ = ctx
    r_empty = c.post(
        "/api/assets",
        headers=_auth(alice),
        json={"kind": "character", "name": "", "images": [_img()]},
    )
    assert r_empty.status_code == 422
    r_long = c.post(
        "/api/assets",
        headers=_auth(alice),
        json={"kind": "character", "name": "x" * 101, "images": [_img()]},
    )
    assert r_long.status_code == 422
    # 边界:100 字符合法
    a = _create(c, alice, name="x" * 100)
    assert len(a["name"]) == 100


def test_create_description_too_long_422(ctx):
    c, alice, _ = ctx
    r = c.post(
        "/api/assets",
        headers=_auth(alice),
        json={
            "kind": "character",
            "name": "x",
            "description": "x" * 2001,
            "images": [_img()],
        },
    )
    assert r.status_code == 422


def test_create_requires_auth(ctx):
    c, *_ = ctx
    r = c.post(
        "/api/assets",
        json={"kind": "character", "name": "x", "images": [_img()]},
    )
    assert r.status_code == 401


# --------------------------------------------------------------------------- #
# 列表 + kind 过滤 + NSFW 上下文过滤
# --------------------------------------------------------------------------- #
def test_list_kind_filter(ctx):
    c, alice, _ = ctx
    _create(c, alice, name="角色A", kind="character")
    _create(c, alice, name="场景B", kind="scene")
    _create(c, alice, name="风格C", kind="style")

    r = c.get("/api/assets?kind=character", headers=_auth(alice))
    assert r.status_code == 200
    assert [a["name"] for a in r.json()] == ["角色A"]

    r_all = c.get("/api/assets", headers=_auth(alice))
    assert len(r_all.json()) == 3

    # 非法 kind 过滤值 → 422
    r_bad = c.get("/api/assets?kind=vehicle", headers=_auth(alice))
    assert r_bad.status_code == 422


def test_list_nsfw_context_filter(ctx):
    """SFW 上下文列表不含 nsfw 资产;带 X-NSFW 头可见。"""
    c, alice, _ = ctx
    _create(c, alice, name="普通角色")
    _create(c, alice, name="成人角色", nsfw=True)

    r = c.get("/api/assets", headers=_auth(alice))
    assert [a["name"] for a in r.json()] == ["普通角色"]

    r18 = c.get("/api/assets", headers=_auth(alice, nsfw=True))
    names = {a["name"] for a in r18.json()}
    assert names == {"普通角色", "成人角色"}


def test_get_nsfw_asset_visibility(ctx):
    """nsfw 资产单查:SFW 上下文 404(不泄露存在性),X-NSFW 头 200。"""
    c, alice, _ = ctx
    a = _create(c, alice, name="成人角色", nsfw=True)
    r = c.get(f"/api/assets/{a['id']}", headers=_auth(alice))
    assert r.status_code == 404
    r18 = c.get(f"/api/assets/{a['id']}", headers=_auth(alice, nsfw=True))
    assert r18.status_code == 200
    assert r18.json()["nsfw"] is True


# --------------------------------------------------------------------------- #
# 多用户隔离(一律 404 防枚举)
# --------------------------------------------------------------------------- #
def test_multi_user_isolation(ctx):
    """用户 B 看不到/改不了/删不了用户 A 的资产,全部 404。"""
    c, alice, bob = ctx
    a = _create(c, alice, name="A 的角色")

    # B 的列表为空
    r = c.get("/api/assets", headers=_auth(bob))
    assert r.json() == []
    # B 单查 A 的资产 → 404
    assert c.get(f"/api/assets/{a['id']}", headers=_auth(bob)).status_code == 404
    # B 改 A 的资产 → 404
    assert (
        c.patch(
            f"/api/assets/{a['id']}", headers=_auth(bob), json={"name": "劫持"}
        ).status_code
        == 404
    )
    # B 删 A 的资产 → 404
    assert (
        c.delete(f"/api/assets/{a['id']}", headers=_auth(bob)).status_code == 404
    )
    # A 的资产原样还在
    r2 = c.get(f"/api/assets/{a['id']}", headers=_auth(alice))
    assert r2.status_code == 200
    assert r2.json()["name"] == "A 的角色"


def test_get_nonexistent_404(ctx):
    c, alice, _ = ctx
    assert c.get("/api/assets/ghost", headers=_auth(alice)).status_code == 404


# --------------------------------------------------------------------------- #
# PATCH 部分更新
# --------------------------------------------------------------------------- #
def test_patch_partial_keeps_other_fields(ctx):
    """只改 name,kind/description/images/nsfw 不动;updated_at 刷新。"""
    c, alice, _ = ctx
    a = _create(
        c,
        alice,
        name="旧名",
        kind="scene",
        description="旧描述",
        images=[_img(1), _img(2)],
    )
    r = c.patch(
        f"/api/assets/{a['id']}", headers=_auth(alice), json={"name": "新名"}
    )
    assert r.status_code == 200, r.text
    b = r.json()
    assert b["name"] == "新名"
    assert b["kind"] == "scene"
    assert b["description"] == "旧描述"
    assert [i["filename"] for i in b["images"]] == ["ref_1.png", "ref_2.png"]
    assert b["nsfw"] is False
    assert b["updated_at"] >= a["updated_at"]


def test_patch_images_and_nsfw(ctx):
    c, alice, _ = ctx
    a = _create(c, alice, name="角色")
    r = c.patch(
        f"/api/assets/{a['id']}",
        headers=_auth(alice),
        json={"images": [_img(9)], "nsfw": True, "kind": "prop", "description": "新"},
    )
    assert r.status_code == 200
    b = r.json()
    assert [i["filename"] for i in b["images"]] == ["ref_9.png"]
    assert b["nsfw"] is True and b["kind"] == "prop" and b["description"] == "新"


def test_patch_validation(ctx):
    """PATCH 同样走校验:非法 kind / 5 张 images / 穿越 filename / 空 name → 422。"""
    c, alice, _ = ctx
    a = _create(c, alice, name="角色")
    url = f"/api/assets/{a['id']}"
    assert c.patch(url, headers=_auth(alice), json={"kind": "bad"}).status_code == 422
    assert (
        c.patch(
            url, headers=_auth(alice), json={"images": [_img(i) for i in range(5)]}
        ).status_code
        == 422
    )
    assert (
        c.patch(
            url,
            headers=_auth(alice),
            json={"images": [{"filename": "../x.png", "worker": "w"}]},
        ).status_code
        == 422
    )
    assert c.patch(url, headers=_auth(alice), json={"name": ""}).status_code == 422
    assert (
        c.patch(url, headers=_auth(alice), json={"name": "y" * 101}).status_code == 422
    )
    # 校验全拒后原数据未变
    assert c.get(url, headers=_auth(alice)).json()["name"] == "角色"


def test_patch_nsfw_asset_in_sfw_context_404(ctx):
    """nsfw 资产在 SFW 上下文不可改(与单查一致,404 不泄露)。"""
    c, alice, _ = ctx
    a = _create(c, alice, name="成人角色", nsfw=True)
    r = c.patch(f"/api/assets/{a['id']}", headers=_auth(alice), json={"name": "改"})
    assert r.status_code == 404
    r18 = c.patch(
        f"/api/assets/{a['id']}",
        headers=_auth(alice, nsfw=True),
        json={"name": "改"},
    )
    assert r18.status_code == 200


# --------------------------------------------------------------------------- #
# 删除
# --------------------------------------------------------------------------- #
def test_delete_flow(ctx):
    c, alice, _ = ctx
    a = _create(c, alice, name="待删")
    r = c.delete(f"/api/assets/{a['id']}", headers=_auth(alice))
    assert r.status_code == 200
    assert r.json()["ok"] is True
    assert c.get(f"/api/assets/{a['id']}", headers=_auth(alice)).status_code == 404


def test_delete_nonexistent_404(ctx):
    c, alice, _ = ctx
    assert c.delete("/api/assets/ghost", headers=_auth(alice)).status_code == 404


# --------------------------------------------------------------------------- #
# 资产参考图回显(GET /api/assets/{id}/images/{index})
# --------------------------------------------------------------------------- #
_DATA = bytes(range(256))  # 256 字节假图


class _FakeWorker:
    """假 worker:直接返回内存字节,不走网络。"""

    base_url = "http://192.168.71.127:8189"

    async def get_image_bytes(self, filename, subfolder, type_):
        assert type_ == "input"  # 资产句柄取自上传目录
        return _DATA, "image/png"


@pytest.fixture
def ctx_img(monkeypatch):
    """在 ctx 基础上覆盖 worker pool,并将 resolve_worker 替换为替身。"""
    from types import SimpleNamespace

    import app.routes.reference_assets as assets_mod
    from app.deps import get_pool

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
    fake = _FakeWorker()
    app.dependency_overrides[get_pool] = lambda: SimpleNamespace(clients=[fake])
    monkeypatch.setattr(assets_mod, "resolve_worker", lambda w: fake)

    with Session(engine) as s:
        alice_id = _make_user(s, "alice@toiv.ai")
        bob_id = _make_user(s, "bob@toiv.ai")
    yield TestClient(app), create_token(alice_id), create_token(bob_id)
    app.dependency_overrides.clear()


def test_asset_image_owner_200(ctx_img):
    """属主回显:200 + 原字节 + content-type 透传 + 私有缓存头。"""
    c, alice, _ = ctx_img
    a = _create(c, alice, images=[_img(1), _img(2)])
    r = c.get(f"/api/assets/{a['id']}/images/1", headers=_auth(alice))
    assert r.status_code == 200
    assert r.content == _DATA
    assert r.headers["content-type"] == "image/png"
    assert r.headers["Cache-Control"].startswith("private")


def test_asset_image_index_bounds(ctx_img):
    """index 越界(负/超长度)→ 404。"""
    c, alice, _ = ctx_img
    a = _create(c, alice, images=[_img(1)])
    assert c.get(f"/api/assets/{a['id']}/images/1", headers=_auth(alice)).status_code == 404
    assert c.get(f"/api/assets/{a['id']}/images/-1", headers=_auth(alice)).status_code == 404


def test_asset_image_other_user_404(ctx_img):
    """他人资产图片 → 404(防枚举,与单查语义一致)。"""
    c, alice, bob = ctx_img
    a = _create(c, alice)
    r = c.get(f"/api/assets/{a['id']}/images/0", headers=_auth(bob))
    assert r.status_code == 404


def test_asset_image_nsfw_context(ctx_img):
    """nsfw 资产图片:SFW 上下文 404,X-NSFW 头 200。"""
    c, alice, _ = ctx_img
    a = _create(c, alice, nsfw=True)
    assert c.get(f"/api/assets/{a['id']}/images/0", headers=_auth(alice)).status_code == 404
    r = c.get(f"/api/assets/{a['id']}/images/0", headers=_auth(alice, nsfw=True))
    assert r.status_code == 200


def test_asset_image_requires_auth(ctx_img):
    c, alice, _ = ctx_img
    a = _create(c, alice)
    assert c.get(f"/api/assets/{a['id']}/images/0").status_code == 401


# --------------------------------------------------------------------------- #
# 数字人形象库(kind=avatar,对标 aigcpanel「我的形象」)
# --------------------------------------------------------------------------- #
def test_avatar_kind_create_and_defaults(ctx):
    """kind=avatar 创建:green_screen/ref_audio 缺省 False/"";显式值原样往返。"""
    c, alice, _ = ctx
    a = _create(c, alice, kind="avatar", name="默认形象")
    assert a["kind"] == "avatar"
    assert a["green_screen"] is False
    assert a["ref_audio"] == ""

    b = _create(
        c,
        alice,
        kind="avatar",
        name="绿幕形象",
        green_screen=True,
        ref_audio="/api/manju/voice/voiceref-abc.wav",
    )
    assert b["green_screen"] is True
    assert b["ref_audio"] == "/api/manju/voice/voiceref-abc.wav"

    # 单查回显两字段(其他既有 kind 同样带默认值,零影响)
    r = c.get(f"/api/assets/{b['id']}", headers=_auth(alice))
    assert r.status_code == 200
    assert r.json()["green_screen"] is True
    old = _create(c, alice, kind="character", name="旧角色")
    assert old["green_screen"] is False and old["ref_audio"] == ""


def test_avatar_kind_list_filter(ctx):
    """GET /api/assets?kind=avatar 只回形象;列表项带 green_screen/ref_audio。"""
    c, alice, _ = ctx
    _create(c, alice, name="角色A", kind="character")
    _create(c, alice, name="形象B", kind="avatar", green_screen=True)
    _create(c, alice, name="形象C", kind="avatar", ref_audio="/api/manju/voice/v.wav")

    r = c.get("/api/assets?kind=avatar", headers=_auth(alice))
    assert r.status_code == 200
    rows = r.json()
    assert [a["name"] for a in rows] == ["形象B", "形象C"]
    assert rows[0]["green_screen"] is True
    assert rows[1]["ref_audio"] == "/api/manju/voice/v.wav"


def test_avatar_green_screen_roundtrip(ctx):
    """green_screen 往返:创建 True → 列表/单查均 True;PATCH 翻回 False 生效。"""
    c, alice, _ = ctx
    a = _create(c, alice, kind="avatar", name="绿幕", green_screen=True)
    assert c.get(f"/api/assets/{a['id']}", headers=_auth(alice)).json()[
        "green_screen"
    ] is True

    r = c.patch(
        f"/api/assets/{a['id']}", headers=_auth(alice), json={"green_screen": False}
    )
    assert r.status_code == 200
    assert r.json()["green_screen"] is False
    # 持久化后再查仍是 False(不是只在响应里翻)
    assert c.get(f"/api/assets/{a['id']}", headers=_auth(alice)).json()[
        "green_screen"
    ] is False


def test_avatar_patch_updates_new_fields(ctx):
    """PATCH 部分更新 green_screen/ref_audio;未给字段原样保留。"""
    c, alice, _ = ctx
    a = _create(c, alice, kind="avatar", name="形象", ref_audio="/api/manju/voice/a.wav")
    r = c.patch(
        f"/api/assets/{a['id']}",
        headers=_auth(alice),
        json={"green_screen": True, "ref_audio": "/api/manju/voice/b.wav"},
    )
    assert r.status_code == 200
    b = r.json()
    assert b["green_screen"] is True
    assert b["ref_audio"] == "/api/manju/voice/b.wav"
    assert b["name"] == "形象" and b["kind"] == "avatar"

    # 只 PATCH name 不动两新字段
    r2 = c.patch(f"/api/assets/{a['id']}", headers=_auth(alice), json={"name": "新名"})
    assert r2.json()["green_screen"] is True
    assert r2.json()["ref_audio"] == "/api/manju/voice/b.wav"


def test_avatar_ref_audio_length_bound(ctx):
    """ref_audio >2000 字符 → 422(POST/PATCH 同口径)。"""
    c, alice, _ = ctx
    r = c.post(
        "/api/assets",
        headers=_auth(alice),
        json={
            "kind": "avatar",
            "name": "x",
            "images": [_img()],
            "ref_audio": "u" * 2001,
        },
    )
    assert r.status_code == 422
    a = _create(c, alice, kind="avatar", name="形象")
    assert (
        c.patch(
            f"/api/assets/{a['id']}",
            headers=_auth(alice),
            json={"ref_audio": "u" * 2001},
        ).status_code
        == 422
    )


def test_reference_assets_avatar_columns_migration_idempotent(monkeypatch):
    """green_screen/ref_audio 两列迁移幂等:对缺列旧表跑两遍不炸,列齐备。"""
    import app.db as db_mod

    eng = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    with eng.begin() as conn:
        conn.exec_driver_sql(
            "CREATE TABLE reference_assets (id TEXT PRIMARY KEY, user_id TEXT, kind TEXT)"
        )
    monkeypatch.setattr(db_mod, "engine", eng)

    db_mod._run_column_migrations()  # 第一次:补列
    db_mod._run_column_migrations()  # 第二次:幂等,不应报错

    with eng.begin() as conn:
        cols = {
            r[1]
            for r in conn.exec_driver_sql("PRAGMA table_info(reference_assets)").fetchall()
        }
    assert {"green_screen", "ref_audio"} <= cols
