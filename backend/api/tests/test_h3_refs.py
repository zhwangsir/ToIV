"""services/h3_refs —— H3 @图片N 多参考图引用行单元测试。

覆盖:
  · build_ref_prefix 格式(编号顺序 / 绝对开头 / 尾随换行 / 一图多功能合并一句)
  · refs_from_characters 实体注册表→参考图映射(三视图取正面 / ref_image 兜底 / 无图跳过)
  · ref_prefix_for_shot 引擎门控与编号确定性(按分镜出场顺序,而非 DB 返回顺序)
  · @主体引用前台化:refs_from_entities(kind→用途后缀/无图跳过)、
    resolve_entity_refs(entity_ids 顺序/缺号跳过/属主隔离)、
    ref_prefix_for_shot 的 entity_ids 显式优先路径(优先于 characters 自动匹配、空列表显式清空)
"""
from __future__ import annotations

import json
from types import SimpleNamespace

import pytest
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.models import DramaCharacter, DramaProject, DramaShot, Entity
from app.services.h3_refs import (
    RefImage,
    build_ref_prefix,
    first_frame_handle_from_entities,
    ref_prefix_for_shot,
    refs_from_characters,
    refs_from_entities,
    resolve_entity_refs,
)


# ---------------------------------------------------------------------------
# build_ref_prefix
# ---------------------------------------------------------------------------
def test_build_ref_prefix_empty():
    """无参考图 → 空串(提示词第一行直接进入正文)。"""
    assert build_ref_prefix([]) == ""


def test_build_ref_prefix_numbering_and_absolute_form():
    """编号按列表顺序(=实际提交顺序),一整行连续引用 + 尾随换行。"""
    refs = [
        RefImage(label="阿明身份与服装参考", role="阿明"),
        RefImage(label="小红身份与服装参考", role="小红"),
        RefImage(label="场景与光影参考"),
    ]
    prefix = build_ref_prefix(refs)
    assert prefix == "@图片1作为阿明身份与服装参考@图片2作为小红身份与服装参考@图片3作为场景与光影参考\n"
    # 编号顺序:1→2→3 依次出现
    assert prefix.index("@图片1") < prefix.index("@图片2") < prefix.index("@图片3")
    # 一整行:仅尾随一个换行(供正文另起一行)
    assert prefix.count("\n") == 1 and prefix.endswith("\n")


def test_build_ref_prefix_multi_function_merged_in_one_label():
    """一图多功能合并为一句(label 内顿号串联),不重复编号。"""
    prefix = build_ref_prefix([RefImage(label="人物身份、服装与场景参考")])
    assert prefix == "@图片1作为人物身份、服装与场景参考\n"
    assert prefix.count("@图片") == 1


# ---------------------------------------------------------------------------
# refs_from_characters
# ---------------------------------------------------------------------------
def _char(name: str, *, front: str = "", side: str = "", back: str = "", ref: str = ""):
    return DramaCharacter(
        project_id="p1",
        name=name,
        reference_front=front,
        reference_side=side,
        reference_back=back,
        ref_image=ref,
    )


def test_refs_from_characters_prefers_three_view_front():
    """有三视图用正面(reference_front),label 为「角色名身份与服装参考」。"""
    refs = refs_from_characters([
        _char("阿明", front="/img/front.png", side="/img/side.png", ref="/img/single.png")
    ])
    assert len(refs) == 1
    assert refs[0].image_url == "/img/front.png"
    assert refs[0].label == "阿明身份与服装参考"
    assert refs[0].role == "阿明"


def test_refs_from_characters_fallback_to_ref_image():
    """无三视图时退回单张 ref_image。"""
    refs = refs_from_characters([_char("小红", ref="/img/single.png")])
    assert [r.image_url for r in refs] == ["/img/single.png"]


def test_refs_from_characters_skips_characters_without_image():
    """无参考图角色跳过,不占编号。"""
    refs = refs_from_characters([_char("无图"), _char("有图", front="/img/f.png")])
    assert [r.role for r in refs] == ["有图"]


# ---------------------------------------------------------------------------
# ref_prefix_for_shot
# ---------------------------------------------------------------------------
@pytest.fixture()
def session():
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    SQLModel.metadata.create_all(engine)
    with Session(engine) as s:
        yield s


def _shot(session: Session, names: list[str]) -> DramaShot:
    shot = DramaShot(
        project_id="p1", idx=0, prompt="p",
        characters=json.dumps(names, ensure_ascii=False),
    )
    session.add(shot)
    session.commit()
    session.refresh(shot)
    return shot


def test_ref_prefix_for_shot_non_h3_engine_returns_empty(session):
    """非 H3 引擎一律空串(ltx 等不认 @图片N 语法)。"""
    shot = _shot(session, ["阿明"])
    session.add(_char("阿明", front="/img/f.png"))
    session.commit()
    assert ref_prefix_for_shot(shot, session, engine="ltx") == ""
    assert ref_prefix_for_shot(shot, session, engine="liveact") == ""


def test_ref_prefix_for_shot_follows_shot_character_order(session):
    """编号确定性:按分镜出场顺序排序(DB 插入顺序相反,证明不依赖 in_ 返回序)。"""
    session.add(_char("甲", front="/img/jia.png"))
    session.add(_char("乙", front="/img/yi.png"))
    session.commit()
    shot = _shot(session, ["乙", "甲"])  # 出场顺序 乙→甲
    prefix = ref_prefix_for_shot(shot, session, engine="h3")
    assert prefix == "@图片1作为乙身份与服装参考@图片2作为甲身份与服装参考\n"


def test_ref_prefix_for_shot_no_characters_returns_empty(session):
    """分镜无出场角色 / characters JSON 损坏 → 空串。"""
    shot = _shot(session, [])
    assert ref_prefix_for_shot(shot, session, engine="h3") == ""
    shot.characters = "{bad json"
    assert ref_prefix_for_shot(shot, session, engine="h3") == ""


# ---------------------------------------------------------------------------
# refs_from_entities(@主体引用前台化)
# ---------------------------------------------------------------------------
def _entity(name: str, *, kind: str = "character", images=None, image_url: str = ""):
    """duck-typing 实体替身(name/kind + images/image_url 两形态,覆盖 _entity_image_url 前两档)。"""
    return SimpleNamespace(name=name, kind=kind, images=images or [], image_url=image_url)


def test_refs_from_entities_kind_suffix_mapping():
    """kind → 用途后缀:character/scene/prop/style 各有专用句,未知 kind 兜底「参考」。"""
    refs = refs_from_entities([
        _entity("牛仔", kind="character", images=[{"filename": "a.png", "worker": "w"}]),
        _entity("酒吧", kind="scene", images=[{"filename": "b.png", "worker": "w"}]),
        _entity("左轮", kind="prop", images=[{"filename": "c.png", "worker": "w"}]),
        _entity("赛博", kind="style", images=[{"filename": "d.png", "worker": "w"}]),
        _entity("杂物", kind="misc", images=[{"filename": "e.png", "worker": "w"}]),
    ])
    assert [r.label for r in refs] == [
        "牛仔身份与服装参考",
        "酒吧场景与光影参考",
        "左轮道具参考",
        "赛博风格参考",
        "杂物参考",
    ]
    assert [r.role for r in refs] == ["牛仔", "酒吧", "左轮", "赛博", "杂物"]


def test_refs_from_entities_image_url_priority_and_string_image():
    """图来源:image_url 直填优先;images[0] 兼容 dict 句柄与纯字符串。"""
    refs = refs_from_entities([
        _entity("甲", images=[{"filename": "h.png", "worker": "w"}], image_url="/img/direct.png"),
        _entity("乙", images=["plain.png"]),
    ])
    assert [r.image_url for r in refs] == ["/img/direct.png", "plain.png"]


def test_refs_from_entities_skips_entities_without_image_or_name():
    """无图 / 无名实体跳过,不占编号(与 refs_from_characters 同一语义)。"""
    refs = refs_from_entities([
        _entity("无图"),
        _entity("", images=[{"filename": "x.png", "worker": "w"}]),
        _entity("有图", images=[{"filename": "y.png", "worker": "w"}]),
    ])
    assert [r.role for r in refs] == ["有图"]


# ---------------------------------------------------------------------------
# resolve_entity_refs
# ---------------------------------------------------------------------------
def _asset(session: Session, name: str, *, user: str = "u1", kind: str = "character") -> Entity:
    """主体库行(models.Entity):ref_image 存 URL 形态(句柄 JSON 形态由实体层契约覆盖)。"""
    a = Entity(
        tenant_id="t1",
        user_id=user,
        kind=kind,
        name=name,
        ref_image=f"/img/{name}.png",
    )
    session.add(a)
    session.commit()
    session.refresh(a)
    return a


def test_resolve_entity_refs_follows_id_order(session):
    """编号确定性:结果按 entity_ids 顺序(DB 插入顺序相反,证明不依赖 in_ 返回序)。"""
    a1 = _asset(session, "牛仔")
    a2 = _asset(session, "酒吧", kind="scene")
    refs = resolve_entity_refs(session, [a2.id, a1.id])
    assert [r.role for r in refs] == ["酒吧", "牛仔"]
    assert build_ref_prefix(refs).startswith("@图片1作为酒吧场景与光影参考@图片2作为牛仔")


def test_resolve_entity_refs_skips_missing_ids(session):
    """不存在的 id 静默跳过(资产可能被删,不阻塞生成)。"""
    a1 = _asset(session, "牛仔")
    refs = resolve_entity_refs(session, ["ghost-id", a1.id])
    assert [r.role for r in refs] == ["牛仔"]


def test_resolve_entity_refs_owner_isolation(session):
    """属主隔离:他人资产被过滤(防跨用户引用)。"""
    mine = _asset(session, "我的", user="u1")
    theirs = _asset(session, "别人的", user="u2")
    refs = resolve_entity_refs(session, [mine.id, theirs.id], owner_id="u1")
    assert [r.role for r in refs] == ["我的"]
    # 不给 owner_id 时不过滤(调用方自行保证来源可信)
    refs = resolve_entity_refs(session, [mine.id, theirs.id])
    assert {r.role for r in refs} == {"我的", "别人的"}


# ---------------------------------------------------------------------------
# ref_prefix_for_shot —— entity_ids 显式优先路径
# ---------------------------------------------------------------------------
def _project(session: Session, pid: str = "p1", user: str = "u1") -> DramaProject:
    p = DramaProject(id=pid, tenant_id="t1", user_id=user, title="测试剧")
    session.add(p)
    session.commit()
    return p


def test_ref_prefix_for_shot_entity_ids_take_priority_over_characters(session):
    """entity_ids 显式给出时优先于 shot.characters 自动匹配(编号按 entity_ids 序)。"""
    _project(session)
    asset = _asset(session, "酒吧", kind="scene")
    # 自动匹配路径本应命中角色「阿明」;entity_ids 在场时不走自动匹配
    session.add(_char("阿明", front="/img/aming.png"))
    session.commit()
    shot = _shot(session, ["阿明"])
    prefix = ref_prefix_for_shot(shot, session, engine="h3", entity_ids=[asset.id])
    assert prefix == "@图片1作为酒吧场景与光影参考\n"


def test_ref_prefix_for_shot_empty_entity_ids_is_explicit_no_refs(session):
    """entity_ids=[] = 用户显式清空全部引用 → 空串,不回退自动匹配。"""
    _project(session)
    session.add(_char("阿明", front="/img/aming.png"))
    session.commit()
    shot = _shot(session, ["阿明"])
    assert ref_prefix_for_shot(shot, session, engine="h3", entity_ids=[]) == ""


def test_ref_prefix_for_shot_entity_ids_scoped_to_project_owner(session):
    """entity_ids 路径按分镜项目属主隔离:引用他人主体资产被过滤。"""
    _project(session, user="u1")
    mine = _asset(session, "我的", user="u1")
    theirs = _asset(session, "别人的", user="u2")
    shot = _shot(session, [])
    prefix = ref_prefix_for_shot(
        shot, session, engine="h3", entity_ids=[mine.id, theirs.id]
    )
    assert prefix == "@图片1作为我的身份与服装参考\n"


def test_ref_prefix_for_shot_entity_ids_non_h3_engine_returns_empty(session):
    """entity_ids 路径同样受引擎门控:非 H3 一律空串。"""
    _project(session)
    asset = _asset(session, "牛仔")
    shot = _shot(session, [])
    assert ref_prefix_for_shot(shot, session, engine="wan", entity_ids=[asset.id]) == ""


def test_first_frame_handle_json_and_url_and_skip():
    """JSON handle wins; /api/images URL restores; external URL / no image -> None."""
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    SQLModel.metadata.create_all(engine)
    with Session(engine) as s:
        e1 = Entity(
            tenant_id="t1", user_id="u1", kind="character", name="ming",
            ref_image='{"filename":"aming.png","worker":"http://w:8189"}',
        )
        e2 = Entity(
            tenant_id="t1", user_id="u1", kind="scene", name="warehouse",
            ref_image="/api/images?filename=wh.png&worker=http://w:8189",
        )
        e3 = Entity(tenant_id="t1", user_id="u1", kind="prop", name="none")
        e4 = Entity(
            tenant_id="t1", user_id="u2", kind="character", name="other",
            ref_image='{"filename":"x.png","worker":"http://w:8189"}',
        )
        s.add(e1); s.add(e2); s.add(e3); s.add(e4)
        s.commit()
        s.refresh(e1); s.refresh(e2); s.refresh(e3); s.refresh(e4)
        h = first_frame_handle_from_entities(s, [e3.id, e1.id], owner_id="u1")
        assert h == {"filename": "aming.png", "worker": "http://w:8189"}
        h2 = first_frame_handle_from_entities(s, [e2.id], owner_id="u1")
        assert h2 == {"filename": "wh.png", "worker": "http://w:8189"}
        assert first_frame_handle_from_entities(s, [e3.id], owner_id="u1") is None
        assert first_frame_handle_from_entities(s, [e4.id], owner_id="u1") is None
        assert first_frame_handle_from_entities(s, [], owner_id="u1") is None
