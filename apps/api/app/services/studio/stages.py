"""C1c:阶段状态机与确认门禁——人工态持久化 + 产物现算 ready/blockers + 审计。

设计纪律:
  · stage_states_json 只存人工态(confirmed/skipped/needs_review/
    pending_confirmation);draft 与 ready/blockers 由 shots/characters/project
    及 C1a media_status 现算——persist 不用文本状态代替产物时效。
  · 旧项目无存储 → 全部 draft(不自动 confirmed)。
  · 上游真实修改(save_shots/reflow/premise/style/ckpt/角色视觉/音色)只把
    对应下游 confirmed/skipped 标 needs_review 并留审计;无变化不误标;不杀在途。
  · 确认门禁:confirm 需 pending_confirmation + ready + 前序 confirmed/skipped;
    skip 是显式用户决定(必须说明);reopen 使 needs_review/confirmed/skipped
    回到 pending_confirmation。幂等重复不重复写历史。
  · 并发纪律:人工态持久化走 stage_revision 条件 UPDATE(CAS),多进程安全;
    读-写间隙被他人提交 → StageConflictError(409),审计随回滚丢弃;上游失效
    遇竞争重读合并重试,绝不静默丢他人已提交跃迁或审计。
"""
from __future__ import annotations

import json
import logging
from typing import Any

from sqlmodel import Session, select

from app.models import (
    STUDIO_STAGES,
    StudioCharacter,
    StudioProject,
    StudioShot,
    StudioStageConfirmation,
)

logger = logging.getLogger(__name__)


class StageError(ValueError):
    """阶段领域错误;路由映射 409(状态/冲突)或 422(参数)。"""


class StageConflictError(StageError):
    """乐观并发冲突:stage_revision 已被其他写入推进,本次跃迁未落库。

    与 StageError 同映射 409;detail 携带 stage_revision 提示客户端重读重试。
    """


# ── 人工态存储 ───────────────────────────────────────────────────────────────


def load_store(project: StudioProject) -> dict[str, str]:
    try:
        data = json.loads(project.stage_states_json or "{}")
    except (ValueError, TypeError):
        data = {}
    return {k: v for k, v in data.items() if k in STUDIO_STAGES} if isinstance(data, dict) else {}


def _persist_store(
    session: Session, project: StudioProject, store: dict[str, str], *,
    expected_revision: int,
) -> None:
    """条件 UPDATE(CAS)持久化人工态:仅当 stage_revision 仍为 expected 才落库。

    多进程/多请求并发下防写后写:版本被他人推进时 0 行命中 → 回滚本事务
    (审计行一并丢弃)并抛 StageConflictError。不用 ORM 读-改-写冒充原子;
    UPDATE ... WHERE id=? AND stage_revision=? 在 PG 与 SQLite 语义一致。
    """
    from datetime import datetime, timezone

    from sqlalchemy import update as sa_update

    new_revision = int(expected_revision) + 1
    stmt = (
        sa_update(StudioProject)
        .where(StudioProject.id == project.id)
        .where(StudioProject.stage_revision == int(expected_revision))
        .values(
            stage_states_json=json.dumps(store, ensure_ascii=False),
            stage_revision=new_revision,
            updated_at=datetime.now(timezone.utc),
        )
    )
    result = session.exec(stmt)
    if getattr(result, "rowcount", 1) == 0:
        session.rollback()
        raise StageConflictError(
            f"阶段状态已被并发修改(stage_revision 已非 {expected_revision}),请重读重试"
        )
    session.commit()


def _audit(
    session: Session, project: StudioProject, *,
    stage: str, from_state: str, to_state: str,
    source: str, note: str, created_by: str,
) -> None:
    session.add(
        StudioStageConfirmation(
            project_id=project.id, stage=stage,
            from_state=from_state, to_state=to_state,
            source=source, note=note[:500], created_by=created_by,
        )
    )


# ── ready/blockers 现算 ──────────────────────────────────────────────────────


def _readiness(
    session: Session, project: StudioProject, shots: list[StudioShot],
    characters: list[StudioCharacter],
) -> dict[str, dict[str, Any]]:
    from app.services.studio import revisions as rev_svc

    ready: dict[str, dict[str, Any]] = {}
    # script
    ready["script"] = {
        "ready": bool((project.premise or "").strip()),
        "blockers": [] if (project.premise or "").strip() else ["剧情概要(premise)为空"],
    }
    # assets
    ready["assets"] = {
        "ready": len(characters) > 0,
        "blockers": [] if characters else ["尚未创建角色卡(无角色项目可跳过本阶段)"],
    }
    # storyboard
    ready["storyboard"] = {
        "ready": len(shots) > 0,
        "blockers": [] if shots else ["尚无分镜"],
    }
    # generate:全部镜视觉产物 current(产物时效,非文本状态)
    gen_blockers = []
    media = {}
    for s in shots:
        st = rev_svc.media_status(session, s)
        media[s.id] = st
        if st["visual_media_status"] != "current":
            gen_blockers.append(
                f"镜{s.idx} 视觉产物未就绪({st['visual_media_status']})"
            )
    ready["generate"] = {"ready": bool(shots) and not gen_blockers, "blockers": gen_blockers}
    # voice:有对白镜 audio current;无对白镜不阻塞(可显式跳过配音/最终合成)
    voice_blockers = []
    for s in shots:
        if not (s.dialogue or "").strip():
            continue
        if media[s.id]["audio_media_status"] != "current":
            voice_blockers.append(f"镜{s.idx} 配音未就绪({media[s.id]['audio_media_status']})")
    ready["voice"] = {
        "ready": bool(shots) and not voice_blockers,
        "blockers": voice_blockers,
    }
    # timeline:final_media_status 不允许 stale(none 由后续合成步骤处理)
    tl_blockers = []
    for s in shots:
        if media[s.id]["final_media_status"] == "stale":
            tl_blockers.append(f"镜{s.idx} 最终片段已过期(final stale)")
    ready["timeline"] = {
        "ready": bool(shots) and not tl_blockers,
        "blockers": tl_blockers,
    }
    return ready


def compute_stage_states(session: Session, project: StudioProject) -> dict[str, dict[str, Any]]:
    """完整阶段投影:{stage: {state, ready, blockers}}。

    state 推导:人工态(confirmed/skipped/needs_review/pending_confirmation)直接采用;
    无人工态 → ready ? pending_confirmation : draft;generate 叠加在途/失败
    (仅未确认时,不打断已确认态)。
    """
    shots = session.exec(
        select(StudioShot).where(StudioShot.project_id == project.id)
    ).all()
    characters = session.exec(
        select(StudioCharacter).where(StudioCharacter.project_id == project.id)
    ).all()
    readiness = _readiness(session, project, shots, characters)
    store = load_store(project)
    out: dict[str, dict[str, Any]] = {}
    any_rendering = any((s.status or "") in ("queued", "rendering") for s in shots)
    any_error = any((s.status or "") == "error" for s in shots)
    for stage in STUDIO_STAGES:
        r = readiness[stage]
        state = store.get(stage)
        if state not in ("confirmed", "skipped", "needs_review", "pending_confirmation"):
            state = "pending_confirmation" if r["ready"] else "draft"
            if stage == "generate":
                if any_rendering:
                    state = "generating"
                elif any_error:
                    state = "failed"
        out[stage] = {"state": state, "ready": r["ready"], "blockers": r["blockers"]}
    return out


def stage_state_of(session: Session, project: StudioProject, stage: str) -> dict[str, Any]:
    return compute_stage_states(session, project)[stage]


# ── 上游失效 ─────────────────────────────────────────────────────────────────


def invalidate_stages(
    session: Session, project: StudioProject, *,
    stages: list[str], source: str, note: str,
    created_by: str = "system",
) -> list[str]:
    """上游真实修改 → 对应下游 confirmed/skipped 标 needs_review + 审计。

    只动已确认/已跳过的阶段(未确认的不必标);重复调用对已 needs_review 幂等
    (不再写历史)。不触碰在途渲染/配音作业。
    """
    # 显式去重并按 STUDIO_STAGES 稳定顺序归一:调用方可传重复/乱序/非法项
    # (如 premise+style 同变时 storyboard 重复),审计与返回序必须确定。
    wanted = set(stages)
    stages = [s for s in STUDIO_STAGES if s in wanted]
    store = load_store(project)
    changed: list[tuple[str, str]] = []
    for stage in stages:
        if stage not in STUDIO_STAGES:
            continue
        current = store.get(stage)
        if current not in ("confirmed", "skipped"):
            continue  # 未确认/已 needs_review:不重复标记,不留重复审计
        store[stage] = "needs_review"
        changed.append((stage, current))
    if not changed:
        return []
    # CAS 竞争时重读合并重试:只降级 confirmed/skipped,对他人已提交的跃迁
    # 纯合并不覆盖;重试耗尽仍冲突则抛出(上游业务变更已提交,绝不静默丢审计)。
    for attempt in range(5):
        for stage, prev in changed:
            _audit(
                session, project, stage=stage, from_state=prev, to_state="needs_review",
                source=source, note=note, created_by=created_by,
            )
        try:
            _persist_store(
                session, project, store,
                expected_revision=int(project.stage_revision or 0),
            )
        except StageConflictError:
            if attempt == 4:
                raise
            session.refresh(project)  # 取回他人写入的最新 store/revision 再合并
            fresh = load_store(project)
            changed = [
                (stage, fresh[stage]) for stage, _prev in changed
                if fresh.get(stage) in ("confirmed", "skipped")
            ]
            if not changed:
                return []
            store = dict(fresh)
            for stage, _prev in changed:
                store[stage] = "needs_review"
            continue
        return [stage for stage, _prev in changed]
    return []  # pragma: no cover - 循环内已 return/raise


# ── transition(confirm/skip/reopen 统一入口)─────────────────────────────────


def transition(
    session: Session, project: StudioProject, *,
    stage: str, action: str, note: str, user_id: str,
    expected_stage_revision: int | None = None,
) -> dict[str, Any]:
    if stage not in STUDIO_STAGES:
        raise StageError(f"未知阶段:{stage}")
    if action not in ("confirm", "skip", "reopen"):
        raise StageError(f"未知动作:{action}")
    if action == "skip" and len((note or "").strip()) < 2:
        raise StageError("跳过阶段须填写说明(显式用户决定)")

    states = compute_stage_states(session, project)
    current = states[stage]["state"]
    store = load_store(project)
    # CAS 基线:显式 expected 优先(路由已预检,持久化层仍原子复核);
    # 未传则以本次读取的 revision 为基线,同样防读-写间隙的并发提交。
    expected = (
        int(expected_stage_revision)
        if expected_stage_revision is not None
        else int(project.stage_revision or 0)
    )

    if action == "confirm":
        if current == "confirmed":
            return states  # 幂等:不重复写历史
        if current == "skipped":
            raise StageError("阶段已显式跳过,如需确认请先 reopen")
        if current != "pending_confirmation":
            if current == "draft" and states[stage]["blockers"]:
                raise StageError(
                    "阶段未就绪:" + ";".join(states[stage]["blockers"][:3])
                )
            raise StageError(f"当前状态({current})不可确认")
        idx = STUDIO_STAGES.index(stage)
        prev_pending = [
            f"{s}={states[s]['state']}"
            for s in STUDIO_STAGES[:idx]
            if states[s]["state"] not in ("confirmed", "skipped")
        ]
        if prev_pending:
            raise StageError("前序阶段未确认/跳过:" + ",".join(prev_pending))
        store[stage] = "confirmed"
        _audit(session, project, stage=stage, from_state=current, to_state="confirmed",
               source="manual", note=note, created_by=user_id)
    elif action == "skip":
        if current == "skipped":
            return states  # 幂等
        if current == "confirmed":
            raise StageError("阶段已确认,如需改判请先 reopen")
        store[stage] = "skipped"
        _audit(session, project, stage=stage, from_state=current, to_state="skipped",
               source="manual", note=note, created_by=user_id)
    else:  # reopen
        if current not in ("needs_review", "confirmed", "skipped"):
            return states  # draft/pending 无需重开
        store[stage] = "pending_confirmation"
        _audit(session, project, stage=stage, from_state=current, to_state="pending_confirmation",
               source="manual", note=note, created_by=user_id)

    _persist_store(session, project, store, expected_revision=expected)
    return compute_stage_states(session, project)


# ── 历史 ─────────────────────────────────────────────────────────────────────


def list_history(
    session: Session, project_id: str, stage: str | None = None
) -> list[StudioStageConfirmation]:
    q = select(StudioStageConfirmation).where(
        StudioStageConfirmation.project_id == project_id
    )
    if stage:
        q = q.where(StudioStageConfirmation.stage == stage)
    rows = session.exec(
        q.order_by(StudioStageConfirmation.created_at.desc())  # type: ignore[attr-defined]
    ).all()
    return list(rows)


def history_out(row: StudioStageConfirmation) -> dict[str, Any]:
    return {
        "id": row.id,
        "stage": row.stage,
        "from_state": row.from_state,
        "to_state": row.to_state,
        "source": row.source,
        "note": row.note,
        "created_by": row.created_by,
        "created_at": row.created_at.isoformat() if row.created_at else "",
    }
