"""P1 全局主体库(/api/entities)测试。

覆盖:
  - CRUD 全流程(创建/列表 kind 过滤/单查/PUT 更新/删除)
  - 图片字段两种形态:上传句柄 {filename,worker} → handles 解析;URL 字符串 → image_urls
  - 校验:kind 非法 422、name 空/超长 422、URL 形态非法 422、filename 路径穿越 422
  - 多用户隔离(他人主体一律 404 防枚举)
  - DramaCharacter → Entity 启动迁移(幂等 copy,二次执行不重复)
  - 迁移后读取 fallback:resolve_shot_characters 同名优先全局 Entity
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

from app.db import get_session
from app.main import app
from app.models import DramaCharacter, DramaProject, Entity, Tenant, User
from app.security import create_token, hash_password
from app.services.entities import resolve_shot_characters


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
    yield TestClient(app), create_token(alice_id), create_token(bob_id), engine
    app.dependency_overrides.clear()


def _auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def _handle(n: int = 1) -> dict:
    return {"filename": f"ref_{n}.png", "worker": "http://192.168.71.127:8189"}


def _create(c: TestClient, token: str, **kw) -> dict:
    body = {"kind": "character", "name": "默认角色"}
    body.update(kw)
    r = c.post("/api/entities", headers=_auth(token), json=body)
    assert r.status_code == 200, r.text
    return r.json()


# --------------------------------------------------------------------------- #
# 创建 + 校验
# --------------------------------------------------------------------------- #
def test_create_and_get_flow(ctx):
    """创建 → 单查:字段完整回显;句柄形态图片被解析进 handles 与 image_urls。"""
    c, alice, _, _ = ctx
    e = _create(
        c,
        alice,
        name="女主林晚",
        kind="character",
        description="黑长直,红瞳",
        prompt_hint="1girl, black long hair, red eyes",
        ref_image=_handle(1),
        reference_front=_handle(2),
    )
    assert e["kind"] == "character"
    assert e["name"] == "女主林晚"
    assert e["prompt_hint"] == "1girl, black long hair, red eyes"
    assert e["handles"]["ref"] == _handle(1)
    assert e["handles"]["front"] == _handle(2)
    assert e["image_urls"]["ref"] == f"/api/entities/{e['id']}/images/ref"
    assert "side" not in e["handles"]

    r = c.get(f"/api/entities/{e['id']}", headers=_auth(alice))
    assert r.status_code == 200
    assert r.json()["name"] == "女主林晚"


def test_create_with_url_image(ctx):
    """URL 字符串形态图片:不进 handles,但有 image_urls 预览。"""
    c, alice, _, _ = ctx
    e = _create(
        c,
        alice,
        name="场景旧仓库",
        kind="scene",
        ref_image="/api/images?filename=a.png&worker=http://w1:8189&type=output",
    )
    assert e["handles"] == {}
    assert e["image_urls"]["ref"].endswith("/images/ref")


def test_create_validation(ctx):
    """kind 非法 / name 空 / name 超长 / URL 形态非法 / filename 穿越 → 422。"""
    c, alice, _, _ = ctx
    for body in (
        {"kind": "style", "name": "x"},  # kind 仅 character|scene|prop
        {"kind": "character", "name": ""},
        {"kind": "character", "name": "x" * 101},
        {"kind": "character", "name": "x", "ref_image": "ftp://bad"},
        {"kind": "character", "name": "x",
         "ref_image": {"filename": "../evil.png", "worker": "http://w:8189"}},
    ):
        r = c.post("/api/entities", headers=_auth(alice), json=body)
        assert r.status_code == 422, f"{body} → {r.status_code}: {r.text}"


# --------------------------------------------------------------------------- #
# 列表 + kind 过滤 + 隔离
# --------------------------------------------------------------------------- #
def test_list_kind_filter(ctx):
    """列表按 kind 过滤;不过滤返回全部;按创建时间升序。"""
    c, alice, _, _ = ctx
    _create(c, alice, name="角色A", kind="character")
    _create(c, alice, name="场景B", kind="scene")
    _create(c, alice, name="道具C", kind="prop")

    r = c.get("/api/entities", headers=_auth(alice))
    assert [e["name"] for e in r.json()] == ["角色A", "场景B", "道具C"]

    r = c.get("/api/entities?kind=scene", headers=_auth(alice))
    assert [e["name"] for e in r.json()] == ["场景B"]

    r = c.get("/api/entities?kind=style", headers=_auth(alice))
    assert r.status_code == 422  # 非法 kind 过滤值


def test_multi_user_isolation(ctx):
    """多用户隔离:列表互不可见;他人主体单查/改/删一律 404(防枚举)。"""
    c, alice, bob, _ = ctx
    e = _create(c, alice, name="Alice的角色")

    assert c.get("/api/entities", headers=_auth(bob)).json() == []
    assert c.get(f"/api/entities/{e['id']}", headers=_auth(bob)).status_code == 404
    r = c.put(f"/api/entities/{e['id']}", headers=_auth(bob), json={"name": "劫持"})
    assert r.status_code == 404
    assert c.delete(f"/api/entities/{e['id']}", headers=_auth(bob)).status_code == 404
    # 属主不受影响
    assert c.get(f"/api/entities/{e['id']}", headers=_auth(alice)).status_code == 200


def test_unauthenticated_rejected(ctx):
    """未登录一律 401。"""
    c, _, _, _ = ctx
    assert c.get("/api/entities").status_code == 401
    assert c.post("/api/entities", json={"name": "x"}).status_code == 401


# --------------------------------------------------------------------------- #
# 更新 + 删除
# --------------------------------------------------------------------------- #
def test_update_partial_and_image_clear(ctx):
    """PUT 部分更新:非 None 字段生效;图片字段显式空串清除;updated_at 前进。"""
    c, alice, _, _ = ctx
    e = _create(c, alice, name="旧名", prompt_hint="old hint", ref_image=_handle(1))
    r = c.put(
        f"/api/entities/{e['id']}",
        headers=_auth(alice),
        json={"name": "新名", "ref_image": ""},
    )
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["name"] == "新名"
    assert out["prompt_hint"] == "old hint"  # 未传字段保持
    assert out["ref_image"] == ""  # 显式空串清除
    assert "ref" not in out["handles"]


def test_delete_flow(ctx):
    """删除后单查 404,列表不再出现。"""
    c, alice, _, _ = ctx
    e = _create(c, alice, name="待删")
    r = c.delete(f"/api/entities/{e['id']}", headers=_auth(alice))
    assert r.status_code == 200 and r.json()["ok"] is True
    assert c.get(f"/api/entities/{e['id']}", headers=_auth(alice)).status_code == 404
    assert c.get("/api/entities", headers=_auth(alice)).json() == []


# --------------------------------------------------------------------------- #
# DramaCharacter → Entity 启动迁移 + 读取 fallback
# --------------------------------------------------------------------------- #
def test_startup_migration_copies_drama_characters_idempotent(ctx):
    """启动迁移:DramaCharacter 按属主 copy 成全局 Entity(kind=character);

    幂等:二次执行不重复插入;visual_prompt → prompt_hint;三视图/单图原样保留。
    """
    _, _, _, engine = ctx
    from app.db import _migrate_drama_characters_to_entities
    from unittest.mock import patch

    with Session(engine) as s:
        alice = s.exec(select(User).where(User.email == "alice@toiv.ai")).one()
        alice_id, alice_tenant = alice.id, alice.tenant_id
        proj = DramaProject(
            tenant_id=alice_tenant, user_id=alice_id, title="迁移源剧"
        )
        s.add(proj)
        s.commit()
        s.refresh(proj)
        s.add(DramaCharacter(
            project_id=proj.id,
            name="阿明",
            description="男主",
            visual_prompt="1boy, silver hair",
            ref_image="/img/aming.png",
            reference_front="/img/aming_front.png",
        ))
        s.commit()

    # db.engine 是全局单例:迁移函数内部用它,测试期临时指到内存库
    with patch("app.db.engine", engine):
        _migrate_drama_characters_to_entities()
        _migrate_drama_characters_to_entities()  # 二次执行:幂等,不重复

    with Session(engine) as s:
        rows = s.exec(select(Entity).where(Entity.kind == "character")).all()
        assert len(rows) == 1
        e = rows[0]
        assert e.name == "阿明"
        assert e.user_id == alice_id
        assert e.tenant_id == alice_tenant
        assert e.prompt_hint == "1boy, silver hair"
        assert e.ref_image == "/img/aming.png"
        assert e.reference_front == "/img/aming_front.png"


def test_resolve_shot_characters_prefers_global_entity(ctx):
    """读取 fallback:同名角色优先全局 Entity;未命中回退项目内 DramaCharacter。"""
    _, _, _, engine = ctx
    with Session(engine) as s:
        alice = s.exec(select(User).where(User.email == "alice@toiv.ai")).one()
        proj = DramaProject(tenant_id=alice.tenant_id, user_id=alice.id, title="剧")
        s.add(proj)
        s.commit()
        s.refresh(proj)
        # 项目内角色卡(旧数据):无三视图
        s.add(DramaCharacter(
            project_id=proj.id, name="阿明", ref_image="/img/drama_aming.png"
        ))
        s.add(DramaCharacter(project_id=proj.id, name="小红", ref_image="/img/hong.png"))
        # 全局主体(新事实源):同名阿明,带三视图
        s.add(Entity(
            tenant_id=alice.tenant_id, user_id=alice.id, kind="character",
            name="阿明", reference_front="/img/entity_aming_front.png",
        ))
        s.commit()

        refs = resolve_shot_characters(s, project_id=proj.id, names=["阿明", "小红"])
        assert [r.name for r in refs] == ["阿明", "小红"]
        # 阿明命中全局 Entity(三视图优先);小红回退项目内角色卡
        assert refs[0].reference_front == "/img/entity_aming_front.png"
        assert refs[0].ref_image == ""  # Entity 的 ref_image 未设置,不串项目卡数据
        assert refs[1].ref_image == "/img/hong.png"


def test_resolve_shot_characters_cross_user_not_leaked(ctx):
    """全局主体按项目属主解析:他人同名 Entity 不会注入到我的分镜。"""
    _, _, _, engine = ctx
    with Session(engine) as s:
        alice = s.exec(select(User).where(User.email == "alice@toiv.ai")).one()
        bob = s.exec(select(User).where(User.email == "bob@toiv.ai")).one()
        proj = DramaProject(tenant_id=alice.tenant_id, user_id=alice.id, title="剧")
        s.add(proj)
        s.commit()
        s.refresh(proj)
        s.add(DramaCharacter(
            project_id=proj.id, name="阿明", ref_image="/img/drama_aming.png"
        ))
        # Bob 的同名全局主体:不应被 Alice 的项目解析命中
        s.add(Entity(
            tenant_id=bob.tenant_id, user_id=bob.id, kind="character",
            name="阿明", reference_front="/img/bob_aming.png",
        ))
        s.commit()

        refs = resolve_shot_characters(s, project_id=proj.id, names=["阿明"])
        assert refs[0].ref_image == "/img/drama_aming.png"
        assert refs[0].reference_front == ""


# --------------------------------------------------------------------------- #
# 双轨归并(2026-08-29):avatar 扩展字段 + ReferenceAsset→Entity 迁移
# --------------------------------------------------------------------------- #
def test_avatar_fields_crud(ctx):
    """kind=avatar 主体:green_screen/ref_audio/nsfw 创建回显 + PUT 更新。"""
    c, alice, _, _ = ctx
    e = _create(
        c, alice,
        kind="avatar", name="数字人小晚",
        green_screen=True, ref_audio="/api/drama/voice/voice-x.wav", nsfw=True,
    )
    assert e["kind"] == "avatar"
    assert e["green_screen"] is True
    assert e["ref_audio"] == "/api/drama/voice/voice-x.wav"
    assert e["nsfw"] is True
    assert e["reference_status"] == ""

    r = c.put(
        f"/api/entities/{e['id']}", headers=_auth(alice),
        json={"green_screen": False, "ref_audio": "", "nsfw": False},
    )
    assert r.status_code == 200, r.text
    assert r.json()["green_screen"] is False
    assert r.json()["ref_audio"] == ""


def test_avatar_kind_filter(ctx):
    """kind=avatar 查询过滤生效。"""
    c, alice, _, _ = ctx
    _create(c, alice, kind="avatar", name="形象A")
    _create(c, alice, kind="character", name="角色B")
    r = c.get("/api/entities?kind=avatar", headers=_auth(alice))
    assert [e["name"] for e in r.json()] == ["形象A"]


def test_reference_assets_migration(ctx):
    """ReferenceAsset→Entity 迁移:字段映射正确 + 幂等(二次执行不重复)。"""
    _, _, _, engine = ctx
    from app.db import _migrate_reference_assets_to_entities
    from app.models import ReferenceAsset
    from unittest.mock import patch

    with Session(engine) as s:
        alice = s.exec(select(User).where(User.email == "alice@toiv.ai")).one()
        s.add(ReferenceAsset(
            user_id=alice.id, kind="avatar", name="迁移形象",
            description="绿幕形象", images=[{"filename": "a.png", "worker": "http://w"}],
            green_screen=True, ref_audio="/voice/x.wav", nsfw=False,
        ))
        s.add(ReferenceAsset(
            user_id=alice.id, kind="character", name="迁移角色", images=[],
        ))
        s.commit()

    # db.engine 是全局单例:迁移函数内部用它,测试期临时指到内存库
    with patch("app.db.engine", engine):
        _migrate_reference_assets_to_entities()
        _migrate_reference_assets_to_entities()  # 幂等:二次执行不重复建档

    with Session(engine) as s:
        rows = s.exec(select(Entity).where(Entity.user_id.in_(
            select(User.id).where(User.email == "alice@toiv.ai")  # type: ignore[attr-defined]
        ))).all()
        by_name = {e.name: e for e in rows}
        assert set(by_name) == {"迁移形象", "迁移角色"}
        av = by_name["迁移形象"]
        assert av.kind == "avatar"
        assert av.green_screen is True
        assert av.ref_audio == "/voice/x.wav"
        import json as _json

        assert _json.loads(av.ref_image)["filename"] == "a.png"
        assert by_name["迁移角色"].ref_image == ""


# --------------------------------------------------------------------------- #
# 补图(2026-08-29):POST /api/entities/{id}/generate-reference 异步三视图
# --------------------------------------------------------------------------- #
def _fake_pool(queue_side_effect):
    """mock WorkerPool + mock ComfyUIClient(与 test_drama_studio 同款)。"""
    from unittest.mock import AsyncMock, MagicMock

    pool = MagicMock()
    cli = AsyncMock()
    cli.base_url = "http://worker"
    cli.queue_prompt = AsyncMock(side_effect=queue_side_effect)
    pool.pick = AsyncMock(return_value=cli)
    return pool, cli


def test_generate_reference_flow(ctx):
    """三视图生成:提交即返回 generating,后台回写四图槽(front 回填空 ref_image)。"""
    from unittest.mock import AsyncMock, MagicMock, patch

    c, alice, _, engine = ctx
    e = _create(c, alice, name="无图角色", prompt_hint="1girl, red dress")

    pool, _cli = _fake_pool(["pf", "ps", "pb"])
    from app.deps import get_pool

    app.dependency_overrides[get_pool] = lambda: pool
    fake_results = {
        "pf": ["/api/images?filename=front.png"],
        "ps": ["/api/images?filename=side.png"],
        "pb": ["/api/images?filename=back.png"],
    }
    try:
        with patch("app.comfy.tracker.spawn", lambda client, pid: None), \
             patch("app.comfy.tracker.wait_for_jobs", AsyncMock(return_value=fake_results)), \
             patch.object(__import__("app.db", fromlist=["engine"]), "engine", engine):
            r = c.post(
                f"/api/entities/{e['id']}/generate-reference",
                headers=_auth(alice), json={},
            )
            assert r.status_code == 200, r.text
            assert r.json()["reference_status"] == "generating"

            # 后台回写已完成(mock 立即返回)
            r2 = c.get("/api/entities", headers=_auth(alice))
            ent = next(x for x in r2.json() if x["id"] == e["id"])
            assert ent["reference_status"] == "done"
            assert ent["reference_front"] == "/api/images?filename=front.png"
            assert ent["reference_side"] == "/api/images?filename=side.png"
            assert ent["reference_back"] == "/api/images?filename=back.png"
            assert ent["ref_image"] == "/api/images?filename=front.png"  # 空 ref_image 被回填
    finally:
        app.dependency_overrides.pop(get_pool, None)


def test_generate_reference_conflict_and_422(ctx):
    """generating 中重复提交 → 409;无描述无提示词 → 422。"""
    from unittest.mock import AsyncMock, patch

    c, alice, _, engine = ctx
    e1 = _create(c, alice, name="生成中角色", prompt_hint="1boy")
    e2 = _create(c, alice, name="空角色")  # 无 prompt_hint/description

    pool, _cli = _fake_pool(["x1", "x2", "x3"])
    from app.deps import get_pool

    app.dependency_overrides[get_pool] = lambda: pool
    try:
        # e2:无描述 → 422(无需 mock 提交)
        r = c.post(
            f"/api/entities/{e2['id']}/generate-reference",
            headers=_auth(alice), json={},
        )
        assert r.status_code == 422

        with patch("app.comfy.tracker.spawn", lambda client, pid: None), \
             patch("app.comfy.tracker.wait_for_jobs", AsyncMock(side_effect=RuntimeError("超时"))), \
             patch.object(__import__("app.db", fromlist=["engine"]), "engine", engine):
            r = c.post(
                f"/api/entities/{e1['id']}/generate-reference",
                headers=_auth(alice), json={},
            )
            assert r.status_code == 200, r.text
            assert r.json()["reference_status"] == "generating"
            # 等待超时但作业仍 queued → 超时豁免保持 generating
            r = c.post(
                f"/api/entities/{e1['id']}/generate-reference",
                headers=_auth(alice), json={},
            )
            assert r.status_code == 409
    finally:
        app.dependency_overrides.pop(get_pool, None)


def test_generate_reference_other_user_404(ctx):
    """他人主体触发生成 → 404(防枚举)。"""
    c, alice, bob, _ = ctx
    e = _create(c, alice, name="阿明的角色", prompt_hint="1boy")
    r = c.post(
        f"/api/entities/{e['id']}/generate-reference",
        headers=_auth(bob), json={},
    )
    assert r.status_code == 404
