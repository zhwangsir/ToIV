"""P1 全局主体库共享逻辑(2026-08-26)。

- parse_image_handle:图片列两种存储形态(上传句柄 JSON 串 / 纯 URL)的统一解析;
- best_image_value:主体最优参考图取值(正面三视图优先,回退单图/侧面/背面);
- resolve_shot_characters:drama 分镜出场角色解析——**优先全局 Entity**
  (kind=character,按属主+名字),未命中回退项目内 DramaCharacter(旧数据兼容);
  返回统一 Duck-type CharacterRef,调用方无需关心来源表。
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from urllib.parse import parse_qs, urlsplit

from sqlmodel import Session, select

from app.models import DramaCharacter, DramaProject, Entity


def parse_image_handle(value: str) -> dict | None:
    """解析图片列:句柄 JSON → {"filename","worker"};纯 URL/空串 → None。"""
    v = (value or "").strip()
    if not v or not v.startswith("{"):
        return None
    try:
        data = json.loads(v)
    except (ValueError, TypeError):
        return None
    if isinstance(data, dict) and data.get("filename") and data.get("worker"):
        return {"filename": str(data["filename"]), "worker": str(data["worker"])}
    return None


def best_image_value(e: Entity) -> str:
    """主体最优参考图(原始存储值):正面 → 单图 → 侧面 → 背面。"""
    for v in (e.reference_front, e.ref_image, e.reference_side, e.reference_back):
        if (v or "").strip():
            return v.strip()
    return ""


def image_handle_for_injection(e: Entity) -> dict | None:
    """主体最优参考图 → {filename, worker} 注入句柄(助手/生成页提交用)。

    句柄 JSON 直接解析;站内 /api/images?filename=..&worker=.. 形态 URL 提取
    query 参数还原句柄;外部 URL / 无图 → None(调用方跳过,不阻塞生成)。
    """
    raw = best_image_value(e)
    if not raw:
        return None
    handle = parse_image_handle(raw)
    if handle is not None:
        return handle
    parts = urlsplit(raw)
    if parts.path.startswith("/api/images"):
        qs = parse_qs(parts.query)
        fn = (qs.get("filename") or [""])[0]
        wk = (qs.get("worker") or [""])[0]
        if fn and wk:
            return {"filename": fn, "worker": wk}
    return None


@dataclass
class CharacterRef:
    """分镜角色解析结果(字段与 DramaCharacter 对齐,Entity/DramaCharacter 双来源)。"""

    name: str
    description: str = ""
    visual_prompt: str = ""
    ref_image: str = ""
    reference_front: str = ""
    reference_side: str = ""
    reference_back: str = ""


def _from_entity(e: Entity) -> CharacterRef:
    return CharacterRef(
        name=e.name,
        description=e.description,
        visual_prompt=e.prompt_hint,
        ref_image=e.ref_image,
        reference_front=e.reference_front,
        reference_side=e.reference_side,
        reference_back=e.reference_back,
    )


def _from_drama(c: DramaCharacter) -> CharacterRef:
    return CharacterRef(
        name=c.name,
        description=c.description,
        visual_prompt=c.visual_prompt,
        ref_image=c.ref_image,
        reference_front=c.reference_front,
        reference_side=c.reference_side,
        reference_back=c.reference_back,
    )


def resolve_shot_characters(
    session: Session, *, project_id: str, names: list[str]
) -> list[CharacterRef]:
    """分镜出场角色解析:同名优先全局 Entity(kind=character),否则回退项目内角色卡。

    返回顺序 = names 出场顺序(调用方负责确定性,SQL in_ 不保证顺序)。
    项目不存在(孤儿分镜)时只查项目内角色卡,不关联任何全局主体。
    """
    clean = [n for n in names if isinstance(n, str) and n.strip()]
    if not clean:
        return []
    drama_chars = list(
        session.exec(
            select(DramaCharacter).where(
                DramaCharacter.project_id == project_id,
                DramaCharacter.name.in_(clean),  # type: ignore[attr-defined]
            )
        ).all()
    )
    by_name: dict[str, CharacterRef] = {c.name: _from_drama(c) for c in drama_chars}

    project = session.get(DramaProject, project_id)
    if project is not None:
        entities = list(
            session.exec(
                select(Entity).where(
                    Entity.user_id == project.user_id,
                    Entity.kind == "character",
                    Entity.name.in_(clean),  # type: ignore[attr-defined]
                )
            ).all()
        )
        # 全局主体优先:同名覆盖项目内角色卡(P1 主体库为一致性唯一事实源)
        for e in entities:
            by_name[e.name] = _from_entity(e)

    return [by_name[n] for n in clean if n in by_name]
