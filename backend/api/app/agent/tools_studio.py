"""V4-1 Agent 同构(2026-10-12):v2 六段工作区/创作域工具。

把 F2–F7 融合批落地的 v2 端点回灌给对话助手——工具与 UI 调同一批 routes 函数
(人机同构的正解=同一 API 面),UI 能做的助手都能代操。

覆盖:
- create_studio_project      建项目(短剧工作台第一步)
- breakdown_script           剧本 AI 拆解(异步 Job,提交后查 studio_parse_status)
- studio_parse_status        拆解结果轮询(确认角色/分镜)
- image_parse_from_reference 从图片建项目(VLM 解析,toiv-vlm)
- gen_character_sheet        角色定妆卡异步生成(需高质量参考图)
- check_sheet                设定卡作业轮询
- render_shot                逐镜渲染(可多候选,异步 Job)
- pick_shot_candidate        选用候选为镜成片
- shot_subtitles             整片字幕(SRT 外挂)/burn_subtitles(内嵌)
- lipsync_shot               对口型(视频+配音镜)

纪律:
- 与 routes 同函数调用(P-9:成功文案首 60 字禁 hint 词,错误路径要含);
- 长任务(拆解/设定卡/渲染)一律提交即返回 job_id,不阻塞对话轮;
- 独立短会话查库(与 tools_gen.exec_list_apps 同范式,防 DetachedInstanceError)。
"""
from __future__ import annotations

import json
import logging
from types import SimpleNamespace

from fastapi import HTTPException
from sqlmodel import Session

from app.models import User

logger = logging.getLogger(__name__)

# ── schemas(OpenAI function 格式;描述写给 LLM)────────────────────────────

TOOL_SCHEMAS_STUDIO = [
    {
        "type": "function",
        "function": {
            "name": "create_studio_project",
            "description": (
                "创建 v2 短剧项目(六段工作区:剧本→资产→分镜→镜头→时间线→成片)。"
                "用户说「建个短剧项目/开新项目」且给出主题时调用;返回 project_id。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "title": {"type": "string", "description": "项目名(简短)"},
                    "premise": {"type": "string", "description": "剧情概要/一句话题材"},
                    "style": {"type": "string", "description": "画风描述(可选)"},
                },
                "required": ["title"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "breakdown_script",
            "description": (
                "剧本 AI 拆解:把剧本/概要拆成结构化分镜+角色(异步,秒回 job_id)。"
                "完成后用 studio_parse_status 查结果;结果不落库,确认后由用户在工作区保存。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "project_id": {"type": "string", "description": "项目 id"},
                    "premise": {"type": "string", "description": "剧本全文或概要"},
                    "num_shots": {"type": "integer", "description": "目标分镜数(默认 8)"},
                },
                "required": ["project_id", "premise"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "studio_parse_status",
            "description": "查询剧本拆解作业:done 返回角色+分镜 JSON;进行中返回状态。",
            "parameters": {
                "type": "object",
                "properties": {
                    "project_id": {"type": "string"},
                    "job_id": {"type": "string"},
                },
                "required": ["project_id", "job_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "image_parse_from_reference",
            "description": (
                "从图片创建项目:上传过的图片(本站 /api/ URL)经 VLM 解析直接建"
                "项目+分镜(异步 job_id;查 studio_image_parse_status)。"
                "需要用户先在对话里发过图。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "image_url": {"type": "string", "description": "本站图片地址(/api/ 开头)"},
                    "hint": {"type": "string", "description": "补充说明(画风/剧情方向)"},
                    "num_shots": {"type": "integer", "description": "分镜数 4-16(默认 8)"},
                },
                "required": ["image_url"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "studio_image_parse_status",
            "description": "查询图片解析作业:done 返回 project_id/title/镜数;进行中返回状态。",
            "parameters": {
                "type": "object",
                "properties": {"job_id": {"type": "string"}},
                "required": ["job_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "gen_character_sheet",
            "description": (
                "生成角色定妆卡(主立绘+三视图+表情组,15-20 分钟级,异步 job_id;"
                "查 check_sheet 取结果)。角色需已有高质量参考图(头肩构图/干净底),"
                "没有时先引导用户上传或用 generate_image 出一张再写入。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "character_id": {"type": "string", "description": "角色 id(工作区资产段)"},
                    "style": {"type": "string", "description": "anime | ancient_realistic", "default": "anime"},
                },
                "required": ["character_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "check_sheet",
            "description": "查询设定卡生成作业:done 返回设定卡与各面板 URL;进行中返回状态。",
            "parameters": {
                "type": "object",
                "properties": {
                    "character_id": {"type": "string"},
                    "job_id": {"type": "string"},
                },
                "required": ["character_id", "job_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "render_shot",
            "description": (
                "渲染一个分镜(图→视频,H3 Ref2VA;异步 job_id,查 check_jobs)。"
                "可多候选(num_candidates>1 自动裁脸选优);镜需先有角色参考图。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "shot_id": {"type": "string"},
                    "num_candidates": {"type": "integer", "description": "候选数(默认 1,上限 3)"},
                },
                "required": ["shot_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "pick_shot_candidate",
            "description": "多候选渲染完成后,把指定候选选为该镜成片。",
            "parameters": {
                "type": "object",
                "properties": {
                    "shot_id": {"type": "string"},
                    "candidate_id": {"type": "string"},
                },
                "required": ["shot_id", "candidate_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "shot_subtitles",
            "description": (
                "整片字幕:对项目成片生成 SRT 外挂(whisper 对齐;op=burn 则烧录内嵌)。"
                "需项目已有成片或逐镜视频。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "project_id": {"type": "string"},
                    "op": {"type": "string", "description": "srt(默认) | burn", "default": "srt"},
                },
                "required": ["project_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "lipsync_shot",
            "description": "对已渲染+已配音的视频镜做对口型(LatentSync 覆盖镜成片;分钟级)。",
            "parameters": {
                "type": "object",
                "properties": {"shot_id": {"type": "string"}},
                "required": ["shot_id"],
            },
        },
    },
]


def _own_session(session: Session) -> Session:
    """独立短会话(端点早释连接;与 tools_gen.exec_list_apps 同范式)。"""
    from sqlmodel import Session as _S

    return _S(bind=session.get_bind())


def _err(prefix: str, e: Exception) -> tuple[str, list[dict]]:
    detail = getattr(e, "detail", None) or str(e)
    return f"{prefix}失败:{detail}", []


# ── executors(签名 (args, ctx);ctx: pool/user/session)───────────────────

async def exec_create_studio_project(args: dict, ctx: dict) -> tuple[str, list[dict]]:
    from app.routes import studio as st

    user: User = ctx["user"]
    with _own_session(ctx["session"]) as own:
        try:
            from app.services.studio.schemas import ProjectCreate

            body = ProjectCreate(
                title=str(args.get("title") or "").strip()[:200] or "未命名项目",
                premise=str(args.get("premise") or "").strip()[:2000],
                style=str(args.get("style") or "").strip()[:300],
            )
            out = st.create_project(body, user=user, session=own)
        except HTTPException as e:
            return _err("创建项目", e)
    pid = out.get("id") if isinstance(out, dict) else getattr(out, "id", "")
    return f"项目已创建:id={pid},名称「{body.title}」。下一步可以说「拆解剧本」进入分镜,或打开工作区细化。", []


async def exec_breakdown_script(args: dict, ctx: dict) -> tuple[str, list[dict]]:
    import asyncio as _asyncio

    from app.routes import studio as st

    user: User = ctx["user"]
    session: Session = ctx["session"]
    pid = str(args.get("project_id") or "").strip()
    premise = str(args.get("premise") or "").strip()
    if not pid or not premise:
        return "project_id 与 premise 均必填。", []
    with _own_session(session) as own:
        try:
            body = st.ScriptParseRequest(premise=premise, num_shots=int(args.get("num_shots") or 8))
            r = st.parse_script_endpoint(pid, body=body, user=user, session=own)
        except HTTPException as e:
            return _err("提交拆解", e)
    return (
        f"剧本拆解已提交(异步):job_id={r['job_id']}。"
        "完成后用 studio_parse_status 查结果(角色+分镜确认后在工作区保存)。"
    ), []


async def exec_studio_parse_status(args: dict, ctx: dict) -> tuple[str, list[dict]]:
    from app.routes import studio as st

    user: User = ctx["user"]
    session: Session = ctx["session"]
    with _own_session(session) as own:
        try:
            r = st.get_script_parse_status(
                str(args.get("project_id") or ""), str(args.get("job_id") or ""),
                user=user, session=own,
            )
        except HTTPException as e:
            return _err("查询拆解", e)
    if r.get("status") != "done":
        return f"拆解作业状态:{r.get('status')}(进行中请稍后再查)。", []
    chars = r.get("characters") or []
    shots = r.get("shots") or []
    lines = [f"拆解完成:{len(chars)} 角色 / {len(shots)} 分镜。"]
    lines += [f"- 角色 {c.get('name')}:{(c.get('description') or '')[:40]}" for c in chars[:6]]
    for i, s_ in enumerate(shots[:8]):
        lines.append(f"- 镜{i + 1}:{(s_.get('scene') or '')[:40]} | {(s_.get('dialogue') or '')[:20]}")
    return "\n".join(lines), []


async def exec_image_parse_from_reference(args: dict, ctx: dict) -> tuple[str, list[dict]]:
    import asyncio as _asyncio

    from app.routes import studio as st

    user: User = ctx["user"]
    session: Session = ctx["session"]
    url = str(args.get("image_url") or "").strip()
    if not url.startswith("/api/"):
        return "image_url 须为本站地址(以 /api/ 开头);请让用户先上传图片。", []
    # 取回图片字节(P-1:产物签名 URL,服务端经 worker ComfyUI 取)
    from app.comfy.client import ComfyUIError, get_image_bytes_any

    try:
        data, _ct = await get_image_bytes_any(url)
    except ComfyUIError as e:
        return f"图片取回失败:{e}(确认 URL 指向已存在产物)。", []
    import io as _io

    from starlette.datastructures import UploadFile as _UF

    up = _UF(file=_io.BytesIO(data), filename="agent-ref.png")
    with _own_session(session) as own:
        try:
            r = await st.create_project_from_image_v2(
                images=[up],
                hint=str(args.get("hint") or "")[:500],
                num_shots=int(args.get("num_shots") or 8),
                user=user, session=own,
            )
        except HTTPException as e:
            return _err("提交图片解析", e)
    return (
        f"图片解析已提交(异步):job_id={r['job_id']}。"
        "完成后用 studio_image_parse_status 查项目 id,再引导用户打开工作区。"
    ), []


async def exec_studio_image_parse_status(args: dict, ctx: dict) -> tuple[str, list[dict]]:
    from app.routes import studio as st

    user: User = ctx["user"]
    session: Session = ctx["session"]
    with _own_session(session) as own:
        try:
            r = st.get_image_parse_status(str(args.get("job_id") or ""), user=user, session=own)
        except HTTPException as e:
            return _err("查询图片解析", e)
    if r.get("status") != "done":
        return f"解析作业状态:{r.get('status')}(VLM 解析 1-2 分钟)。", []
    return (
        f"解析完成:项目「{r.get('title')}」(id={r.get('project_id')}),"
        f"{r.get('shot_count')} 分镜 / {r.get('character_count')} 角色;已可直接打开工作区。"
    ), []


async def exec_gen_character_sheet(args: dict, ctx: dict) -> tuple[str, list[dict]]:
    from app.routes import studio as st

    user: User = ctx["user"]
    session: Session = ctx["session"]
    cid = str(args.get("character_id") or "").strip()
    style = str(args.get("style") or "anime").strip()
    with _own_session(session) as own:
        try:
            from app.routes.studio import CharacterSheetRequest

            r = await st.generate_character_sheet_async(
                cid, body=CharacterSheetRequest(style=style), user=user, session=own,
            )
        except HTTPException as e:
            return _err("提交设定卡", e)
    return (
        f"设定卡生成已提交(异步):job_id={r['job_id']}(15-20 分钟级;主立绘+三视图+表情组)。"
        "完成后用 check_sheet 查结果;进行中可先做别的。"
    ), []


async def exec_check_sheet(args: dict, ctx: dict) -> tuple[str, list[dict]]:
    from app.routes import studio as st

    user: User = ctx["user"]
    session: Session = ctx["session"]
    with _own_session(session) as own:
        try:
            r = st.sheet_job_status(
                str(args.get("character_id") or ""), str(args.get("job_id") or ""),
                user=user, session=own,
            )
        except HTTPException as e:
            return _err("查询设定卡", e)
    if r.get("status") != "done":
        return f"设定卡作业状态:{r.get('status')}(分钟级,请稍后再查)。", []
    sheet = r.get("sheet_url") or ""
    panels = r.get("panel_urls") or {}
    media = [{"type": "image", "url": sheet}] if sheet else []
    return (
        f"设定卡完成:主卡 {sheet.split('/')[-1] if sheet else ''}"
        f";面板 {len(panels)} 张(portrait/front/side…)。已展示主卡,面板 URL 在工作区可见。"
    ), media


async def exec_render_shot(args: dict, ctx: dict) -> tuple[str, list[dict]]:
    from app.routes import studio as st

    user: User = ctx["user"]
    session: Session = ctx["session"]
    sid = str(args.get("shot_id") or "").strip()
    n = max(1, min(3, int(args.get("num_candidates") or 1)))
    with _own_session(session) as own:
        try:
            from app.routes.studio import RenderShotBody

            r = await st.render_one(
                sid, body=RenderShotBody(video_model="h3", num_candidates=n, wait=False),
                user=user, session=own, request=None,
            )
        except HTTPException as e:
            return _err("提交渲染", e)
    return (
        f"渲染已提交(异步 H3 Ref2VA):job_id={r.get('job_id')}(15 分钟级/候选)。"
        "完成后用 check_jobs 查;多候选时用 pick_shot_candidate 选定。"
    ), []


async def exec_pick_shot_candidate(args: dict, ctx: dict) -> tuple[str, list[dict]]:
    from app.routes import studio as st

    user: User = ctx["user"]
    session: Session = ctx["session"]
    with _own_session(session) as own:
        try:
            st.pick_shot_candidate(
                str(args.get("shot_id") or ""), str(args.get("candidate_id") or ""),
                user=user, session=own,
            )
        except HTTPException as e:
            return _err("选用候选", e)
    return "已选定该候选为本镜成片;可继续配音/对口型或进入下一镜。", []


async def exec_shot_subtitles(args: dict, ctx: dict) -> tuple[str, list[dict]]:
    from app.routes import studio as st

    user: User = ctx["user"]
    session: Session = ctx["session"]
    pid = str(args.get("project_id") or "").strip()
    op = str(args.get("op") or "srt").strip().lower()
    with _own_session(session) as own:
        try:
            if op == "burn":
                r = await st.burn_subtitles_endpoint(pid, user=user, session=own)
                url = r.get("video_url") or ""
                return f"内嵌字幕成片已生成:{url}(可直接播放/下载)。", []
            r = st.build_subtitles_endpoint(pid, user=user, session=own)
        except HTTPException as e:
            return _err("生成字幕", e)
    return (
        f"SRT 外挂已生成:{r.get('srt_url')}(覆盖 {r.get('shots_covered')} 镜,"
        f"总时长 {r.get('total_duration')}s);烧录内嵌可用 op=burn。"
    ), []


async def exec_lipsync_shot(args: dict, ctx: dict) -> tuple[str, list[dict]]:
    from app.routes import studio as st

    user: User = ctx["user"]
    session: Session = ctx["session"]
    with _own_session(session) as own:
        try:
            r = await st.lipsync_one(str(args.get("shot_id") or ""), user=user, session=own)
        except HTTPException as e:
            return _err("对口型", e)
    url = ""
    if isinstance(r, dict):
        url = r.get("final_clip_url") or ""
    return f"对口型完成,镜成片已更新:{url}。", []
