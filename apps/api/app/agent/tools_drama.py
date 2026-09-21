"""漫剧线工具(A1 多轮导演,2026-09-21)——把分镜板管线暴露给助手 agent。

用户说「把这个剧本做成 N 镜短剧/漫剧」时的标准流程:
create_storyboard(LLM 拆镜建板+角色落库) → (get_storyboard 检查/汇报)
→ assemble_storyboard(一键成片:逐镜生成+配音+词锚定字幕+拼接,后台跑)
→ check_film(追踪进度,完成把成片展示给用户)。
审片循环:某镜不满意 → generate_shot 单镜重跑 → 再次 assemble_storyboard(已挂视频的镜自动复用)。

设计纪律与 tools_gen 一致:全部委托 services 层(board_storyboard/board_generate/board_film
的 route↔tool 共用函数),本文件不复制任何生成/编排逻辑;归属隔离在各服务/查询内完成。
"""
from __future__ import annotations

import json
import logging

from sqlmodel import select

from app.agent.tools_gen import _err_event, _job_event
from app.models import Board, BoardItem, Job, User
from app.ratelimit import enforce_generation_rate_limit
from app.services.board_film import KIND as BOARD_FILM_KIND, start_board_film
from app.services.board_generate import prepare_shot_meta, submit_shot_generation
from app.services.board_storyboard import create_board_from_script

logger = logging.getLogger(__name__)

_ENGINE_DESC = (
    "生成引擎三选一:phantom-s2v(角色锁定,跨镜一致性最强,需角色在主体库有定妆照);"
    "h3-r2v(H3 多参考,同样需定妆照);h3-t2v(快速兜底,无角色定妆照也能跑,有照自动带首帧)"
)

TOOL_SCHEMAS_DRAMA = [
    {
        "type": "function",
        "function": {
            "name": "create_storyboard",
            "description": (
                "把剧本/剧情文本做成短剧的第一步:LLM 自动拆镜,创建分镜板"
                "(每镜含场景/台词/时长/英文生成提示词),出场角色自动落库到主体库(带外观提示词)。"
                "用户要求「做短剧/漫剧/分镜/成片」时先调它;完成后向用户汇报分镜数与角色,"
                "用户确认后再 assemble_storyboard 一键成片(LLM 拆镜约 20-30 秒,属正常)。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "script": {"type": "string", "description": "剧本或剧情大纲(中文,最长 2 万字)"},
                    "num_shots": {"type": "integer", "description": "分镜数量(1-50,默认 8;用户指定镜数时按其给)", "default": 8},
                    "style": {"type": "string", "description": "风格(可选,如 cinematic/日系动画/写实胶片)"},
                    "name": {"type": "string", "description": "分镜板名称(可选,缺省自动取剧本前 12 字)"},
                },
                "required": ["script"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_storyboard",
            "description": (
                "查看分镜板内容与各镜状态(拆镜后向用户汇报、成片前检查、"
                "用户问「我的分镜板/短剧做到哪了」时用)。返回板 id/各行文本/视频状态/角色。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "board_id": {"type": "string", "description": "分镜板 id(create_storyboard 返回)"},
                },
                "required": ["board_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "generate_shot",
            "description": (
                "单独重跑分镜板某一镜(审片时用户点名某镜不满意/该镜失败重试;异步返回作业 id)。"
                "重跑成功后需再 assemble_storyboard 才会进新成片。" + _ENGINE_DESC
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "board_id": {"type": "string", "description": "分镜板 id"},
                    "item_id": {"type": "integer", "description": "分镜行 id(get_storyboard 返回的 item_id)"},
                    "engine": {"type": "string", "enum": ["phantom-s2v", "h3-r2v", "h3-t2v"],
                               "description": "生成引擎(缺省 phantom-s2v)"},
                    "fps": {"type": "integer", "description": "视频帧率 8-30(默认 16)", "default": 16},
                },
                "required": ["board_id", "item_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "assemble_storyboard",
            "description": (
                "一键成片:对分镜板逐镜生成缺失视频 + 台词镜配音(IndexTTS 角色音色克隆)+ "
                "词锚定字幕(whisper 逐词卡拉 OK)+ ffmpeg 拼接烧字,产物进作品库(后台管线,立即返回成片作业 id)。"
                "已挂视频的镜自动复用不重跑(审片循环:改镜后重发只补变化镜)。"
                "同板已有在跑成片作业会 409,先 check_film 看进度。" + _ENGINE_DESC
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "board_id": {"type": "string", "description": "分镜板 id(create_storyboard 返回)"},
                    "engine": {"type": "string", "enum": ["phantom-s2v", "h3-r2v", "h3-t2v"],
                               "description": "生成引擎(缺省 phantom-s2v;角色无定妆照时改 h3-t2v)"},
                    "fps": {"type": "integer", "description": "视频帧率 8-30(默认 16)", "default": 16},
                },
                "required": ["board_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "check_film",
            "description": (
                "查询分镜板最近一次一键成片作业的状态与产物(用户追问进度时用;"
                "done 会自动把成片视频展示给用户,附卡拉 OK 字幕 ass/srt 下载链接)。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "board_id": {"type": "string", "description": "分镜板 id"},
                },
                "required": ["board_id"],
            },
        },
    },
]


def _owned_board(session, user: User, board_id: str) -> Board | None:
    b = session.get(Board, str(board_id or ""))
    return b if b is not None and b.user_id == user.id else None


async def exec_create_storyboard(args: dict, ctx: dict) -> tuple[str, list[dict]]:
    user: User = ctx["user"]
    session = ctx["session"]
    script = str(args.get("script") or "").strip()
    if not script:
        return "script 为空,请传入剧本或剧情文本。", [_err_event("script 为空")]
    try:
        num_shots = max(1, min(50, int(args.get("num_shots") or 8)))
    except (TypeError, ValueError):
        num_shots = 8
    try:
        board, item_count, cast_count = await create_board_from_script(
            session, user, script[:20000], num_shots,
            str(args.get("style") or "")[:2000], str(args.get("name") or "")[:64],
        )
    except Exception as e:  # StoryboardError/LLMError 统一收敛为工具错误文案
        logger.info("create_storyboard 失败: %s", e)
        return f"剧本拆镜失败(LLM 服务暂不可用或返回不可解析): {e}", [
            _err_event("剧本拆镜失败", str(e)[:200]),
        ]
    return (
        f"分镜板已创建:「{board.name}」(board_id={board.id}),共 {item_count} 个分镜行,"
        f"{cast_count} 个角色已落库主体库(可在主体库补定妆照/音色以提升一致性)。"
        f"下一步:用户确认后可 assemble_storyboard(board_id=\"{board.id}\") 一键成片"
        f"(逐镜生成+配音+字幕+拼接,后台执行);角色有定妆照用 phantom-s2v,否则 h3-t2v。"
    ), []


async def exec_get_storyboard(args: dict, ctx: dict) -> tuple[str, list[dict]]:
    user: User = ctx["user"]
    session = ctx["session"]
    b = _owned_board(session, user, str(args.get("board_id") or ""))
    if b is None:
        return "分镜板不存在或不属于当前用户。", [_err_event("分镜板不存在")]
    items = session.exec(
        select(BoardItem).where(BoardItem.board_id == b.id).order_by(BoardItem.sort_order)
    ).all()
    job_ids = [it.job_id for it in items if it.job_id]
    jobs = {j.id: j for j in session.exec(select(Job).where(Job.id.in_(job_ids))).all()} if job_ids else {}
    lines = [f"分镜板「{b.name}」(board_id={b.id}),{len(items)} 行:"]
    for i, it in enumerate(items, 1):
        job = jobs.get(it.job_id)
        status = job.status if job else "待生成"
        text = (it.shot_text or "").split("\n")[0][:40]
        lines.append(f"- 镜{i:02d}(item_id={it.id}):{status} | {text}")
    return "\n".join(lines), []


async def exec_generate_shot(args: dict, ctx: dict) -> tuple[str, list[dict]]:
    user: User = ctx["user"]
    session = ctx["session"]
    pool = ctx["pool"]
    b = _owned_board(session, user, str(args.get("board_id") or ""))
    if b is None:
        return "分镜板不存在或不属于当前用户。", [_err_event("分镜板不存在")]
    try:
        item_id = int(args.get("item_id"))
    except (TypeError, ValueError):
        return "item_id 缺失或非法(get_storyboard 可查)。", [_err_event("item_id 非法")]
    item = session.get(BoardItem, item_id)
    if item is None or item.board_id != b.id:
        return "分镜行不存在(或不属于该板)。", [_err_event("分镜行不存在")]
    engine = str(args.get("engine") or "phantom-s2v")
    try:
        fps = max(8, min(30, int(args.get("fps") or 16)))
    except (TypeError, ValueError):
        fps = 16
    try:
        result = await submit_shot_generation(
            session, pool, user, prepare_shot_meta(item), engine, fps=fps
        )
    except Exception as e:
        return f"单镜生成提交失败: {e}", [_err_event("单镜生成提交失败", str(e)[:200])]
    pid = str(result.get("prompt_id") or "")
    return (
        f"镜已提交生成(engine={result.get('engine', engine)},prompt_id={pid})。"
        f"完成后该镜自动换挂新作品;检查进度用 check_jobs([\"{pid}\"])。"
    ), [_job_event(job_id=pid, kind=str(result.get("kind") or ""), status="queued",
                   label="分镜单镜生成")]


async def exec_assemble_storyboard(args: dict, ctx: dict) -> tuple[str, list[dict]]:
    user: User = ctx["user"]
    session = ctx["session"]
    b = _owned_board(session, user, str(args.get("board_id") or ""))
    if b is None:
        return "分镜板不存在或不属于当前用户。", [_err_event("分镜板不存在")]
    engine = str(args.get("engine") or "phantom-s2v")
    try:
        fps = max(8, min(30, int(args.get("fps") or 16)))
    except (TypeError, ValueError):
        fps = 16
    enforce_generation_rate_limit(user)
    try:
        job = start_board_film(session, user, b, engine, fps)
    except Exception as e:
        from fastapi import HTTPException as _HTTPException

        if isinstance(e, _HTTPException):
            return f"一键成片未发起: {e.detail}", [_err_event("一键成片未发起", str(e.detail)[:200])]
        raise
    return (
        f"一键成片已提交(film prompt_id={job.prompt_id}):后台逐镜生成缺失视频→配音→词锚定字幕→拼接,"
        f"已挂视频的镜自动复用。进度用 check_film(board_id=\"{b.id}\") 追踪;完成后成片进作品库。"
    ), [_job_event(job_id=job.prompt_id, kind=BOARD_FILM_KIND, status="queued", label="一键成片")]


async def exec_check_film(args: dict, ctx: dict) -> tuple[str, list[dict]]:
    user: User = ctx["user"]
    session = ctx["session"]
    b = _owned_board(session, user, str(args.get("board_id") or ""))
    if b is None:
        return "分镜板不存在或不属于当前用户。", [_err_event("分镜板不存在")]
    rows = session.exec(
        select(Job)
        .where(Job.user_id == user.id, Job.kind == BOARD_FILM_KIND)
        .order_by(Job.created_at.desc())
        .limit(10)
    ).all()
    job = None
    for j in rows:
        try:
            if json.loads(j.params or "{}").get("board_id") == b.id:
                job = j
                break
        except ValueError:
            continue
    if job is None:
        return f"分镜板「{b.name}」还没有成片作业(assemble_storyboard 可发起)。", []
    progress = {}
    if job.progress:
        try:
            progress = json.loads(job.progress)
        except ValueError:
            progress = {}
    stage = progress.get("stage", job.status)
    line = f"成片作业 {job.prompt_id}:{job.status}(阶段 {stage} {progress.get('done', 0)}/{progress.get('total', '?')})"
    events: list[dict] = []
    if job.status == "done":
        results = json.loads(job.result) if job.result else []
        film_extra = {}
        try:
            film_extra = (json.loads(job.params or "{}").get("film") or {})
        except ValueError:
            pass
        line += f",成片 {len(results)} 个已展示给用户"
        if film_extra.get("ass_url"):
            line += ";卡拉 OK 字幕 ass/srt 侧车可下载"
        events.append(_job_event(job_id=job.id, kind=job.kind, status="done",
                                 label="漫剧成片", results=results))
    elif job.status == "error":
        line += f"({job.error or '执行失败'})"
    return line, events
