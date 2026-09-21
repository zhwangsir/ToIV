"""整片级 remix(M3.5,2026-09-21)——结构级变体:换主角/换词/换 B-roll。

做法 = 克隆板 + 按类改写 shot_meta + 起一键成片(复用语义天然生效):
- 换主角(protagonist):character_map 旧角色名→新主体 id;命中行 entity_ids 换绑、
  prompt/scene 内旧名换新名、prompt 前缀补新主体 prompt_hint,job_id 清空强制重出
  (参考图/提示词同步换;旧外观 token 残留为 v1 已知边界,大差异需人工顺修);
- 换词(words):dialogue_overrides 行→新台词(可改 speaker);**job_id 全保留**
  (视频复用,只重跑配音+字幕+拼接,是三种里最便宜的变体);
- 换 B-roll(broll):prompt_suffix 全局追加 或 prompt_overrides 逐镜改写场景,
  job_id 清空强制重出;台词/音色不动(voice 阶段照常重跑)。

克隆保原版,变体独立成板(命名「原名 · remix换主角/换词/换背景」)。
"""
from __future__ import annotations

import json
import re
from typing import Any

from fastapi import HTTPException
from sqlmodel import Session, select

from app.models import Board, BoardItem, Entity, User

_KIND_SUFFIX = {
    "protagonist": "remix换主角",
    "words": "remix换词",
    "broll": "remix换背景",
}
KINDS = tuple(_KIND_SUFFIX)


def _meta_of(item: BoardItem) -> dict[str, Any]:
    if not item.shot_meta:
        return {}
    try:
        obj = json.loads(item.shot_meta)
        return obj if isinstance(obj, dict) else {}
    except ValueError:
        return {}


def _swap_character_text(text: str, old: str, new: str) -> str:
    if not old or old == new:
        return text
    return text.replace(old, new)


def _apply_protagonist(
    meta: dict[str, Any], character_map: dict[str, Entity]
) -> bool:
    """命中行换绑主体:characters 内旧名→新名;entity_ids 按位换新 id;prompt 前缀补新外观。"""
    names = [str(n) for n in (meta.get("characters") or [])]
    hit = False
    new_names: list[str] = []
    for n in names:
        ent = character_map.get(n)
        if ent is not None:
            hit = True
            new_names.append(ent.name)
        else:
            new_names.append(n)
    if not hit:
        return False
    meta["characters"] = new_names
    ids = [str(i) for i in (meta.get("entity_ids") or [])]
    for old, ent in character_map.items():
        for i, n in enumerate(names):
            if n == old:
                if i < len(ids):
                    ids[i] = ent.id
                else:
                    ids.append(ent.id)
    meta["entity_ids"] = ids
    for old, ent in character_map.items():
        for key in ("prompt", "scene", "dialogue", "speaker", "shot_text"):
            v = str(meta.get(key) or "")
            if old in v:
                meta[key] = _swap_character_text(v, old, ent.name)
    hints = [e.prompt_hint.strip() for e in character_map.values() if e.prompt_hint.strip()]
    if hints:
        meta["prompt"] = ", ".join(hints) + ", " + str(meta.get("prompt") or "")
    return True


def clone_board_with_remix(
    session: Session,
    user: User,
    board: Board,
    kind: str,
    *,
    character_map: dict[str, Entity] | None = None,
    dialogue_overrides: dict[int, dict] | None = None,
    prompt_suffix: str = "",
    prompt_overrides: dict[int, str] | None = None,
) -> tuple[Board, dict[str, int]]:
    """克隆板并按 remix 类改写成员。返回 (新板, 统计{shots, video_reset, voice_redo})。"""
    if kind not in KINDS:
        raise HTTPException(status_code=422, detail=f"不支持的 remix 类型: {kind}")
    items = session.exec(
        select(BoardItem).where(BoardItem.board_id == board.id).order_by(BoardItem.sort_order)
    ).all()
    if not items:
        raise HTTPException(status_code=422, detail="画板还没有分镜行,无法 remix")
    nb = Board(
        tenant_id=board.tenant_id,
        user_id=board.user_id,
        name=f"{board.name} · {_KIND_SUFFIX[kind]}"[:64],
        description=f"remix 自「{board.name}」({kind})",
        sort=board.sort + 1,
    )
    session.add(nb)
    session.commit()
    session.refresh(nb)

    stats = {"shots": 0, "video_reset": 0, "voice_redo": 0}
    for it in items:
        meta = _meta_of(it)
        shot_text = it.shot_text
        job_id = it.job_id
        reset_video = False
        redo_voice = False

        if kind == "protagonist":
            if character_map and _apply_protagonist(meta, character_map):
                reset_video = True
                for old, ent in character_map.items():
                    shot_text = _swap_character_text(shot_text, old, ent.name)
        elif kind == "words":
            ov = (dialogue_overrides or {}).get(it.id)
            if ov is not None:
                meta["dialogue"] = str(ov.get("dialogue") or "")
                if ov.get("speaker") is not None:
                    meta["speaker"] = str(ov.get("speaker") or "")
                redo_voice = True
        elif kind == "broll":
            ov = (prompt_overrides or {}).get(it.id)
            if ov is not None and str(ov).strip():
                meta["prompt"] = str(ov).strip()
                reset_video = True
            elif prompt_suffix.strip():
                meta["prompt"] = str(meta.get("prompt") or "") + ", " + prompt_suffix.strip()
                reset_video = True

        if reset_video:
            job_id = ""  # 强制重出(复用语义自然跳过未清行)
            stats["video_reset"] += 1
        if redo_voice or reset_video:
            stats["voice_redo"] += 1
        stats["shots"] += 1
        session.add(BoardItem(
            board_id=nb.id,
            job_id=job_id,
            sort_order=it.sort_order,
            note=it.note,
            shot_text=shot_text,
            shot_meta=json.dumps(meta, ensure_ascii=False) if meta else it.shot_meta,
        ))
    session.commit()
    return nb, stats


def resolve_character_map(
    session: Session, user: User, mapping: dict[str, str]
) -> dict[str, Entity]:
    """{旧角色名: 新主体 id} → {旧角色名: Entity}(属主/kind/存在性校验)。"""
    out: dict[str, Entity] = {}
    for old_name, eid in mapping.items():
        old = str(old_name or "").strip()
        e = session.get(Entity, str(eid or "").strip())
        if not old:
            raise HTTPException(status_code=422, detail="旧角色名不能为空")
        if e is None or e.user_id != user.id:
            raise HTTPException(status_code=422, detail=f"主体不存在或不属于当前用户: {eid}")
        if e.kind != "character":
            raise HTTPException(status_code=422, detail=f"主体「{e.name}」不是角色类(kind={e.kind})")
        out[old] = e
    if not out:
        raise HTTPException(status_code=422, detail="character_map 不能为空(旧角色名→新主体 id)")
    return out
