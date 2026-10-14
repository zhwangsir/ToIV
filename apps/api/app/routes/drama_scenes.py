"""scene_asset 场景一致性 v0(FU1,dramaclaw 设计采纳)——项目级场景实体与锚点冻结。

设计来源:dramaclaw(Elastic-2.0,本地自用可并码;此处为设计采纳,未复制其代码):
  · 场景派生变体:场景存基础行,派生行只存 variant_prompt 增量与 time_of_day;
  · prompt 组装器:[环境基础]+[变体增量]+[时段板];
  · 背景锚点冻结:master/reverse 参考图任选其一快照冻结(frozen_anchor),
    绑定到分镜后跨镜生成共用同一背景,是一致性的主机制(无 LoRA 依赖);
  · 机位预设 CameraPreset{name,position,target,fov}(衔接 T-W world_camera)。

零 schema 变更纪律:DramaScene 是新表(create_all 自动建);分镜绑定写进既有
DramaShot.scene_layout JSON 的 scene_ref 键,不加列(P-18b/生产 schema 须拍板)。
"""
from __future__ import annotations

import json

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlmodel import Session, select

from app.db import get_session
from app.deps import get_current_user
from app.models import DramaProject, DramaScene, DramaShot, User
from app.routes.drama_studio import _append_process, _owned_project, _owned_shot

router = APIRouter()

#: 时段板白名单(dramaclaw time_of_day 语义,拼进 prompt 的固定短语)
_TIME_OF_DAY_PLATES = {
    "morning": "soft morning light",
    "noon": "harsh midday sunlight",
    "afternoon": "warm afternoon glow",
    "dusk": "golden dusk light, long shadows",
    "night": "night scene, artificial lighting",
    "late_night": "late night, dim practical lights",
    "dawn": "pale dawn light, mist",
}
#: 背景锚点枚举(master=正向参考/reverse=反向参考/selected=自选图)
_ANCHOR_KINDS = ("master", "reverse", "selected")


def _scene_dict(s: DramaScene) -> dict:
    return {
        "id": s.id,
        "project_id": s.project_id,
        "name": s.name,
        "base_scene_id": s.base_scene_id,
        "is_variant": bool(s.base_scene_id),
        "variant_prompt": s.variant_prompt,
        "time_of_day": s.time_of_day,
        "environment_prompt": s.environment_prompt,
        "master_ref": s.master_ref,
        "reverse_ref": s.reverse_ref,
        "frozen_anchor": json.loads(s.frozen_anchor) if s.frozen_anchor else None,
        "camera_presets": json.loads(s.camera_presets) if s.camera_presets else [],
        "created_at": s.created_at.isoformat() if s.created_at else "",
    }


def compose_scene_prompt(s: DramaScene, session: Session | None = None) -> str:
    """dramaclaw 组装器:[环境基础]+[变体增量]+[时段板]。

    派生场景环境继承基础行(传 session 时向上解析);变体自身增量+时段必拼。
    """
    env = s.environment_prompt
    if s.base_scene_id and session is not None:
        base = session.get(DramaScene, s.base_scene_id)
        if base:
            env = base.environment_prompt
    plate = _TIME_OF_DAY_PLATES.get(s.time_of_day, "")
    return ", ".join(p for p in (env, s.variant_prompt, plate) if p)


def _owned_scene(sid: str, user: User, session: Session) -> DramaScene:
    s = session.get(DramaScene, sid)
    if not s:
        raise HTTPException(status_code=404, detail="场景不存在")
    _owned_project(s.project_id, user, session)
    return s


class SceneCreate(BaseModel):
    name: str = Field(max_length=120)
    environment_prompt: str = Field(default="", max_length=2000)
    time_of_day: str = Field(default="", max_length=24)
    master_ref: str = Field(default="", max_length=600)
    reverse_ref: str = Field(default="", max_length=600)
    camera_presets: list[dict] | None = None


class SceneVariantCreate(BaseModel):
    variant_prompt: str = Field(max_length=2000)
    time_of_day: str = Field(default="", max_length=24)
    name: str = Field(default="", max_length=120)


class ScenePatch(BaseModel):
    name: str | None = Field(default=None, max_length=120)
    environment_prompt: str | None = Field(default=None, max_length=2000)
    variant_prompt: str | None = Field(default=None, max_length=2000)
    time_of_day: str | None = Field(default=None, max_length=24)
    master_ref: str | None = Field(default=None, max_length=600)
    reverse_ref: str | None = Field(default=None, max_length=600)
    camera_presets: list[dict] | None = None


class AnchorFreezeRequest(BaseModel):
    anchor_id: str  # master | reverse | selected
    image_url: str = Field(default="", max_length=600)  # anchor_id=selected 时必填


class SceneAttachRequest(BaseModel):
    shot_id: str
    use_frozen: bool = True  # False=只绑场景不冻锚点


@router.get("/drama/projects/{pid}/scenes")
def list_scenes(
    pid: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    """场景清单:基础场景带 variants 数组,派生场景带 composed_prompt。"""
    _owned_project(pid, user, session)
    rows = session.exec(
        select(DramaScene).where(DramaScene.project_id == pid).order_by(DramaScene.created_at)
    ).all()
    bases: list[dict] = []
    by_base: dict[str, list[dict]] = {}
    for s in rows:
        d = _scene_dict(s)
        d["composed_prompt"] = compose_scene_prompt(s, session)
        if s.base_scene_id:
            by_base.setdefault(s.base_scene_id, []).append(d)
        else:
            bases.append(d)
    for b in bases:
        b["variants"] = by_base.pop(b["id"], [])
    # 孤儿变体(基础场景被删)也透出,防静默丢数据
    orphans = [v for vs in by_base.values() for v in vs]
    return {"scenes": bases, "orphans": orphans}


@router.post("/drama/projects/{pid}/scenes")
def create_scene(
    pid: str,
    body: SceneCreate,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    """建基础场景(base_scene_id 空)。"""
    p = _owned_project(pid, user, session)
    if body.time_of_day and body.time_of_day not in _TIME_OF_DAY_PLATES:
        raise HTTPException(status_code=422, detail=f"time_of_day 仅支持 {'/'.join(_TIME_OF_DAY_PLATES)}")
    s = DramaScene(
        project_id=pid,
        name=body.name,
        environment_prompt=body.environment_prompt,
        time_of_day=body.time_of_day,
        master_ref=body.master_ref,
        reverse_ref=body.reverse_ref,
        camera_presets=json.dumps(body.camera_presets, ensure_ascii=False) if body.camera_presets else "[]",
    )
    session.add(s)
    _append_process(p, "scene-asset", f"新建场景「{body.name}」")
    session.add(p)
    session.commit()
    session.refresh(s)
    d = _scene_dict(s)
    d["composed_prompt"] = compose_scene_prompt(s, session)
    return {"scene": d}


@router.post("/drama/scenes/{sid}/variants")
def create_variant(
    sid: str,
    body: SceneVariantCreate,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    """派生变体:只存 variant_prompt 增量+时段,环境继承基础场景。"""
    base = _owned_scene(sid, user, session)
    if base.base_scene_id:
        raise HTTPException(status_code=422, detail="变体不能再派生变体(仅基础场景可派生)")
    if body.time_of_day and body.time_of_day not in _TIME_OF_DAY_PLATES:
        raise HTTPException(status_code=422, detail=f"time_of_day 仅支持 {'/'.join(_TIME_OF_DAY_PLATES)}")
    s = DramaScene(
        project_id=base.project_id,
        name=body.name or f"{base.name}·变体",
        base_scene_id=base.id,
        variant_prompt=body.variant_prompt,
        time_of_day=body.time_of_day,
        master_ref=base.master_ref,
        reverse_ref=base.reverse_ref,
    )
    session.add(s)
    session.commit()
    session.refresh(s)
    d = _scene_dict(s)
    d["composed_prompt"] = compose_scene_prompt(s, session)
    return {"scene": d}


@router.patch("/drama/scenes/{sid}")
def patch_scene(
    sid: str,
    body: ScenePatch,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    s = _owned_scene(sid, user, session)
    for k, v in body.model_dump(exclude_none=True).items():
        if k == "camera_presets":
            setattr(s, k, json.dumps(v, ensure_ascii=False))
        else:
            setattr(s, k, v)
    session.add(s)
    session.commit()
    session.refresh(s)
    d = _scene_dict(s)
    d["composed_prompt"] = compose_scene_prompt(s, session)
    return {"scene": d}


@router.delete("/drama/scenes/{sid}")
def delete_scene(
    sid: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    """删除场景(派生变体级联删;已绑定分镜的 scene_ref 键就地清空,不删分镜)。"""
    s = _owned_scene(sid, user, session)
    variant_ids = [
        v.id
        for v in session.exec(select(DramaScene).where(DramaScene.base_scene_id == s.id)).all()
    ]
    doomed_ids = [s.id, *variant_ids]
    doomed_set = set(doomed_ids)
    # 解绑引用该场景(或其变体)的分镜
    shots = session.exec(select(DramaShot).where(DramaShot.project_id == s.project_id)).all()
    detached = 0
    for shot in shots:
        if not shot.scene_layout:
            continue
        try:
            layout = json.loads(shot.scene_layout)
        except (ValueError, TypeError):
            continue
        ref = layout.get("scene_ref") if isinstance(layout, dict) else None
        if isinstance(ref, dict) and ref.get("scene_id") in doomed_set:
            layout.pop("scene_ref")
            shot.scene_layout = json.dumps(layout, ensure_ascii=False)
            session.add(shot)
            detached += 1
    for did in doomed_ids:
        row = session.get(DramaScene, did)
        if row:
            session.delete(row)
    session.commit()
    return {"deleted": len(doomed_ids), "variants": len(variant_ids), "shots_detached": detached}


@router.post("/drama/scenes/{sid}/freeze-anchor")
def freeze_anchor(
    sid: str,
    body: AnchorFreezeRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    """冻结背景锚点:master/reverse 用场景已有参考图,selected 用传入图。

    冻结后该场景绑定分镜的背景统一,是一致性主机制(dramaclaw render_anchor 语义)。
    """
    import time as _time

    s = _owned_scene(sid, user, session)
    if body.anchor_id not in _ANCHOR_KINDS:
        raise HTTPException(status_code=422, detail=f"anchor_id 仅支持 {'/'.join(_ANCHOR_KINDS)}")
    image = body.image_url
    if body.anchor_id == "master":
        image = s.master_ref
    elif body.anchor_id == "reverse":
        image = s.reverse_ref
    if not image:
        raise HTTPException(status_code=422, detail="锚点图缺失:master/reverse 需先在场景上设参考图,selected 需传 image_url")
    s.frozen_anchor = json.dumps(
        {"anchor_id": body.anchor_id, "image_url": image, "frozen_at": int(_time.time())},
        ensure_ascii=False,
    )
    session.add(s)
    session.commit()
    return {"scene": _scene_dict(s)}


@router.post("/drama/scenes/{sid}/attach")
def attach_scene(
    sid: str,
    body: SceneAttachRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    """把场景(可含冻结锚点)绑到分镜:写进 scene_layout JSON 的 scene_ref 键。

    compose=true 语义:若分镜 prompt 未包含场景环境词,把组装提示词前置注入
    (与角色视觉 token 同型);已包含则不重复注入,幂等。
    """
    from app.jsonutil import parse_json_obj

    s = _owned_scene(sid, user, session)
    shot = _owned_shot(body.shot_id, user, session)
    if shot.project_id != s.project_id:
        raise HTTPException(status_code=422, detail="分镜与场景不在同一项目")

    layout = parse_json_obj(shot.scene_layout) or {}
    if not isinstance(layout, dict):
        layout = {}
    ref: dict = {"scene_id": s.id, "scene_name": s.name}
    anchor_image = ""
    if body.use_frozen:
        if not s.frozen_anchor:
            raise HTTPException(status_code=422, detail="场景尚未冻结锚点(先 freeze-anchor 或 use_frozen=false)")
        frozen = json.loads(s.frozen_anchor)
        ref["anchor_id"] = frozen["anchor_id"]
        ref["anchor_image"] = frozen["image_url"]
        anchor_image = frozen["image_url"]
    layout["scene_ref"] = ref
    shot.scene_layout = json.dumps(layout, ensure_ascii=False)

    composed = compose_scene_prompt(s, session)
    injected = False
    if composed and composed.lower() not in (shot.prompt or "").lower():
        shot.prompt = f"{composed}, {shot.prompt}" if shot.prompt else composed
        injected = True
    session.add(shot)
    session.commit()
    session.refresh(shot)
    return {
        "shot_id": shot.id,
        "scene_ref": ref,
        "anchor_image": anchor_image,
        "composed_prompt": composed,
        "prompt_injected": injected,
        "prompt": shot.prompt,
    }


@router.get("/drama/shots/{shot_id}/scene-ref")
def get_shot_scene_ref(
    shot_id: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    """读分镜的 scene_ref(含场景名/锚点),供前端时间线/工作区展示。"""
    shot = _owned_shot(shot_id, user, session)
    layout = None
    if shot.scene_layout:
        from app.jsonutil import parse_json_obj

        layout = parse_json_obj(shot.scene_layout)
    ref = layout.get("scene_ref") if isinstance(layout, dict) else None
    scene = None
    if isinstance(ref, dict) and ref.get("scene_id"):
        row = session.get(DramaScene, ref["scene_id"])
        if row:
            scene = {**_scene_dict(row), "composed_prompt": compose_scene_prompt(row, session)}
    return {"shot_id": shot.id, "scene_ref": ref, "scene": scene}
