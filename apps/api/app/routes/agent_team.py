"""R3.1 Agent Team 统一入口:「计划可见 + 秒回 + 任务卡片」壳。

数据底座 = AgentRun/AgentTask/AgentEvent/AgentApproval 四表(models.py);
内部执行仍调现有 Studio 流水线服务层(storyboard 拆解 / orchestrator 渲染 /
voice 配音 / assemble 合成),零 LangGraph 依赖 —— Leader 规划、LangGraph
checkpoint、Verifier 对抗回路均为 R3.2 范围
(见 docs/2026-08-14-competitive-r3-r5-deep-dive.md 1.3.5 迁移步骤①)。

执行器设计要点:
- 后台协程按 depends_on 拓扑调度 AgentTask;启动时内部建 StudioProject
  (goal 作 premise,opts 透传产出规格),AgentTask ↔ StudioShot 映射
  的 shot_id 回写进任务 input_json。
- 计划确认门(plan)→ 全镜头就绪后挂起待合成(awaiting_assembly,推
  confirm_required 事件)→ 合成确认门(assembly)→ 成片。本期不做确认门
  超时自动继续(30min 默认动作是 R3.2 的事)。
- 渲染类任务 asyncio.Semaphore(_RENDER_CONCURRENCY) 限流;单任务失败标
  error + 推 blocked 事件,不中断其他分支;全部结束后有 error → run error
  (已完成任务的产物保留可见)。
- 执行器重入(api 重启)本期不恢复:内存协程丢失后 run 停在 running,
  用户可 cancel 后重建(R3.2 用 LangGraph checkpoint/PostgresSaver 断点续跑,
  幂等键 run_id+task_id+attempt 已落库,恢复时已完成节点直接跳过)。
"""
from __future__ import annotations

import asyncio
import json
import logging
from contextlib import nullcontext
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlmodel import Session, select
from sse_starlette.sse import EventSourceResponse

from app.db import get_session
from app.deps import get_current_user
from app.models import (
    AgentApproval,
    AgentEvent,
    AgentRun,
    AgentTask,
    StudioCharacter,
    StudioProject,
    StudioShot,
    User,
)
from app.ratelimit import enforce_rate_limit
from app.services.studio import assemble as assemble_svc
from app.services.studio import orchestrator
from app.services.studio import storyboard as storyboard_svc
from app.services.studio import voice as voice_svc

router = APIRouter()
logger = logging.getLogger(__name__)

# SSE 轮询间隔(秒);测试可 monkeypatch 调小
_EVENTS_POLL_SEC = 1.5
# 渲染类任务并发上限(与 ComfyUI-LB 后端规模对齐,防瞬间打爆 worker)
_RENDER_CONCURRENCY = 3
# 任务最大尝试次数(首次执行 + 1 次重生成 = 2;超出 400,防成本爆炸)
_MAX_ATTEMPT = 2
# 后台执行器强引用表:asyncio 仅持弱引用,不持强引用任务可能被 GC 提前回收
# (与 comfy/tracker.py 的 _tasks 同一模式)
_RUNNER_TASKS: set[asyncio.Task] = set()
# 已在执行的 run_id,防 resume 重复点击/重试导致双执行器并发写同一 run
_ACTIVE_RUNS: set[str] = set()
# run 终态集合:SSE 推完残留事件后据此关流
_TERMINAL = {"done", "error", "canceled"}


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _loads(raw: str, default):
    """JSON 字符串容错解析(空串/损坏 → default,不抛)。"""
    if not raw:
        return default
    try:
        return json.loads(raw)
    except (ValueError, TypeError):
        return default


# ---------------------------------------------------------------------------
# Director Gate:任务分级(规则启发式;R3.2 换 Leader LLM 分级)
# ---------------------------------------------------------------------------

_L2_KEYWORDS = ("短剧", "分镜", "系列", "多镜", "宣传片")
_L0_KEYWORDS = ("视频", "生成")


def classify_goal(goal: str) -> str:
    """L2=复杂项目(关键词或长文本);L0=单步生成语义;其余 L1。

    顺序敏感:先 L2 后 L0——「帮我做一支宣传短片」既含"宣传片"也含"视频",
    必须判 L2 走团队而非 L0 直达,故复杂级优先。
    """
    text = goal.strip()
    if any(k in text for k in _L2_KEYWORDS) or len(text) > 200:
        return "L2"
    if any(k in text for k in _L0_KEYWORDS):
        return "L0"
    return "L1"


# ---------------------------------------------------------------------------
# 序列化辅助
# ---------------------------------------------------------------------------


def _emit(session: Session, run_id: str, type_: str, payload: dict) -> None:
    """写一条 SSE 事件(调用方负责 commit;与状态变更同 commit 保证原子可见)。"""
    session.add(
        AgentEvent(
            run_id=run_id,
            type=type_,
            payload_json=json.dumps(payload, ensure_ascii=False),
        )
    )


def _task_brief(t: AgentTask) -> dict:
    """计划视图(创建/编辑计划/SSE plan 事件共用形状)。"""
    return {
        "id": t.id,
        "kind": t.kind,
        "title": t.title,
        "depends_on": _loads(t.depends_on, []),
        "status": t.status,
    }


def _task_detail(t: AgentTask) -> dict:
    """卡片详情视图(input/output/verdict 解析为对象)。"""
    return {
        **_task_brief(t),
        "attempt": t.attempt,
        "input": _loads(t.input_json, {}),
        "output": _loads(t.output_json, {}),
        "verdict": _loads(t.verdict_json, {}),
        "gpu_hint": t.gpu_hint,
    }


def _tasks_of(session: Session, run: AgentRun) -> list[AgentTask]:
    """按 plan_json 快照顺序返回任务(计划编辑删增后仍保持稳定展示序)。"""
    rows = list(
        session.exec(select(AgentTask).where(AgentTask.run_id == run.id)).all()
    )
    plan = _loads(run.plan_json, {})
    order = {t.get("id"): i for i, t in enumerate(plan.get("tasks") or [])}
    rows.sort(key=lambda t: order.get(t.id, len(order)))
    return rows


def _sync_plan_json(session: Session, run: AgentRun) -> None:
    """以 AgentTask 表现状重建 plan_json 快照(plan 编辑后保持单一事实源)。"""
    plan = _loads(run.plan_json, {})
    plan["tasks"] = [_task_brief(t) for t in _tasks_of(session, run)]
    run.plan_json = json.dumps(plan, ensure_ascii=False)
    run.updated_at = _utcnow()
    session.add(run)


def _get_run(session: Session, run_id: str, user: User) -> AgentRun:
    """取当前用户的 run;不存在/非本人一律 404(不泄露存在性)。"""
    run = session.get(AgentRun, run_id)
    if not run or run.user_id != user.id:
        raise HTTPException(status_code=404, detail="任务不存在")
    return run


# ---------------------------------------------------------------------------
# 计划构建:storyboard 分镜草稿 → AgentTask 卡片 DAG
# ---------------------------------------------------------------------------


def _build_tasks(shots: list) -> list[AgentTask]:
    """每分镜一张渲染卡;有台词的分镜追加配音卡;末尾合成卡依赖全部。

    对口型卡本期不生成(按需,R3.2 接 lipsync 链后补);depends_on 用任务 id。
    """
    tasks: list[AgentTask] = []
    for i, shot in enumerate(shots):
        kind = "video" if shot.render_mode == "video" else "image"
        shot_task = AgentTask(
            kind=kind,
            title=f"镜头 {i + 1}:{shot.scene or '未命名'}",
            input_json=json.dumps(shot.model_dump(), ensure_ascii=False),
        )
        tasks.append(shot_task)
        if shot.dialogue.strip():
            tasks.append(
                AgentTask(
                    kind="audio",
                    title=f"镜头 {i + 1} 配音",
                    depends_on=json.dumps([shot_task.id]),
                    input_json=json.dumps(
                        {
                            "shot_ref": shot_task.id,
                            "dialogue": shot.dialogue,
                            "speaker": shot.speaker,
                        },
                        ensure_ascii=False,
                    ),
                )
            )
    if tasks:
        tasks.append(
            AgentTask(
                kind="assemble",
                title="合成成片",
                depends_on=json.dumps([t.id for t in tasks]),
            )
        )
    return tasks


# ---------------------------------------------------------------------------
# 请求 DTO
# ---------------------------------------------------------------------------


class AgentRunCreate(BaseModel):
    goal: str = Field(min_length=1, max_length=20000)
    level: str | None = Field(default=None, pattern="^(L0|L1|L2)$")
    opts: dict = Field(default_factory=dict)


class PlanEditOp(BaseModel):
    """计划编辑单条操作:add 时 id 可空(服务端生成),kind/depends_on 从 input 读。"""

    id: str = ""
    action: str = Field(pattern="^(update|remove|add)$")
    title: str | None = None
    input: dict | None = None


class PlanEditRequest(BaseModel):
    tasks: list[PlanEditOp]


class ResumeRequest(BaseModel):
    gate: str = Field(pattern="^(plan|assembly)$")
    action: str = Field(pattern="^(approve|modify|reject)$")
    feedback: str = Field(default="", max_length=4000)


class TaskActionRequest(BaseModel):
    action: str = Field(pattern="^(edit|regenerate|approve|upload|reprompt)$")
    payload: dict = Field(default_factory=dict)


# ---------------------------------------------------------------------------
# 端点:创建(秒回)/ 列表 / 详情
# ---------------------------------------------------------------------------


@router.post("/agent-runs")
async def create_agent_run(
    body: AgentRunCreate,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    """创建 Agent Team 任务。L0 不建 run 直接回指引;L1/L2 同步拆计划后秒回。"""
    enforce_rate_limit(user, scope="generation")
    level = body.level or classify_goal(body.goal)
    if level == "L0":
        return {"level": "L0", "ack": "单步任务建议直达工作台", "run_id": None}

    try:
        num_shots = max(1, min(50, int(body.opts.get("num_shots") or 8)))
    except (ValueError, TypeError):
        num_shots = 8
    try:
        characters, shots = await storyboard_svc.parse_script(
            body.goal, num_shots=num_shots, style=str(body.opts.get("style") or "")
        )
    except storyboard_svc.StoryboardError as e:
        # 规划阶段强依赖 LLM;失败必须明确 503(前端据此提示稍后重试)
        raise HTTPException(status_code=503, detail=f"规划失败:{e}") from e

    run = AgentRun(user_id=user.id, level=level, goal=body.goal)
    tasks = _build_tasks(shots)
    plan = {
        "tasks": [_task_brief(t) for t in tasks],
        "opts": body.opts,
        "characters": [c.model_dump() for c in characters],
    }
    run.plan_json = json.dumps(plan, ensure_ascii=False)
    run.status = "awaiting_confirm"  # 计划确认门:approve 后才进执行
    session.add(run)
    session.commit()
    session.refresh(run)
    for t in tasks:
        t.run_id = run.id
        session.add(t)
    ack = f"已拆成 {len(tasks)} 步,后台执行,关键节点会找你"
    _emit(session, run.id, "ack", {"message": ack, "level": level})
    _emit(session, run.id, "plan", {"tasks": plan["tasks"]})
    session.commit()
    return {"run_id": run.id, "level": level, "ack": ack, "plan": {"tasks": plan["tasks"]}}


@router.get("/agent-runs")
def list_agent_runs(
    limit: int = Query(default=50, ge=1, le=200),
    status: str = Query(default="", description="按状态过滤,空=全部"),
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> list[dict]:
    """当前用户的 run 列表(最新在前),附任务计数供列表页徽章。"""
    stmt = select(AgentRun).where(AgentRun.user_id == user.id)
    if status:
        stmt = stmt.where(AgentRun.status == status)
    rows = session.exec(stmt.order_by(AgentRun.created_at.desc()).limit(limit)).all()
    out = []
    for r in rows:
        tasks = session.exec(select(AgentTask).where(AgentTask.run_id == r.id)).all()
        out.append(
            {
                "id": r.id,
                "level": r.level,
                "goal": r.goal,
                "status": r.status,
                "created_at": r.created_at.isoformat(),
                "task_counts": {
                    "total": len(tasks),
                    # approved 视为完成态(人工通过后不再回流执行器)
                    "done": sum(1 for t in tasks if t.status in ("done", "approved")),
                    "error": sum(1 for t in tasks if t.status == "error"),
                },
            }
        )
    return out


@router.get("/agent-runs/{run_id}")
def get_agent_run(
    run_id: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    """run 详情:计划 DAG + 全任务卡片(input/output/verdict 解析为对象)。"""
    run = _get_run(session, run_id, user)
    return {
        "id": run.id,
        "goal": run.goal,
        "level": run.level,
        "status": run.status,
        "error": run.error,
        "plan": [_task_detail(t) for t in _tasks_of(session, run)],
        "created_at": run.created_at.isoformat(),
        "updated_at": run.updated_at.isoformat(),
    }


# ---------------------------------------------------------------------------
# 端点:SSE 事件流
# ---------------------------------------------------------------------------


@router.get("/agent-runs/{run_id}/events")
async def run_events(
    run_id: str,
    request: Request,
    after: int = Query(default=0, ge=0, description="断点续传:只推 id > after 的事件"),
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """轮询 AgentEvent 表推 SSE。终态 run 推完残留事件后关流。

    事件与状态变更同事务 commit,故「读到终态时事件已全部可见」,无丢事件窗口。
    认证走 get_current_user(?token= 查询参数兼容原生 EventSource)。
    """
    run = _get_run(session, run_id, user)
    bind = session.get_bind()

    async def stream():
        last = after
        while True:
            if await request.is_disconnected():
                return
            with Session(bind) as s:
                evs = s.exec(
                    select(AgentEvent)
                    .where(AgentEvent.run_id == run_id, AgentEvent.id > last)
                    .order_by(AgentEvent.id)
                ).all()
                cur = s.get(AgentRun, run_id)
                status = cur.status if cur else "error"
            for ev in evs:
                last = ev.id
                yield {"event": ev.type, "data": ev.payload_json}
            if status in _TERMINAL:
                return
            await asyncio.sleep(_EVENTS_POLL_SEC)

    return EventSourceResponse(stream())


# ---------------------------------------------------------------------------
# 端点:计划编辑 / 确认门 resume / 卡片干预 / 取消 / 结果
# ---------------------------------------------------------------------------


@router.post("/agent-runs/{run_id}/plan")
def edit_plan(
    run_id: str,
    body: PlanEditRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    """编辑计划(Flowith 式:改文案/删镜头/加镜头)。仅计划确认门挂起时可改。"""
    run = _get_run(session, run_id, user)
    if run.status != "awaiting_confirm":
        raise HTTPException(status_code=409, detail="仅待确认状态可编辑计划")
    for op in body.tasks:
        if op.action == "add":
            inp = dict(op.input or {})
            kind = str(inp.pop("kind", "video"))
            deps = inp.pop("depends_on", [])
            t = AgentTask(
                kind=kind,
                title=op.title or "新任务",
                depends_on=json.dumps(deps),
                input_json=json.dumps(inp, ensure_ascii=False),
            )
            if op.id:
                t.id = op.id  # 前端预生成 id(保持 DAG 引用稳定)
            t.run_id = run.id
            session.add(t)
            continue
        t = session.get(AgentTask, op.id)
        if not t or t.run_id != run.id:
            raise HTTPException(status_code=404, detail=f"任务不存在:{op.id}")
        if op.action == "remove":
            session.delete(t)
        else:  # update:标题直接改;input 按键合并(不动未提交字段)
            if op.title is not None:
                t.title = op.title
            if op.input:
                merged = {**_loads(t.input_json, {}), **op.input}
                t.input_json = json.dumps(merged, ensure_ascii=False)
            session.add(t)
    session.commit()
    # remove 后清理其他任务 depends_on 里的悬挂引用(防执行器死等已删依赖)
    removed = {op.id for op in body.tasks if op.action == "remove"}
    if removed:
        for t in session.exec(select(AgentTask).where(AgentTask.run_id == run.id)).all():
            deps = [d for d in _loads(t.depends_on, []) if d not in removed]
            new_deps = json.dumps(deps)
            if new_deps != t.depends_on:
                t.depends_on = new_deps
                session.add(t)
    _sync_plan_json(session, run)
    tasks = _loads(run.plan_json, {}).get("tasks") or []
    _emit(session, run.id, "plan", {"tasks": tasks})
    session.commit()
    return {"run_id": run.id, "plan": {"tasks": tasks}}


@router.post("/agent-runs/{run_id}/resume")
async def resume_run(
    run_id: str,
    body: ResumeRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    """确认门裁决。无论何种动作都先落 AgentApproval(HITL 数据 R5 回流用)。"""
    run = _get_run(session, run_id, user)
    session.add(
        AgentApproval(
            run_id=run.id, gate=body.gate, action=body.action, feedback=body.feedback
        )
    )
    bind = session.get_bind()
    if body.gate == "plan":
        # planning = reject 后的重规划挂起态,允许用户在原位再次 approve
        if run.status not in ("awaiting_confirm", "planning"):
            raise HTTPException(
                status_code=409, detail=f"当前状态({run.status})不可操作计划确认门"
            )
        if body.action == "approve":
            run.status = "running"
            run.error = ""
            run.updated_at = _utcnow()
            session.add(run)
            session.commit()
            _spawn_run(run.id, bind)
            return {"run_id": run.id, "status": run.status}
        if body.action == "reject":
            # 打回重规划:feedback 记入 run.error 供重规划参考
            # (R3.2 接 Leader 自动重规划,本期用户可 edit plan 后重新 approve)
            run.status = "planning"
            run.error = body.feedback or "计划被拒绝"
            run.updated_at = _utcnow()
            session.add(run)
            session.commit()
            return {"run_id": run.id, "status": run.status}
        # modify:仅记录裁决,run 保持原挂起态(实际改动走 POST /plan)
        session.commit()
        return {"run_id": run.id, "status": run.status}
    # 合成确认门
    if run.status != "awaiting_assembly":
        raise HTTPException(
            status_code=409, detail=f"当前状态({run.status})不可操作合成确认门"
        )
    if body.action == "approve":
        run.status = "running"
        run.updated_at = _utcnow()
        session.add(run)
        session.commit()
        _spawn_assembly(run.id, bind)
        return {"run_id": run.id, "status": run.status}
    if body.action == "reject":
        # 不合成,回 running:可单卡 regenerate 后重新到达待合成
        run.status = "running"
        run.updated_at = _utcnow()
        session.add(run)
        session.commit()
        return {"run_id": run.id, "status": run.status}
    session.commit()
    return {"run_id": run.id, "status": run.status}


@router.post("/agent-runs/{run_id}/tasks/{task_id}/action")
async def task_action(
    run_id: str,
    task_id: str,
    body: TaskActionRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    """卡片级干预:edit 改文案 / regenerate 带引导词重生 / approve 通过。

    upload(替换上传)与 reprompt(反推提示词)本期未实现,501 明示 R3.2 提供。
    """
    run = _get_run(session, run_id, user)
    task = session.get(AgentTask, task_id)
    if not task or task.run_id != run.id:
        raise HTTPException(status_code=404, detail="任务卡片不存在")
    if body.action in ("upload", "reprompt"):
        raise HTTPException(status_code=501, detail="R3.2 提供")
    if body.action == "approve":
        task.status = "approved"
        session.add(task)
        session.commit()
        session.refresh(task)
        return _task_detail(task)
    if body.action == "edit":
        if body.payload:
            # 前端契约:payload={input:{...}};兼容直传平铺 dict 两种形态
            patch = body.payload.get("input") if isinstance(body.payload.get("input"), dict) else body.payload
            merged = {**_loads(task.input_json, {}), **patch}
            task.input_json = json.dumps(merged, ensure_ascii=False)
        # 回 pending:执行器(重)跑时以新 input 为准(_render_task 执行前回同步 shot)
        task.status = "pending"
        session.add(task)
        session.commit()
        session.refresh(task)
        return _task_detail(task)
    # regenerate
    if task.status not in ("done", "error"):
        raise HTTPException(status_code=409, detail="仅已完成/失败的任务可重生成")
    if run.status == "canceled":
        raise HTTPException(status_code=409, detail="任务已取消")
    if task.kind == "assemble":
        raise HTTPException(status_code=400, detail="合成任务请走合成确认门")
    if task.attempt >= _MAX_ATTEMPT:
        raise HTTPException(status_code=400, detail=f"已达最大重试次数({_MAX_ATTEMPT})")
    guidance = str(body.payload.get("guidance") or "").strip()
    if guidance:
        inp = _loads(task.input_json, {})
        # 引导词拼进主文案(渲染卡拼 prompt,配音卡拼台词)
        key = "prompt" if "prompt" in inp else "dialogue"
        base = str(inp.get(key) or "")
        inp[key] = f"{base}, {guidance}" if base else guidance
        task.input_json = json.dumps(inp, ensure_ascii=False)
    task.status = "pending"
    session.add(task)
    if run.status in ("error", "done", "awaiting_assembly"):
        # 单卡重跑期间 run 回 running;完成后由执行器重新挂起待合成门
        run.status = "running"
        run.updated_at = _utcnow()
        session.add(run)
    session.commit()
    session.refresh(task)
    _spawn_task_rerun(run.id, task.id, session.get_bind())
    return _task_detail(task)


@router.post("/agent-runs/{run_id}/cancel")
def cancel_run(
    run_id: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    """取消 run:停止调度新任务;在跑的 ComfyUI 作业不追杀(追杀语义属现有
    job 取消链,R3.2 再打通),执行器等其自然结束后退出。"""
    run = _get_run(session, run_id, user)
    if run.status not in ("planning", "awaiting_confirm", "running", "awaiting_assembly"):
        raise HTTPException(status_code=409, detail=f"当前状态({run.status})不可取消")
    run.status = "canceled"
    run.updated_at = _utcnow()
    session.add(run)
    _emit(session, run.id, "task_status", {"run_id": run.id, "status": "canceled"})
    session.commit()
    return {"run_id": run.id, "status": "canceled"}


@router.get("/agent-runs/{run_id}/result")
def run_result(
    run_id: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    """成片与产物清单。final_url 取自合成卡产物;duration 为镜头卡时长合计。"""
    run = _get_run(session, run_id, user)
    if run.status != "done":
        raise HTTPException(status_code=409, detail="任务尚未完成")
    tasks = _tasks_of(session, run)
    final_url = ""
    for t in tasks:
        if t.kind == "assemble" and t.status == "done":
            final_url = str(_loads(t.output_json, {}).get("url") or "")
    duration = sum(
        int(_loads(t.input_json, {}).get("duration_sec") or 0)
        for t in tasks
        if t.kind in ("video", "image")
    )
    return {
        "final_url": final_url,
        "duration_sec": duration,
        "tasks": [
            {
                "id": t.id,
                "title": t.title,
                "kind": t.kind,
                "status": t.status,
                "output": _loads(t.output_json, {}),
            }
            for t in tasks
        ],
    }


# ---------------------------------------------------------------------------
# 后台执行器(薄适配层):AgentTask DAG → Studio 流水线服务层
# ---------------------------------------------------------------------------


def _spawn(coro) -> None:
    """fire-and-forget 启动后台协程(强引用防 GC,同 tracker.spawn 模式)。"""
    task = asyncio.create_task(coro)
    _RUNNER_TASKS.add(task)
    task.add_done_callback(_RUNNER_TASKS.discard)


def _spawn_run(run_id: str, bind) -> None:
    if run_id in _ACTIVE_RUNS:
        return
    _ACTIVE_RUNS.add(run_id)

    async def _wrap() -> None:
        try:
            await _execute_run(run_id, bind)
        finally:
            _ACTIVE_RUNS.discard(run_id)

    _spawn(_wrap())


def _spawn_assembly(run_id: str, bind) -> None:
    key = f"{run_id}:assembly"
    if key in _ACTIVE_RUNS:
        return
    _ACTIVE_RUNS.add(key)

    async def _wrap() -> None:
        try:
            await _execute_assembly(run_id, bind)
        finally:
            _ACTIVE_RUNS.discard(key)

    _spawn(_wrap())


def _spawn_task_rerun(run_id: str, task_id: str, bind) -> None:
    key = f"{run_id}:{task_id}"
    if key in _ACTIVE_RUNS:
        return
    _ACTIVE_RUNS.add(key)

    async def _wrap() -> None:
        try:
            await _rerun_single(run_id, task_id, bind)
        finally:
            _ACTIVE_RUNS.discard(key)

    _spawn(_wrap())


async def _execute_run(run_id: str, bind) -> None:
    """主执行器:建 Studio 工程 → 拓扑调度非合成任务 → 挂起待合成门。"""
    try:
        _setup_studio_project(run_id, bind)
    except Exception:
        logger.exception("agent run %s 建 Studio 工程失败", run_id)
        _finish_run_error(bind, run_id, "初始化 Studio 工程失败")
        return

    sem = asyncio.Semaphore(_RENDER_CONCURRENCY)
    running: dict[str, asyncio.Task] = {}
    try:
        while True:
            with Session(bind) as s:
                run = s.get(AgentRun, run_id)
                status = run.status if run else "canceled"
                rows = s.exec(
                    select(AgentTask).where(AgentTask.run_id == run_id)
                ).all()
                work = {t.id: t for t in rows if t.kind != "assemble"}
                states = {tid: t.status for tid, t in work.items()}
            if status == "canceled":
                # 取消:停止调度新任务;在跑任务不追杀,等其自然结束后退出
                if running:
                    await asyncio.gather(*running.values(), return_exceptions=True)
                return
            pending = [
                t for t in work.values() if t.status == "pending" and t.id not in running
            ]
            if not pending and not running:
                break
            schedulable, doomed = [], []
            for t in pending:
                # 未知依赖(计划编辑已删的)忽略;上游 error → 本任务不再尝试
                deps = [d for d in _loads(t.depends_on, []) if d in work]
                if any(states.get(d) == "error" for d in deps):
                    doomed.append(t)
                elif all(states.get(d) in ("done", "approved") for d in deps):
                    schedulable.append(t)
            for t in doomed:
                _mark_task_error(bind, run_id, t.id, "上游任务失败,跳过")
            for t in schedulable:
                running[t.id] = asyncio.create_task(_exec_task(run_id, t.id, bind, sem))
            if running:
                done, _ = await asyncio.wait(
                    running.values(), return_when=asyncio.FIRST_COMPLETED
                )
                for d in done:
                    tid = next(k for k, v in running.items() if v is d)
                    del running[tid]
                    if not d.cancelled() and d.exception():
                        logger.error(
                            "agent run %s 任务协程异常:%s", run_id, d.exception()
                        )
            elif pending and not schedulable and not doomed:
                # 依赖未满足且无任务在跑(不应发生;防死循环安全阀)
                logger.error("agent run %s 调度死锁,剩余任务标 error", run_id)
                for t in pending:
                    _mark_task_error(bind, run_id, t.id, "调度死锁:依赖无法满足")
    except Exception:
        logger.exception("agent run %s 执行器异常", run_id)
        _finish_run_error(bind, run_id, "执行器内部异常")
        return

    with Session(bind) as s:
        run = s.get(AgentRun, run_id)
        if not run or run.status != "running":
            return  # 调度期间已被 cancel
        rows = [
            t
            for t in s.exec(select(AgentTask).where(AgentTask.run_id == run_id)).all()
            if t.kind != "assemble"
        ]
        failed = [t for t in rows if t.status == "error"]
        run.updated_at = _utcnow()
        if failed:
            # 有失败 → run error;已完成任务的产物保留可见(可单卡 regenerate 挽救)
            run.status = "error"
            run.error = (
                f"{len(failed)} 个任务失败;已完成产物保留,"
                "可单卡重生成,或 cancel 后重建"
            )
            _emit(
                s, run_id, "error",
                {"message": run.error, "failed": [t.id for t in failed]},
            )
        else:
            run.status = "awaiting_assembly"
            _emit(
                s, run_id, "confirm_required",
                {"gate": "assembly", "message": "全部镜头已就绪,确认后合成"},
            )
        s.add(run)
        s.commit()


def _setup_studio_project(run_id: str, bind) -> None:
    """内部建 StudioProject + 角色 + 分镜,并把 shot_id/project_id 回写任务 input。"""
    with Session(bind) as s:
        run = s.get(AgentRun, run_id)
        if not run or run.status != "running":
            return
        plan = _loads(run.plan_json, {})
        opts = plan.get("opts") or {}
        owner = s.get(User, run.user_id)
        project = StudioProject(
            tenant_id=owner.tenant_id if owner else "",
            user_id=run.user_id,
            title=(run.goal[:80] or "Agent 任务"),
            premise=run.goal,
            style=str(opts.get("style") or ""),
            render_mode_default=str(opts.get("render_mode_default") or "video"),
            width=int(opts.get("width") or 768),
            height=int(opts.get("height") or 384),
            fps=int(opts.get("fps") or 16),
            status="generating",
        )
        s.add(project)
        s.commit()
        s.refresh(project)
        for c in plan.get("characters") or []:
            s.add(
                StudioCharacter(
                    project_id=project.id,
                    name=str(c.get("name") or ""),
                    description=str(c.get("description") or ""),
                    visual_prompt=str(c.get("visual_prompt") or ""),
                )
            )
        tasks = _tasks_of(s, run)
        shot_task_ids: dict[str, str] = {}  # task_id → shot_id(供配音卡解析)
        idx = 0
        for t in tasks:
            if t.kind not in ("video", "image"):
                continue
            inp = _loads(t.input_json, {})
            shot = StudioShot(
                project_id=project.id,
                idx=idx,
                scene=str(inp.get("scene") or ""),
                prompt=str(inp.get("prompt") or ""),
                negative=str(inp.get("negative") or ""),
                camera=str(inp.get("camera") or ""),
                dialogue=str(inp.get("dialogue") or ""),
                speaker=str(inp.get("speaker") or ""),
                duration_sec=int(inp.get("duration_sec") or 6),
                characters=json.dumps(inp.get("characters") or [], ensure_ascii=False),
                render_mode="video" if t.kind == "video" else "image_motion",
            )
            idx += 1
            s.add(shot)
            s.commit()
            s.refresh(shot)
            shot_task_ids[t.id] = shot.id
            inp["shot_id"] = shot.id
            inp["project_id"] = project.id
            t.input_json = json.dumps(inp, ensure_ascii=False)
            s.add(t)
        for t in tasks:
            inp = _loads(t.input_json, {})
            if t.kind == "audio" and inp.get("shot_ref") in shot_task_ids:
                inp["shot_id"] = shot_task_ids[inp["shot_ref"]]
            if t.kind == "assemble":
                inp["project_id"] = project.id
            t.input_json = json.dumps(inp, ensure_ascii=False)
            s.add(t)
        s.commit()


async def _exec_task(run_id: str, task_id: str, bind, sem: asyncio.Semaphore) -> None:
    """执行单任务:queued→running(记事件)→ 服务层调用 → done/error。"""
    with Session(bind) as s:
        task = s.get(AgentTask, task_id)
        run = s.get(AgentRun, run_id)
        if not task or not run or run.status == "canceled":
            return
        kind = task.kind
        inp = _loads(task.input_json, {})
        task.status = "running"
        task.attempt += 1
        # 本期静态提示;真实 GPU 队列位置 R3.2 接 comfy/pool.queue_position()
        task.gpu_hint = "pool"
        # 幂等键:run_id+task_id+attempt(R3.2 checkpoint 恢复时已完成节点跳过)
        task.idempotency_key = f"{run_id}-{task_id}-{task.attempt}"
        task.verdict_json = ""
        s.add(task)
        _emit(
            s, run_id, "task_status",
            {
                "task_id": task_id,
                "status": "running",
                "title": task.title,
                "gpu_hint": task.gpu_hint,
                "attempt": task.attempt,
            },
        )
        s.commit()

    # 渲染类走信号量限流;配音/合成轻量不占渲染槽
    ctx = sem if kind in ("video", "image") else nullcontext()
    try:
        async with ctx:
            if kind in ("video", "image"):
                output = await _render_task(bind, task_id, inp)
            elif kind == "audio":
                output = await _voice_task(bind, task_id, inp)
            elif kind == "assemble":
                output = await _assemble_task(bind, task_id, inp)
            else:
                raise RuntimeError(f"未知任务类型:{kind}")
    except Exception as e:  # noqa: BLE001 — 单任务失败不中断其他分支
        logger.warning("agent run %s 任务 %s 失败:%s", run_id, task_id, e)
        _mark_task_error(bind, run_id, task_id, str(e))
        return

    with Session(bind) as s:
        task = s.get(AgentTask, task_id)
        if not task:
            return
        task.status = "done"
        task.output_json = json.dumps(output, ensure_ascii=False)
        s.add(task)
        _emit(
            s, run_id, "task_status",
            {"task_id": task_id, "status": "done", "title": task.title, "output": output},
        )
        s.commit()


async def _render_task(bind, task_id: str, inp: dict) -> dict:
    """渲染卡 → orchestrator.render_shot(服务层直调,不复制渲染逻辑)。"""
    with Session(bind) as s:
        shot = s.get(StudioShot, str(inp.get("shot_id") or ""))
        if not shot:
            raise RuntimeError("镜头映射缺失(任务未关联 StudioShot)")
        # edit/regenerate 后 input_json 是最新事实源,执行前同步回 StudioShot
        shot.scene = str(inp.get("scene") or shot.scene)
        shot.prompt = str(inp.get("prompt") or shot.prompt)
        shot.dialogue = str(inp.get("dialogue") or shot.dialogue)
        shot.speaker = str(inp.get("speaker") or shot.speaker)
        if inp.get("negative"):
            shot.negative = str(inp["negative"])
        if inp.get("camera"):
            shot.camera = str(inp["camera"])
        try:
            shot.duration_sec = int(inp.get("duration_sec") or shot.duration_sec)
        except (ValueError, TypeError):
            pass
        s.add(shot)
        s.commit()
        await orchestrator.render_shot(s, shot)
        url = shot.final_clip_url or shot.video_url or shot.image_url
        return {"url": url, "shot_id": shot.id}


async def _voice_task(bind, task_id: str, inp: dict) -> dict:
    """配音卡 → voice.synth_for_shot(按说话人命中角色卡克隆音色)。"""
    with Session(bind) as s:
        shot = s.get(StudioShot, str(inp.get("shot_id") or ""))
        if not shot:
            raise RuntimeError("镜头映射缺失(任务未关联 StudioShot)")
        if inp.get("dialogue"):
            shot.dialogue = str(inp["dialogue"])
            s.add(shot)
            s.commit()
        character = None
        if shot.speaker:
            character = s.exec(
                select(StudioCharacter).where(
                    StudioCharacter.project_id == shot.project_id,
                    StudioCharacter.name == shot.speaker,
                )
            ).first()
        await voice_svc.synth_for_shot(s, shot, character)
        return {"url": shot.voice_url, "shot_id": shot.id}


async def _assemble_task(bind, task_id: str, inp: dict) -> dict:
    """合成卡 → assemble.assemble_project(ffmpeg concat 确定性拼接)。"""
    with Session(bind) as s:
        project = s.get(StudioProject, str(inp.get("project_id") or ""))
        if not project:
            raise RuntimeError("项目映射缺失(任务未关联 StudioProject)")
        shots = s.exec(
            select(StudioShot)
            .where(StudioShot.project_id == project.id)
            .order_by(StudioShot.idx)
        ).all()
        url = await assemble_svc.assemble_project(s, project, shots)
        return {"url": url, "project_id": project.id}


def _mark_task_error(bind, run_id: str, task_id: str, message: str) -> None:
    """任务标 error + 推 blocked 事件;失败原因写 verdict_json 对卡片可见。"""
    with Session(bind) as s:
        task = s.get(AgentTask, task_id)
        if not task:
            return
        task.status = "error"
        task.verdict_json = json.dumps({"error": message}, ensure_ascii=False)
        s.add(task)
        _emit(
            s, run_id, "blocked",
            {"task_id": task_id, "title": task.title, "error": message},
        )
        s.commit()


def _finish_run_error(bind, run_id: str, message: str) -> None:
    with Session(bind) as s:
        run = s.get(AgentRun, run_id)
        if not run or run.status in _TERMINAL:
            return
        run.status = "error"
        run.error = message
        run.updated_at = _utcnow()
        s.add(run)
        _emit(s, run_id, "error", {"message": message})
        s.commit()


async def _execute_assembly(run_id: str, bind) -> None:
    """合成阶段:合成确认门 approve 后触发;成功后 run done + 推 done 事件。"""
    with Session(bind) as s:
        run = s.get(AgentRun, run_id)
        if not run or run.status != "running":
            return
        assemble_ids = [
            t.id
            for t in s.exec(select(AgentTask).where(AgentTask.run_id == run_id)).all()
            if t.kind == "assemble"
        ]
    sem = asyncio.Semaphore(1)  # 占位;assemble 走 _exec_task 非渲染路径
    for tid in assemble_ids:
        with Session(bind) as s:
            cur = s.get(AgentRun, run_id)
            if not cur or cur.status == "canceled":
                return
        await _exec_task(run_id, tid, bind, sem)

    with Session(bind) as s:
        run = s.get(AgentRun, run_id)
        if not run or run.status != "running":
            return
        rows = s.exec(select(AgentTask).where(AgentTask.run_id == run_id)).all()
        failed = [t for t in rows if t.kind == "assemble" and t.status == "error"]
        run.updated_at = _utcnow()
        if failed:
            reason = _loads(failed[0].verdict_json, {}).get("error") or "合成失败"
            run.status = "error"
            run.error = f"合成失败:{reason}"
            _emit(s, run_id, "error", {"message": run.error})
        else:
            done_task = next(
                (t for t in rows if t.kind == "assemble" and t.status == "done"), None
            )
            final_url = (
                str(_loads(done_task.output_json, {}).get("url") or "")
                if done_task
                else ""
            )
            run.status = "done"
            _emit(s, run_id, "done", {"run_id": run_id, "final_url": final_url})
        s.add(run)
        s.commit()


async def _rerun_single(run_id: str, task_id: str, bind) -> None:
    """单卡重跑(regenerate);完成后若全部非合成任务就绪,重新挂起待合成门。"""
    await _exec_task(run_id, task_id, bind, asyncio.Semaphore(_RENDER_CONCURRENCY))
    with Session(bind) as s:
        run = s.get(AgentRun, run_id)
        if not run or run.status != "running":
            return
        rows = [
            t
            for t in s.exec(select(AgentTask).where(AgentTask.run_id == run_id)).all()
            if t.kind != "assemble"
        ]
        if rows and all(t.status in ("done", "approved") for t in rows):
            run.status = "awaiting_assembly"
            run.updated_at = _utcnow()
            s.add(run)
            _emit(
                s, run_id, "confirm_required",
                {"gate": "assembly", "message": "全部镜头已就绪,确认后合成"},
            )
            s.commit()
