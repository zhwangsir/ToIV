"""Studio 创作工作室路由(薄层):项目/角色/分镜 CRUD + 剧本拆解 + 渲染编排。

业务编排入 app.services.studio;配音/对口型/合成端点见 M3 追加。
"""
from __future__ import annotations

import json
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from sqlmodel import Session, select

from app.db import get_session
from app.deps import get_current_user
from app.models import StudioCharacter, StudioProject, StudioShot, User
from app.services.studio import assemble as assemble_svc
from app.services.studio import lipsync as lipsync_svc
from app.services.studio import orchestrator, storyboard
from app.services.studio import voice as voice_svc
from app.services.studio.renderers.base import RenderError
from app.services.studio.schemas import (
    CharacterCreate,
    CharacterPatch,
    ProjectCreate,
    ProjectPatch,
    ScriptParseRequest,
    ShotsSaveRequest,
)

router = APIRouter()


# ── 工具 ──────────────────────────────────────────────────────────────────


def _get_project(session: Session, pid: str, user: User) -> StudioProject:
    p = session.get(StudioProject, pid)
    if not p or p.tenant_id != user.tenant_id:
        raise HTTPException(status_code=404, detail="项目不存在")
    return p


def _project_detail(session: Session, p: StudioProject) -> dict:
    chars = session.exec(
        select(StudioCharacter).where(StudioCharacter.project_id == p.id)
    ).all()
    shots = session.exec(
        select(StudioShot).where(StudioShot.project_id == p.id).order_by(StudioShot.idx)
    ).all()
    return {
        **p.model_dump(),
        "characters": [
            {**c.model_dump(), "reference_images": json.loads(c.reference_images or "[]")}
            for c in chars
        ],
        "shots": [
            {**s.model_dump(), "characters": json.loads(s.characters or "[]")}
            for s in shots
        ],
    }


# ── 项目 CRUD ─────────────────────────────────────────────────────────────


@router.post("/studio/projects")
def create_project(
    body: ProjectCreate,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    p = StudioProject(
        tenant_id=user.tenant_id,
        user_id=user.id,
        title=body.title,
        premise=body.premise,
        style=body.style,
        ckpt_name=body.ckpt_name,
        render_mode_default=body.render_mode_default,
        width=body.width,
        height=body.height,
        fps=body.fps,
    )
    session.add(p)
    session.commit()
    session.refresh(p)
    return p


@router.get("/studio/projects")
def list_projects(
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    rows = session.exec(
        select(StudioProject)
        .where(StudioProject.tenant_id == user.tenant_id)
        .order_by(StudioProject.updated_at.desc())
    ).all()
    return rows


@router.get("/studio/projects/{pid}")
def get_project(
    pid: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    return _project_detail(session, _get_project(session, pid, user))


@router.patch("/studio/projects/{pid}")
def patch_project(
    pid: str,
    body: ProjectPatch,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    p = _get_project(session, pid, user)
    for k, v in body.model_dump(exclude_none=True).items():
        setattr(p, k, v)
    session.add(p)
    session.commit()
    session.refresh(p)
    return p


@router.delete("/studio/projects/{pid}")
def delete_project(
    pid: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    p = _get_project(session, pid, user)
    for model in (StudioShot, StudioCharacter):
        for row in session.exec(select(model).where(model.project_id == pid)).all():
            session.delete(row)
    session.delete(p)
    session.commit()
    return {"ok": True}


# ── 角色 CRUD ─────────────────────────────────────────────────────────────


@router.post("/studio/projects/{pid}/characters")
def create_character(
    pid: str,
    body: CharacterCreate,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    _get_project(session, pid, user)
    c = StudioCharacter(
        project_id=pid,
        name=body.name,
        description=body.description,
        visual_prompt=body.visual_prompt,
    )
    session.add(c)
    session.commit()
    session.refresh(c)
    return c


@router.patch("/studio/characters/{cid}")
def patch_character(
    cid: str,
    body: CharacterPatch,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    c = session.get(StudioCharacter, cid)
    if not c:
        raise HTTPException(status_code=404, detail="角色不存在")
    _get_project(session, c.project_id, user)  # 租户校验
    for k, v in body.model_dump(exclude_none=True).items():
        setattr(c, k, v)
    session.add(c)
    session.commit()
    session.refresh(c)
    return c


@router.delete("/studio/characters/{cid}")
def delete_character(
    cid: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    c = session.get(StudioCharacter, cid)
    if not c:
        raise HTTPException(status_code=404, detail="角色不存在")
    _get_project(session, c.project_id, user)
    session.delete(c)
    session.commit()
    return {"ok": True}


# ── 分镜批量保存 ───────────────────────────────────────────────────────────


@router.put("/studio/projects/{pid}/shots")
def save_shots(
    pid: str,
    body: ShotsSaveRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    _get_project(session, pid, user)
    out: list[StudioShot] = []
    for i, item in enumerate(body.shots):
        if item.id:
            shot = session.get(StudioShot, item.id)
            if not shot or shot.project_id != pid:
                raise HTTPException(status_code=404, detail=f"分镜不存在:{item.id}")
        else:
            shot = StudioShot(project_id=pid)
        shot.idx = i
        shot.scene = item.scene
        shot.prompt = item.prompt
        if item.negative is not None:
            shot.negative = item.negative
        shot.camera = item.camera
        shot.dialogue = item.dialogue
        shot.speaker = item.speaker
        shot.duration_sec = item.duration_sec
        shot.characters = json.dumps(item.characters, ensure_ascii=False)
        # 生成方式变化 → 旧媒体失效,回到草稿
        if shot.render_mode != item.render_mode:
            shot.render_mode = item.render_mode
            shot.image_url = shot.video_url = shot.final_clip_url = ""
            shot.status = "draft"
        session.add(shot)
        out.append(shot)
    # 全量替换语义:请求未包含的旧分镜删除(前端拆解剧本/删镜依赖此契约)
    keep = {s.id for s in out}
    for s in session.exec(select(StudioShot).where(StudioShot.project_id == pid)).all():
        if s.id not in keep:
            session.delete(s)
    # 统一提交:循环内逐个 commit 会 expire 已产出的 shot 对象,导致 model_dump 丢字段
    session.commit()
    for shot in out:
        session.refresh(shot)
    return {
        "shots": [
            {**s.model_dump(), "characters": json.loads(s.characters or "[]")}
            for s in out
        ]
    }


# ── 剧本拆解 ───────────────────────────────────────────────────────────────


@router.post("/studio/projects/{pid}/script/parse")
async def parse_script_endpoint(
    pid: str,
    body: ScriptParseRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """LLM 拆解 premise → 角色+分镜草稿(不落库,前端确认后走 CRUD 保存)。"""
    _get_project(session, pid, user)
    try:
        characters, shots = await storyboard.parse_script(
            body.premise, num_shots=body.num_shots, style=body.style
        )
    except storyboard.StoryboardError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
    return {
        "characters": [c.model_dump() for c in characters],
        "shots": [s.model_dump() for s in shots],
    }


# ── 渲染编排 ───────────────────────────────────────────────────────────────


def _get_shot(session: Session, sid: str, user: User) -> StudioShot:
    shot = session.get(StudioShot, sid)
    if not shot:
        raise HTTPException(status_code=404, detail="分镜不存在")
    _get_project(session, shot.project_id, user)  # 租户校验
    return shot


def _shot_out(s: StudioShot) -> dict:
    return {**s.model_dump(), "characters": json.loads(s.characters or "[]")}


@router.post("/studio/shots/{sid}/render")
async def render_one(
    sid: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """渲染单镜(同步等待)。render_mode 决定走视频链还是图像运镜链。"""
    shot = _get_shot(session, sid, user)
    try:
        return _shot_out(await orchestrator.render_shot(session, shot))
    except RenderError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e


@router.post("/studio/projects/{pid}/render")
async def render_batch(
    pid: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """批量渲染:跳过已 rendered/voiced/lipsynced/done 的分镜;单镜失败不阻塞其余。"""
    _get_project(session, pid, user)
    shots = session.exec(
        select(StudioShot).where(StudioShot.project_id == pid).order_by(StudioShot.idx)
    ).all()
    done, failed = 0, 0
    for shot in shots:
        if shot.status in orchestrator.terminal_states():
            continue
        try:
            await orchestrator.render_shot(session, shot)
            done += 1
        except RenderError:
            failed += 1
    return {"rendered": done, "failed": failed}


@router.get("/studio/projects/{pid}/status")
def project_status(
    pid: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """聚合状态:各阶段计数,供前端轮询。"""
    _get_project(session, pid, user)
    shots = session.exec(
        select(StudioShot).where(StudioShot.project_id == pid)
    ).all()
    counts: dict[str, int] = {}
    for s in shots:
        counts[s.status] = counts.get(s.status, 0) + 1
    return {"total": len(shots), "by_status": counts}


# ── 配音 / 对口型(M3)─────────────────────────────────────────────────────


@router.post("/studio/shots/{sid}/voice")
async def voice_one(
    sid: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """单镜配音:按说话人命中角色卡(带参考音则克隆音色);状态 rendered → voiced。"""
    shot = _get_shot(session, sid, user)
    if not shot.dialogue.strip():
        raise HTTPException(status_code=422, detail="该镜无台词")
    character = None
    if shot.speaker:
        character = session.exec(
            select(StudioCharacter).where(
                StudioCharacter.project_id == shot.project_id,
                StudioCharacter.name == shot.speaker,
            )
        ).first()
    try:
        await voice_svc.synth_for_shot(session, shot, character)
    except voice_svc.VoiceError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
    return _shot_out(shot)


@router.post("/studio/shots/{sid}/lipsync")
async def lipsync_one(
    sid: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """对口型:仅视频镜(已有视频+配音);LatentSync 产物覆盖 final_clip_url。"""
    shot = _get_shot(session, sid, user)
    if shot.render_mode != "video":
        raise HTTPException(status_code=422, detail="仅视频镜支持对口型")
    if not shot.video_url or not shot.voice_url:
        raise HTTPException(status_code=422, detail="需要先出视频并配音")
    try:
        await lipsync_svc.lipsync_for_shot(session, shot)
    except lipsync_svc.LipsyncError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
    return _shot_out(shot)


# ── 合成(M3)───────────────────────────────────────────────────────────────


@router.post("/studio/projects/{pid}/assemble")
async def assemble_project_endpoint(
    pid: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """拼接全部就绪分镜 → 项目成片;任一镜缺 final_clip_url → 422。"""
    project = _get_project(session, pid, user)
    shots = session.exec(
        select(StudioShot).where(StudioShot.project_id == pid).order_by(StudioShot.idx)
    ).all()
    try:
        await assemble_svc.assemble_project(session, project, shots)
    except assemble_svc.AssembleError as e:
        msg = str(e)
        code = 422 if "未就绪" in msg or "无分镜" in msg else 502
        raise HTTPException(status_code=code, detail=msg) from e
    return _project_detail(session, project)


# ── 产出文件服务 ───────────────────────────────────────────────────────────

_MEDIA_TYPES = {
    ".mp4": "video/mp4",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".wav": "audio/wav",
}


@router.get("/studio/files/{name}", response_model=None)
def studio_file(name: str) -> FileResponse:
    """Studio 产出静图/片段/配音文件(渲染器落盘目录,NAS 优先降级本地)。

    路径穿越防护:仅允许纯文件名(拒绝任何含路径分隔的输入)。
    """
    from app.storage import drama_output_root

    safe = Path(name).name
    if not safe or safe != name:
        raise HTTPException(status_code=400, detail="非法文件名")
    path = drama_output_root() / "studio" / safe
    if not path.is_file():
        raise HTTPException(status_code=404, detail="文件不存在")
    return FileResponse(
        path, media_type=_MEDIA_TYPES.get(path.suffix.lower(), "application/octet-stream")
    )
