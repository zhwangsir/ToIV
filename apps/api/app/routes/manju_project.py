"""漫剧工作台 —— 项目 / 资产 / 镜头 的 CRUD(P1 数据底座)。

让漫剧生产"可追踪、可调整、可复用":
  · 项目(ManjuProject):一部漫剧的容器(剧情/画风/底模)。
  · 资产(ManjuAsset):可复用的角色/场景/道具/风格;镜头按 name 引用,改资产可全剧同步。
  · 镜头(ManjuShot):分镜,持久化出图/运动提示词 + 关键帧/视频作业 id(可追踪)。

全部按 user/tenant 鉴权:非本人/不存在一律 404(不泄露存在性)。
"""
from __future__ import annotations

import json

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlmodel import Session, delete, select

from app.db import get_session
from app.deps import get_current_user
from app.models import ManjuAsset, ManjuProject, ManjuShot, User, _now

router = APIRouter()

_ASSET_KINDS = ("character", "scene", "prop", "style")


# ---------------------------------------------------------------------------
# 请求体
# ---------------------------------------------------------------------------
class ProjectIn(BaseModel):
    title: str = Field(default="", max_length=200)
    premise: str = Field(default="", max_length=20000)
    style: str = Field(default="", max_length=300)
    ckpt_name: str = Field(default="", max_length=200)


class ProjectPatch(BaseModel):
    title: str | None = Field(default=None, max_length=200)
    premise: str | None = Field(default=None, max_length=20000)
    style: str | None = Field(default=None, max_length=300)
    ckpt_name: str | None = Field(default=None, max_length=200)


class AssetIn(BaseModel):
    kind: str = Field(default="character")
    name: str = Field(min_length=1, max_length=120)
    description: str = Field(default="", max_length=2000)
    ref_image: str = Field(default="", max_length=1000)
    ref_audio: str = Field(default="", max_length=1000)


class AssetPatch(BaseModel):
    name: str | None = Field(default=None, max_length=120)
    description: str | None = Field(default=None, max_length=2000)
    ref_image: str | None = Field(default=None, max_length=1000)
    ref_audio: str | None = Field(default=None, max_length=1000)


class ShotIn(BaseModel):
    scene: str = Field(default="", max_length=500)
    prompt: str = Field(default="", max_length=2000)
    motion: str = Field(default="", max_length=2000)
    characters: list[str] = Field(default_factory=list)
    camera: str = Field(default="", max_length=120)
    dialogue: str = Field(default="", max_length=1000)
    duration_sec: int = Field(default=3, ge=1, le=30)


class AssetsBulkIn(BaseModel):
    assets: list[AssetIn] = Field(default_factory=list, max_length=200)


class ShotsBulkIn(BaseModel):
    shots: list[ShotIn] = Field(default_factory=list, max_length=200)


class ShotPatch(BaseModel):
    scene: str | None = Field(default=None, max_length=500)
    prompt: str | None = Field(default=None, max_length=2000)
    motion: str | None = Field(default=None, max_length=2000)
    characters: list[str] | None = None
    camera: str | None = Field(default=None, max_length=120)
    dialogue: str | None = Field(default=None, max_length=1000)
    duration_sec: int | None = Field(default=None, ge=1, le=30)
    image_job_id: str | None = Field(default=None, max_length=64)
    video_job_id: str | None = Field(default=None, max_length=64)
    voice_url: str | None = Field(default=None, max_length=300)
    status: str | None = Field(default=None, max_length=20)


# ---------------------------------------------------------------------------
# 序列化
# ---------------------------------------------------------------------------
def _project_dict(p: ManjuProject) -> dict:
    return {
        "id": p.id,
        "title": p.title,
        "premise": p.premise,
        "style": p.style,
        "ckpt_name": p.ckpt_name,
        "created_at": p.created_at.isoformat(),
        "updated_at": p.updated_at.isoformat(),
    }


def _asset_dict(a: ManjuAsset) -> dict:
    return {
        "id": a.id,
        "kind": a.kind,
        "name": a.name,
        "description": a.description,
        "ref_image": a.ref_image,
        "ref_audio": a.ref_audio,
    }


def _shot_dict(s: ManjuShot) -> dict:
    try:
        chars = json.loads(s.characters) if s.characters else []
    except (ValueError, TypeError):
        chars = []
    return {
        "id": s.id,
        "idx": s.idx,
        "scene": s.scene,
        "prompt": s.prompt,
        "motion": s.motion,
        "characters": chars,
        "camera": s.camera,
        "dialogue": s.dialogue,
        "duration_sec": s.duration_sec,
        "image_job_id": s.image_job_id,
        "video_job_id": s.video_job_id,
        "voice_url": s.voice_url,
        "status": s.status,
    }


# ---------------------------------------------------------------------------
# 鉴权辅助:取本人项目/资产/镜头,否则 404
# ---------------------------------------------------------------------------
def _owned_project(pid: str, user: User, session: Session) -> ManjuProject:
    p = session.get(ManjuProject, pid)
    if not p or p.user_id != user.id:
        raise HTTPException(status_code=404, detail="项目不存在")
    return p


def _owned_asset(aid: str, user: User, session: Session) -> ManjuAsset:
    a = session.get(ManjuAsset, aid)
    if not a:
        raise HTTPException(status_code=404, detail="资产不存在")
    _owned_project(a.project_id, user, session)  # 经项目校验归属
    return a


def _owned_shot(sid: str, user: User, session: Session) -> ManjuShot:
    s = session.get(ManjuShot, sid)
    if not s:
        raise HTTPException(status_code=404, detail="镜头不存在")
    _owned_project(s.project_id, user, session)
    return s


# ---------------------------------------------------------------------------
# 项目
# ---------------------------------------------------------------------------
@router.post("/manju/projects")
def create_project(
    body: ProjectIn,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    p = ManjuProject(
        tenant_id=user.tenant_id,
        user_id=user.id,
        title=body.title,
        premise=body.premise,
        style=body.style,
        ckpt_name=body.ckpt_name,
    )
    session.add(p)
    session.commit()
    session.refresh(p)
    return _project_dict(p)


@router.get("/manju/projects")
def list_projects(
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> list[dict]:
    rows = session.exec(
        select(ManjuProject)
        .where(ManjuProject.user_id == user.id)
        .order_by(ManjuProject.updated_at.desc())
    ).all()
    return [_project_dict(p) for p in rows]


@router.get("/manju/projects/{pid}")
def get_project(
    pid: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    p = _owned_project(pid, user, session)
    assets = session.exec(select(ManjuAsset).where(ManjuAsset.project_id == pid)).all()
    shots = session.exec(
        select(ManjuShot).where(ManjuShot.project_id == pid).order_by(ManjuShot.idx)
    ).all()
    return {
        **_project_dict(p),
        "assets": [_asset_dict(a) for a in assets],
        "shots": [_shot_dict(s) for s in shots],
    }


@router.patch("/manju/projects/{pid}")
def update_project(
    pid: str,
    body: ProjectPatch,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    p = _owned_project(pid, user, session)
    for field in ("title", "premise", "style", "ckpt_name"):
        val = getattr(body, field)
        if val is not None:
            setattr(p, field, val)
    p.updated_at = _now()
    session.add(p)
    session.commit()
    session.refresh(p)
    return _project_dict(p)


@router.delete("/manju/projects/{pid}")
def delete_project(
    pid: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    _owned_project(pid, user, session)
    session.exec(delete(ManjuShot).where(ManjuShot.project_id == pid))
    session.exec(delete(ManjuAsset).where(ManjuAsset.project_id == pid))
    session.exec(delete(ManjuProject).where(ManjuProject.id == pid))
    session.commit()
    return {"ok": True, "id": pid}


# ---------------------------------------------------------------------------
# 资产(可复用角色/场景/道具/风格)
# ---------------------------------------------------------------------------
@router.post("/manju/projects/{pid}/assets")
def add_asset(
    pid: str,
    body: AssetIn,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    _owned_project(pid, user, session)
    kind = body.kind if body.kind in _ASSET_KINDS else "character"
    a = ManjuAsset(
        project_id=pid,
        tenant_id=user.tenant_id,
        kind=kind,
        name=body.name,
        description=body.description,
        ref_image=body.ref_image,
        ref_audio=body.ref_audio,
    )
    session.add(a)
    session.commit()
    session.refresh(a)
    return _asset_dict(a)


@router.put("/manju/projects/{pid}/assets")
def save_assets(
    pid: str,
    body: AssetsBulkIn,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    """整体保存/替换项目资产(把角色登记等可复用资产落库)。

    镜头按资产 name 引用(非 id),故按名整体替换不破坏引用关系。
    """
    _owned_project(pid, user, session)
    session.exec(delete(ManjuAsset).where(ManjuAsset.project_id == pid))
    for a in body.assets:
        kind = a.kind if a.kind in _ASSET_KINDS else "character"
        session.add(
            ManjuAsset(
                project_id=pid,
                tenant_id=user.tenant_id,
                kind=kind,
                name=a.name,
                description=a.description,
                ref_image=a.ref_image,
                ref_audio=a.ref_audio,
            )
        )
    session.commit()
    rows = session.exec(select(ManjuAsset).where(ManjuAsset.project_id == pid)).all()
    return {"assets": [_asset_dict(a) for a in rows]}


@router.patch("/manju/assets/{aid}")
def update_asset(
    aid: str,
    body: AssetPatch,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    a = _owned_asset(aid, user, session)
    for field in ("name", "description", "ref_image", "ref_audio"):
        val = getattr(body, field)
        if val is not None:
            setattr(a, field, val)
    session.add(a)
    session.commit()
    session.refresh(a)
    return _asset_dict(a)


@router.delete("/manju/assets/{aid}")
def delete_asset(
    aid: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    a = _owned_asset(aid, user, session)
    session.delete(a)
    session.commit()
    return {"ok": True, "id": aid}


# ---------------------------------------------------------------------------
# 镜头(分镜)
# ---------------------------------------------------------------------------
@router.put("/manju/projects/{pid}/shots")
def save_shots(
    pid: str,
    body: ShotsBulkIn,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    """整体保存/替换项目分镜(把生成的 storyboard 落库,按 idx 排序)。"""
    _owned_project(pid, user, session)
    session.exec(delete(ManjuShot).where(ManjuShot.project_id == pid))
    for i, sh in enumerate(body.shots):
        session.add(
            ManjuShot(
                project_id=pid,
                tenant_id=user.tenant_id,
                idx=i,
                scene=sh.scene,
                prompt=sh.prompt,
                motion=sh.motion,
                characters=json.dumps(sh.characters, ensure_ascii=False),
                camera=sh.camera,
                dialogue=sh.dialogue,
                duration_sec=sh.duration_sec,
            )
        )
    session.commit()
    rows = session.exec(
        select(ManjuShot).where(ManjuShot.project_id == pid).order_by(ManjuShot.idx)
    ).all()
    return {"shots": [_shot_dict(s) for s in rows]}


@router.patch("/manju/shots/{sid}")
def update_shot(
    sid: str,
    body: ShotPatch,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    """改单镜(编辑提示词/运镜,或回写关键帧/视频作业 id 与状态,实现可追踪)。"""
    s = _owned_shot(sid, user, session)
    for field in ("scene", "prompt", "motion", "camera", "dialogue", "duration_sec", "image_job_id", "video_job_id", "voice_url", "status"):
        val = getattr(body, field)
        if val is not None:
            setattr(s, field, val)
    if body.characters is not None:
        s.characters = json.dumps(body.characters, ensure_ascii=False)
    session.add(s)
    session.commit()
    session.refresh(s)
    return _shot_dict(s)
