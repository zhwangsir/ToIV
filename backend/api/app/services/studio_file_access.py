"""Studio / fusion 媒体产物归属校验(P-1:鉴权≠授权,防 IDOR)。

口径对齐 /api/images 与 /api/dub/output:
  1. 可选 sig=HMAC(studio_file_sig) → 签名即能力,持 URL 即可取;
  2. 无 sig → DB 归属回退(StudioProject/StudioShot/StudioCharacter/DramaScene/
     DramaProject/Job 任一引用该 /api/studio/files/{name} 且属主=当前用户);
  3. admin 直通;一律失败 404「产物不存在」,不泄露存在性。

char_panel_{cid8}_* / scene_anchor_* 另走文件名启发:面板按角色 id 前缀绑项目属主;
场景锚点按 DramaScene.frozen_anchor/master_ref/reverse_ref 引用。
"""
from __future__ import annotations

import hmac
import hashlib
from pathlib import Path

from fastapi import HTTPException
from sqlmodel import Session, select

from app.config import get_settings
from app.models import (
    DramaProject,
    DramaScene,
    Job,
    StudioCharacter,
    StudioProject,
    StudioShot,
    User,
)


def studio_file_sig(name: str) -> str:
    """产物能力签名(HMAC-SHA256 截断 24 hex),与 /api/images image_sig 同形。"""
    key = f"toiv-studio-file:{get_settings().jwt_secret}".encode()
    return hmac.new(key, name.encode(), hashlib.sha256).hexdigest()[:24]


def _sig_ok(name: str, sig: str) -> bool:
    if not sig:
        return False
    expected = studio_file_sig(name)
    return hmac.compare_digest(sig.encode(), expected.encode())


def _marker(name: str) -> str:
    return f"/api/studio/files/{name}"


def _drama_marker(name: str) -> str:
    return f"/api/drama/output/{name}"


def user_owns_studio_file(session: Session, user: User, name: str) -> bool:
    """DB 归属:任一引用点挂在本用户项目/作业上即视为属主。"""
    if user.role == "admin":
        return True
    marker = _marker(name)

    # 成片挂在项目
    if session.exec(
        select(StudioProject.id)
        .where(StudioProject.user_id == user.id)
        .where(StudioProject.final_url.contains(marker))  # type: ignore[attr-defined]
    ).first():
        return True

    # 分镜多列 + JSON 引用
    shot_cols = (
        StudioShot.video_url,
        StudioShot.voice_url,
        StudioShot.image_url,
        StudioShot.final_clip_url,
        StudioShot.candidates_json,
        StudioShot.ref_images_json,
        StudioShot.scene_ref_json,
    )
    from sqlalchemy import or_

    if session.exec(
        select(StudioShot.id)
        .join(StudioProject, StudioShot.project_id == StudioProject.id)
        .where(StudioProject.user_id == user.id)
        .where(or_(*[c.contains(marker) for c in shot_cols]))  # type: ignore[attr-defined]
    ).first():
        return True

    # 角色参考图
    char_cols = (
        StudioCharacter.reference_images,
        StudioCharacter.reference_images_by_style,
        StudioCharacter.voice_ref_url,
    )
    if session.exec(
        select(StudioCharacter.id)
        .join(StudioProject, StudioCharacter.project_id == StudioProject.id)
        .where(StudioProject.user_id == user.id)
        .where(or_(*[c.contains(marker) for c in char_cols]))  # type: ignore[attr-defined]
    ).first():
        return True

    # 场景锚点(双域 project_id)
    scene_cols = (
        DramaScene.master_ref,
        DramaScene.reverse_ref,
        DramaScene.frozen_anchor,
    )
    # Studio 项目下的场景
    studio_pids = session.exec(
        select(StudioProject.id).where(StudioProject.user_id == user.id)
    ).all()
    drama_pids = session.exec(
        select(DramaProject.id).where(DramaProject.user_id == user.id)
    ).all()
    pids = list({*studio_pids, *drama_pids})
    if pids and session.exec(
        select(DramaScene.id)
        .where(DramaScene.project_id.in_(pids))  # type: ignore[attr-defined]
        .where(or_(*[c.contains(marker) for c in scene_cols]))  # type: ignore[attr-defined]
    ).first():
        return True

    # Job.result 回退(作品库产物)
    if session.exec(
        select(Job.id)
        .where(Job.user_id == user.id)
        .where(Job.result.contains(marker))  # type: ignore[attr-defined]
    ).first():
        return True

    # char_panel_{cid8}_* / char_sheet_{cid8}_* 文件名启发:角色属主
    # （设定卡列表与警告软保留落盘后，<img> 需能凭登录态取图）
    if name.startswith("char_panel_") or name.startswith("char_sheet_"):
        parts = name.split("_")
        # char_panel_{cid8}_... 或 char_sheet_{cid8}_...
        if len(parts) >= 3 and len(parts[2]) >= 8:
            cid8 = parts[2][:8]
            chars = session.exec(
                select(StudioCharacter)
                .join(StudioProject, StudioCharacter.project_id == StudioProject.id)
                .where(StudioProject.user_id == user.id)
            ).all()
            if any(c.id.startswith(cid8) for c in chars):
                return True

    return False


def user_owns_drama_output(session: Session, user: User, name: str) -> bool:
    """drama/output 产物归属(fusion 双形态)。"""
    if user.role == "admin":
        return True
    marker = _drama_marker(name)
    if session.exec(
        select(DramaProject.id)
        .where(DramaProject.user_id == user.id)
        .where(DramaProject.video_url.contains(marker))  # type: ignore[attr-defined]
    ).first():
        return True
    if session.exec(
        select(Job.id)
        .where(Job.user_id == user.id)
        .where(Job.result.contains(marker))  # type: ignore[attr-defined]
    ).first():
        return True
    # Studio 成片偶发写到 output/ 子目录时也按 studio marker 对称查
    return False



def user_owns_job_backed_file(
    session: Session,
    user: User,
    name: str,
    *,
    url_prefix: str,
) -> bool:
    """Job.result 引用 `{url_prefix}/{name}` 且属主=当前用户(scope/orch 等 Job 建档产物)。"""
    if user.role == "admin":
        return True
    marker = f"{url_prefix.rstrip('/')}/{name}"
    return bool(
        session.exec(
            select(Job.id)
            .where(Job.user_id == user.id)
            .where(Job.result.contains(marker))  # type: ignore[attr-defined]
        ).first()
    )


def assert_job_backed_file_access(
    session: Session,
    user: User,
    name: str,
    *,
    url_prefix: str,
    sig: str = "",
) -> None:
    """Job 建档文件入口:sig 即能力,或 Job 属主回退;失败统一 404。

    与 assert_studio_file_access 同语义,仅归属源收窄为 Job.result
    (scope_camera / audio_orchestrate 等)。
    """
    if _sig_ok(name, sig):
        return
    if user_owns_job_backed_file(session, user, name, url_prefix=url_prefix):
        return
    raise HTTPException(status_code=404, detail="产物不存在")


def assert_studio_file_access(
    session: Session,
    user: User,
    name: str,
    *,
    sig: str = "",
) -> None:
    """路由入口:失败统一 404。"""
    if _sig_ok(name, sig):
        return
    if user_owns_studio_file(session, user, name):
        return
    raise HTTPException(status_code=404, detail="产物不存在")


def assert_media_path_owned(
    session: Session,
    user: User,
    path: Path,
    *,
    root: Path | None = None,
) -> None:
    """fusion 已过路径闸的本地文件 → 归属校验。

    studio/ 下按 studio 文件归属;output/ 下按 drama output 归属;
    其它子路径(含 drama 根侧车 *.transcript.md)按同名主媒体推断:
      foo.transcript.md → 查 studio/foo.* 或 output/foo.* 的归属。
    """
    from app.storage import drama_output_root

    if user.role == "admin":
        return
    root = (root or drama_output_root()).resolve()
    try:
        rel = path.resolve().relative_to(root)
    except ValueError as exc:
        raise HTTPException(status_code=403, detail="视频路径不在允许的媒体目录内") from exc

    parts = rel.parts
    if not parts:
        raise HTTPException(status_code=404, detail="产物不存在")

    name = parts[-1]
    # 侧车 → 主媒体名
    stem_name = name
    if name.endswith(".transcript.md"):
        stem_name = name[: -len(".transcript.md")]  # owned-by-a

    if len(parts) >= 2 and parts[0] == "studio":
        # studio/foo.mp4 或 studio/foo.transcript.md
        check = name if not name.endswith(".transcript.md") else _first_studio_media(root, stem_name)
        if check and user_owns_studio_file(session, user, check):
            return
        # 侧车在 studio/ 但属主挂的是 stem.mp4
        if name.endswith(".transcript.md"):
            for ext in (".mp4", ".webm", ".mov", ".mkv", ".wav", ".png"):
                cand = f"{stem_name}{ext}"
                if user_owns_studio_file(session, user, cand):
                    return
        raise HTTPException(status_code=404, detail="产物不存在")

    if len(parts) >= 2 and parts[0] == "output":
        check = name if not name.endswith(".transcript.md") else f"{stem_name}.mp4"
        if user_owns_drama_output(session, user, check):
            return
        raise HTTPException(status_code=404, detail="产物不存在")

    # drama 根内侧车(钩子统一落点):owned-by-a.transcript.md
    if name.endswith(".transcript.md"):
        for ext in (".mp4", ".webm", ".mov", ".mkv"):
            if user_owns_studio_file(session, user, f"{stem_name}{ext}"):
                return
            if user_owns_drama_output(session, user, f"{stem_name}{ext}"):
                return
        raise HTTPException(status_code=404, detail="产物不存在")

    # 裸落在根下的媒体
    if user_owns_studio_file(session, user, name) or user_owns_drama_output(session, user, name):
        return
    raise HTTPException(status_code=404, detail="产物不存在")


def _first_studio_media(root: Path, stem: str) -> str | None:
    studio = root / "studio"
    if not studio.is_dir():
        return None
    for p in studio.glob(f"{stem}.*"):
        if p.suffix.lower() in {".mp4", ".webm", ".mov", ".mkv", ".wav", ".png", ".jpg"}:
            return p.name
    return None
