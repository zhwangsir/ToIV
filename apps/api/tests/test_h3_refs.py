"""services/h3_refs —— H3 @图片N 多参考图引用行单元测试。

覆盖:
  · build_ref_prefix 格式(编号顺序 / 绝对开头 / 尾随换行 / 一图多功能合并一句)
  · refs_from_characters 实体注册表→参考图映射(三视图取正面 / ref_image 兜底 / 无图跳过)
  · ref_prefix_for_shot 引擎门控与编号确定性(按分镜出场顺序,而非 DB 返回顺序)
"""
from __future__ import annotations

import json

import pytest
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.models import DramaCharacter, DramaShot
from app.services.h3_refs import (
    RefImage,
    build_ref_prefix,
    ref_prefix_for_shot,
    refs_from_characters,
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
