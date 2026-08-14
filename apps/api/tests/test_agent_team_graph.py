"""R3.2 Agent Team 图编排测试:MemorySaver,不触网,不依赖真 PG。

覆盖 LangGraph 核心性质(§1.2 工程要点):
① 图全链路:Send fan-out 并行(探针断言并发数 ≥ 2)→ assembly interrupt 挂起
   → Command(resume=approve) → assemble → done;
② interrupt 挂起态持久化:同一 saver 重建图实例能从 interrupt 点恢复(模拟 api 重启);
③ 幂等:任务 done 节点重入跳过(副作用不重复,attempt 不增长);
④ 单 worker 失败 → run error,其余分支完成(与 R3.1 行为一致);
⑤ cancel:取消标志在节点间生效——在跑分支自然结束,新一波不再调度;
⑥ startup 恢复:resume_unfinished_runs 对 running run 幂等重放。

外部依赖(渲染/配音/合成)全部 mock;测试库用临时文件 SQLite(WAL + busy timeout),
保证图执行线程与断言线程并发读写不丢状态(同 test_agent_team.py 的 ctx 策略)。
"""
from __future__ import annotations

import asyncio
import json
import time

import pytest
from sqlmodel import Session, SQLModel, create_engine, select

from app.agent import llm
from app.models import AgentRun, AgentTask, Tenant, User
from app.security import hash_password
from app.services import agent_team_graph as atg
from app.services.studio import assemble as assemble_svc
from app.services.studio import orchestrator as orch
from app.services.studio import voice as voice_svc


@pytest.fixture()
def engine(tmp_path):
    db_file = tmp_path / "graph_test.db"
    eng = create_engine(
        f"sqlite:///{db_file}",
        connect_args={"check_same_thread": False, "timeout": 30},
    )
    with eng.connect() as conn:
        conn.exec_driver_sql("PRAGMA journal_mode=WAL")
    SQLModel.metadata.create_all(eng)
    yield eng
    eng.dispose()


@pytest.fixture()
def user(engine):
    with Session(engine) as s:
        t = Tenant(name="g")
        s.add(t)
        s.commit()
        u = User(email="g@t.c", hashed_password=hash_password("x"), tenant_id=t.id)
        s.add(u)
        s.commit()
        s.refresh(u)
        return u.id


@pytest.fixture(autouse=True)
def _stub_llm(monkeypatch):
    """Director Gate LLM 不触网(本文件不经创建端点,防御性 stub)。"""

    async def _boom(*a, **k):  # noqa: ANN001
        raise llm.LLMError("stub")

    monkeypatch.setattr(llm, "chat", _boom)


@pytest.fixture(autouse=True)
def _stub_svc(monkeypatch):
    """渲染/配音/合成三外部依赖替身(不触网);各用例可再覆写 render 注入探针/失败。"""

    async def _render(session, shot, pool=None):  # noqa: ANN001
        shot.status = "rendered"
        shot.video_url = f"/f/{shot.idx}.mp4"
        shot.final_clip_url = shot.video_url
        session.add(shot)
        session.commit()
        return shot

    async def _voice(session, shot, character):  # noqa: ANN001
        shot.voice_url = f"/f/{shot.idx}.wav"
        session.add(shot)
        session.commit()
        return shot.voice_url

    async def _assemble(session, project, shots):  # noqa: ANN001
        project.final_url = "/f/final.mp4"
        session.add(project)
        session.commit()
        return project.final_url

    monkeypatch.setattr(orch, "render_shot", _render)
    monkeypatch.setattr(voice_svc, "synth_for_shot", _voice)
    monkeypatch.setattr(assemble_svc, "assemble_project", _assemble)


@pytest.fixture(autouse=True)
def _fresh_saver():
    """每用例全新 MemorySaver 单例,checkpoint 不跨用例泄漏。"""
    atg._reset_for_tests()
    yield
    atg._reset_for_tests()


def _make_run(engine, user_id: str, tasks_spec: list[dict]) -> str:
    """直接落库 run(running)+ 任务卡,返回 run_id。"""
    with Session(engine) as s:
        run = AgentRun(user_id=user_id, level="L2", goal="test", status="running")
        s.add(run)
        s.commit()
        s.refresh(run)
        for spec in tasks_spec:
            s.add(
                AgentTask(
                    run_id=run.id,
                    kind=spec["kind"],
                    title=spec.get("title", ""),
                    depends_on=json.dumps(spec.get("depends_on", [])),
                    input_json=json.dumps(spec.get("input", {}), ensure_ascii=False),
                )
            )
        s.commit()
        return run.id


def _task_rows(engine, run_id: str) -> list[AgentTask]:
    with Session(engine) as s:
        return list(
            s.exec(select(AgentTask).where(AgentTask.run_id == run_id)).all()
        )


def _run_status(engine, run_id: str) -> str:
    with Session(engine) as s:
        return s.get(AgentRun, run_id).status


# ---------------------------------------------------------------------------
# ① 图全链路:fanout 并行 → assembly interrupt → resume approve → done
# ---------------------------------------------------------------------------


async def test_graph_full_flow_parallel_and_gate(engine, user, monkeypatch):
    probe = {"cur": 0, "max": 0}

    async def _timed_render(session, shot, pool=None):  # noqa: ANN001
        # 真 await 让出事件循环:两个并行 worker 同时处于渲染中才算真并发
        probe["cur"] += 1
        probe["max"] = max(probe["max"], probe["cur"])
        await asyncio.sleep(0.05)
        probe["cur"] -= 1
        shot.status = "rendered"
        shot.video_url = f"/f/{shot.idx}.mp4"
        shot.final_clip_url = shot.video_url
        session.add(shot)
        session.commit()
        return shot

    monkeypatch.setattr(orch, "render_shot", _timed_render)

    with Session(engine) as s:
        run = AgentRun(user_id=user, level="L2", goal="t", status="running")
        s.add(run)
        s.commit()
        s.refresh(run)
        v1 = AgentTask(run_id=run.id, kind="video", title="镜头1",
                       input_json=json.dumps({"scene": "s1", "prompt": "p1", "dialogue": "来", "speaker": "阿黎"}))
        i2 = AgentTask(run_id=run.id, kind="image", title="镜头2",
                       input_json=json.dumps({"scene": "s2", "prompt": "p2"}))
        s.add(v1)
        s.add(i2)
        s.commit()
        s.refresh(v1)
        a1 = AgentTask(run_id=run.id, kind="audio", title="配音1",
                       depends_on=json.dumps([v1.id]),
                       input_json=json.dumps({"shot_ref": v1.id, "dialogue": "来", "speaker": "阿黎"}))
        s.add(a1)
        s.commit()
        asm = AgentTask(run_id=run.id, kind="assemble", title="合成",
                        depends_on=json.dumps([v1.id, i2.id, a1.id]))
        s.add(asm)
        s.commit()
        run_id, v1_id, a1_id = run.id, v1.id, a1.id

    saver = await atg.get_checkpointer()
    graph = atg.build_graph(engine, saver)
    cfg = atg._thread_config(run_id)

    out = await graph.ainvoke({"run_id": run_id}, cfg)
    # 并行断言:两个根渲染任务同波并发执行
    assert probe["max"] >= 2
    # 挂起在合成确认门(interrupt),run 状态与 R3.1 一致
    assert "__interrupt__" in out
    snap = await graph.aget_state(cfg)
    assert snap.next == ("assembly_gate",)
    assert _run_status(engine, run_id) == "awaiting_assembly"
    rows = {t.id: t for t in _task_rows(engine, run_id)}
    # 配音任务依赖镜头 1,第二波才被调度 → 两级 DAG 验证
    assert rows[v1_id].status == "done" and rows[v1_id].attempt == 1
    assert rows[a1_id].status == "done" and rows[a1_id].attempt == 1

    # resume approve → assemble → done
    out2 = await graph.ainvoke(atg.Command(resume={"action": "approve", "feedback": ""}), cfg)
    assert _run_status(engine, run_id) == "done"
    asm_task = next(t for t in _task_rows(engine, run_id) if t.kind == "assemble")
    assert asm_task.status == "done"
    assert json.loads(asm_task.output_json)["url"] == "/f/final.mp4"
    # reducer 汇报通道:3 个 worker 分支(video/image/audio)各汇报一次 done
    # (assemble 是独立图节点不经 worker 汇报通道)
    statuses = [r["status"] for r in out2["results"]]
    assert statuses.count("done") == 3


# ---------------------------------------------------------------------------
# ② interrupt 挂起态持久化:重建图实例恢复(模拟 api 重启)
# ---------------------------------------------------------------------------


async def test_interrupt_state_survives_graph_rebuild(engine, user):
    run_id = _make_run(
        engine, user,
        [
            {"kind": "video", "title": "镜头1", "input": {"scene": "s1", "prompt": "p1"}},
            {"kind": "assemble", "title": "合成"},
        ],
    )
    saver = await atg.get_checkpointer()
    cfg = atg._thread_config(run_id)
    graph1 = atg.build_graph(engine, saver)
    await graph1.ainvoke({"run_id": run_id}, cfg)
    assert _run_status(engine, run_id) == "awaiting_assembly"

    # 模拟 api 重启:全新图实例,同一 saver(checkpoint 在 saver 里,不在图里)
    graph2 = atg.build_graph(engine, saver)
    snap = await graph2.aget_state(cfg)
    assert snap.next == ("assembly_gate",)
    await graph2.ainvoke(atg.Command(resume={"action": "approve"}), cfg)
    assert _run_status(engine, run_id) == "done"


# ---------------------------------------------------------------------------
# ③ 幂等:续跑/重放时已 done 任务节点跳过,attempt 不增长
# ---------------------------------------------------------------------------


async def test_resume_skips_done_tasks(engine, user, monkeypatch):
    calls: list[str] = []

    async def _counting_render(session, shot, pool=None):  # noqa: ANN001
        calls.append(shot.id)
        shot.status = "rendered"
        shot.video_url = f"/f/{shot.idx}.mp4"
        shot.final_clip_url = shot.video_url
        session.add(shot)
        session.commit()
        return shot

    monkeypatch.setattr(orch, "render_shot", _counting_render)

    run_id = _make_run(
        engine, user,
        [
            {"kind": "video", "title": "镜头1", "input": {"scene": "s1", "prompt": "p1"}},
            {"kind": "assemble", "title": "合成"},
        ],
    )
    saver = await atg.get_checkpointer()
    cfg = atg._thread_config(run_id)
    graph = atg.build_graph(engine, saver)
    await graph.ainvoke({"run_id": run_id}, cfg)
    assert len(calls) == 1

    # startup 断点续跑等价路径:ainvoke(None) 从挂起 superstep 继续
    # (挂起在 interrupt → 无 resume 值 → 再次挂起;已完成 worker 不重跑)
    out = await graph.ainvoke(None, cfg)
    assert "__interrupt__" in out
    assert _run_status(engine, run_id) == "awaiting_assembly"
    video = next(t for t in _task_rows(engine, run_id) if t.kind == "video")
    assert video.status == "done" and video.attempt == 1
    assert len(calls) == 1  # 渲染未被重复执行


# ---------------------------------------------------------------------------
# ④ 单 worker 失败 → run error,其余分支完成
# ---------------------------------------------------------------------------


async def test_worker_failure_marks_run_error_others_done(engine, user, monkeypatch):
    async def _boom_render(session, shot, pool=None):  # noqa: ANN001
        if shot.scene == "bad":
            raise RuntimeError("渲染爆炸")
        shot.status = "rendered"
        shot.video_url = f"/f/{shot.idx}.mp4"
        shot.final_clip_url = shot.video_url
        session.add(shot)
        session.commit()
        return shot

    monkeypatch.setattr(orch, "render_shot", _boom_render)

    with Session(engine) as s:
        run = AgentRun(user_id=user, level="L2", goal="t", status="running")
        s.add(run)
        s.commit()
        s.refresh(run)
        bad = AgentTask(run_id=run.id, kind="video", title="坏镜头",
                        input_json=json.dumps({"scene": "bad", "prompt": "p"}))
        good = AgentTask(run_id=run.id, kind="image", title="好镜头",
                         input_json=json.dumps({"scene": "ok", "prompt": "p"}))
        s.add(bad)
        s.add(good)
        s.commit()
        s.refresh(bad)
        dep = AgentTask(run_id=run.id, kind="audio", title="依赖坏镜头",
                        depends_on=json.dumps([bad.id]),
                        input_json=json.dumps({"shot_ref": bad.id, "dialogue": "x"}))
        s.add(dep)
        s.commit()
        run_id, bad_id, good_id, dep_id = run.id, bad.id, good.id, dep.id

    saver = await atg.get_checkpointer()
    graph = atg.build_graph(engine, saver)
    out = await graph.ainvoke({"run_id": run_id}, atg._thread_config(run_id))

    assert _run_status(engine, run_id) == "error"
    rows = {t.id: t for t in _task_rows(engine, run_id)}
    assert rows[bad_id].status == "error"
    assert rows[good_id].status == "done"  # 其他分支不受影响
    # 依赖失败任务的下游被调度器打落(doomed),与 R3.1「上游任务失败,跳过」一致
    assert rows[dep_id].status == "error"
    assert "上游任务失败" in rows[dep_id].verdict_json
    statuses = {r["task_id"]: r["status"] for r in out["results"]}
    assert statuses[bad_id] == "error"
    assert statuses[good_id] == "done"


# ---------------------------------------------------------------------------
# ⑤ cancel:在跑分支自然结束,新一波不再调度
# ---------------------------------------------------------------------------


async def test_cancel_between_nodes(engine, user, monkeypatch):
    gate = asyncio.Event()

    async def _slow_render(session, shot, pool=None):  # noqa: ANN001
        await gate.wait()
        shot.status = "rendered"
        shot.video_url = f"/f/{shot.idx}.mp4"
        shot.final_clip_url = shot.video_url
        session.add(shot)
        session.commit()
        return shot

    monkeypatch.setattr(orch, "render_shot", _slow_render)

    with Session(engine) as s:
        run = AgentRun(user_id=user, level="L2", goal="t", status="running")
        s.add(run)
        s.commit()
        s.refresh(run)
        v1 = AgentTask(run_id=run.id, kind="video", title="镜头1",
                       input_json=json.dumps({"scene": "s1", "prompt": "p"}))
        s.add(v1)
        s.commit()
        s.refresh(v1)
        a1 = AgentTask(run_id=run.id, kind="audio", title="配音",
                       depends_on=json.dumps([v1.id]),
                       input_json=json.dumps({"shot_ref": v1.id, "dialogue": "x"}))
        s.add(a1)
        s.commit()
        run_id, v1_id, a1_id = run.id, v1.id, a1.id

    saver = await atg.get_checkpointer()
    graph = atg.build_graph(engine, saver)
    cfg = atg._thread_config(run_id)
    task = asyncio.create_task(graph.ainvoke({"run_id": run_id}, cfg))

    # 等第一波 worker 进入渲染(running)后取消 run
    deadline = time.time() + 5
    while time.time() < deadline:
        rows = {t.id: t for t in _task_rows(engine, run_id)}
        if rows[v1_id].status == "running":
            break
        await asyncio.sleep(0.02)
    assert rows[v1_id].status == "running"
    with Session(engine) as s:
        r = s.get(AgentRun, run_id)
        r.status = "canceled"
        s.add(r)
        s.commit()
    gate.set()  # 在跑分支自然结束(R3.1 不追杀语义)
    await task

    assert _run_status(engine, run_id) == "canceled"
    rows = {t.id: t for t in _task_rows(engine, run_id)}
    assert rows[v1_id].status == "done"  # 在跑的跑完
    assert rows[a1_id].status == "pending" and rows[a1_id].attempt == 0  # 新一波不再调度


# ---------------------------------------------------------------------------
# ⑥ startup 恢复:resume_unfinished_runs 幂等重放 running run
# ---------------------------------------------------------------------------


async def test_resume_unfinished_runs_recovers(engine, user, monkeypatch):
    calls: list[str] = []

    async def _counting_render(session, shot, pool=None):  # noqa: ANN001
        calls.append(shot.id)
        shot.status = "rendered"
        shot.video_url = f"/f/{shot.idx}.mp4"
        shot.final_clip_url = shot.video_url
        session.add(shot)
        session.commit()
        return shot

    monkeypatch.setattr(orch, "render_shot", _counting_render)

    # 场景:api 重启前任务已全部完成并挂起在确认门;MemorySaver 重启丢失 checkpoint
    # → 恢复时应幂等重放(渲染不重复),重新武装到 awaiting_assembly 等用户裁决
    run_id = _make_run(
        engine, user,
        [
            {"kind": "video", "title": "镜头1", "input": {"scene": "s1", "prompt": "p1"}},
            {"kind": "assemble", "title": "合成"},
        ],
    )
    # 先把 run 推进到 awaiting_assembly(模拟重启前状态)
    saver = await atg.get_checkpointer()
    graph = atg.build_graph(engine, saver)
    await graph.ainvoke({"run_id": run_id}, atg._thread_config(run_id))
    assert _run_status(engine, run_id) == "awaiting_assembly"
    assert len(calls) == 1

    # 模拟重启:checkpoint 丢失(MemorySaver 换新),run 被人为留在 running
    # (R3.1 遗留 run 就是这种形态:内存执行器丢失,状态卡在 running)
    atg._reset_for_tests()
    with Session(engine) as s:
        r = s.get(AgentRun, run_id)
        r.status = "running"
        s.add(r)
        s.commit()

    n = await atg.resume_unfinished_runs(engine)
    assert n == 1
    # 恢复协程是后台 spawn,轮询等收敛
    deadline = time.time() + 5
    while time.time() < deadline:
        if _run_status(engine, run_id) == "awaiting_assembly":
            break
        await asyncio.sleep(0.05)
    assert _run_status(engine, run_id) == "awaiting_assembly"
    assert len(calls) == 1  # 幂等:已 done 任务不重跑
    video = next(t for t in _task_rows(engine, run_id) if t.kind == "video")
    assert video.attempt == 1
