"""Agent Team 单任务执行函数:从 routes/agent_team.py 下沉到 services 层。

清理 routes ↔ services 循环依赖(H3 任务 3):
- routes/agent_team.py 保留端点(HTTP 层),本模块承载单任务执行逻辑;
- services/agent_team_graph.py 的图节点直接 import 本模块,不再惰性 import routes;
- routes/agent_team.py 同样 import 本模块(单卡重跑 _rerun_single)。

函数签名与行为不变(test_agent_team.py/test_agent_team_graph.py 19 例是锁)。
"""
from __future__ import annotations

import asyncio
import json
import logging
from contextlib import nullcontext
from datetime import datetime, timezone

from sqlmodel import Session, select

from app.models import (
    AgentEvent,
    AgentRun,
    AgentTask,
    StudioCharacter,
    StudioProject,
    StudioShot,
    User,
)
from app.services.studio import assemble as assemble_svc
from app.services.studio import orchestrator
from app.services.studio import voice as voice_svc

logger = logging.getLogger(__name__)

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


def _emit(session: Session, run_id: str, type_: str, payload: dict) -> None:
    """写一条 SSE 事件(调用方负责 commit;与状态变更同 commit 保证原子可见)。"""
    session.add(
        AgentEvent(
            run_id=run_id,
            type=type_,
            payload_json=json.dumps(payload, ensure_ascii=False),
        )
    )


def _spawn(coro) -> None:
    """fire-and-forget 启动后台协程(强引用防 GC,同 tracker.spawn 模式)。"""
    task = asyncio.create_task(coro)
    _RUNNER_TASKS.add(task)
    task.add_done_callback(_RUNNER_TASKS.discard)


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


def _tasks_of(session: Session, run: AgentRun) -> list[AgentTask]:
    """按 plan_json 快照顺序返回任务(计划编辑删增后仍保持稳定展示序)。"""
    rows = list(
        session.exec(select(AgentTask).where(AgentTask.run_id == run.id)).all()
    )
    plan = _loads(run.plan_json, {})
    order = {t.get("id"): i for i, t in enumerate(plan.get("tasks") or [])}
    rows.sort(key=lambda t: order.get(t.id, len(order)))
    return rows


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
