"""R3.2 Agent Team 执行器:LangGraph StateGraph + checkpoint 断点续跑。

承接 R3.1(routes/agent_team.py 的手写 asyncio 拓扑循环),按
docs/2026-08-14-competitive-r3-r5-deep-dive.md §1.2/§1.3.1 落地:

- 拓扑:START → setup(建 Studio 工程,幂等)→ schedule(确定性调度,非 LLM)
    ⇄ worker(Send API 并行 fan-out,每波完成后 join 回 schedule 再调度下一波)
    → join_eval(汇总:有失败 → run error;全就绪 → 挂起待合成门)
    → assembly_gate(interrupt 确认门)→ assemble(ffmpeg 合成)→ END。
- State:run_id 为键;results 是并行分支共写的汇报通道,必须配 reducer
  (Annotated[list, operator.add],否则 InvalidUpdateError,§1.2 工程要点)。
- 确认门:assembly_gate 节点内 interrupt();resume 端点投递
  Command(resume={"action", "feedback"})。plan 门保持在图外(approve 才启动图)。
- checkpointer:thread_id = run.id。生产 database_url 是
  postgresql+psycopg:// → 转 psycopg3 DSN 给 AsyncPostgresSaver(复用 core PG18,
  checkpoint 跨进程存活);测试/开发(SQLite)回退 MemorySaver —— SQLite 不支持
  PG saver,进程内存重启即丢,靠幂等重放兜底,行为一致。
- 副作用幂等(§1.2 告诫:checkpoint 只保证状态可恢复,不保证副作用 exactly-once):
  worker 节点执行前查 AgentTask 表,done/approved 直接跳过;幂等键
  run_id+task_id+attempt 仍由 R3.1 的 _exec_task 落库。
- 事件/状态写库完全复用 R3.1(AgentEvent/AgentTask/AgentRun 更新点不变,SSE 契约不变)。

单任务执行函数(_exec_task/_setup_studio_project/_mark_task_error 等)已下沉到
services/agent_team_exec.py(H3 循环依赖清理),本模块直接 import,
不再惰性 import routes/agent_team.py。
"""
from __future__ import annotations

import asyncio
import logging
import operator
import re
import threading
from typing import Annotated, Any, TypedDict

from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, START, StateGraph
from langgraph.types import Command, Send, interrupt
from sqlmodel import Session, select

from app.config import get_settings
from app.models import AgentRun, AgentTask
from app.services.agent_team_exec import (
    _ACTIVE_RUNS,
    _RENDER_CONCURRENCY,
    _emit,
    _exec_task,
    _finish_run_error,
    _loads,
    _mark_task_error,
    _setup_studio_project,
    _utcnow,
)

logger = logging.getLogger(__name__)

# 后台图执行协程强引用表:asyncio 仅持弱引用,不持强引用任务可能被 GC 提前回收
# (与 services/agent_team_exec.py 的 _RUNNER_TASKS、comfy/tracker.py 的 _tasks 同一模式)
_GRAPH_TASKS: set[asyncio.Task] = set()


# ---------------------------------------------------------------------------
# State:并行分支共写 results 必须配 reducer(§1.2 工程要点第一条)
# ---------------------------------------------------------------------------


class AgentTeamState(TypedDict, total=False):
    """图状态。任务真相永远在 AgentTask 表(DB 是唯一事实源),state 只带游标:

    - run_id:图操作对象(= checkpoint thread_id);
    - results:worker 完成汇报通道,Send 并行分支同写,operator.add 归并;
    - approval:assembly_gate resume 注入的裁决 {action, feedback}。
    """

    run_id: str
    results: Annotated[list[dict], operator.add]
    approval: dict


def _thread_config(run_id: str) -> dict:
    """LangGraph RunnableConfig:thread_id = agent_run_id(§1.3.1 架构图)。"""
    return {"configurable": {"thread_id": run_id}}


# ---------------------------------------------------------------------------
# checkpointer:生产 PostgresSaver / 测试开发 MemorySaver(SQLite 回退)
# ---------------------------------------------------------------------------

_SAVER: Any = None
# threading.Lock 而非 asyncio.Lock:后者绑定首次使用的事件循环,而 pytest-asyncio
# 每个用例一个新循环,跨用例复用会抛 "attached to a different loop"
_SAVER_LOCK = threading.Lock()


def _pg_dsn(database_url: str) -> str:
    """SQLAlchemy URL → psycopg3 连接串(剥掉 +psycopg 等方言后缀)。"""
    return re.sub(r"^postgresql\+\w+://", "postgresql://", database_url)


async def _create_checkpointer() -> Any:
    settings = get_settings()
    url = settings.database_url
    if settings.agent_pg_checkpointer and url.startswith("postgresql"):
        try:
            # 惰性 import:CI/测试环境不装 langgraph-checkpoint-postgres 也能跑
            # (MemorySaver 随 langgraph 自带);生产 requirements.txt 才装
            from psycopg.rows import dict_row
            from psycopg_pool import AsyncConnectionPool

            from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver

            # autocommit/prepare_threshold=0/dict_row 与官方 from_conn_string 一致;
            # 用连接池而非 from_conn_string:后者是 asynccontextmanager 单连接,
            # 生命周期要挂在请求上,不适合作应用级常驻 saver
            pool = AsyncConnectionPool(
                _pg_dsn(url),
                min_size=1,
                max_size=4,
                open=False,
                kwargs={
                    "autocommit": True,
                    "prepare_threshold": 0,
                    "row_factory": dict_row,
                },
            )
            await pool.open()
            saver = AsyncPostgresSaver(pool)
            await saver.setup()  # 首用必须建表/迁移(官方要求显式调用)
            logger.info("Agent Team checkpointer:PostgresSaver 已就绪")
            return saver
        except Exception:
            # PG 不可达不拖垮启动:回退内存 saver(重启丢失,幂等重放兜底)
            logger.exception("Agent Team PostgresSaver 初始化失败,回退 MemorySaver")
    else:
        logger.info("Agent Team checkpointer:MemorySaver(非 PG 或已显式关闭)")
    return MemorySaver()


async def get_checkpointer() -> Any:
    """进程级 saver 单例(懒加载)。竞态双建取先建者,丢弃本实例即可:

    MemorySaver 无外部资源;PG 池在生产是单事件循环顺序启动,不会竞态。
    """
    global _SAVER
    if _SAVER is None:
        saver = await _create_checkpointer()
        with _SAVER_LOCK:
            if _SAVER is None:
                _SAVER = saver
            else:
                saver = _SAVER
    return _SAVER


def _reset_for_tests() -> None:
    """测试隔离:清掉 saver 单例(MemorySaver 状态随实例,换新即全新 checkpoint 空间)。"""
    global _SAVER
    with _SAVER_LOCK:
        _SAVER = None


# ---------------------------------------------------------------------------
# 图节点:DB 是唯一事实源,节点只做「读任务表 → 调 R3.1 执行函数 → 写状态/事件」
# ---------------------------------------------------------------------------


def _setup_node(state: AgentTeamState, bind) -> dict:
    """建 Studio 工程(StudioProject/角色/StudioShot 映射回写任务 input)。

    幂等:断点重放/恢复时会再次进入本节点,已建过(任务 input 含 project_id)直接跳过,
    否则每个 run 会重复建工程(R3.1 不恢复所以无此问题,R3.2 必须防)。
    """
    run_id = state["run_id"]
    with Session(bind) as s:
        row = s.exec(
            select(AgentTask).where(AgentTask.run_id == run_id).limit(1)
        ).first()
        if row and '"project_id"' in (row.input_json or ""):
            return {}
    _setup_studio_project(run_id, bind)
    return {}


async def _schedule_node(state: AgentTeamState, bind) -> Command:
    """确定性调度器(非 LLM,§1.2.2 吸收 Google ADK 思想):

    每波 worker join 后重入:把依赖已满足的非合成任务用 Send 并行扇出;
    上游失败的任务标 error 打落(doomed);无待办 → join_eval 收口;
    run 被取消 → 直接 END(在跑分支自然结束,R3.1 不追杀语义不变)。
    """
    run_id = state["run_id"]
    with Session(bind) as s:
        run = s.get(AgentRun, run_id)
        status = run.status if run else "canceled"
        rows = s.exec(select(AgentTask).where(AgentTask.run_id == run_id)).all()
    if status != "running":
        return Command(goto=END)

    work = {t.id: t for t in rows if t.kind != "assemble"}
    states = {tid: t.status for tid, t in work.items()}
    pending = [t for t in work.values() if t.status == "pending"]
    schedulable, doomed = [], []
    for t in pending:
        # 未知依赖(计划编辑已删的)忽略,与 R3.1 一致;上游 error → 本任务打落
        deps = [d for d in _loads(t.depends_on, []) if d in work]
        if any(states.get(d) == "error" for d in deps):
            doomed.append(t)
        elif all(states.get(d) in ("done", "approved") for d in deps):
            schedulable.append(t)
    for t in doomed:
        _mark_task_error(bind, run_id, t.id, "上游任务失败,跳过")
    if schedulable:
        return Command(
            goto=[Send("worker", {"run_id": run_id, "task_id": t.id}) for t in schedulable]
        )
    if pending:
        # 本轮无 Send = 没有在跑分支;仍有 pending = 依赖永远无法满足。
        # 防死循环安全阀(理论不可达:R3.1 同位有同款保护)
        logger.error("agent run %s 调度死锁,剩余任务标 error", run_id)
        for t in pending:
            if t.id not in {d.id for d in doomed}:
                _mark_task_error(bind, run_id, t.id, "调度死锁:依赖无法满足")
    return Command(goto="join_eval")


async def _worker_node(state: dict, bind, sem: asyncio.Semaphore) -> dict:
    """执行单任务:queued→running→done/error(复用 agent_team_exec._exec_task)。

    幂等屏障(§1.2 工程要点:checkpoint 不保证副作用 exactly-once):
    断点恢复/重放会再次进入本节点,任务已 done/approved 直接跳过,
    不重复渲染/扣费。结果经 results reducer 汇报,供测试观测并行度。
    """
    run_id, task_id = state["run_id"], state["task_id"]
    with Session(bind) as s:
        task = s.get(AgentTask, task_id)
        run = s.get(AgentRun, run_id)
        if not task or not run or run.status == "canceled":
            return {"results": [{"task_id": task_id, "status": "canceled"}]}
        if task.status in ("done", "approved"):
            return {"results": [{"task_id": task_id, "status": "skipped"}]}
    await _exec_task(run_id, task_id, bind, sem)
    with Session(bind) as s:
        task = s.get(AgentTask, task_id)
        final = task.status if task else "error"
    return {"results": [{"task_id": task_id, "status": final}]}


def _join_eval_node(state: AgentTeamState, bind) -> Command:
    """汇总一波调度结果(与 R3.1 执行器收尾逐点一致):

    - run 已非 running(调度期间被 cancel)→ END,不碰状态;
    - 有失败任务 → run error + error 事件(已完成产物保留,可单卡 regenerate 挽救);
    - 全部就绪 → run awaiting_assembly + confirm_required 事件 → 合成确认门。
    """
    run_id = state["run_id"]
    with Session(bind) as s:
        run = s.get(AgentRun, run_id)
        if not run or run.status != "running":
            return Command(goto=END)
        rows = [
            t
            for t in s.exec(select(AgentTask).where(AgentTask.run_id == run_id)).all()
            if t.kind != "assemble"
        ]
        failed = [t for t in rows if t.status == "error"]
        run.updated_at = _utcnow()
        if failed:
            run.status = "error"
            run.error = (
                f"{len(failed)} 个任务失败;已完成产物保留,"
                "可单卡重生成,或 cancel 后重建"
            )
            _emit(
                s, run_id, "error",
                {"message": run.error, "failed": [t.id for t in failed]},
            )
            s.add(run)
            s.commit()
            return Command(goto=END)
        run.status = "awaiting_assembly"
        _emit(
            s, run_id, "confirm_required",
            {"gate": "assembly", "message": "全部镜头已就绪,确认后合成"},
        )
        s.add(run)
        s.commit()
    return Command(goto="assembly_gate")


def _assembly_gate_node(state: AgentTeamState, bind) -> Command:
    """合成确认门:interrupt() 挂起等 HITL 裁决;Command(resume=...) 恢复。

    ⚠️ resume 时节点从头重跑、interrupt() 返回裁决值,所以本节点必须保持
    「interrupt 前零副作用」——挂起时的状态/事件写库全部前置到 join_eval,
    否则每次 resume 都会重复发 confirm_required、重复改写 run 状态。

    approve → assemble;reject → run 回 running 后图结束(用户可单卡 regenerate
    重新到达门,此时 resume 走「幂等重放再投递」路径,见 spawn_assembly_decision)。
    """
    decision = interrupt({"gate": "assembly", "message": "全部镜头已就绪,确认后合成"})
    decision = decision if isinstance(decision, dict) else {}
    action = decision.get("action")
    if action == "approve":
        # 幂等重放路径(join_eval 刚把 run 挂回 awaiting_assembly)下,先把状态拉回
        # running,否则 assemble 节点的「非 running 退出」检查会让重放后的合成被跳过;
        # 正常路径端点已置 running,此处为幂等 no-op
        with Session(bind) as s:
            run = s.get(AgentRun, state["run_id"])
            if run and run.status == "awaiting_assembly":
                run.status = "running"
                run.updated_at = _utcnow()
                s.add(run)
                s.commit()
        return Command(update={"approval": decision}, goto="assemble")
    # reject(或未知动作):不合成,回 running 等单卡干预;事件不发(R3.1 同样无事件)
    with Session(bind) as s:
        run = s.get(AgentRun, state["run_id"])
        if run and run.status == "awaiting_assembly":
            run.status = "running"
            run.updated_at = _utcnow()
            s.add(run)
            s.commit()
    return Command(update={"approval": decision}, goto=END)


async def _assemble_node(state: AgentTeamState, bind, sem: asyncio.Semaphore) -> dict:
    """合成阶段:跑合成卡(ffmpeg concat 确定性拼接),成功 run done + done 事件。

    与 R3.1 _execute_assembly 逐点一致;run 非 running(cancel)直接退出。
    幂等:合成卡不走 schedule,这里显式查状态,done 则跳过执行只补 run 终态
    (防断点重放重复跑 ffmpeg 合成)。
    """
    run_id = state["run_id"]
    with Session(bind) as s:
        run = s.get(AgentRun, run_id)
        if not run or run.status != "running":
            return {}
        assemble_ids = [
            t.id
            for t in s.exec(select(AgentTask).where(AgentTask.run_id == run_id)).all()
            if t.kind == "assemble"
        ]
    for tid in assemble_ids:
        with Session(bind) as s:
            cur = s.get(AgentRun, run_id)
            if not cur or cur.status == "canceled":
                return {}
            done_already = s.get(AgentTask, tid).status == "done"
        if not done_already:
            await _exec_task(run_id, tid, bind, sem)

    with Session(bind) as s:
        run = s.get(AgentRun, run_id)
        if not run or run.status != "running":
            return {}
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
    return {}


# ---------------------------------------------------------------------------
# 图装配:每次调用编译一个新图(节点闭包捕获 bind/sem);saver 共享故 checkpoint 互通
# ---------------------------------------------------------------------------


def build_graph(bind, checkpointer: Any, sem: asyncio.Semaphore | None = None):
    """装配并编译 Agent Team 图。

    图编译本身无 I/O、代价可忽略;按调用方装配让节点闭包捕获请求侧 DB bind
    (测试用 StaticPool 内存库、生产用全局 engine),saver 单例共享保证
    「重建图实例也能从 checkpoint 恢复」(模拟 api 重启的关键性质)。
    """
    if sem is None:
        # 渲染并发上限与 R3.1 一致(对齐 ComfyUI-LB 后端规模,防瞬间打爆 worker)
        sem = asyncio.Semaphore(at_render_concurrency())

    # 具名闭包而非 lambda:langgraph 靠 inspect.iscoroutinefunction 区分同步/异步节点,
    # lambda 返回协程会被误判为同步节点(丢进线程池执行协程对象,直接报错)
    async def schedule(state: AgentTeamState) -> Command:
        return await _schedule_node(state, bind)

    async def worker(state: dict) -> dict:
        return await _worker_node(state, bind, sem)

    async def assemble(state: AgentTeamState) -> dict:
        return await _assemble_node(state, bind, sem)

    def setup(state: AgentTeamState) -> dict:
        return _setup_node(state, bind)

    def join_eval(state: AgentTeamState) -> Command:
        return _join_eval_node(state, bind)

    def assembly_gate(state: AgentTeamState) -> Command:
        return _assembly_gate_node(state, bind)

    g = StateGraph(AgentTeamState)
    g.add_node("setup", setup)
    g.add_node("schedule", schedule)
    g.add_node("worker", worker)
    g.add_node("join_eval", join_eval)
    g.add_node("assembly_gate", assembly_gate)
    g.add_node("assemble", assemble)
    g.add_edge(START, "setup")
    g.add_edge("setup", "schedule")
    # worker 完成默认回流 schedule(LangGraph join 语义:同波并行分支全完成才重入);
    # schedule 内部用 Command(goto=[Send...]) 决定下一波扇出/收口
    g.add_edge("worker", "schedule")
    g.add_edge("assemble", END)
    return g.compile(checkpointer=checkpointer)


def at_render_concurrency() -> int:
    """渲染并发上限独立成函数:测试可 monkeypatch 调小;与 R3.1 _RENDER_CONCURRENCY 对齐。"""
    return _RENDER_CONCURRENCY


# ---------------------------------------------------------------------------
# 启动/恢复入口(供 routes 端点与 main.py startup 调用)
# ---------------------------------------------------------------------------


def _spawn(coro) -> None:
    task = asyncio.create_task(coro)
    _GRAPH_TASKS.add(task)
    task.add_done_callback(_GRAPH_TASKS.discard)


def spawn_run(run_id: str, bind) -> None:
    """plan 确认门 approve 后启动图(替代 R3.1 的 _spawn_run)。"""
    if run_id in _ACTIVE_RUNS:
        return
    _ACTIVE_RUNS.add(run_id)

    async def _wrap() -> None:
        try:
            saver = await get_checkpointer()
            graph = build_graph(bind, saver)
            await graph.ainvoke({"run_id": run_id}, _thread_config(run_id))
        except Exception:
            logger.exception("agent run %s 图执行异常", run_id)
            _finish_run_error(bind, run_id, "执行器内部异常")
        finally:
            _ACTIVE_RUNS.discard(run_id)

    _spawn(_wrap())


def spawn_assembly_decision(run_id: str, bind, decision: dict) -> None:
    """合成确认门裁决投递:Command(resume={action, feedback})。

    图可能不在挂起态(reject 后单卡 regenerate 重新就绪、或 MemorySaver 进程
    重启丢了 checkpoint):此时先以初始 state 幂等重放(已完成任务节点自查跳过),
    重新武装到 interrupt 后再投递裁决。
    """
    if run_id in _ACTIVE_RUNS:
        return
    _ACTIVE_RUNS.add(run_id)

    async def _wrap() -> None:
        try:
            saver = await get_checkpointer()
            graph = build_graph(bind, saver)
            cfg = _thread_config(run_id)
            snap = await graph.aget_state(cfg)
            if not snap.next and decision.get("action") != "approve":
                # reject/modify 且图未挂门:没有裁决需要投递(端点已把 run 置 running),
                # 不必为重放付出一次空跑
                return
            if not snap.next:
                await graph.ainvoke({"run_id": run_id}, cfg)
                snap = await graph.aget_state(cfg)
            if snap.next:
                await graph.ainvoke(Command(resume=decision), cfg)
            else:
                logger.warning(
                    "agent run %s 合成门裁决无处投递(图未挂起且重放未武装)", run_id
                )
        except Exception:
            logger.exception("agent run %s 合成裁决投递异常", run_id)
            _finish_run_error(bind, run_id, "执行器内部异常")
        finally:
            _ACTIVE_RUNS.discard(run_id)

    _spawn(_wrap())


async def resume_unfinished_runs(bind) -> int:
    """api 启动恢复:非终态 run 从 checkpoint 断点续跑(替代 R3.1「重启即中断」限制)。

    - running:有 checkpoint → ainvoke(None) 从挂起的 superstep 续跑;
      无 checkpoint(MemorySaver 重启丢失/R3.1 遗留 run)→ 初始 state 幂等重放,
      已完成任务节点自查跳过,未完成的任务重新执行;
    - awaiting_assembly:正挂在确认门等用户裁决,不自动推进;
    - 单个 run 恢复失败标 error 落库,不拖垮启动与其余 run。

    返回成功重挂的 run 数(记日志用)。
    """
    with Session(bind) as s:
        runs = s.exec(
            select(AgentRun).where(AgentRun.status.in_(("running", "awaiting_assembly")))
        ).all()
        snapshot = [(r.id, r.status) for r in runs]
    resumed = 0
    for run_id, status in snapshot:
        if status != "running":
            continue  # awaiting_assembly = 挂门等用户,不在启动侧自动推进
        try:
            saver = await get_checkpointer()
            graph = build_graph(bind, saver)
            cfg = _thread_config(run_id)
            snap = await graph.aget_state(cfg)
            # 有挂起点 → 续跑;无 checkpoint → 幂等重放。两种入口都用 spawn_run 之外的
            # 独立协程,避免与「plan approve 新启动」共用 _ACTIVE_RUNS 键空间时语义混淆
            _spawn_resume(run_id, bind, from_checkpoint=bool(snap.next))
            resumed += 1
        except Exception:
            logger.exception("agent run %s 断点恢复失败,标 error", run_id)
            try:
                _finish_run_error(bind, run_id, "api 重启后断点恢复失败")
            except Exception:
                logger.exception("agent run %s 标 error 也失败", run_id)
    if snapshot:
        logger.info(
            "Agent Team 启动恢复:非终态 run %d 个(running %d / awaiting_assembly %d),重挂 %d 个",
            len(snapshot),
            sum(1 for _, st in snapshot if st == "running"),
            sum(1 for _, st in snapshot if st == "awaiting_assembly"),
            resumed,
        )
    return resumed


def _spawn_resume(run_id: str, bind, *, from_checkpoint: bool) -> None:
    """startup 断点续跑协程(与 spawn_run 的区别仅入口:None=从 checkpoint 续)。"""
    if run_id in _ACTIVE_RUNS:
        return
    _ACTIVE_RUNS.add(run_id)

    async def _wrap() -> None:
        try:
            saver = await get_checkpointer()
            graph = build_graph(bind, saver)
            cfg = _thread_config(run_id)
            if from_checkpoint:
                # None 输入 = 从 checkpoint 挂起的 superstep 续跑,已完成节点不重放
                await graph.ainvoke(None, cfg)
            else:
                await graph.ainvoke({"run_id": run_id}, cfg)
        except Exception:
            logger.exception("agent run %s 断点续跑异常", run_id)
            _finish_run_error(bind, run_id, "api 重启后断点恢复失败")
        finally:
            _ACTIVE_RUNS.discard(run_id)

    _spawn(_wrap())
