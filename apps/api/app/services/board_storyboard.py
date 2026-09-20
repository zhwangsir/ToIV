"""分镜板 v2(M1,2026-09-21)——画板 shot_text/shot_meta 的纯函数层。

- compose_shot_text:ShotDraft(LLM 拆镜草稿)→ 人读分镜文本(写 BoardItem.shot_text)
- upsert_script_characters:CharacterDraft → Entity(kind=character) 幂等落库(M2)
- resolve_shot_entities:shot_meta(entity_ids/characters) → Entity 列表(按位对齐)
- build_export_document:板+成员 → drama_studio 格式导出文档
  (字段名对齐 routes/drama_studio.py `_shot_dict` 序列化形态;media 取自挂载作品)
"""
from __future__ import annotations

import json
import re
from datetime import datetime
from typing import Any

from sqlmodel import Session, select

from app.models import Board, BoardItem, Entity, Job, User
from app.services.studio.schemas import CharacterDraft, ShotDraft

# 产物 URL 的扩展名常在 query(/api/videos?filename=v.mp4)而非路径,整串匹配
_VIDEO_RE = re.compile(r"\.(mp4|webm|mov|mkv|avi)([?&/#]|$)")
_IMAGE_RE = re.compile(r"\.(png|jpe?g|webp|gif|bmp)([?&/#]|$)")


def compose_shot_text(draft: ShotDraft) -> str:
    """LLM 拆镜草稿 → 人读分镜文本(scene + 台词 + 运镜;≤2000,全空回退 prompt)。"""
    parts: list[str] = []
    scene = draft.scene.strip()
    if scene:
        parts.append(scene)
    dialogue = draft.dialogue.strip()
    if dialogue:
        speaker = draft.speaker.strip() or "旁白"
        parts.append(f"台词({speaker}):{dialogue}")
    camera = draft.camera.strip()
    if camera:
        parts.append(f"运镜:{camera}")
    text = "\n".join(parts) or draft.prompt.strip()
    return text[:2000]


def _meta_of(item: BoardItem) -> dict[str, Any]:
    if not item.shot_meta:
        return {}
    try:
        obj = json.loads(item.shot_meta)
        return obj if isinstance(obj, dict) else {}
    except ValueError:
        return {}


def _duration_of(meta: dict[str, Any]) -> int:
    try:
        d = int(meta.get("duration_sec") or 6)
    except (ValueError, TypeError):
        d = 6
    return max(1, min(60, d))


# ---------------------------------------------------------------------------
# M2 角色一致性:角色草稿落库 / 分镜实体解析
# ---------------------------------------------------------------------------


def _entity_by_name(session: Session, user_id: str, name: str) -> Entity | None:
    """按名查角色主体(kind=character);名无唯一约束,取 created_at 最旧一条(确定性)。"""
    rows = session.exec(
        select(Entity)
        .where(Entity.user_id == user_id, Entity.kind == "character", Entity.name == name)
        .order_by(Entity.created_at)
    ).all()
    return rows[0] if rows else None


def upsert_script_characters(
    session: Session, user: User, drafts: list[CharacterDraft]
) -> dict[str, str]:
    """LLM 角色草稿 → Entity(kind=character) 幂等落库,返回 {角色名: entity_id}。

    按 (user_id, kind, name) 幂等:已存在取最旧一条;description/prompt_hint 只补空,
    不覆盖用户策展数据(定妆照/音色等其余列一律不动)。
    """
    out: dict[str, str] = {}
    for d in drafts:
        name = d.name.strip()
        if not name:
            continue
        ent = _entity_by_name(session, user.id, name)
        if ent is None:
            ent = Entity(
                tenant_id=user.tenant_id,
                user_id=user.id,
                kind="character",
                name=name,
                description=d.description.strip(),
                prompt_hint=d.visual_prompt.strip(),
            )
            session.add(ent)
            session.commit()
            session.refresh(ent)
        else:
            changed = False
            if not ent.description.strip() and d.description.strip():
                ent.description = d.description.strip()
                changed = True
            if not ent.prompt_hint.strip() and d.visual_prompt.strip():
                ent.prompt_hint = d.visual_prompt.strip()
                changed = True
            if changed:
                ent.updated_at = datetime.utcnow()
                session.add(ent)
                session.commit()
        out[name] = ent.id
    return out


def resolve_shot_entities(
    session: Session, user_id: str, meta: dict[str, Any]
) -> list[Entity | None]:
    """分镜实体解析:与 characters/entity_ids 双列表按位对齐(entity_ids 优先、名下放)。

    - entity_ids:属主过滤,不存在的位次落空;该位次用 characters 同名下放
    - 名无唯一约束取最旧一条;**返回 None 补齐的对齐列表**(位次语义不压缩,调用方按需滤空/去重)
    """
    names = [str(n).strip() for n in (meta.get("characters") or []) if str(n).strip()]
    raw_ids = [str(i).strip() for i in (meta.get("entity_ids") or []) if str(i).strip()]
    by_id: dict[str, Entity] = {}
    if raw_ids:
        rows = session.exec(
            select(Entity).where(Entity.user_id == user_id, Entity.id.in_(raw_ids))
        ).all()
        by_id = {e.id: e for e in rows}
    out: list[Entity | None] = []
    for i in range(max(len(names), len(raw_ids))):
        ent = by_id.get(raw_ids[i]) if i < len(raw_ids) else None
        if ent is None and i < len(names):
            ent = _entity_by_name(session, user_id, names[i])
        out.append(ent)
    return out


def _job_results(job: Job | None) -> list[str]:
    if job is None or not job.result:
        return []
    try:
        rs = json.loads(job.result)
        return [str(u) for u in rs if str(u).strip()] if isinstance(rs, list) else []
    except ValueError:
        return []


def _split_media(urls: list[str]) -> tuple[str, str]:
    """产物 URL 列表 → (video_url, image_url),按扩展名/端点前缀分流,各取首个。"""
    video = image = ""
    for u in urls:
        low = u.lower()
        path = low.split("?")[0]
        is_video = bool(_VIDEO_RE.search(low)) or path.rstrip("/").endswith("/videos")
        is_image = bool(_IMAGE_RE.search(low)) or path.rstrip("/").endswith("/images")
        if is_video and not video:
            video = u
        elif is_image and not image:
            image = u
    return video, image


def build_export_document(
    board: Board,
    rows: list[tuple[BoardItem, Job | None]],
    session: Session | None = None,
    user_id: str = "",
) -> dict[str, Any]:
    """整板导出 drama_studio 格式(rows 须已按 sort_order 排序)。

    seam_to_next:shot_meta 有草稿值优先;否则除末镜 hardcut、末镜空(drama_studio 铁律:
    拿不准一律 hardcut)。narration:有台词的行按全镜时长累计起止。
    characters(M2 升维):传 session+user_id 时按名/entity_ids 解析主体,附带
    entity_id/visual_prompt/ref_audio/reference_front(解析不到留空串)。
    """
    shots: list[dict[str, Any]] = []
    characters: list[str] = []
    char_entities: dict[str, Entity] = {}
    narration: list[dict[str, Any]] = []
    cursor = 0.0
    total = len(rows)
    for i, (item, job) in enumerate(rows):
        meta = _meta_of(item)
        duration = _duration_of(meta)
        urls = _job_results(job)
        video_url, image_url = _split_media(urls)
        shot_chars = [str(c) for c in (meta.get("characters") or []) if str(c).strip()]
        for name in shot_chars:
            if name not in characters:
                characters.append(name)
        if session is not None and user_id and shot_chars:
            for name, ent in zip(shot_chars, resolve_shot_entities(session, user_id, meta)):
                if ent is not None and name not in char_entities:
                    char_entities[name] = ent
        seam = str(meta.get("seam_to_next") or "").strip()
        if not seam:
            seam = "" if i == total - 1 else "hardcut"
        dialogue = str(meta.get("dialogue") or "").strip()
        speaker = str(meta.get("speaker") or "").strip()
        shots.append(
            {
                "idx": i + 1,
                "scene": item.shot_text or str(meta.get("scene") or ""),
                "prompt": str(meta.get("prompt") or "") or (job.prompt if job else ""),
                "negative": str(meta.get("negative") or ""),
                "characters": shot_chars,
                "dialogue": dialogue,
                "speaker": speaker,
                "duration_sec": duration,
                "mood": str(meta.get("mood") or ""),
                "beat": str(meta.get("beat") or ""),
                "seam_to_next": seam,
                "seam_anchor": str(meta.get("seam_anchor") or ""),
                "video_url": video_url,
                "image_url": image_url,
                "job_id": item.job_id,
                "seed": job.seed if job else None,
                "status": job.status if job else "pending",
            }
        )
        if dialogue:
            narration.append(
                {
                    "start": round(cursor, 3),
                    "end": round(cursor + duration, 3),
                    "speaker": speaker or "narrator",
                    "text": dialogue,
                }
            )
        cursor += duration
    char_docs: list[dict[str, Any]] = []
    for n in characters:
        ent = char_entities.get(n)
        doc: dict[str, Any] = {
            "name": n,
            "entity_id": "",
            "visual_prompt": "",
            "ref_audio": "",
            "reference_front": "",
        }
        if ent is not None:
            doc.update(
                {
                    "entity_id": ent.id,
                    "visual_prompt": ent.prompt_hint or "",
                    "ref_audio": ent.ref_audio or "",
                    "reference_front": ent.reference_front or "",
                }
            )
        char_docs.append(doc)
    return {
        "title": board.name,
        "description": board.description,
        "characters": char_docs,
        "shots": shots,
        "narration": narration,
        "duration_sec": round(cursor, 3),
    }
