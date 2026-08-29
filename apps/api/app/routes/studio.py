"""Studio 创作工作室路由(薄层):项目/角色/分镜 CRUD + 剧本拆解 + 渲染编排。

业务编排入 app.services.studio;配音/对口型/合成端点见 M3 追加。
"""
from __future__ import annotations

import json
import logging
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from sqlmodel import Session, select

from app.db import get_session
from app.deps import get_current_user
from app.models import StudioCharacter, StudioProject, StudioShot, User
from app.services.drama_pipeline import compute_studio_next_step
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
logger = logging.getLogger(__name__)


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
    from app import audit as _audit

    _audit.record(
        session, user=user, action="project.delete", target_type="studio_project",
        target_id=pid, summary=f"删除 Studio 项目:{p.title or pid[:8]}",
        detail={"title": p.title, "project_id": pid},
    )
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
    from app import audit as _audit

    _audit.record(
        session, user=user, action="character.delete", target_type="studio_character",
        target_id=cid, summary=f"删除 Studio 角色:{c.name or cid[:8]}",
        detail={"name": c.name, "project_id": c.project_id},
    )
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

# 2026-08-29 异步化(生产实证:长文本同步拆解必然撞前端 120s fetch 墙):
# POST 提交即建档 Job(kind=studio_script_parse)+ 进程内后台任务跑 LLM,
# 前端 2s 轮询 GET parse-status 拉结果;任务中心可见/可中止(取消 → error 态返回)。
_PARSE_KIND = "studio_script_parse"


async def _run_script_parse(job_id: str, pid: str, body: ScriptParseRequest) -> None:
    """后台跑 LLM 拆解,结果写 Job.result;取消/终态不回写(与 tracker canceled 语义一致)。"""
    from app.db import engine as _engine
    from app.models import Job

    def _finish(status: str, result: dict) -> None:
        with Session(_engine) as s:
            job = s.get(Job, job_id)
            # 用户中止/异常回收的终态不覆盖
            if not job or job.status in ("done", "error", "canceled"):
                return
            job.status = status
            job.result = json.dumps(result, ensure_ascii=False)
            s.add(job)
            s.commit()

    try:
        # 启动自检:已被用户中止(cancel 端点直写库)直接退出,否则标记 running
        with Session(_engine) as s:
            job0 = s.get(Job, job_id)
            if not job0 or job0.status == "canceled":
                return
            job0.status = "running"
            s.add(job0)
            s.commit()
        # 合法角色名集合注入校验上下文(与原同步路径同语义)
        with Session(_engine) as s:
            known = [
                c.name
                for c in s.exec(
                    select(StudioCharacter).where(StudioCharacter.project_id == pid)
                ).all()
            ]
        characters, shots = await storyboard.parse_script(
            body.premise,
            num_shots=body.num_shots,
            style=body.style,
            known_characters=known or None,
        )
        _finish("done", {
            "characters": [c.model_dump() for c in characters],
            "shots": [s.model_dump() for s in shots],
        })
    except storyboard.StoryboardError as e:
        _finish("error", {"error": str(e)})
    except Exception as e:  # noqa: BLE001 — 后台任务绝不静默死掉
        logger.exception("script parse job %s 意外失败", job_id)
        _finish("error", {"error": f"拆解失败:{e}"})


def reconcile_parse_jobs() -> int:
    """api 重启后收口在跑拆解作业(进程内协程随重启消失):标 error 允许重试。

    参照 drama_studio.reconcile_interrupted;tracker.reconcile_pending 按空 worker
    跳过此类作业,收口责任在本函数。返回收口数量。
    """
    from app.db import engine as _engine
    from app.models import Job

    n = 0
    with Session(_engine) as s:
        rows = s.exec(
            select(Job).where(
                Job.kind == _PARSE_KIND,
                Job.status.in_(("queued", "running")),  # type: ignore[attr-defined]
            )
        ).all()
        for job in rows:
            job.status = "error"
            job.result = json.dumps({"error": "服务重启,拆解中断,请重新提交"}, ensure_ascii=False)
            s.add(job)
            n += 1
        if n:
            s.commit()
    if n:
        logger.info("reconcile_parse_jobs: 收口 %d 个中断的拆解作业为 error", n)
    return n


@router.post("/studio/projects/{pid}/script/parse")
async def parse_script_endpoint(
    pid: str,
    body: ScriptParseRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """提交剧本拆解(异步):建档 Job + 后台跑 LLM,前端轮询 parse-status 取结果。

    返回 {job_id, status: "queued"};拆解结果不落项目库,前端确认后走 CRUD 保存。
    """
    import asyncio as _asyncio

    from app.models import Job
    from app.versioning import params_snapshot

    p = _get_project(session, pid, user)
    job = Job(
        tenant_id=user.tenant_id,
        user_id=user.id,
        prompt_id="",  # 回填 job.id(占位;非 ComfyUI 作业,tracker reconcile 按空 worker 跳过)
        worker="",
        kind=_PARSE_KIND,
        status="queued",
        prompt=body.premise[:200],
        params=params_snapshot(body, pid=pid),
    )
    session.add(job)
    session.commit()
    session.refresh(job)
    job.prompt_id = f"parse-{job.id}"
    session.add(job)
    session.commit()
    _asyncio.create_task(_run_script_parse(job.id, p.id, body))
    return {"job_id": job.id, "status": "queued"}


@router.get("/studio/projects/{pid}/script/parse/{job_id}")
def get_script_parse_status(
    pid: str,
    job_id: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """轮询拆解结果:done → {characters, shots};error → {error};进行中 → {status}。"""
    from app.models import Job

    _get_project(session, pid, user)
    job = session.get(Job, job_id)
    if not job or job.user_id != user.id or job.kind != _PARSE_KIND:
        raise HTTPException(status_code=404, detail="拆解任务不存在")
    out: dict = {"status": job.status}
    if job.status == "done":
        out.update(json.loads(job.result or "{}"))
    elif job.status == "error":
        try:
            out["error"] = json.loads(job.result or "{}").get("error") or "拆解失败"
        except (ValueError, TypeError):
            out["error"] = "拆解失败"
    elif job.status == "canceled":
        out["error"] = "已中止"
    return out


# ── 分镜 AI 扩写(Skill 化剧本优化,2026-08-18)─────────────────────────────


class ShotOptimizeRequest(BaseModel):
    """简短描述 → 结构化分镜字段(镜头/动作/人物/场景)。

    shot_id 可选:传入时以既有分镜为上下文重写(保留台词/角色骨架);
    省略时纯从 brief 扩写(前端用作「追加新分镜」)。
    skill_id 可选:Skill 市场技能(公共/本人导入),其 system_prompt 作为风格
    人格拼在分镜系统提示之前(2026-08-18 与 /api/optimize 三层叠加同构)。
    """

    brief: str = Field(min_length=1, max_length=2000)
    shot_id: str | None = None
    style_hint: str | None = Field(default=None, max_length=500)
    skill_id: str | None = Field(default=None, max_length=64)


_SHOT_OPTIMIZE_SYSTEM = """你是资深影视分镜师与 AI 视频提示词工程师。
用户给出一句简短的中文画面描述,你要把它扩写为可直接用于 AI 图像/视频生成的完整分镜。

要求:
1. scene:中文场景描述——时间、地点、光线氛围、人物位置与动作(2-4 句,具体可视)
2. camera:中文运镜与景别(如「中近景,缓慢推近」「广角俯拍,跟随横移」)
3. prompt:英文生成提示词——主体外观+服装+具体动作+表情+环境细节+光线+构图;
   若提供角色视觉 token,必须原样融入对应角色描述;运动学动词具体(piston/bounce/pan/zoom 等)
4. negative:英文负向提示词(质量类:blurry, low quality, distorted, watermark, text)
5. characters:出场角色名列表(只能从提供的角色表选;未提供角色表则返回 [])

只输出 JSON,不要任何解释:
{"scene": "...", "camera": "...", "prompt": "...", "negative": "...", "characters": ["..."]}"""


@router.post("/studio/projects/{pid}/optimize-shot")
async def optimize_shot_endpoint(
    pid: str,
    body: ShotOptimizeRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """分镜 AI 扩写:简短描述 → {scene, camera, prompt, negative, characters}(不落库,前端回填)。"""
    project = _get_project(session, pid, user)

    # 角色注册表:name + visual_prompt(英文 token)+ 中文描述,注入 LLM 保证人物一致性
    chars = session.exec(
        select(StudioCharacter).where(StudioCharacter.project_id == pid)
    ).all()
    char_lines = [
        f"- {c.name}: {c.visual_prompt or '(无视觉token)'} | {c.description[:120]}"
        for c in chars
    ] or ["(项目暂无角色,自由设计人物外观)"]

    # 既有分镜上下文:重写模式带原字段(保留台词骨架,动作/场景升维)
    ref_lines: list[str] = []
    if body.shot_id:
        shot = session.get(StudioShot, body.shot_id)
        if shot and shot.project_id == pid:
            ref_lines = [
                f"原场景:{shot.scene or '(空)'}",
                f"原提示词:{shot.prompt or '(空)'}",
                f"原台词:{shot.dialogue or '(无)'}(说话人:{shot.speaker or '无'})",
                f"原时长:{shot.duration_sec}s",
            ]

    user_payload = {
        "项目概要": project.premise[:400],
        "画风": project.style or "不限",
        "额外风格要求": body.style_hint or "无",
        "角色表": char_lines,
        "原分镜(重写模式,空为新写)": ref_lines,
        "简短描述": body.brief,
    }
    from app.harness.ctx import get_ctx

    # Skill 风格人格(与 /api/optimize 三层叠加同构):
    # style_hint(用户指定,最高优先级,已在 user_payload)→ skill.system_prompt → 分镜系统提示
    system_prompt = _SHOT_OPTIMIZE_SYSTEM
    if body.skill_id:
        from app.models import Agent
        from app.nsfw_ctx import nsfw_allowed

        skill = session.get(Agent, body.skill_id)
        if not skill or (skill.user_id and skill.user_id != user.id):
            raise HTTPException(status_code=404, detail="技能不存在")
        if skill.is_nsfw and not nsfw_allowed(user):
            raise HTTPException(status_code=403, detail="该技能需要 R18 鉴权")
        system_prompt = f"{skill.system_prompt}\n\n{_SHOT_OPTIMIZE_SYSTEM}"

    try:
        msg = await get_ctx().service("llm").chat_layered(
            [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": json.dumps(user_payload, ensure_ascii=False)},
            ],
            layer="L3",  # 分镜级质量:结构化输出走精修层(降级链 L3→L2→L1)
            max_tokens=3000,
        )
    except Exception as e:  # noqa: BLE001 —— llm.LLMError 等统一 502
        raise HTTPException(status_code=502, detail=f"LLM 不可用:{e}") from e

    raw = (msg.get("content") or "").strip()
    # 容错抽取:容忍 ```json 围栏与前后噪声(与 storyboard._extract_json 同思路,轻量内联)
    start, end = raw.find("{"), raw.rfind("}")
    obj = None
    if start >= 0 and end > start:
        try:
            obj = json.loads(raw[start : end + 1])
        except json.JSONDecodeError:
            obj = None
    if not obj or not str(obj.get("prompt") or "").strip():
        raise HTTPException(status_code=502, detail="LLM 返回不可解析,请重试")

    # 角色名约束:LLM 幻觉出的角色名过滤回库内名(近名纠错,与 parse_script 策略一致)
    known_lower = {c.name.strip().lower(): c.name for c in chars}
    picked: list[str] = []
    for name in obj.get("characters") or []:
        if not isinstance(name, str) or not name.strip():
            continue
        fixed = known_lower.get(name.strip().lower())
        if fixed and fixed not in picked:
            picked.append(fixed)

    return {
        "scene": str(obj.get("scene") or "").strip(),
        "camera": str(obj.get("camera") or "").strip(),
        "prompt": str(obj.get("prompt") or "").strip(),
        "negative": str(obj.get("negative") or "blurry, low quality, text, watermark").strip(),
        "characters": picked,
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
    request: Request = None  # FastAPI 注入;勿标 Optional 否则当 Pydantic 字段,
):
    """渲染单镜(同步等待)。render_mode 决定走视频链还是图像运镜链。"""
    shot = _get_shot(session, sid, user)
    try:
        return _shot_out(await orchestrator.render_shot(session, shot, request=request))
    except RenderError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e


@router.post("/studio/projects/{pid}/render")
async def render_batch(
    pid: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
    request: Request = None  # FastAPI 注入;勿标 Optional 否则当 Pydantic 字段,
):
    """批量渲染:跳过已 rendered/voiced/lipsynced/done 的分镜;单镜失败不阻塞其余。"""
    _get_project(session, pid, user)
    shots = session.exec(
        select(StudioShot).where(StudioShot.project_id == pid).order_by(StudioShot.idx)
    ).all()
    done, failed = 0, 0
    for shot in shots:
        if request is not None and await request.is_disconnected():
            break
        if shot.status in orchestrator.terminal_states():
            continue
        try:
            await orchestrator.render_shot(session, shot, request=request)
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
    """聚合状态:各阶段计数 + next_step(状态重算),供前端轮询与断点续跑。"""
    _get_project(session, pid, user)
    shots = session.exec(
        select(StudioShot).where(StudioShot.project_id == pid)
    ).all()
    counts: dict[str, int] = {}
    for s in shots:
        counts[s.status] = counts.get(s.status, 0) + 1
    next_step = compute_studio_next_step(shots)
    next_step["action"] = next_step["action"].replace("{pid}", pid)
    return {"total": len(shots), "by_status": counts, "next_step": next_step}


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
def studio_file(
    name: str,
    user: User = Depends(get_current_user),
) -> FileResponse:
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
