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



def _character_out(c: StudioCharacter) -> dict:
    """角色响应:reference_images 解析为 list(与 _project_detail 一致,避免泄漏 JSON 串)。"""
    return {**c.model_dump(), "reference_images": json.loads(c.reference_images or "[]")}


def _parse_scene_images(raw: str | None) -> list[str]:
    try:
        scenes = json.loads(raw or "[]")
    except (ValueError, TypeError):
        scenes = []
    if not isinstance(scenes, list):
        return []
    return [u for u in scenes if isinstance(u, str) and u.strip()]


def _project_out(p: StudioProject) -> dict:
    """项目响应:scene_images_json → scene_images list(不泄漏 JSON 串列名)。"""
    data = p.model_dump()
    data.pop("scene_images_json", None)
    data["scene_images"] = _parse_scene_images(getattr(p, "scene_images_json", None))
    return data


def _project_detail(session: Session, p: StudioProject) -> dict:
    chars = session.exec(
        select(StudioCharacter).where(StudioCharacter.project_id == p.id)
    ).all()
    shots = session.exec(
        select(StudioShot).where(StudioShot.project_id == p.id).order_by(StudioShot.idx)
    ).all()
    return {
        **_project_out(p),
        "characters": [
            {**c.model_dump(), "reference_images": json.loads(c.reference_images or "[]")}
            for c in chars
        ],
        "shots": [_shot_out(s) for s in shots],
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
    return _project_out(p)


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
    out = []
    for p in rows:
        item = _project_out(p)
        # Batch5:列表进度点(复用 compute_studio_next_step)
        item["pipeline"] = _studio_pipeline_brief(session, p.id)
        out.append(item)
    return out


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
    data = body.model_dump(exclude_none=True)
    # Batch3:scene_images list → DB JSON 字符串列
    if "scene_images" in data:
        scenes = data.pop("scene_images") or []
        if not isinstance(scenes, list):
            raise HTTPException(status_code=400, detail="scene_images 须为字符串数组")
        if len(scenes) > 4:
            raise HTTPException(status_code=400, detail="scene_images 最多 4 张")
        for u in scenes:
            if not isinstance(u, str) or not u.strip():
                raise HTTPException(status_code=400, detail="scene_images 项无效")
        data["scene_images_json"] = json.dumps(scenes, ensure_ascii=False)
    for k, v in data.items():
        setattr(p, k, v)
    session.add(p)
    session.commit()
    session.refresh(p)
    return _project_out(p)


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
    return _character_out(c)


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
    data = body.model_dump(exclude_none=True)
    # Batch2:reference_images list → DB JSON 字符串列
    if "reference_images" in data:
        refs = data["reference_images"] or []
        if not isinstance(refs, list):
            raise HTTPException(status_code=400, detail="reference_images 须为字符串数组")
        if len(refs) > 8:
            raise HTTPException(status_code=400, detail="reference_images 最多 8 张")
        for u in refs:
            if not isinstance(u, str) or len(u) > 1024:
                raise HTTPException(status_code=400, detail="reference_images 项无效")
        data["reference_images"] = json.dumps(refs, ensure_ascii=False)
    for k, v in data.items():
        setattr(c, k, v)
    session.add(c)
    session.commit()
    session.refresh(c)
    return _character_out(c)


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
    """分镜响应:characters/candidates/ref_images 解析为 list。"""
    try:
        candidates = json.loads(s.candidates_json or "[]")
    except (ValueError, TypeError):
        candidates = []
    try:
        ref_images = json.loads(s.ref_images_json or "[]")
    except (ValueError, TypeError):
        ref_images = []
    data = s.model_dump()
    data.pop("candidates_json", None)
    data.pop("ref_images_json", None)
    data["characters"] = json.loads(s.characters or "[]")
    data["candidates"] = candidates if isinstance(candidates, list) else []
    data["ref_images"] = ref_images if isinstance(ref_images, list) else []
    data.setdefault("video_model", getattr(s, "video_model", None) or "h3")
    return data


class RenderShotBody(BaseModel):
    """Batch2 视频步:引擎 / 多候选 / 多参考(均可选;缺省兼容旧客户端)。"""

    video_model: str = Field(default="h3", max_length=16)
    num_candidates: int = Field(default=2, ge=1, le=4)
    ref_images: list[str] | None = Field(default=None, max_length=9)
    scene_images: list[str] | None = Field(default=None, max_length=4)


@router.post("/studio/shots/{sid}/render")
async def render_one(
    sid: str,
    body: RenderShotBody | None = None,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
    request: Request = None  # FastAPI 注入;勿标 Optional 否则当 Pydantic 字段,
):
    """渲染单镜(同步等待)。render_mode 决定走视频链还是图像运镜链。

    body 缺省(旧客户端/批量):video_model=h3、num_candidates=1。
    视频步 UI 显式传 num_candidates(默认 2)与 ref_images。
    """
    shot = _get_shot(session, sid, user)
    # 无 body → 单候选(兼容 renderStudioShot 旧调用与批量路径语义)
    vm = (body.video_model if body else None) or "h3"
    n = body.num_candidates if body is not None else 1
    refs = body.ref_images if body is not None else None
    scenes = body.scene_images if body is not None else None
    try:
        return _shot_out(
            await orchestrator.render_shot(
                session,
                shot,
                request=request,
                video_model=vm,
                num_candidates=n,
                ref_images=refs,
                scene_images=scenes,
            )
        )
    except RenderError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e


@router.post("/studio/shots/{sid}/candidates/{cid}/pick")
def pick_shot_candidate(
    sid: str,
    cid: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """选用某个候选视频为当前分镜成片。"""
    shot = _get_shot(session, sid, user)
    try:
        return _shot_out(orchestrator.pick_candidate(session, shot, cid))
    except RenderError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


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
    """单镜配音:按说话人命中角色卡(带参考音则克隆音色);状态 rendered → voiced。

    Batch4 边界:
      · 空台词 → 422
      · 有说话人但角色卡不存在 / 未配置音色 → 422(不静默降级默认音糊弄)
      · 无说话人(旁白) → 允许默认音色
      · TTS 不可达 → 502(VoiceError)
    """
    shot = _get_shot(session, sid, user)
    if not shot.dialogue.strip():
        raise HTTPException(status_code=422, detail="该镜无台词")
    character = None
    speaker = (shot.speaker or "").strip()
    if speaker:
        character = session.exec(
            select(StudioCharacter).where(
                StudioCharacter.project_id == shot.project_id,
                StudioCharacter.name == speaker,
            )
        ).first()
        if character is None:
            raise HTTPException(
                status_code=422, detail=f"未找到说话人「{speaker}」的角色卡"
            )
        if not (character.voice_ref_url or "").strip():
            raise HTTPException(
                status_code=422, detail=f"角色「{speaker}」未配置音色"
            )
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



# ── Batch5:样片种子 + 步骤整组重跑 ─────────────────────────────────────────

SAMPLE_RAIN_NIGHT_TITLE = "雨夜便利店·林夏"
SAMPLE_RAIN_NIGHT_MARKER = "[sample:rain-night]"
SAMPLE_RAIN_NIGHT_PREMISE = (
    f"{SAMPLE_RAIN_NIGHT_MARKER} 雨夜便利店短剧样片。"
    "林夏进店→冷柜→结账→出门四拍；竖屏 9:16 768p。"
)

# 四拍与 H3 长视频实验剧本对齐(对白含验收句)
_SAMPLE_SHOTS = [
    {
        "scene": "雨夜便利店门口·进店",
        "prompt": (
            "vertical 9:16 short drama, rainy night convenience store, young woman Lin Xia "
            "pushes glass door, shakes water off umbrella, looks at clerk"
        ),
        "dialogue": "还营业吧？",
        "speaker": "林夏",
        "camera": "跟拍推进",
        "duration_sec": 15,
        "characters": ["林夏"],
    },
    {
        "scene": "便利店冷柜·货架",
        "prompt": (
            "same rainy night convenience store aisle, Lin Xia walks to fridge, "
            "picks a bottle of water, soft cold white light"
        ),
        "dialogue": "加班到现在…就这一瓶。",
        "speaker": "林夏",
        "camera": "手部特写到脸",
        "duration_sec": 15,
        "characters": ["林夏"],
    },
    {
        "scene": "收银台·结账",
        "prompt": (
            "convenience store checkout, Lin Xia puts water bottle on counter, "
            "asks clerk about WeChat pay"
        ),
        "dialogue": "微信可以吗？",
        "speaker": "林夏",
        "camera": "过肩",
        "duration_sec": 15,
        "characters": ["林夏"],
    },
    {
        "scene": "便利店门口·出门",
        "prompt": (
            "Lin Xia with plastic bag pushes door open, looks back into store, "
            "then walks into heavier rain on neon street"
        ),
        "dialogue": "外面雨更大了。",
        "speaker": "林夏",
        "camera": "后退跟拍",
        "duration_sec": 15,
        "characters": ["林夏"],
    },
]

_LINXIA_DESC = (
    "年轻女人林夏，黑色冲锋衣，湿发贴额，神情克制；雨夜便利店冷白灯。"
)
_LINXIA_VISUAL = (
    "young East Asian woman Lin Xia, black windbreaker, wet hair on forehead, "
    "restrained expression, rainy night convenience store cold white light"
)


def _sample_asset_candidates() -> list[Path]:
    """样片素材搜索路径:优先 H3 实验资产,其次本地 uploads/assets。"""
    from app.storage import drama_output_root

    roots = [
        Path("/home/merlin/toiv/tmp/h3_long_exp/assets"),
        Path(__file__).resolve().parents[4] / "tmp" / "h3_long_exp" / "assets",
        drama_output_root() / "sample_assets",
        Path("/home/merlin/toiv/uploads/assets"),
    ]
    # 去重保序
    seen: set[str] = set()
    out: list[Path] = []
    for r in roots:
        key = str(r)
        if key in seen:
            continue
        seen.add(key)
        out.append(r)
    return out


def _stage_sample_image(src_name: str, dest_name: str) -> str | None:
    """复制样片图到 studio 产出目录,返回 /api/studio/files URL;不可用则 None。"""
    import shutil
    from app.storage import drama_output_root

    src: Path | None = None
    for root in _sample_asset_candidates():
        cand = root / src_name
        if cand.is_file():
            src = cand
            break
    if src is None:
        return None
    dest_dir = drama_output_root() / "studio"
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / dest_name
    if not dest.is_file() or dest.stat().st_size != src.stat().st_size:
        shutil.copy2(src, dest)
    return f"/api/studio/files/{dest_name}"


def _find_sample_rain_night(session: Session, user: User) -> StudioProject | None:
    rows = session.exec(
        select(StudioProject).where(
            StudioProject.tenant_id == user.tenant_id,
            StudioProject.user_id == user.id,
        )
    ).all()
    for p in rows:
        if SAMPLE_RAIN_NIGHT_MARKER in (p.premise or ""):
            return p
        if (p.title or "").strip() == SAMPLE_RAIN_NIGHT_TITLE:
            return p
    return None


def _studio_pipeline_brief(session: Session, pid: str) -> dict:
    """项目级管线摘要(供样片返回/列表进度点)。"""
    shots = session.exec(
        select(StudioShot).where(StudioShot.project_id == pid)
    ).all()
    next_step = compute_studio_next_step(shots)
    counts: dict[str, int] = {}
    for s in shots:
        counts[s.status] = counts.get(s.status, 0) + 1
    return {
        "total_shots": len(shots),
        "by_status": counts,
        "next_step": next_step,
    }


@router.post("/studio/sample-projects/rain-night")
def seed_rain_night_sample(
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """幂等种子:创建/更新固定样片「雨夜便利店·林夏」。

    - 重复调用不堆第二个项目(按 premise marker / 标题命中)
    - 三视图/场景图可得则绑定 URL;不可用仍建角色卡并标 assets_ready=false
    - 返回 project id + pipeline status
    """
    front = _stage_sample_image("linxia_front.png", "sample_linxia_front.png")
    side = _stage_sample_image("linxia_side.png", "sample_linxia_side.png")
    full = _stage_sample_image("linxia_full.png", "sample_linxia_full.png")
    scene = _stage_sample_image("scene_rain_store.png", "sample_scene_rain_store.png")
    refs = [u for u in (front, side, full) if u]
    assets_ready = len(refs) >= 3 and bool(scene)
    asset_notes: list[str] = []
    if len(refs) < 3:
        asset_notes.append("角色三视图未齐(素材不可用)")
    if not scene:
        asset_notes.append("场景图不可用")

    existing = _find_sample_rain_night(session, user)
    created = existing is None
    if existing is None:
        p = StudioProject(
            tenant_id=user.tenant_id,
            user_id=user.id,
            title=SAMPLE_RAIN_NIGHT_TITLE,
            premise=SAMPLE_RAIN_NIGHT_PREMISE,
            style="雨夜便利店冷白灯/霓虹积水，竖屏 9:16",
            render_mode_default="video",
            width=768,
            height=1360,
            fps=24,
            status="storyboard",
        )
        session.add(p)
        session.commit()
        session.refresh(p)
    else:
        p = existing
        p.title = SAMPLE_RAIN_NIGHT_TITLE
        p.premise = SAMPLE_RAIN_NIGHT_PREMISE
        p.style = "雨夜便利店冷白灯/霓虹积水，竖屏 9:16"
        p.width = 768
        p.height = 1360
        p.fps = 24
        if p.status in ("draft", ""):
            p.status = "storyboard"
        session.add(p)
        session.commit()
        session.refresh(p)

    # 场景图
    scenes = [scene] if scene else []
    p.scene_images_json = json.dumps(scenes, ensure_ascii=False)
    session.add(p)

    # 角色:林夏(幂等按名)
    char = session.exec(
        select(StudioCharacter).where(
            StudioCharacter.project_id == p.id,
            StudioCharacter.name == "林夏",
        )
    ).first()
    if char is None:
        char = StudioCharacter(project_id=p.id, name="林夏")
    char.description = _LINXIA_DESC
    char.visual_prompt = _LINXIA_VISUAL
    char.reference_images = json.dumps(refs, ensure_ascii=False)
    session.add(char)

    # 分镜:固定 4 镜全量替换(样片契约;保留已有媒体若镜数/对白一致则尽量按 idx 复用 id)
    old_shots = session.exec(
        select(StudioShot).where(StudioShot.project_id == p.id).order_by(StudioShot.idx)
    ).all()
    by_idx = {s.idx: s for s in old_shots}
    keep_ids: set[str] = set()
    for i, spec in enumerate(_SAMPLE_SHOTS):
        shot = by_idx.get(i)
        if shot is None:
            shot = StudioShot(project_id=p.id)
        shot.idx = i
        shot.scene = spec["scene"]
        shot.prompt = spec["prompt"]
        shot.dialogue = spec["dialogue"]
        shot.speaker = spec["speaker"]
        shot.camera = spec["camera"]
        shot.duration_sec = int(spec["duration_sec"])
        shot.characters = json.dumps(spec["characters"], ensure_ascii=False)
        shot.render_mode = "video"
        shot.video_model = "h3"
        if shot.status in ("", None):
            shot.status = "draft"
        session.add(shot)
        session.flush()
        keep_ids.add(shot.id)
    for s in old_shots:
        if s.id not in keep_ids:
            session.delete(s)

    session.commit()
    session.refresh(p)
    pipeline = _studio_pipeline_brief(session, p.id)
    detail = _project_detail(session, p)
    return {
        "id": p.id,
        "title": p.title,
        "created": created,
        "assets_ready": assets_ready,
        "asset_notes": asset_notes,
        "reference_images": refs,
        "scene_images": scenes,
        "pipeline": pipeline,
        "project": detail,
    }


@router.post("/studio/projects/{pid}/steps/{step}/rerun")
async def step_group_rerun(
    pid: str,
    step: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
    request: Request = None,
):
    """步骤整组重跑:对当前步未完成或失败镜头批量触发,错误写入 errors 不静默吞。

    step ∈ video | voice | lipsync | storyboard
      · video/storyboard: draft/error/queued/rendering 以外的未达 rendered+ 镜
      · voice: 有台词且未 voiced+ 的镜(需已出视频;否则记入 errors)
      · lipsync: 未 lipsynced+ 且具备视频+配音的镜
    """
    step = (step or "").strip().lower()
    if step not in {"video", "voice", "lipsync", "storyboard"}:
        raise HTTPException(
            status_code=422, detail="step 须为 video|voice|lipsync|storyboard"
        )
    _get_project(session, pid, user)
    shots = session.exec(
        select(StudioShot).where(StudioShot.project_id == pid).order_by(StudioShot.idx)
    ).all()
    if not shots:
        raise HTTPException(status_code=422, detail="无分镜可重跑")

    rendered_ok = {"rendered", "voiced", "lipsynced", "done"}
    voiced_ok = {"voiced", "lipsynced", "done"}
    lipsync_ok = {"lipsynced", "done"}

    targets: list[StudioShot] = []
    if step in ("video", "storyboard"):
        # 未达 rendered+ 的镜(含 draft/error/queued/rendering)
        targets = [s for s in shots if s.status not in rendered_ok]
    elif step == "voice":
        targets = [
            s
            for s in shots
            if (s.dialogue or "").strip() and s.status not in voiced_ok
        ]
    else:  # lipsync
        targets = [s for s in shots if s.status not in lipsync_ok]

    attempted = 0
    ok = 0
    failed = 0
    errors: list[dict] = []

    for shot in targets:
        if request is not None and await request.is_disconnected():
            break
        attempted += 1
        try:
            if step in ("video", "storyboard"):
                await orchestrator.render_shot(session, shot, request=request)
            elif step == "voice":
                if not (shot.dialogue or "").strip():
                    raise ValueError("该镜无台词")
                if shot.status not in rendered_ok and not shot.video_url:
                    raise ValueError("需要先出视频")
                character = None
                speaker = (shot.speaker or "").strip()
                if speaker:
                    character = session.exec(
                        select(StudioCharacter).where(
                            StudioCharacter.project_id == shot.project_id,
                            StudioCharacter.name == speaker,
                        )
                    ).first()
                    if character is None:
                        raise ValueError(f"未找到说话人「{speaker}」的角色卡")
                    if not (character.voice_ref_url or "").strip():
                        raise ValueError(f"角色「{speaker}」未配置音色")
                await voice_svc.synth_for_shot(session, shot, character)
            else:
                if shot.render_mode != "video":
                    raise ValueError("仅视频镜支持对口型")
                if not shot.video_url or not shot.voice_url:
                    raise ValueError("需要先出视频并配音")
                await lipsync_svc.lipsync_for_shot(session, shot)
            ok += 1
        except Exception as e:  # noqa: BLE001 — 整组聚合错误,不中断其余镜
            failed += 1
            errors.append(
                {
                    "shot_id": shot.id,
                    "idx": shot.idx,
                    "detail": str(e)[:240],
                }
            )

    pipeline = _studio_pipeline_brief(session, pid)
    return {
        "step": step,
        "attempted": attempted,
        "ok": ok,
        "failed": failed,
        "errors": errors,
        "pipeline": pipeline,
    }



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
