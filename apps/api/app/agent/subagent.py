"""子 Agent 编排原型(Harness 化 M2 草案,2026-08-19;参照 DeepSeek Harness Turn/Step 语义)。

定位:AI 助手「大需求拆解」的轻量编排——与 agent_team_exec/graph(短剧流水线,
kind 固定 script/storyboard/...)互补,本模块面向任意子任务 DAG:
  用户大需求 → LLM 拆解成 N 个子任务(kind 自由,如 research/draft/image/polish)
  → 每个子任务 = 一次子 agent 运行(persona + 工具子集 + 上游产物注入)
  → DAG 依赖就绪即调度(信号量控并行),产物与事件落 AgentRun/AgentTask/AgentEvent。

复用现有底座(零新表):
  AgentRun   —— 一次编排(level="subagent"),plan_json 存拆解快照;
  AgentTask  —— DAG 节点,kind 自由,input_json/output_json 存上下文与产物;
  AgentEvent —— SSE 流水(ack/plan/task_status/done/error,与 Agent Team 卡片页同契约)。

与 runner.run() 的关系:子 agent 执行核心复用同一 llm/tools 缝
(get_ctx().service("llm"/"tools")),但不走多轮工具循环——每个子任务
单轮请求(原型从简,多轮可后续包一层)。

原型状态:未接路由。接法(草案):
  POST /api/agent/subagent  {goal, max_subagents?}  → 创建 AgentRun(status=running)
  → spawn execute_run() → GET /api/agent-team/runs/{id}/events 消费(现有端点直接可用)。
"""
from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import AsyncIterator

from sqlmodel import Session

from app.config import get_settings
from app.harness.ctx import get_ctx
from app.models import AgentRun, AgentTask, User

logger = logging.getLogger(__name__)

# 拆解指令:让 LLM 输出严格 JSON(子任务 ≤ 上限,防止成本爆炸)
_PLAN_SYSTEM = """你是任务规划器。把用户需求拆解为可独立执行的子任务 DAG。
只输出 JSON,格式:
{{"tasks": [{{"kind": "research|draft|image|video|audio|polish|verify|其它自由短词",
  "title": "一句话标题",
  "instruction": "给执行子代理的完整指令(含风格/约束/期望产物)",
  "depends_on": ["上游任务编号,如 t1"],
  "persona": "执行者人格一句话(可选,空则通用助手)",
  "tools": ["允许的工具名列表,空则全部"]}}]}}
规则:子任务数 ≤ {max_tasks};编号 t1..tN 隐式按数组顺序;depends_on 只能引用更早的任务;
能并行的不要串起来;最后必须有一个汇总/校验类任务。"""

# 单个子任务的 system 模板
_SUBAGENT_SYSTEM = """你是子代理「{title}」。
人格:{persona}
任务指令:
{instruction}

上游产物(可直接引用):
{upstream}

只做本任务范围内的事;完成后用 1-3 句话交付结果(纯文本),不要寒暄。"""

# 默认并行度(每子任务一次 LLM 调用,IO 型;再高对 vLLM 排队不友好)
_DEFAULT_CONCURRENCY = 3


def _emit(session: Session, run_id: str, type_: str, payload: dict) -> None:
    """落 AgentEvent(与 agent_team_exec._emit 同契约;独立小函数避免私有导入)。"""
    from app.models import AgentEvent

    session.add(AgentEvent(run_id=run_id, type=type_, payload_json=json.dumps(payload, ensure_ascii=False)))
    session.commit()


async def plan_subagents(goal: str, max_tasks: int = 5) -> list[dict]:
    """阶段一:LLM 把大需求拆成子任务 DAG(纯函数,不落库;供 execute_run 与单测复用)。

    返回 [{kind,title,instruction,depends_on,persona,tools}],编号 t1..tN 注入 _id。
    LLM 输出非法 JSON / 空任务时抛 ValueError(调用方决定落 error 事件)。
    """
    rsp = await get_ctx().service("llm").chat(
        [{"role": "system", "content": _PLAN_SYSTEM.format(max_tasks=max_tasks)},
         {"role": "user", "content": goal}],
    )
    raw = (rsp.get("content") or "").strip()
    # 容错:剥离 markdown 代码围栏(LLM 常见输出习惯)
    if raw.startswith("```"):
        raw = raw.split("\n", 1)[1].rsplit("```", 1)[0]
    data = json.loads(raw)
    tasks = data.get("tasks") or []
    if not tasks:
        raise ValueError("plan: empty tasks")
    for i, t in enumerate(tasks, 1):
        t["_id"] = f"t{i}"
        t.setdefault("depends_on", [])
        t.setdefault("persona", "通用创作助手")
        t.setdefault("tools", [])
    logger.info("subagent.plan: goal_len=%d tasks=%d kinds=%s",
                len(goal), len(tasks), [t["kind"] for t in tasks])
    return tasks


def _upstream_context(task: dict, done_outputs: dict[str, str]) -> str:
    """把上游子任务产物拼成注入块(原型:key-value 平铺;大产物后续可走 RAG)。"""
    deps = task.get("depends_on") or []
    if not deps:
        return "(无——本任务是起点)"
    return "\n".join(f"[{d}] {done_outputs.get(d, '(上游无产物)')}" for d in deps)


async def _run_subagent(task: dict, goal: str, done_outputs: dict[str, str]) -> str:
    """阶段二单点:执行一个子任务(单轮 LLM;工具子集为原型简化——工具执行后续接)。"""
    system = _SUBAGENT_SYSTEM.format(
        title=task["title"], persona=task.get("persona") or "通用创作助手",
        instruction=task["instruction"], upstream=_upstream_context(task, done_outputs),
    )
    rsp = await get_ctx().service("llm").chat(
        [{"role": "system", "content": system},
         {"role": "user", "content": f"总目标:{goal}\n现在执行你的任务。"}],
    )
    out = (rsp.get("content") or "").strip()
    logger.info("subagent.exec: id=%s kind=%s title_len=%d out_len=%d",
                task["_id"], task["kind"], len(task["title"]), len(out))
    return out


async def execute_run(
    run_id: str, session_factory, user: User, concurrency: int = _DEFAULT_CONCURRENCY,
) -> AsyncIterator[dict]:
    """阶段二:按 DAG 调度执行(依赖就绪即跑,信号量控并行),产出事件流。

    session_factory:() -> Session(异步上下文里按需开短会话,不跨 await 持有)。
    事件契约对齐 Agent Team:{type:plan|task_status|done|error}。
    """
    with session_factory() as s:
        run = s.get(AgentRun, run_id)
        if run is None:
            yield {"type": "error", "content": f"run {run_id} not found"}
            return
        goal = run.goal
        tasks: list[AgentTask] = _load_tasks(s, run_id)
        plan = [json.loads(t.input_json) for t in tasks]  # plan_subagents 已写进 input_json
        s.query(AgentRun).filter(AgentRun.id == run_id).update({"status": "running"})
        s.commit()
        _emit(s, run_id, "plan", {"tasks": plan})
    yield {"type": "plan", "tasks": plan}

    sem = asyncio.Semaphore(concurrency)
    done_outputs: dict[str, str] = {}
    remaining = {t["_id"]: t for t in plan}
    failed: list[str] = []

    while remaining:
        # 就绪判定:依赖全部在 done_outputs(失败依赖直接判失败,不无限等)
        ready = [t for t in remaining.values()
                 if all(d in done_outputs or d in failed for d in t["depends_on"])]
        if not ready:
            yield {"type": "error", "content": f"deadlock: {list(remaining)}"}
            return
        results = await asyncio.gather(
            *(_run_one(sem, t, goal, done_outputs) for t in ready)
        )
        for t, (ok, out) in zip(ready, results):
            tid = t["_id"]
            if ok:
                done_outputs[tid] = out
                del remaining[tid]
                yield {"type": "task_status", "task": tid, "status": "done", "out_len": len(out)}
            else:
                failed.append(tid)
                del remaining[tid]
                yield {"type": "task_status", "task": tid, "status": "error", "error": out}
            with session_factory() as s:
                _update_task(s, run_id, tid, ok, out)

    if failed:
        yield {"type": "error", "content": f"failed subtasks: {failed}"}
        with session_factory() as s:
            s.query(AgentRun).filter(AgentRun.id == run_id).update(
                {"status": "error", "error": f"failed: {failed}"})
            s.commit()
        return
    yield {"type": "done", "outputs": done_outputs}
    with session_factory() as s:
        s.query(AgentRun).filter(AgentRun.id == run_id).update({"status": "done"})
        s.commit()


async def _run_one(sem: asyncio.Semaphore, task: dict, goal: str, done_outputs: dict):
    """信号量包裹的单任务执行;返回 (ok, out)。"""
    async with sem:
        try:
            return True, await _run_subagent(task, goal, done_outputs)
        except Exception as e:  # noqa: BLE001 —— 子任务失败不拖垮整 run
            logger.warning("subagent.fail: id=%s err=%s", task.get("_id"), e)
            return False, str(e)


def _load_tasks(s: Session, run_id: str) -> list[AgentTask]:
    from sqlmodel import select

    return list(s.exec(select(AgentTask).where(AgentTask.run_id == run_id)))


def _update_task(s: Session, run_id: str, tid: str, ok: bool, out: str) -> None:
    s.query(AgentTask).filter(
        AgentTask.run_id == run_id, AgentTask.title == tid  # 原型:以 _id 存 title 列
    ).update({"status": "done" if ok else "error", "output_json": json.dumps({"text": out[:4000]}, ensure_ascii=False)})
    s.commit()


async def create_run(session: Session, user: User, goal: str, max_tasks: int = 5) -> AgentRun:
    """入口:拆解 + 落底座(run + tasks),返回 AgentRun(状态 awaiting_confirm 可选门)。

    原型从简直接 running;接路由后可先 awaiting_confirm 走现有 plan 确认门。
    """
    tasks = await plan_subagents(goal, max_tasks)
    run = AgentRun(user_id=user.id, level="L1", goal=goal, status="running")
    session.add(run)
    session.commit()
    session.refresh(run)
    for t in tasks:
        session.add(AgentTask(
            run_id=run.id, kind=t["kind"][:32], title=t["_id"],  # _id 暂存 title 列(原型)
            depends_on=json.dumps(t["depends_on"]),
            input_json=json.dumps(t, ensure_ascii=False), status="pending",
        ))
    session.commit()
    _emit(session, run.id, "ack", {"goal": goal[:200]})
    return run
