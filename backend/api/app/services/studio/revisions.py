"""C1a:分镜修订(studio revision)领域逻辑——内容快照、指纹、stale 投影、回滚。

设计要点(合理最小):
  · 一张 studioshotrevision 表:内容修订(manual-edit/rollback/imported)记完整
    内容快照;render 修订记发起时的实际生成输入(内容字段+解析后参数+媒体 URL)。
  · 行不可变;任何变化只追加。回滚=以目标修订内容生成新修订,绝不改写历史。
  · stale 不存标志,一律由指纹派生,且当前侧一律按 live shot 实际输入比较:
    媒体归属修订的指纹 vs live 视觉/音频输入指纹。orchestrator 合法回写
    ref_images_json/video_model 后(live 已更新)不会误 stale;换参考/换引擎/
    换音色参考都能被检出。
  · 视觉输入 = 内容视觉字段 + ref_images_json + video_model;
    音频输入 = dialogue + speaker + voice_ref_url + character_id(角色卡经
    session 现查)。参考音下载降级事实存 render_params.voice_ref_degraded,
    指纹口径=配置来源(降级≠配置变更,不谎报 stale)。
  · 编辑去重(content_equal)只看 CONTENT_FIELDS——render_params/媒体 URL 等
    存档字段永不算用户手工编辑;视觉/音频补充字段不参与去重(那是输入集,
    不是编辑集),二者显式区分,不靠漏字段掩盖。
  · 旧行无历史(指针为空)→ 投影 unknown,不伪造已同步。
"""
from __future__ import annotations

import hashlib
import json
import logging
from typing import Any

from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, select

from app.models import StudioCharacter, StudioShot, StudioShotRevision

logger = logging.getLogger(__name__)


class RevisionConflictError(RuntimeError):
    """(shot_id,version) 并发冲突重试耗尽;路由应转 409(客户端可重试)。"""


# 内容快照字段(编辑去重口径:全量内容;不含媒体 URL/运行态/修订指针,
# 也不含 orchestrator 回写的 ref_images_json/video_model)
CONTENT_FIELDS = (
    "idx", "scene", "prompt", "negative", "camera",
    "dialogue", "speaker", "duration_sec",
    "characters", "render_mode",
    "seam_to_next", "seam_anchor", "ref_epoch", "ref_epoch_note",
    "beats_json", "scene_ref_json",
)
# 视觉输入字段(生成图像/视频的文本与参考依据;指纹口径,跨 source 可比)。
# ref_images_json/video_model 由渲染链回写,属输入而非用户编辑,故不在 CONTENT_FIELDS;
# duration_sec 决定视频长度,同属视觉输入(改时长 → visual stale,配音线不动)。
VISUAL_FIELDS = (
    "scene", "prompt", "negative", "camera", "characters", "render_mode",
    "ref_images_json", "video_model", "duration_sec",
    "seam_to_next", "seam_anchor", "ref_epoch", "ref_epoch_note",
    "scene_ref_json",
)
# 音频输入字段(配音依据:台词+说话人+音色来源)。voice_ref_url/character_id
# 经角色卡解析(F1:换音色参考必须 stale)。
AUDIO_FIELDS = ("dialogue", "speaker", "voice_ref_url", "character_id")
# 仅随 render 快照存档的媒体字段(不参与指纹/去重/diff)
MEDIA_FIELDS = ("image_url", "video_url", "final_clip_url", "voice_url")


def shot_content_snapshot(shot: StudioShot) -> dict[str, Any]:
    return {f: getattr(shot, f, None) for f in CONTENT_FIELDS}


def _voice_source(session: Session | None, shot: StudioShot) -> dict[str, str]:
    """说话人角色卡解析当前音色来源(无卡/无说话人 → 默认音色,空串口径)。"""
    empty = {"voice_ref_url": "", "character_id": ""}
    speaker = (getattr(shot, "speaker", "") or "").strip()
    if not speaker or session is None:
        return empty
    char = session.exec(
        select(StudioCharacter).where(
            StudioCharacter.project_id == shot.project_id,
            StudioCharacter.name == speaker,
        )
    ).first()
    if char is None:
        return empty
    return {
        "voice_ref_url": (getattr(char, "voice_ref_url", "") or "").strip(),
        "character_id": str(getattr(char, "id", "") or ""),
    }


def live_media_inputs(session: Session | None, shot: StudioShot) -> dict[str, Any]:
    """live 实际输入集:内容字段 + 渲染链回写字段 + 音色来源。stale 比较的当前侧。"""
    snap = shot_content_snapshot(shot)
    snap["ref_images_json"] = getattr(shot, "ref_images_json", "") or "[]"
    snap["video_model"] = getattr(shot, "video_model", "") or ""
    snap.update(_voice_source(session, shot))
    return snap


def _fingerprint(snapshot: dict[str, Any], fields: tuple[str, ...]) -> str:
    canonical = json.dumps(
        {f: snapshot.get(f) for f in fields},
        ensure_ascii=False, sort_keys=True, default=str,
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def visual_fingerprint(snapshot: dict[str, Any]) -> str:
    return _fingerprint(snapshot, VISUAL_FIELDS)


def audio_fingerprint(snapshot: dict[str, Any]) -> str:
    return _fingerprint(snapshot, AUDIO_FIELDS)


def content_equal(a: dict[str, Any], b: dict[str, Any]) -> bool:
    """编辑去重:仅 CONTENT_FIELDS。render_params/媒体/ref/video_model 存档不算编辑。"""
    return all(a.get(f) == b.get(f) for f in CONTENT_FIELDS)


def _next_version(session: Session, shot_id: str) -> int:
    rows = session.exec(
        select(StudioShotRevision.version).where(StudioShotRevision.shot_id == shot_id)
    ).all()
    return (max(rows) if rows else 0) + 1


def _is_version_unique_conflict(exc: IntegrityError) -> bool:
    """仅 (shot_id,version) 唯一冲突返回 True(可重试取下一版本)。

    其余 IntegrityError(NOT NULL/FK/其他唯一键/触发器等真实 DB 错误)返回
    False——调用方须原样上抛,不得误包装成 RevisionConflictError/409。
    SQLite: 唯一冲突消息点名本表 shot_id+version 列;PG: SQLSTATE 23505 且
    约束/索引名为 uq_studioshotrevision_shot_version。
    """
    orig = getattr(exc, "orig", None) or exc
    if getattr(orig, "pgcode", None) == "23505":
        diag = getattr(orig, "diag", None)
        name = str(getattr(diag, "constraint_name", "") or "")
        return "studioshotrevision" in name and "shot_version" in name
    msg = str(orig).lower()
    if "unique" not in msg:
        return False
    return "studioshotrevision" in msg and "shot_id" in msg and "version" in msg


def _add_revision(
    session: Session,
    shot: StudioShot,
    *,
    source: str,
    snapshot: dict[str, Any],
    created_by: str,
    parent_id: str,
    render_params: dict[str, Any] | None = None,
    inputs_override: dict[str, Any] | None = None,
) -> StudioShotRevision:
    """追加修订。(shot_id,version) 唯一约束下并发冲突自动重试取下一版本,
    重试耗尽抛 RevisionConflictError(路由转 409,绝不 500)。

    冲突边界=SAVEPOINT(begin_nested):每次 insert 在嵌套事务内 flush,
    IntegrityError 只 ROLLBACK TO SAVEPOINT——外层未提交内容(prompt/回滚
    内容/渲染状态)原样保留,不依赖调用方已 commit 的前提。
    """
    base = dict(snapshot)
    base["ref_images_json"] = getattr(shot, "ref_images_json", "") or "[]"
    base["video_model"] = getattr(shot, "video_model", "") or ""
    base.update(_voice_source(session, shot))
    if inputs_override:
        base.update({k: v for k, v in inputs_override.items() if k in AUDIO_FIELDS})
    content: dict[str, Any] = dict(base)
    if render_params is not None:
        content["render_params"] = render_params
        for f in MEDIA_FIELDS:
            content[f] = getattr(shot, f, "") or ""
    content_json = json.dumps(content, ensure_ascii=False, default=str)
    visual_fp = visual_fingerprint(base)
    audio_fp = audio_fingerprint(base)

    last_exc: IntegrityError | None = None
    for _attempt in range(3):
        # SAVEPOINT 在前:begin_nested 的 snapshot flush 只波及外层已 pending 内容;
        # 修订 insert 随后在嵌套事务内执行,冲突只 ROLLBACK TO SAVEPOINT
        sp = session.begin_nested()
        rev = StudioShotRevision(
            shot_id=shot.id,
            project_id=shot.project_id,
            version=_next_version(session, shot.id),
            source=source,
            parent_id=parent_id,
            content_json=content_json,
            visual_fingerprint=visual_fp,
            audio_fingerprint=audio_fp,
            created_by=created_by,
        )
        session.add(rev)
        try:
            session.flush()
        except IntegrityError as e:
            sp.rollback()  # 释放 SAVEPOINT,保持外层事务可用
            if not _is_version_unique_conflict(e):
                raise  # 非版本冲突:真实 DB 错误原样上抛,不得误报 409
            last_exc = e
            continue
        sp.commit()  # 释放 SAVEPOINT,修订并入外层事务
        return rev
    raise RevisionConflictError(
        f"分镜 {shot.id} 修订版本并发冲突,请重试"
    ) from last_exc


def _get_revision(session: Session, revision_id: str) -> StudioShotRevision | None:
    if not revision_id:
        return None
    return session.get(StudioShotRevision, revision_id)


def ensure_content_revision(
    session: Session,
    shot: StudioShot,
    *,
    source: str,
    created_by: str,
    force: bool = False,
) -> StudioShotRevision | None:
    """内容真实变化才追加修订;重复保存/重排返回 None(不造版本)。

    旧行无当前修订 → 以新状态建档(from unknown,diff 无上游可比)。
    force=True 仅供配方 apply 等显式入口:shot 列在 CONTENT_FIELDS 之外的
    输入(如 ref_images_json)变化也要留痕,但调用方须先自行判定真实变化,
    不得用 force 绕过 C1a 的编辑去重口径。
    """
    snapshot = shot_content_snapshot(shot)
    current = _get_revision(session, shot.current_revision_id)
    if current is not None:
        try:
            old = json.loads(current.content_json or "{}")
        except (ValueError, TypeError):
            old = {}
        if not force and content_equal(old, snapshot):
            return None
        parent_id = current.id
    else:
        parent_id = ""
    rev = _add_revision(
        session, shot, source=source, snapshot=snapshot,
        created_by=created_by, parent_id=parent_id,
    )
    shot.current_revision_id = rev.id
    return rev


def create_render_revision(
    session: Session,
    shot: StudioShot,
    *,
    render_params: dict[str, Any],
    created_by: str = "system",
    snapshot_override: dict[str, Any] | None = None,
    inputs_override: dict[str, Any] | None = None,
) -> StudioShotRevision:
    """渲染/配音发起时登记实际生成输入快照(source=render)。

    snapshot_override:发起时捕获的内容字段(F4:合成在途用户编辑不得记入);
    inputs_override:发起时捕获的音色来源(F1 同款语义)。不改 current_revision_id
    (内容真源不被生成动作顶替);parent 指向发起时的当前内容修订。完成回写时
    rendered/voiced/final 指针记到本修订,用户中途编辑只会经指纹比对出 stale。
    """
    snapshot = shot_content_snapshot(shot)
    if snapshot_override:
        snapshot.update({k: v for k, v in snapshot_override.items() if k in CONTENT_FIELDS})
    return _add_revision(
        session, shot,
        source="render",
        snapshot=snapshot,
        created_by=created_by,
        parent_id=shot.current_revision_id or "",
        render_params=render_params,
        inputs_override=inputs_override,
    )


def _status(
    session: Session | None,
    *,
    media_url: str,
    revision_id: str,
    fingerprint_attr: str,
    current_fingerprint: str,
) -> str:
    """none=无媒体;unknown=无归属(旧行,不伪造);current/stale=指纹派生。"""
    if not (media_url or "").strip():
        return "none"
    if not revision_id:
        return "unknown"
    if session is None:
        return "unknown"
    rev = _get_revision(session, revision_id)
    if rev is None:
        return "unknown"
    attributed = getattr(rev, fingerprint_attr)
    if not current_fingerprint or not attributed:
        return "unknown"
    return "current" if attributed == current_fingerprint else "stale"


def final_media_status(session: Session | None, shot: StudioShot) -> str:
    """final_clip(最终合成)投影:来源=提交时快照的两个指针 × live 指纹重估。

    current=合成时的视频/配音输入仍是现行输入;任一线落后(重渲染/重配音/
    改词改参考)→ stale,提示可重对口型。文件永不因 stale 被清。
    """
    if not (shot.final_clip_url or "").strip():
        return "none"
    fv, fa = shot.final_visual_revision_id or "", shot.final_voice_revision_id or ""
    if not fv and not fa:
        # C1c 无音频语义:final 即原始渲染产物(final==video/image,典型=无对白镜
        # 未对口型/未合成)时,成片时效由视觉线单独定——voiced/final 指针为空
        # 不得把无对白镜永远卡成 unknown。
        raw_final = (shot.final_clip_url == (shot.video_url or "").strip()
                     or shot.final_clip_url == (shot.image_url or "").strip())
        if raw_final:
            live0 = live_media_inputs(session, shot) if session else shot_content_snapshot(shot)
            media_url0 = (shot.video_url or "") or (shot.image_url or "")
            v0 = _status(
                session, media_url=media_url0,
                revision_id=shot.rendered_revision_id,
                fingerprint_attr="visual_fingerprint",
                current_fingerprint=visual_fingerprint(live0),
            )
            return v0 if v0 != "none" else "unknown"
        return "unknown"
    if not fv or not fa:
        return "unknown"
    live = live_media_inputs(session, shot) if session else shot_content_snapshot(shot)
    cur_visual = visual_fingerprint(live)
    cur_audio = audio_fingerprint(live)
    media_url = (shot.video_url or "") or (shot.image_url or "")
    v = _status(
        session, media_url=media_url, revision_id=fv,
        fingerprint_attr="visual_fingerprint", current_fingerprint=cur_visual,
    )
    a = _status(
        session, media_url=shot.voice_url or "", revision_id=fa,
        fingerprint_attr="audio_fingerprint", current_fingerprint=cur_audio,
    )
    if v == "unknown" or a == "unknown":
        return "unknown"
    return "current" if (v == "current" and a == "current") else "stale"


def media_status(session: Session | None, shot: StudioShot) -> dict[str, str]:
    """可解释的 production/stale 投影(视觉/音频/最终合成三条独立线)。"""
    live = live_media_inputs(session, shot) if session else shot_content_snapshot(shot)
    cur_visual = visual_fingerprint(live)
    cur_audio = audio_fingerprint(live)
    media_url = (shot.video_url or "") or (shot.image_url or "")
    return {
        "visual_media_status": _status(
            session,
            media_url=media_url,
            revision_id=shot.rendered_revision_id,
            fingerprint_attr="visual_fingerprint",
            current_fingerprint=cur_visual,
        ),
        "audio_media_status": _status(
            session,
            media_url=shot.voice_url or "",
            revision_id=shot.voiced_revision_id,
            fingerprint_attr="audio_fingerprint",
            current_fingerprint=cur_audio,
        ),
        "final_media_status": final_media_status(session, shot),
    }


def rollback_to_revision(
    session: Session,
    shot: StudioShot,
    revision_id: str,
    *,
    created_by: str,
) -> StudioShotRevision | None:
    """回滚:把目标修订的内容字段写回 shot 并追加 source=rollback 的新修订。

    目标必须属于本镜(调用方已做租户校验);内容无实际变化 → None(去重)。
    媒体归属指针不动——stale 由指纹重估,回滚到与媒体输入一致的内容即恢复 current。
    """
    target = _get_revision(session, revision_id)
    if target is None or target.shot_id != shot.id:
        raise LookupError("修订不存在")
    try:
        snapshot = json.loads(target.content_json or "{}")
    except (ValueError, TypeError):
        snapshot = {}
    for f in CONTENT_FIELDS:
        if f in snapshot:
            setattr(shot, f, snapshot.get(f))
    return ensure_content_revision(
        session, shot, source="rollback", created_by=created_by
    )


def diff_revision(
    session: Session, revision_id: str
) -> dict[str, Any] | None:
    """修订与其上游(内容链)的逐字段 diff;无上游 → from_unknown。

    只暴露 CONTENT_FIELDS:render_params/媒体存档永不被误当用户手工编辑。
    """
    rev = _get_revision(session, revision_id)
    if rev is None:
        return None
    try:
        new = json.loads(rev.content_json or "{}")
    except (ValueError, TypeError):
        new = {}
    parent = _get_revision(session, rev.parent_id)
    from_version: int | None = None
    if parent is not None:
        try:
            old = json.loads(parent.content_json or "{}")
        except (ValueError, TypeError):
            old = {}
        from_version = parent.version
    else:
        old = {}
    fields: dict[str, dict[str, Any]] = {}
    for f in CONTENT_FIELDS:
        o, n = old.get(f), new.get(f)
        if f not in new:
            continue
        if parent is None or o != n:
            fields[f] = {"from": o if parent is not None else None, "to": n}
    return {
        "revision_id": rev.id,
        "version": rev.version,
        "source": rev.source,
        "from_version": from_version,
        "from_unknown": parent is None,
        "fields": fields,
    }


def list_revisions(session: Session, shot_id: str) -> list[StudioShotRevision]:
    rows = session.exec(
        select(StudioShotRevision)
        .where(StudioShotRevision.shot_id == shot_id)
        .order_by(StudioShotRevision.version.desc())  # type: ignore[attr-defined]
    ).all()
    return list(rows)


def revision_out(rev: StudioShotRevision) -> dict[str, Any]:
    return {
        "id": rev.id,
        "version": rev.version,
        "source": rev.source,
        "parent_id": rev.parent_id,
        "visual_fingerprint": rev.visual_fingerprint,
        "audio_fingerprint": rev.audio_fingerprint,
        "created_by": rev.created_by,
        "created_at": rev.created_at.isoformat() if rev.created_at else "",
    }
