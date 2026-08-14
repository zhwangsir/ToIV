"""R3.1/R3.2 Agent Team 路由测试:创建分级/秒回契约/归属/计划编辑/确认门/执行器/取消/重生/SSE。

外部依赖全部 mock:storyboard.parse_script(LLM 拆解)、orchestrator.render_shot
(ComfyUI 渲染)、voice.synth_for_shot(TTS)、assemble.assemble_project(ffmpeg)、
llm.chat(R3.2 Director Gate LLM 分级),不触网。执行器是 LangGraph 图后台协程,
测试用轮询 run 详情的方式等待状态收敛。
"""
from __future__ import annotations

import json
import time

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

import app.services.studio.orchestrator as orch
from app.agent import llm
from app.db import get_session
from app.main import app
from app.models import AgentRun, Tenant, User
from app.security import create_token, hash_password
from app.services.studio import assemble as assemble_svc
from app.services.studio import storyboard
from app.services.studio import voice as voice_svc
from app.services.studio.schemas import CharacterDraft, ShotDraft


@pytest.fixture()
def ctx(tmp_path):
    # R3.2 起后台图任务跑在独立线程 loop(见 _graph_bg_loop),与 TestClient 的
    # per-request portal 线程真并发。内存 StaticPool 全局只有一条连接,跨线程并发
    # 会话会共享事务上下文:一线程会话 close 触发 rollback 会把另一线程未提交的
    # 写滚掉(偶发丢状态,flaky 根源)。故改用临时文件库 + 每会话独立连接,
    # 获得真实提交语义;WAL + busy timeout 防读写互斥锁等待失败。
    db_file = tmp_path / "agent_team_test.db"
    engine = create_engine(
        f"sqlite:///{db_file}",
        connect_args={"check_same_thread": False, "timeout": 30},
    )
    with engine.connect() as conn:
        conn.exec_driver_sql("PRAGMA journal_mode=WAL")
    SQLModel.metadata.create_all(engine)

    def override() -> Session:
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override
    with Session(engine) as s:
        tenant = Tenant(name="agent-team")
        s.add(tenant)
        s.commit()
        s.refresh(tenant)
        user = User(
            email="leader@toiv.ai",
            hashed_password=hash_password("password1"),
            tenant_id=tenant.id,
        )
        s.add(user)
        s.commit()
        s.refresh(user)
        uid = user.id
        tid = tenant.id
    yield TestClient(app), create_token(uid), engine, tid
    app.dependency_overrides.clear()


def _h(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


import asyncio
import threading


@pytest.fixture(scope="session")
def _graph_bg_loop():
    """为 LangGraph 后台任务提供跨 TestClient 请求存活的 event loop。

    TestClient 的 ASGI transport 使用 per-request anyio blocking portal,
    请求结束后 portal 关闭,其 event loop 不再调度新 task → fire-and-forget
    的后台图任务在响应后死亡。本 fixture 启动独立 daemon 线程跑 asyncio
    event loop,所有图任务改投到此 loop,测试中轮询即可观测状态收敛。
    """
    loop = asyncio.new_event_loop()
    t = threading.Thread(target=loop.run_forever, daemon=True)
    t.start()
    yield loop
    loop.call_soon_threadsafe(loop.stop)
    t.join(timeout=2)


@pytest.fixture(autouse=True)
def _patch_spawn_for_tests(monkeypatch, _graph_bg_loop):
    """把图与单卡重跑的后台协程都改投到独立后台 loop,保证跨请求存活。"""
    from app.routes import agent_team as at
    from app.services import agent_team_graph as atg

    def bg_spawn(coro):
        def _do():
            task = _graph_bg_loop.create_task(coro)
            atg._GRAPH_TASKS.add(task)
            task.add_done_callback(atg._GRAPH_TASKS.discard)

        _graph_bg_loop.call_soon_threadsafe(_do)

    def bg_spawn_at(coro):
        def _do():
            task = _graph_bg_loop.create_task(coro)
            at._RUNNER_TASKS.add(task)
            task.add_done_callback(at._RUNNER_TASKS.discard)

        _graph_bg_loop.call_soon_threadsafe(_do)

    monkeypatch.setattr(atg, "_spawn", bg_spawn)
    monkeypatch.setattr(at, "_spawn", bg_spawn_at)
    # 同时清掉可能跨用例残留的 saver 单例(MemorySaver 状态随实例)
    atg._reset_for_tests()


@pytest.fixture(autouse=True)
def _stub_director_llm(monkeypatch):
    """Director Gate LLM 分级替身:默认立即失败 → 走启发式兜底。

    R3.2 起创建 run 先调 llm.chat 分级;本模块既有用例的契约断言与分级来源无关,
    替身快速失败即可让它们保持原样全绿,同时保证不触网(开发机可能直连 LLM)。
    LLM 成功/失败两条路径由末尾 ⑥⑦ 专项用例覆盖(测试内再 monkeypatch 覆盖本替身)。
    """

    async def _boom(messages, tools=None, max_tokens=None, temperature=0.4):  # noqa: ANN001
        raise llm.LLMError("测试替身:Director Gate LLM 未 mock")

    monkeypatch.setattr(llm, "chat", _boom)


def _fake_parse(shots: list[ShotDraft] | None = None):
    """storyboard.parse_script 替身:2 个分镜(一视频镜带台词 + 一图像运镜镜)。"""

    async def fake(premise, num_shots=8, style=""):  # noqa: ANN001
        chars = [
            CharacterDraft(name="阿黎", description="女主", visual_prompt="1girl, black hair")
        ]
        return chars, shots or [
            ShotDraft(
                scene="雨夜重逢", prompt="rain alley, 阿黎 (1girl, black hair)",
                dialogue="你终于来了", speaker="阿黎", render_mode="video",
            ),
            ShotDraft(scene="旧照片", prompt="old photo on table", render_mode="image_motion"),
        ]

    return fake


async def _fake_render(session, shot, pool=None):  # noqa: ANN001
    shot.status = "rendered"
    shot.video_url = f"/api/studio/files/{shot.idx}.mp4"
    shot.final_clip_url = shot.video_url
    session.add(shot)
    session.commit()
    return shot


async def _fake_voice(session, shot, character):  # noqa: ANN001
    shot.voice_url = f"/api/studio/files/{shot.idx}.wav"
    shot.status = "voiced"
    session.add(shot)
    session.commit()
    return shot.voice_url


async def _fake_assemble(session, project, shots):  # noqa: ANN001
    project.final_url = "/api/studio/files/final-fake.mp4"
    project.status = "ready"
    session.add(project)
    session.commit()
    return project.final_url


def _mock_pipeline(monkeypatch, shots: list[ShotDraft] | None = None) -> None:
    """一键 mock 拆解 + 渲染 + 配音 + 合成四外部依赖。"""
    monkeypatch.setattr(storyboard, "parse_script", _fake_parse(shots))
    monkeypatch.setattr(orch, "render_shot", _fake_render)
    monkeypatch.setattr(voice_svc, "synth_for_shot", _fake_voice)
    monkeypatch.setattr(assemble_svc, "assemble_project", _fake_assemble)


def _create_run(client: TestClient, H: dict, goal: str = "拍一个短剧:雨夜重逢") -> dict:
    r = client.post("/api/agent-runs", headers=H, json={"goal": goal})
    assert r.status_code == 200, r.text
    return r.json()


def _wait_run(client: TestClient, H: dict, run_id: str, want: str, timeout: float = 10.0) -> dict:
    """轮询 run 详情直到目标状态(后台执行器是异步协程)。"""
    deadline = time.time() + timeout
    last = ""
    detail = {}
    while time.time() < deadline:
        detail = client.get(f"/api/agent-runs/{run_id}", headers=H).json()
        last = detail["status"]
        if last == want:
            return detail
        time.sleep(0.05)
    states = [(t["kind"], t["status"], t["attempt"]) for t in detail.get("plan", [])]
    raise AssertionError(
        f"run {run_id} 未在 {timeout}s 内到达 {want}(当前 {last},tasks={states})"
    )


# ── ① L0 不建 run ────────────────────────────────────────────────────────────


def test_create_l0_returns_guidance_without_run(ctx):
    client, token, _, _ = ctx
    H = _h(token)
    r = client.post("/api/agent-runs", headers=H, json={"goal": "帮我生成一张猫图"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body == {"level": "L0", "ack": "单步任务建议直达工作台", "run_id": None}
    # 未建 run:列表为空
    assert client.get("/api/agent-runs", headers=H).json() == []


# ── ② L2 秒回契约 ───────────────────────────────────────────────────────────


def test_create_l2_ack_plan_contract(ctx, monkeypatch):
    client, token, _, _ = ctx
    H = _h(token)
    _mock_pipeline(monkeypatch)
    body = _create_run(client, H)
    assert body["level"] == "L2"
    assert body["run_id"]
    assert "已拆成" in body["ack"] and "后台执行" in body["ack"]
    tasks = body["plan"]["tasks"]
    # 2 渲染卡 + 1 配音卡(视频镜带台词)+ 1 合成卡
    assert len(tasks) == 4
    assert [t["kind"] for t in tasks] == ["video", "audio", "image", "assemble"]
    assert all(t["status"] == "pending" for t in tasks)
    voice = tasks[1]
    assert voice["depends_on"] == [tasks[0]["id"]]
    assert set(tasks[3]["depends_on"]) == {t["id"] for t in tasks[:3]}
    # 状态进计划确认门
    detail = client.get(f"/api/agent-runs/{body['run_id']}", headers=H).json()
    assert detail["status"] == "awaiting_confirm"
    assert detail["plan"][0]["input"]["prompt"].startswith("rain alley")


# ── ③ 未认证 401 ────────────────────────────────────────────────────────────


def test_create_requires_auth(ctx):
    client, _, _, _ = ctx
    assert client.post("/api/agent-runs", json={"goal": "短剧"}).status_code == 401
    assert client.get("/api/agent-runs").status_code == 401


# ── ④ 他人 run 404 ──────────────────────────────────────────────────────────


def test_other_user_run_404(ctx, monkeypatch):
    client, token, engine, tid = ctx
    _mock_pipeline(monkeypatch)
    body = _create_run(client, _h(token))
    with Session(engine) as s:
        other = User(
            email="other@toiv.ai",
            hashed_password=hash_password("password1"),
            tenant_id=tid,
        )
        s.add(other)
        s.commit()
        s.refresh(other)
        other_token = create_token(other.id)
    r = client.get(f"/api/agent-runs/{body['run_id']}", headers=_h(other_token))
    assert r.status_code == 404


# ── ⑤ 计划编辑(改/删/加)─────────────────────────────────────────────────────


def test_plan_edit_update_remove_add(ctx, monkeypatch):
    client, token, _, _ = ctx
    H = _h(token)
    _mock_pipeline(monkeypatch)
    body = _create_run(client, H)
    run_id = body["run_id"]
    tasks = body["plan"]["tasks"]
    shot_id, voice_id, _, assemble_id = (t["id"] for t in tasks)

    r = client.post(
        f"/api/agent-runs/{run_id}/plan",
        headers=H,
        json={
            "tasks": [
                {"id": shot_id, "action": "update", "title": "镜头 1:改题",
                 "input": {"prompt": " rewritten prompt"}},
                {"id": voice_id, "action": "remove"},
                {"action": "add", "title": "镜头 3:空镜",
                 "input": {"kind": "image", "prompt": "empty street"}},
            ]
        },
    )
    assert r.status_code == 200, r.text
    new_tasks = r.json()["plan"]["tasks"]
    by_id = {t["id"]: t for t in new_tasks}
    assert voice_id not in by_id  # 删除生效
    assert by_id[shot_id]["title"] == "镜头 1:改题"  # 更新生效
    added = [t for t in new_tasks if t["title"] == "镜头 3:空镜"]
    assert len(added) == 1 and added[0]["kind"] == "image"  # 新增生效
    # 合成卡 depends_on 中的悬挂引用(被删配音卡)已清理
    assert voice_id not in by_id[assemble_id]["depends_on"]
    # 详情页 input 已合并更新
    detail = client.get(f"/api/agent-runs/{run_id}", headers=H).json()
    shot = [t for t in detail["plan"] if t["id"] == shot_id][0]
    assert shot["input"]["prompt"] == " rewritten prompt"
    # 非确认门状态不可编辑(先 approve 进 running)
    client.post(f"/api/agent-runs/{run_id}/resume", headers=H,
                json={"gate": "plan", "action": "approve"})
    r2 = client.post(f"/api/agent-runs/{run_id}/plan", headers=H,
                     json={"tasks": [{"id": shot_id, "action": "remove"}]})
    assert r2.status_code == 409


# ── ⑥ 全链路:plan approve → 待合成门 → assembly approve → done → result ──────


def test_full_flow_gates_to_done(ctx, monkeypatch):
    client, token, _, _ = ctx
    H = _h(token)
    _mock_pipeline(monkeypatch)
    run_id = _create_run(client, H)["run_id"]

    r = client.post(f"/api/agent-runs/{run_id}/resume", headers=H,
                    json={"gate": "plan", "action": "approve"})
    assert r.status_code == 200, r.text
    # 执行器跑完全部镜头 → 挂起待合成门(不自动合成)
    detail = _wait_run(client, H, run_id, "awaiting_assembly")
    statuses = {t["kind"]: t["status"] for t in detail["plan"]}
    assert statuses["video"] == statuses["image"] == statuses["audio"] == "done"
    assert statuses["assemble"] == "pending"
    shot = [t for t in detail["plan"] if t["kind"] == "video"][0]
    assert shot["output"]["url"].endswith(".mp4")
    assert shot["attempt"] == 1 and shot["gpu_hint"] == "pool"

    # 未完成时 result → 409
    assert client.get(f"/api/agent-runs/{run_id}/result", headers=H).status_code == 409

    r = client.post(f"/api/agent-runs/{run_id}/resume", headers=H,
                    json={"gate": "assembly", "action": "approve"})
    assert r.status_code == 200, r.text
    detail = _wait_run(client, H, run_id, "done")
    result = client.get(f"/api/agent-runs/{run_id}/result", headers=H).json()
    assert result["final_url"] == "/api/studio/files/final-fake.mp4"
    assert result["duration_sec"] == 12  # 两镜各默认 6s
    assert len(result["tasks"]) == 4

    # SSE 补验:终态 run 推完全部事件后关流,含 confirm_required 与 done
    r = client.get(f"/api/agent-runs/{run_id}/events?after=0", headers=H)
    assert "event: confirm_required" in r.text
    assert "event: done" in r.text


# ── ⑦ cancel 生效 ───────────────────────────────────────────────────────────


def test_cancel_run(ctx, monkeypatch):
    client, token, _, _ = ctx
    H = _h(token)
    _mock_pipeline(monkeypatch)
    run_id = _create_run(client, H)["run_id"]
    r = client.post(f"/api/agent-runs/{run_id}/cancel", headers=H)
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "canceled"
    detail = client.get(f"/api/agent-runs/{run_id}", headers=H).json()
    assert detail["status"] == "canceled"
    # 终态不可重复取消
    assert client.post(f"/api/agent-runs/{run_id}/cancel", headers=H).status_code == 409


# ── ⑧ regenerate attempt 上限 400 ────────────────────────────────────────────


def test_regenerate_attempt_limit(ctx, monkeypatch):
    client, token, _, _ = ctx
    H = _h(token)
    _mock_pipeline(monkeypatch)
    run_id = _create_run(client, H)["run_id"]
    client.post(f"/api/agent-runs/{run_id}/resume", headers=H,
                json={"gate": "plan", "action": "approve"})
    detail = _wait_run(client, H, run_id, "awaiting_assembly")
    shot_id = [t for t in detail["plan"] if t["kind"] == "video"][0]["id"]

    # 首次重生成:attempt 1→2,带引导词,立即单卡重跑回待合成
    r = client.post(
        f"/api/agent-runs/{run_id}/tasks/{shot_id}/action",
        headers=H,
        json={"action": "regenerate", "payload": {"guidance": "雨更大一些"}},
    )
    assert r.status_code == 200, r.text
    detail = _wait_run(client, H, run_id, "awaiting_assembly")
    shot = [t for t in detail["plan"] if t["id"] == shot_id][0]
    assert shot["status"] == "done" and shot["attempt"] == 2
    assert "雨更大一些" in shot["input"]["prompt"]

    # 第二次:超出上限 → 400
    r = client.post(
        f"/api/agent-runs/{run_id}/tasks/{shot_id}/action",
        headers=H,
        json={"action": "regenerate"},
    )
    assert r.status_code == 400


# ── ⑨ SSE 事件流读到 ack/plan ────────────────────────────────────────────────


def test_events_sse_reads_ack_and_plan(ctx, monkeypatch):
    client, token, _, _ = ctx
    H = _h(token)
    _mock_pipeline(monkeypatch)
    run_id = _create_run(client, H)["run_id"]
    # 取消使 run 进终态,SSE 推完残留事件即关流(测试可读完整响应体)
    client.post(f"/api/agent-runs/{run_id}/cancel", headers=H)
    r = client.get(f"/api/agent-runs/{run_id}/events?after=0", headers=H)
    assert r.status_code == 200, r.text
    assert "event: ack" in r.text
    assert "event: plan" in r.text
    assert "已拆成" in r.text


# ── ⑩ upload/reprompt → 501 ──────────────────────────────────────────────────


def test_upload_and_reprompt_501(ctx, monkeypatch):
    client, token, _, _ = ctx
    H = _h(token)
    _mock_pipeline(monkeypatch)
    body = _create_run(client, H)
    run_id = body["run_id"]
    task_id = body["plan"]["tasks"][0]["id"]
    for action in ("upload", "reprompt"):
        r = client.post(
            f"/api/agent-runs/{run_id}/tasks/{task_id}/action",
            headers=H,
            json={"action": action},
        )
        assert r.status_code == 501, action
        assert r.json()["detail"] == "R3.2 提供"


# ── 附加:LLM 规划失败 → 503 ──────────────────────────────────────────────────


def test_create_llm_failure_503(ctx, monkeypatch):
    client, token, _, _ = ctx
    H = _h(token)

    async def boom(premise, num_shots=8, style=""):  # noqa: ANN001
        raise storyboard.StoryboardError("LLM 不可用:连接超时")

    monkeypatch.setattr(storyboard, "parse_script", boom)
    r = client.post("/api/agent-runs", headers=H, json={"goal": "拍一个短剧:x"})
    assert r.status_code == 503
    assert "规划失败" in r.json()["detail"]


# ── ⑥ Director Gate:LLM 分级成功走 LLM 结果 ─────────────────────────────────


def test_classify_llm_success_uses_llm_level(ctx, monkeypatch):
    client, token, engine, _ = ctx
    H = _h(token)
    _mock_pipeline(monkeypatch)

    async def fake_chat(messages, tools=None, max_tokens=None, temperature=0.4):  # noqa: ANN001
        return {"content": '{"level": "L2", "reason": "多镜头叙事属于复杂项目"}'}

    monkeypatch.setattr(llm, "chat", fake_chat)
    # 「视频」关键词使启发式判 L0;LLM 判 L2 → 响应 level 证明生效的是 LLM 结果
    r = client.post("/api/agent-runs", headers=H, json={"goal": "帮我做一个视频:小猫的一天"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["level"] == "L2"
    assert body["run_id"]
    # 分级证据落 plan_json.meta.classify(不进入任何响应字段,响应形状不变)
    with Session(engine) as s:
        run = s.get(AgentRun, body["run_id"])
        meta = json.loads(run.plan_json)["meta"]["classify"]
    assert meta == {
        "level": "L2",
        "reason": "多镜头叙事属于复杂项目",
        "source": "llm",
    }


# ── ⑦ Director Gate:LLM 失败/非法输出回退启发式 ─────────────────────────────


def test_classify_llm_failure_falls_back_to_heuristic(ctx, monkeypatch):
    client, token, engine, _ = ctx
    H = _h(token)
    _mock_pipeline(monkeypatch)
    # 场景一:LLM 抛错(autouse 替身已是此行为,显式再覆写以自文档化)
    body = _create_run(client, H)  # goal 含「短剧」关键词 → 启发式 L2
    assert body["level"] == "L2"
    with Session(engine) as s:
        meta = json.loads(s.get(AgentRun, body["run_id"]).plan_json)["meta"]["classify"]
    assert meta["source"] == "heuristic"
    assert meta["level"] == "L2"

    # 场景二:LLM 返回非法 JSON(非 JSON 文本)→ 同样回退,不阻塞创建
    async def garbage(messages, tools=None, max_tokens=None, temperature=0.4):  # noqa: ANN001
        return {"content": "我觉得这个任务挺复杂的……"}

    monkeypatch.setattr(llm, "chat", garbage)
    body2 = _create_run(client, H, goal="拍一个短剧:雨夜告别")
    assert body2["level"] == "L2"
    with Session(engine) as s:
        meta2 = json.loads(s.get(AgentRun, body2["run_id"]).plan_json)["meta"]["classify"]
    assert meta2["source"] == "heuristic"
