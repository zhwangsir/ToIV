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
{tool_hint}
只做本任务范围内的事;完成后用简洁的结构化文本交付结果(要点/清单优先),不要寒暄。"""

# 工具循环配置:research 类任务默认工具集 + 最大轮数(每轮可多个调用)
_RESEARCH_TOOLS = ["web_search", "search_knowledge", "model_qa", "list_models"]
_SUB_MAX_TOOL_ROUNDS = 4

_TOOL_HINT = """
可用工具(按需调用,可多轮换关键词深挖;查完再综合输出):
{tools}
- 优先 web_search 联网查新知识;平台内模型/节点细节用 search_knowledge/model_qa。
- 引用事实时标注来源 URL;查不到就明说,不要编造。
"""

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


async def _run_subagent(task: dict, goal: str, done_outputs: dict[str, str],
                        tool_ctx: dict | None = None) -> str:
    """阶段二单点:执行一个子任务。

    工具循环:task.tools 非空、或 kind=research(默认联网调研集)时,子代理可
    多轮调用工具(≤_SUB_MAX_TOOL_ROUNDS),达上限强制无工具收尾一轮。
    tool_ctx:{pool,user,session}(路由层传入;单测可 None=纯 LLM)。
    """
    allowed = [t for t in (task.get("tools") or []) if isinstance(t, str)]
    if not allowed and task.get("kind") == "research":
        allowed = list(_RESEARCH_TOOLS)
    tool_hint = _TOOL_HINT.format(tools="\n".join(f"- {t}" for t in allowed)) if allowed else ""

    system = _SUBAGENT_SYSTEM.format(
        title=task["title"], persona=task.get("persona") or "通用创作助手",
        instruction=task["instruction"], upstream=_upstream_context(task, done_outputs),
        tool_hint=tool_hint,
    )
    llm = get_ctx().service("llm")
    msgs: list[dict] = [
        {"role": "system", "content": system},
        {"role": "user", "content": f"总目标:{goal}\n现在执行你的任务。"},
    ]
    if not allowed or tool_ctx is None:
        rsp = await llm.chat(msgs)
        out = (rsp.get("content") or "").strip()
        logger.info("subagent.exec: id=%s kind=%s plain out_len=%d",
                    task["_id"], task.get("kind"), len(out))
        return out

    reg = get_ctx().service("tools")
    schemas = [s for s in reg.schemas() if s.get("function", {}).get("name") in allowed]
    for rnd in range(1, _SUB_MAX_TOOL_ROUNDS + 1):
        rsp = await llm.chat(msgs, tools=schemas)
        calls = rsp.get("tool_calls") or []
        content = rsp.get("content") or ""
        if not calls:
            logger.info("subagent.exec: id=%s kind=%s rounds=%d out_len=%d",
                        task["_id"], task.get("kind"), rnd, len(content))
            return content.strip() or "(空产出)"
        msgs.append({"role": "assistant", "content": content, "tool_calls": calls})
        for tc in calls:
            fn = tc.get("function", {})
            try:
                args = json.loads(fn.get("arguments") or "{}")
            except json.JSONDecodeError:
                args = {}
            text, _ = await reg.execute(fn.get("name", ""), args, tool_ctx)
            msgs.append({"role": "tool", "tool_call_id": tc.get("id", ""), "content": text})
    # 达轮次上限:无工具强制收尾
    rsp = await llm.chat(msgs)
    out = (rsp.get("content") or "").strip()
    logger.info("subagent.exec: id=%s kind=%s capped out_len=%d",
                task["_id"], task.get("kind"), len(out))
    return out or "(达到工具轮次上限,未产出)"


async def execute_run(
    run_id: str, session_factory, user: User, concurrency: int = _DEFAULT_CONCURRENCY,
    tool_ctx: dict | None = None, learn: bool = False,
) -> AsyncIterator[dict]:
    """阶段二:按 DAG 调度执行(依赖就绪即跑,信号量控并行),产出事件流。

    session_factory:() -> Session(异步上下文里按需开短会话,不跨 await 持有)。
    tool_ctx:{pool,user,session}——传入即启用子代理工具循环(联网调研)。
    learn=True 且 run 成功时,结束后把产物提炼为技能卡(见 distill_skills)。
    事件契约对齐 Agent Team:{type:plan|task_status|learn|done|error}。
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
            *(_run_one(sem, t, goal, done_outputs, tool_ctx) for t in ready)
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
    # 学习沉淀(可选):产物 → 技能卡(个人技能,Skill 市场可编辑/分享)
    if learn:
        try:
            with session_factory() as s:
                learned = await distill_skills(s, user, goal, done_outputs)
        except Exception as e:  # noqa: BLE001 —— 沉淀失败不影响 run 终态
            logger.warning("subagent.distill.fail: run=%s err=%s", run_id, e)
            yield {"type": "learn", "status": "error", "error": str(e)}
        else:
            yield {"type": "learn", "status": "done", "skills": learned}
    yield {"type": "done", "outputs": done_outputs}
    with session_factory() as s:
        s.query(AgentRun).filter(AgentRun.id == run_id).update({"status": "done"})
        s.commit()


# ---------------------------------------------------------------------------
# 学习成长闭环:run 产物 → 技能卡(Agent 表个人技能)
# ---------------------------------------------------------------------------

_DISTILL_SYSTEM = """你是知识沉淀器。把一次多任务协作的产物提炼为可复用的技能卡。
只输出 JSON:
{{"skills": [{{"name": "技能名(≤12字,如「水母主题提示词配方」)",
  "description": "一句话简介,含适用场景关键词(供后续按用户消息匹配注入)",
  "system_prompt": "完整人格/方法论 system prompt:如何复用本次沉淀的知识(要点式,含具体提示词模式/参数/来源结论)"}}]}}
规则:0-3 张;没有值得沉淀的(如纯一次性执行)输出 {{"skills": []}};
system_prompt 是核心资产,要具体可执行,不要空话;保留关键事实与来源。"""


async def distill_skills(session: Session, user: User, goal: str,
                         outputs: dict[str, str]) -> list[dict]:
    """把 run 产物提炼成技能卡,落 Agent 表为用户个人技能。

    返回 [{'id','name','description'}] 快照(dict,不返回 ORM——调用方
    事件构造时对象可能已 detach)。闭环:learn 产出的技能卡在 Skill 市场
    可见/可编辑/可分享;且属主对话时参与 _skills_context 匹配注入(见
    runner)——AI 学到的东西会在后续对话中直接生效。
    """
    from app.models import Agent as SkillCard, _uid

    digest = "\n\n".join(f"[{tid}] {out[:2500]}" for tid, out in outputs.items())[:9000]
    rsp = await get_ctx().service("llm").chat(
        [{"role": "system", "content": _DISTILL_SYSTEM},
         {"role": "user", "content": f"总目标:{goal}\n\n各任务产物:\n{digest}"}],
    )
    raw = (rsp.get("content") or "").strip()
    if raw.startswith("```"):
        raw = raw.split("\n", 1)[1].rsplit("```", 1)[0]
    data = json.loads(raw)
    cards: list[dict] = []
    for c in (data.get("skills") or [])[:3]:
        name = (c.get("name") or "").strip()[:24]
        prompt = (c.get("system_prompt") or "").strip()
        if not name or len(prompt) < 20:  # 过滤空壳卡
            continue
        card = SkillCard(
            id=f"learned_{_uid()[:10]}", name=name, user_id=user.id,
            description=(c.get("description") or "").strip()[:200],
            system_prompt=prompt[:6000], applies_to="all", icon="graduation-cap",
        )
        session.add(card)
        cards.append({"id": card.id, "name": name, "description": card.description})
    if cards:
        session.commit()
    logger.info("subagent.distill: goal_len=%d outputs=%d skills=%d",
                len(goal), len(outputs), len(cards))
    return cards


async def _run_one(sem: asyncio.Semaphore, task: dict, goal: str, done_outputs: dict,
                   tool_ctx: dict | None = None):
    """信号量包裹的单任务执行;返回 (ok, out)。"""
    async with sem:
        try:
            return True, await _run_subagent(task, goal, done_outputs, tool_ctx)
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
