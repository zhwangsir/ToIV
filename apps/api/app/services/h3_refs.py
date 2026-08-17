"""H3 @图片N 多参考图引用行(正典技能 h3-prompt-writer 规则的可复用实现)。

规则正典(摘自 app/skills/h3-prompt-writer/SKILL.md「@图片N 引用规则」,
配套可复用模板 app/skills/h3-multi-ref/SKILL.md):
  · 按实际提交顺序编号 图片1、图片2、图片3…,每张图片只编号一次;
  · 存在图片时,最终提示词的**绝对开头**是一整行连续引用:
    ``@图片1作为主角身份与服装参考@图片2作为场景与光影参考``(随后换行进正文);
  · 一张图片承担多个功能时合并为一句;
  · 正文中引用紧贴对象:角色名(@图片1),全角括号、与对象名之间不留空格。

drama 线实体→参考图载体是 DramaCharacter(三视图 reference_front/side/back
或单图 ref_image);仅 H3 引擎分镜在 prompt 绝对开头注入引用行,
与 Team B 的 seam modifier(末尾注入)天然兼容:引用行恒在最前。
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass

from sqlmodel import Session, select

from app.models import DramaCharacter, DramaShot

logger = logging.getLogger(__name__)


@dataclass
class RefImage:
    """一张随 prompt 提交给 H3 的参考图。

    label: 用途说明(中文),如「阿明身份与服装参考」;一图多功能时合并写一句。
    role: 来源实体名(角色名),便于日志/排查。
    image_url / image_bytes: 图来源,二选一(当前 H3 链路只注入引用行,暂不下发字节)。
    """

    label: str
    role: str = ""
    image_url: str = ""
    image_bytes: bytes | None = None


def build_ref_prefix(refs: list[RefImage]) -> str:
    """产出绝对开头引用行:``@图片1作为{label}@图片2作为{label}…`` + 换行。

    编号顺序 = refs 列表顺序(即实际提交顺序);空列表 → 空串
    (无图时提示词第一行直接进入正文,与正典规则一致)。
    """
    if not refs:
        return ""
    return "".join(f"@图片{i + 1}作为{r.label}" for i, r in enumerate(refs)) + "\n"


def refs_from_characters(characters: list[DramaCharacter]) -> list[RefImage]:
    """实体注册表(角色卡)→ 参考图映射。

    有三视图用正面(reference_front),否则退回单张 ref_image;无图角色跳过。
    编号顺序 = 传入列表顺序(调用方负责确定性排序,见 ref_prefix_for_shot)。
    """
    refs: list[RefImage] = []
    for c in characters:
        url = (c.reference_front or "").strip() or (c.ref_image or "").strip()
        if not url:
            continue
        refs.append(
            RefImage(label=f"{c.name}身份与服装参考", role=c.name, image_url=url)
        )
    return refs


def ref_prefix_for_shot(shot: DramaShot, session: Session, *, engine: str) -> str:
    """分镜 + 引擎 → @图片N 引用行;非 H3 引擎 / 无出场角色 / 角色无参考图 → 空串。

    编号确定性:按 shot.characters 的出场顺序排序角色卡,保证同一分镜多次
    提交得到完全一致的 @图片N 绑定(SQL in_ 查询不保证返回顺序)。
    """
    if engine != "h3":
        return ""
    try:
        names = json.loads(shot.characters) if shot.characters else []
    except (ValueError, TypeError):
        names = []
    names = [n for n in names if isinstance(n, str) and n.strip()]
    if not names:
        return ""
    chars = list(
        session.exec(
            select(DramaCharacter).where(
                DramaCharacter.project_id == shot.project_id,
                DramaCharacter.name.in_(names),
            )
        ).all()
    )
    order = {n: i for i, n in enumerate(names)}
    chars.sort(key=lambda c: order.get(c.name, len(names)))
    prefix = build_ref_prefix(refs_from_characters(chars))
    if prefix:
        logger.info(
            "h3 分镜 #%s 注入 %d 张角色参考图引用行(%s)",
            shot.idx,
            prefix.count("@图片"),
            ",".join(c.name for c in chars),
        )
    return prefix
