"""跨集资产对账(B3):只读台账 + 确定性建议 + 幂等 apply。

口径:
- 同租户且同用户的项目视为同一剧集的各集(无 Series 模型,按归属聚合);
- 正典 = 全局主体库 Entity;项目角色卡 = StudioCharacter;
- 状态优先 local_only → missing_reference → outdated → synced,
  matches_canonical 只认「本集参考图非空且是正典参考图子集」;
- 建议不接 LLM:名称确定性命中 + 引用 URL 差异即可给出 merge/import/create;
- apply 以 (project_id, receipt_id) 唯一约束幂等;重放直接回执,不再写业务行。
"""
from __future__ import annotations

import json
from typing import Any
from urllib.parse import quote

from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, select

from app.models import (
    Entity,
    StudioAssetLedgerApply,
    StudioCharacter,
    StudioProject,
    StudioShot,
)
from app.services.entities import parse_image_handle
from app.services.studio import revisions as rev_svc

LEDGER_ACTIONS = ("merge", "import", "create")
_ASSET_KINDS = ("character", "scene", "prop")
_ENTITY_SLOTS = ("ref_image", "reference_front", "reference_side", "reference_back")
_DRIFT_STALE_MEDIA = "SHOT_MEDIA_STALE"


def normalize_name(value: str) -> str:
    return " ".join((value or "").strip().split()).casefold()


def _image_url(value: str) -> str:
    h = parse_image_handle(value)
    if h:
        return (
            f"/api/images?filename={quote(h['filename'])}"
            f"&type=input&worker={quote(h['worker'])}"
        )
    return (value or "").strip()


def _image_key(value: str) -> str:
    h = parse_image_handle(value)
    if h:
        return f"handle:{h['worker']}:{h['filename']}"
    return (value or "").strip()


def _json_list(raw: Any) -> list:
    if isinstance(raw, list):
        return raw
    try:
        value = json.loads(raw or "[]")
    except (ValueError, TypeError):
        return []
    return value if isinstance(value, list) else []


def _json_dict(raw: Any) -> dict:
    if isinstance(raw, dict):
        return raw
    try:
        value = json.loads(raw or "{}")
    except (ValueError, TypeError):
        return {}
    return value if isinstance(value, dict) else {}


def _iso(value: Any) -> str:
    return value.isoformat() if value is not None else ""


def _entity_refs(entity: Entity) -> list[tuple[str, str]]:
    """正典参考图 [(身份键, 可展示 URL)],按 单图→正→侧→背 去重。"""
    out: list[tuple[str, str]] = []
    seen: set[str] = set()
    for attr in _ENTITY_SLOTS:
        raw = (getattr(entity, attr, "") or "").strip()
        if not raw:
            continue
        key = _image_key(raw)
        if not key or key in seen:
            continue
        seen.add(key)
        out.append((key, _image_url(raw)))
    return out


def _character_refs(character: StudioCharacter) -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    seen: set[str] = set()
    for raw in _json_list(character.reference_images):
        text = str(raw or "").strip()
        if not text:
            continue
        key = _image_key(text)
        if not key or key in seen:
            continue
        seen.add(key)
        out.append((key, _image_url(text)))
    return out


def _shot_character_names(shot: StudioShot) -> list[str]:
    return [
        str(name).strip()
        for name in _json_list(shot.characters)
        if isinstance(name, str) and str(name).strip()
    ]


def _asset_key(kind: str, name: str) -> str:
    return f"{kind}:{name}"


def _split_asset_key(asset_key: str) -> tuple[str, str]:
    kind, _, name = (asset_key or "").partition(":")
    return kind.strip(), name.strip()


def _episode_order(project: StudioProject, row: StudioProject) -> tuple:
    return (
        row.id != project.id,
        _iso(row.created_at),
        row.id,
    )


def _load_episodes(session: Session, project: StudioProject) -> list[StudioProject]:
    rows = session.exec(
        select(StudioProject).where(
            StudioProject.tenant_id == project.tenant_id,
            StudioProject.user_id == project.user_id,
        )
    ).all()
    return sorted(rows, key=lambda row: _episode_order(project, row))


def _load_characters(session: Session, project_ids: list[str]) -> dict[str, list[StudioCharacter]]:
    if not project_ids:
        return {}
    rows = session.exec(
        select(StudioCharacter).where(StudioCharacter.project_id.in_(project_ids))
    ).all()
    grouped: dict[str, list[StudioCharacter]] = {pid: [] for pid in project_ids}
    for row in rows:
        grouped.setdefault(row.project_id, []).append(row)
    for rows_in_episode in grouped.values():
        rows_in_episode.sort(key=lambda c: (_iso(c.created_at), c.name, c.id))
    return grouped


def _load_shots(session: Session, project_ids: list[str]) -> dict[str, list[StudioShot]]:
    if not project_ids:
        return {}
    rows = session.exec(
        select(StudioShot).where(StudioShot.project_id.in_(project_ids))
    ).all()
    grouped: dict[str, list[StudioShot]] = {pid: [] for pid in project_ids}
    for row in rows:
        grouped.setdefault(row.project_id, []).append(row)
    for rows_in_episode in grouped.values():
        rows_in_episode.sort(key=lambda s: (int(s.idx or 0), _iso(s.created_at), s.id))
    return grouped


def _load_canonical_entities(session: Session, project: StudioProject) -> list[Entity]:
    return session.exec(
        select(Entity).where(
            Entity.tenant_id == project.tenant_id,
            Entity.user_id == project.user_id,
        )
    ).all()


def _entity_rank(entity: Entity) -> tuple:
    """同名多正典时取确定性首选:有参考图 → 建得早 → id。"""
    return (0 if _entity_refs(entity) else 1, _iso(entity.created_at), entity.id)


def _canonical_index(entities: list[Entity]) -> dict[tuple[str, str], Entity]:
    index: dict[tuple[str, str], Entity] = {}
    for entity in sorted(entities, key=_entity_rank):
        kind = (entity.kind or "character").strip()
        name_key = normalize_name(entity.name)
        if not name_key:
            continue
        index.setdefault((kind, name_key), entity)
    return index


def _shot_mentions(shot: StudioShot, name_key: str) -> bool:
    haystack = " ".join(
        (shot.scene or "", shot.prompt or "", shot.dialogue or "")
    )
    return name_key in normalize_name(haystack)


def _entity_out(entity: Entity | None) -> dict | None:
    if entity is None:
        return None
    return {
        "id": entity.id,
        "kind": entity.kind,
        "name": entity.name,
        "description": entity.description,
        "prompt_hint": entity.prompt_hint,
        "ref_image": _image_url(entity.ref_image),
        "reference_front": _image_url(entity.reference_front),
        "reference_side": _image_url(entity.reference_side),
        "reference_back": _image_url(entity.reference_back),
        "reference_count": len(_entity_refs(entity)),
    }


def _receipt_out(receipt: StudioAssetLedgerApply) -> dict:
    return {
        "receipt_id": receipt.receipt_id,
        "action": receipt.action,
        "asset_key": receipt.asset_key,
        "entity_id": receipt.entity_id,
        "created_at": _iso(receipt.created_at),
    }


def _fill_entity_slots(entity: Entity, refs: list[tuple[str, str]]) -> int:
    """只填空槽(单图→正→侧→背),已存在的槽位与已有引用绝不覆盖。"""
    if not refs:
        return 0
    used = {
        _image_key(getattr(entity, attr, ""))
        for attr in _ENTITY_SLOTS
        if (getattr(entity, attr, "") or "").strip()
    }
    pending = [url for key, url in refs if key not in used]
    changed = 0
    for attr in _ENTITY_SLOTS:
        if not pending:
            break
        if (getattr(entity, attr, "") or "").strip():
            continue
        setattr(entity, attr, pending.pop(0))
        changed += 1
    return changed


def _fill_character_refs(character: StudioCharacter, refs: list[tuple[str, str]]) -> int:
    """正典 → 项目角色卡只在卡片尚无参考图时补;后来手工编辑优先。"""
    if not refs or _character_refs(character):
        return 0
    urls = [url for _key, url in refs]
    character.reference_images = json.dumps(urls, ensure_ascii=False)
    return len(urls)


def _replay(session: Session, receipt: StudioAssetLedgerApply) -> dict:
    entity = session.get(Entity, receipt.entity_id) if receipt.entity_id else None
    return {
        "applied": True,
        "replayed": True,
        "entity": _entity_out(entity),
        "receipt": _receipt_out(receipt),
    }


def build_ledger(session: Session, project: StudioProject) -> dict:
    """逐集/逐镜头资产版本清单 + 漂移点 + 确定性建议 + 应用回执。"""
    episodes = _load_episodes(session, project)
    episode_ids = [row.id for row in episodes]
    characters_by_episode = _load_characters(session, episode_ids)
    shots_by_episode = _load_shots(session, episode_ids)
    entities = _load_canonical_entities(session, project)
    canonical = _canonical_index(entities)

    episodes_out: list[dict] = []
    occurrence_map: dict[str, dict] = {}
    for episode in episodes:
        characters = characters_by_episode.get(episode.id, [])
        rows_out = []
        for character in characters:
            refs = _character_refs(character)
            rows_out.append(
                {
                    "id": character.id,
                    "name": character.name,
                    "ref_count": len(refs),
                    "refs": [url for _key, url in refs],
                    "visual_prompt": character.visual_prompt,
                }
            )
            name_key = normalize_name(character.name)
            if not name_key:
                continue
            slot = occurrence_map.setdefault(
                name_key, {"name": character.name, "occurrences": []}
            )
            slot["occurrences"].append(
                {"episode": episode, "character": character, "refs": refs}
            )
        episodes_out.append(
            {
                "project_id": episode.id,
                "title": episode.title,
                "is_current": episode.id == project.id,
                "created_at": _iso(episode.created_at),
                "characters": rows_out,
            }
        )

    all_shots: list[tuple[StudioProject, StudioShot]] = []
    for episode in episodes:
        for shot in shots_by_episode.get(episode.id, []):
            all_shots.append((episode, shot))

    shot_mentions: list[tuple[StudioShot, str]] = []
    shots_out: list[dict] = []
    for episode, shot in all_shots:
        names = _shot_character_names(shot)
        shot_refs = _json_list(shot.ref_images_json)
        media = rev_svc.media_status(session, shot)
        for name in names:
            shot_mentions.append((shot, normalize_name(name)))
        anchor = _json_dict(shot.scene_ref_json) or None
        shots_out.append(
            {
                "shot_id": shot.id,
                "project_id": shot.project_id,
                "episode_title": episode.title,
                "idx": int(shot.idx or 0),
                "scene": shot.scene,
                "prompt": shot.prompt,
                "render_mode": shot.render_mode,
                "characters": [
                    {
                        "name": name,
                        "ref_epoch": int(shot.ref_epoch or 0),
                        "ref_count": len(shot_refs),
                    }
                    for name in names
                ],
                "scene_anchor": anchor,
                "media": {
                    "visual": media["visual_media_status"],
                    "audio": media["audio_media_status"],
                    "final": media["final_media_status"],
                },
            }
        )

    assets: list[dict] = []
    drifts: list[dict] = []
    suggestions: list[dict] = []

    for name_key, slot in occurrence_map.items():
        name = slot["name"]
        key = _asset_key("character", name)
        entity = canonical.get(("character", name_key))
        canonical_refs = _entity_refs(entity) if entity else []
        canonical_keys = {ref_key for ref_key, _url in canonical_refs}
        episode_rows = []
        matches: list[bool] = []
        missing_ref = False
        for occurrence in slot["occurrences"]:
            character = occurrence["character"]
            refs = occurrence["refs"]
            ref_keys = {ref_key for ref_key, _url in refs}
            matched = bool(ref_keys) and ref_keys <= canonical_keys
            matches.append(matched)
            missing_ref = missing_ref or not ref_keys
            episode_rows.append(
                {
                    "project_id": occurrence["episode"].id,
                    "character_id": character.id,
                    "ref_count": len(refs),
                    "refs": [url for _key, url in refs],
                    "matches_canonical": matched,
                }
            )
        if entity is None:
            status = "local_only"
        elif not canonical_keys or missing_ref:
            status = "missing_reference"
        elif all(matches):
            status = "synced"
        else:
            status = "outdated"
        used_in_shot_ids = [
            shot.id for shot, name_key_hit in shot_mentions if name_key_hit == name_key
        ]
        assets.append(
            {
                "key": key,
                "kind": "character",
                "name": name,
                "status": status,
                "canonical_entity_id": entity.id if entity else None,
                "canonical_refs": [url for _key, url in canonical_refs],
                "episodes": episode_rows,
                "used_in_shot_ids": used_in_shot_ids,
            }
        )

        distinct_ref_sets = {
            tuple(ref_key for ref_key, _url in occurrence["refs"])
            for occurrence in slot["occurrences"]
        }
        if (
            status != "synced"
            and len(slot["occurrences"]) >= 2
            and len(distinct_ref_sets) >= 2
        ):
            drifts.append(
                {
                    "code": "ASSET_MULTI_VERSION",
                    "severity": "warning",
                    "asset_key": key,
                    "episode_ids": [occ["episode"].id for occ in slot["occurrences"]],
                    "message": (
                        f"「{name}」在 {len(slot['occurrences'])} 集里出现"
                        f" {len(distinct_ref_sets)} 组不同参考图"
                    ),
                }
            )
        if entity is None:
            drifts.append(
                {
                    "code": "ASSET_LOCAL_ONLY",
                    "severity": "warning",
                    "asset_key": key,
                    "episode_ids": [occ["episode"].id for occ in slot["occurrences"]],
                    "message": f"「{name}」只在项目里有角色卡，正典资产库没有同名角色",
                }
            )
        if missing_ref:
            drifts.append(
                {
                    "code": "ASSET_MISSING_REFERENCE",
                    "severity": "warning",
                    "asset_key": key,
                    "episode_ids": [
                        occ["episode"].id
                        for occ in slot["occurrences"]
                        if not occ["refs"]
                    ],
                    "message": f"「{name}」缺少定妆参考图，跨集一致性无法保证",
                }
            )

        needs_merge = any(
            ref_key not in canonical_keys
            for occurrence in slot["occurrences"]
            for ref_key, _url in occurrence["refs"]
        )
        if entity is not None and needs_merge:
            suggestions.append(
                {
                    "asset_key": key,
                    "action": "merge",
                    "entity_id": entity.id,
                    "confidence": 1.0,
                    "reason": "把本集参考图补进正典的空槽位",
                }
            )
        elif entity is not None and missing_ref:
            suggestions.append(
                {
                    "asset_key": key,
                    "action": "import",
                    "entity_id": entity.id,
                    "confidence": 0.9,
                    "reason": "用正典定妆补项目角色卡的空参考图",
                }
            )
        elif entity is None:
            suggestions.append(
                {
                    "asset_key": key,
                    "action": "create",
                    "entity_id": None,
                    "confidence": 0.5,
                    "reason": "正典没有同名角色，可新建正典",
                }
            )

        episode_epochs: dict[int, list[str]] = {}
        for occurrence in slot["occurrences"]:
            for shot, name_key_hit in shot_mentions:
                if (
                    name_key_hit != name_key
                    or shot.project_id != occurrence["episode"].id
                ):
                    continue
                episode_epochs.setdefault(int(shot.ref_epoch or 0), []).append(shot.id)
        if len(episode_epochs) >= 2:
            drifts.append(
                {
                    "code": "SHOT_REF_EPOCH_SWITCH",
                    "severity": "info",
                    "asset_key": key,
                    "shot_ids": sorted(
                        {shot_id for ids in episode_epochs.values() for shot_id in ids}
                    ),
                    "message": (
                        f"「{name}」的镜头在 "
                        f"{' → '.join(str(epoch) for epoch in sorted(episode_epochs))}"
                        " 之间切换了参考版本，旧参考镜头可能需要重渲"
                    ),
                }
            )

    for entity in entities:
        kind = (entity.kind or "").strip()
        if kind not in ("scene", "prop"):
            continue
        name_key = normalize_name(entity.name)
        if not name_key:
            continue
        used: list[StudioShot] = []
        for _episode, shot in all_shots:
            if kind == "scene":
                hit = name_key in normalize_name(shot.scene)
            else:
                hit = _shot_mentions(shot, name_key)
            if hit:
                used.append(shot)
        if not used:
            continue
        refs = _entity_refs(entity)
        episodes_used = sorted({shot.project_id for shot in used}, key=episode_ids.index)
        assets.append(
            {
                "key": _asset_key(kind, entity.name),
                "kind": kind,
                "name": entity.name,
                "status": "synced" if refs else "missing_reference",
                "canonical_entity_id": entity.id,
                "canonical_refs": [url for _key, url in refs],
                "episodes": [
                    {
                        "project_id": pid,
                        "character_id": None,
                        "ref_count": 0,
                        "refs": [],
                        "matches_canonical": None,
                    }
                    for pid in episodes_used
                ],
                "used_in_shot_ids": [shot.id for shot in used],
            }
        )

    for row in shots_out:
        if "stale" in row["media"].values():
            drifts.append(
                {
                    "code": _DRIFT_STALE_MEDIA,
                    "severity": "warning",
                    "asset_key": "",
                    "shot_id": row["shot_id"],
                    "project_id": row["project_id"],
                    "message": f"镜头 #{row['idx'] + 1} 的媒体已过期，需要重渲或重配音",
                }
            )

    receipts = session.exec(
        select(StudioAssetLedgerApply)
        .where(StudioAssetLedgerApply.project_id == project.id)
        .order_by(StudioAssetLedgerApply.created_at, StudioAssetLedgerApply.id)
    ).all()

    return {
        "project_id": project.id,
        "project_title": project.title,
        "episodes": episodes_out,
        "assets": assets,
        "shots": shots_out,
        "drifts": drifts,
        "suggestions": suggestions,
        "receipts": [_receipt_out(receipt) for receipt in receipts],
    }


def _find_project_character(
    session: Session, project_id: str, name: str
) -> StudioCharacter | None:
    rows = session.exec(
        select(StudioCharacter).where(StudioCharacter.project_id == project_id)
    ).all()
    name_key = normalize_name(name)
    for row in rows:
        if row.name.strip() == name:
            return row
    for row in rows:
        if normalize_name(row.name) == name_key:
            return row
    return None


def _find_canonical_by_name(
    session: Session, project: StudioProject, kind: str, name: str
) -> Entity | None:
    rows = session.exec(
        select(Entity).where(
            Entity.tenant_id == project.tenant_id,
            Entity.user_id == project.user_id,
            Entity.kind == kind,
        )
    ).all()
    name_key = normalize_name(name)
    for row in rows:
        if normalize_name(row.name) == name_key:
            return row
    return None


def apply_action(
    session: Session,
    project: StudioProject,
    *,
    receipt_id: str,
    action: str,
    asset_key: str,
    entity_id: str | None = None,
) -> dict:
    """应用一条对账动作;同一 receipt_id 重放返回原回执,不覆盖后来编辑。"""
    receipt_id = (receipt_id or "").strip()
    existing = session.exec(
        select(StudioAssetLedgerApply).where(
            StudioAssetLedgerApply.project_id == project.id,
            StudioAssetLedgerApply.receipt_id == receipt_id,
        )
    ).first()
    if existing is not None:
        return _replay(session, existing)

    kind, name = _split_asset_key(asset_key)
    if kind not in _ASSET_KINDS or not name:
        raise ValueError("资产键无效，应为 character:名称")
    if kind != "character":
        raise ValueError("当前仅角色资产支持对账应用")
    action = (action or "").strip()
    if action not in LEDGER_ACTIONS:
        raise ValueError("不支持的对账动作")

    character = _find_project_character(session, project.id, name)
    if character is None:
        raise ValueError("本项目没有该角色卡片")

    entity: Entity | None = None
    if action in ("merge", "import"):
        if not entity_id:
            raise ValueError("merge/import 需要指定正典资产 entity_id")
        entity = session.get(Entity, entity_id)
        if (
            entity is None
            or entity.tenant_id != project.tenant_id
            or (entity.user_id and entity.user_id != project.user_id)
        ):
            raise ValueError("正典资产不存在")
        if (entity.kind or "character") not in ("character", "avatar"):
            raise ValueError("仅角色类正典资产可应用")
        if action == "merge":
            _fill_entity_slots(entity, _character_refs(character))
            session.add(entity)
        else:
            _fill_character_refs(character, _entity_refs(entity))
            session.add(character)
    else:
        entity = _find_canonical_by_name(session, project, "character", character.name)
        if entity is None:
            entity = Entity(
                tenant_id=project.tenant_id,
                user_id=project.user_id,
                kind="character",
                name=character.name,
                description=character.description,
                prompt_hint=character.visual_prompt,
            )
            _fill_entity_slots(entity, _character_refs(character))
            session.add(entity)
        else:
            _fill_entity_slots(entity, _character_refs(character))
            session.add(entity)

    receipt = StudioAssetLedgerApply(
        tenant_id=project.tenant_id,
        user_id=project.user_id,
        project_id=project.id,
        receipt_id=receipt_id,
        asset_key=_asset_key(kind, character.name),
        action=action,
        entity_id=entity.id if entity.id else "",
    )
    session.add(receipt)
    try:
        session.flush()
    except IntegrityError:
        session.rollback()
        existing = session.exec(
            select(StudioAssetLedgerApply).where(
                StudioAssetLedgerApply.project_id == project.id,
                StudioAssetLedgerApply.receipt_id == receipt_id,
            )
        ).first()
        if existing is not None:
            return _replay(session, existing)
        raise
    session.commit()
    session.refresh(entity)
    session.refresh(receipt)
    return {
        "applied": True,
        "replayed": False,
        "entity": _entity_out(entity),
        "receipt": _receipt_out(receipt),
    }
