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
from typing import Any

from sqlmodel import Session, select

from app.models import DramaProject, DramaShot, Entity
from app.services.entities import resolve_shot_characters

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


def refs_from_characters(characters: list[Any]) -> list[RefImage]:
    """实体注册表(角色卡)→ 参考图映射。

    duck-typing:DramaCharacter 与 services/entities.CharacterRef 同字段
    (name/reference_front/ref_image)。有三视图用正面,否则退回单张 ref_image;
    无图角色跳过。编号顺序 = 传入列表顺序(调用方负责确定性排序)。
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


# ---------------------------------------------------------------------------
# 全局主体库(@主体引用前台化):entity_ids 显式优先路径
# ---------------------------------------------------------------------------
# 资产类别 → 引用行用途后缀(与正典「一图多功能合并为一句」同构)。
_ENTITY_KIND_SUFFIX = {
    "character": "身份与服装参考",
    "scene": "场景与光影参考",
    "prop": "道具参考",
    "style": "风格参考",
}


def _entity_image_url(entity: Any) -> str:
    """实体参考图来源(duck-typing),按优先级取一:

    1. ``image_url`` 直填;
    2. ``images[0]``(list 形态,兼容 dict 句柄 {filename, worker} / 纯字符串);
    3. 主体库 Entity 四图列:reference_front → ref_image → reference_side →
       reference_back(与 services/entities.best_image_value 同序)。
    取不到图 → 空串(该实体跳过,不占编号)。
    """
    url = str(getattr(entity, "image_url", "") or "").strip()
    if url:
        return url
    images = getattr(entity, "images", None) or []
    if images:
        first = images[0]
        if isinstance(first, dict):
            url = str(first.get("filename", "") or "").strip()
        else:
            url = str(first or "").strip()
        if url:
            return url
    for col in ("reference_front", "ref_image", "reference_side", "reference_back"):
        url = str(getattr(entity, col, "") or "").strip()
        if url:
            return url
    return ""


def refs_from_entities(entities: list[Any]) -> list[RefImage]:
    """全局主体库实体 → 参考图映射。

    编号顺序 = 传入列表顺序(即 entity_ids 顺序,前端 @ 提及的首次出现序);
    无图实体跳过(与 refs_from_characters 同一语义)。label 按 kind 给
    「身份与服装/场景与光影/道具/风格」用途后缀,未知 kind 兜底「参考」。
    """
    refs: list[RefImage] = []
    for e in entities:
        name = str(getattr(e, "name", "") or "").strip()
        if not name:
            continue
        url = _entity_image_url(e)
        if not url:
            continue
        kind = str(getattr(e, "kind", "") or "").strip()
        suffix = _ENTITY_KIND_SUFFIX.get(kind, "参考")
        refs.append(RefImage(label=f"{name}{suffix}", role=name, image_url=url))
    return refs


def first_frame_handle_from_entities(
    session: Session, entity_ids: list[str], *, owner_id: str | None = None
) -> dict | None:
    """entity_ids 顺序下首个有封面句柄的主体 → {filename, worker}。

    无图/外部 URL/他人主体跳过;全无 → None(调用方保持 t2v,不改 SFW 无主体路径)。
    本 pass 只取 1 张作 i2v first_frame,不组装 9-ref 图。
    """
    from app.services.entities import image_handle_for_injection

    ids = [i for i in entity_ids if isinstance(i, str) and i.strip()]
    if not ids:
        return None
    rows = list(session.exec(select(Entity).where(Entity.id.in_(ids))).all())
    if owner_id:
        rows = [r for r in rows if r.user_id == owner_id]
    order = {i: n for n, i in enumerate(ids)}
    rows.sort(key=lambda r: order.get(r.id, len(ids)))
    for r in rows:
        handle = image_handle_for_injection(r)
        if handle:
            return handle
    return None


def resolve_entity_refs(
    session: Session, entity_ids: list[str], *, owner_id: str | None = None
) -> list[RefImage]:
    """按 entity_ids 顺序解析全局主体库(models.Entity)为参考图映射。

    - 编号确定性:结果按 entity_ids 传入顺序排序(SQL in_ 不保证返回序);
    - 不存在的 id 静默跳过(用户可能删了主体,不阻塞生成);
    - owner_id 给出时按属主过滤(防跨用户引用他人主体)。
    """
    ids = [i for i in entity_ids if isinstance(i, str) and i.strip()]
    if not ids:
        return []
    rows = list(session.exec(select(Entity).where(Entity.id.in_(ids))).all())
    if owner_id:
        rows = [r for r in rows if r.user_id == owner_id]
    order = {i: n for n, i in enumerate(ids)}
    rows.sort(key=lambda r: order.get(r.id, len(ids)))
    return refs_from_entities(rows)


def ref_prefix_for_shot(
    shot: DramaShot,
    session: Session,
    *,
    engine: str,
    entity_ids: list[str] | None = None,
) -> str:
    """分镜 + 引擎 → @图片N 引用行;非 H3 引擎 / 无出场角色 / 角色无参考图 → 空串。

    编号确定性:按 shot.characters 的出场顺序排序角色卡,保证同一分镜多次
    提交得到完全一致的 @图片N 绑定(SQL in_ 查询不保证返回顺序)。

    entity_ids(@主体引用前台化):显式给出时**优先于** shot.characters 自动匹配——
    编号顺序 = entity_ids 顺序;空列表 = 用户显式清空全部引用,直接返回空串
    (不回退自动匹配);属主按分镜项目归属隔离。
    """
    if engine != "h3":
        return ""
    if entity_ids is not None:
        if not entity_ids:
            return ""
        owner_id = ""
        project = session.get(DramaProject, shot.project_id)
        if project is not None:
            owner_id = project.user_id
        prefix = build_ref_prefix(
            resolve_entity_refs(session, entity_ids, owner_id=owner_id or None)
        )
        if prefix:
            logger.info(
                "h3 分镜 #%s 注入 %d 张主体库参考图引用行(entity_ids 显式路径)",
                shot.idx,
                prefix.count("@图片"),
            )
        return prefix
    try:
        names = json.loads(shot.characters) if shot.characters else []
    except (ValueError, TypeError):
        names = []
    names = [n for n in names if isinstance(n, str) and n.strip()]
    if not names:
        return ""
    # P1 全局主体库:同名优先 Entity(kind=character),未命中回退项目内 DramaCharacter;
    # resolve_shot_characters 已按 names 出场顺序排序(编号确定性)
    chars = resolve_shot_characters(session, project_id=shot.project_id, names=names)
    prefix = build_ref_prefix(refs_from_characters(chars))
    if prefix:
        logger.info(
            "h3 分镜 #%s 注入 %d 张角色参考图引用行(%s)",
            shot.idx,
            prefix.count("@图片"),
            ",".join(c.name for c in chars),
        )
    return prefix
