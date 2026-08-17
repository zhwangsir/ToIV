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
from sqlmodel import Session, SQLModel, create_engine, select

import app.services.studio.orchestrator as orch
from app.agent import llm
from app.db import get_session
from app.main import app
from app.models import AgentRun, AgentTask, Tenant, User
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
    """轮询 run 详情直到目标状态(后台规划/执行器是异步协程)。"""
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


def _create_planned(client: TestClient, H: dict, goal: str = "拍一个短剧:雨夜重逢") -> dict:
    """创建并等后台规划完成(awaiting_confirm),返回详情(计划已可断言/操作)。"""
    run_id = _create_run(client, H, goal)["run_id"]
    return _wait_run(client, H, run_id, "awaiting_confirm")


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


# ── ② L2 秒回契约(创建秒回 + 后台规划异步交付计划)───────────────────────────


def test_create_l2_ack_plan_contract(ctx, monkeypatch):
    client, token, _, _ = ctx
    H = _h(token)
    _mock_pipeline(monkeypatch)
    body = _create_run(client, H)
    assert body["level"] == "L2"
    assert body["run_id"]
    assert "已接单" in body["ack"]
    # 秒回响应不带计划:拆解在后台协程完成,经详情/SSE 到达
    assert "plan" not in body
    # 后台规划完成 → awaiting_confirm,计划结构完整
    detail = _wait_run(client, H, body["run_id"], "awaiting_confirm")
    tasks = detail["plan"]
    # 2 渲染卡 + 1 配音卡(视频镜带台词)+ 1 合成卡
    assert len(tasks) == 4
    assert [t["kind"] for t in tasks] == ["video", "audio", "image", "assemble"]
    assert all(t["status"] == "pending" for t in tasks)
    voice = tasks[1]
    assert voice["depends_on"] == [tasks[0]["id"]]
    assert set(tasks[3]["depends_on"]) == {t["id"] for t in tasks[:3]}
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
    detail0 = _create_planned(client, H)
    run_id = detail0["id"]
    tasks = detail0["plan"]
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
    run_id = _create_planned(client, H)["id"]

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
    run_id = _create_planned(client, H)["id"]
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
    # 等后台规划完成(ack/plan 事件已落库),再取消进终态,SSE 推完残留事件即关流
    run_id = _create_planned(client, H)["id"]
    client.post(f"/api/agent-runs/{run_id}/cancel", headers=H)
    r = client.get(f"/api/agent-runs/{run_id}/events?after=0", headers=H)
    assert r.status_code == 200, r.text
    assert "event: ack" in r.text
    assert "event: plan" in r.text
    assert "已拆成" in r.text
    assert "event: confirm_required" in r.text


# ── ⑩ upload/reprompt ────────────────────────────────────────────────────────


def _pin_studio_dir(monkeypatch, tmp_path):
    """把 agent_team 的 drama_output_root 钉到临时目录(落盘/读取都走这里)。"""
    from app.routes import agent_team as at

    (tmp_path / "studio").mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(at, "drama_output_root", lambda: tmp_path)
    return tmp_path / "studio"


def test_upload_action_replaces_output(ctx, monkeypatch, tmp_path):
    client, token, _, _ = ctx
    H = _h(token)
    _mock_pipeline(monkeypatch)
    studio_dir = _pin_studio_dir(monkeypatch, tmp_path)
    (studio_dir / "replacement.png").write_bytes(b"\x89PNG\r\n\x1a\nfake")
    run_id = _create_planned(client, H)["id"]
    client.post(f"/api/agent-runs/{run_id}/resume", headers=H,
                json={"gate": "plan", "action": "approve"})
    detail = _wait_run(client, H, run_id, "awaiting_assembly")
    task = [t for t in detail["plan"] if t["kind"] == "video"][0]

    # 合法本地产物 url → output 替换,卡片回 done,shot_id 映射保留
    r = client.post(
        f"/api/agent-runs/{run_id}/tasks/{task['id']}/action",
        headers=H,
        json={"action": "upload", "payload": {"url": "/api/studio/files/replacement.png"}},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "done"
    assert body["output"]["url"] == "/api/studio/files/replacement.png"
    assert body["output"]["source"] == "upload"
    assert body["output"]["shot_id"] == task["input"]["shot_id"]

    # 外链/缺文件/缺 url → 400;合成卡 → 400
    for bad in ("https://evil.com/x.png", "/api/studio/files/missing.png", ""):
        r = client.post(
            f"/api/agent-runs/{run_id}/tasks/{task['id']}/action",
            headers=H,
            json={"action": "upload", "payload": {"url": bad}},
        )
        assert r.status_code == 400, bad
    assemble = [t for t in detail["plan"] if t["kind"] == "assemble"][0]
    r = client.post(
        f"/api/agent-runs/{run_id}/tasks/{assemble['id']}/action",
        headers=H,
        json={"action": "upload", "payload": {"url": "/api/studio/files/replacement.png"}},
    )
    assert r.status_code == 400


def test_task_upload_multipart(ctx, monkeypatch, tmp_path):
    client, token, _, _ = ctx
    H = _h(token)
    _mock_pipeline(monkeypatch)
    studio_dir = _pin_studio_dir(monkeypatch, tmp_path)
    run_id = _create_planned(client, H)["id"]
    client.post(f"/api/agent-runs/{run_id}/resume", headers=H,
                json={"gate": "plan", "action": "approve"})
    detail = _wait_run(client, H, run_id, "awaiting_assembly")
    task = [t for t in detail["plan"] if t["kind"] == "video"][0]

    png = b"\x89PNG\r\n\x1a\n" + b"0" * 32
    r = client.post(
        f"/api/agent-runs/{run_id}/tasks/{task['id']}/upload",
        headers=H,
        files={"file": ("replacement.png", png, "image/png")},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "done"
    assert body["output"]["url"].startswith("/api/studio/files/")
    assert body["output"]["source"] == "upload"
    name = body["output"]["url"].rsplit("/", 1)[-1]
    assert (studio_dir / name).read_bytes() == png  # 落盘真实存在

    # 伪造扩展名(魔数不符)→ 415;合成卡 → 400
    r = client.post(
        f"/api/agent-runs/{run_id}/tasks/{task['id']}/upload",
        headers=H,
        files={"file": ("fake.png", b"MZ not a png", "image/png")},
    )
    assert r.status_code == 415
    assemble = [t for t in detail["plan"] if t["kind"] == "assemble"][0]
    r = client.post(
        f"/api/agent-runs/{run_id}/tasks/{assemble['id']}/upload",
        headers=H,
        files={"file": ("replacement.png", png, "image/png")},
    )
    assert r.status_code == 400


def test_reprompt_writes_reversed_prompt(ctx, monkeypatch, tmp_path):
    client, token, _, _ = ctx
    H = _h(token)
    _mock_pipeline(monkeypatch)
    studio_dir = _pin_studio_dir(monkeypatch, tmp_path)
    run_id = _create_planned(client, H)["id"]
    client.post(f"/api/agent-runs/{run_id}/resume", headers=H,
                json={"gate": "plan", "action": "approve"})
    detail = _wait_run(client, H, run_id, "awaiting_assembly")
    task = [t for t in detail["plan"] if t["kind"] == "video"][0]
    # 假渲染产物 url(/api/studio/files/{idx}.mp4)落盘成真文件,供反推读取
    name = task["output"]["url"].rsplit("/", 1)[-1]
    (studio_dir / name).write_bytes(b"\x00\x00\x00\x18ftypisom" + b"0" * 16)

    from app.routes import agent_team as at
    from app.routes.reverse import ReverseResponse

    async def fake_reverse(content, filename, content_type, kind, nsfw):  # noqa: ANN001
        assert kind == "video" and content.startswith(b"\x00\x00\x00\x18ftyp")
        return ReverseResponse(kind=kind, prompt="reversed cinematic prompt", negative="blurry")

    monkeypatch.setattr(at.reverse_svc, "reverse_visual", fake_reverse)
    r = client.post(
        f"/api/agent-runs/{run_id}/tasks/{task['id']}/action",
        headers=H,
        json={"action": "reprompt"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["input"]["prompt"] == "reversed cinematic prompt"
    assert body["input"]["negative"] == "blurry"
    assert body["status"] == "done"  # 卡片保持 done,用户审阅后再决定是否重生成


def test_reprompt_guards(ctx, monkeypatch, tmp_path):
    client, token, _, _ = ctx
    H = _h(token)
    _mock_pipeline(monkeypatch)
    _pin_studio_dir(monkeypatch, tmp_path)
    detail0 = _create_planned(client, H)
    run_id = detail0["id"]
    tasks = detail0["plan"]
    render = [t for t in tasks if t["kind"] == "video"][0]
    assemble = [t for t in tasks if t["kind"] == "assemble"][0]

    # 未产出 → 409;合成卡 → 400(非图像/视频)
    r = client.post(
        f"/api/agent-runs/{run_id}/tasks/{render['id']}/action",
        headers=H, json={"action": "reprompt"},
    )
    assert r.status_code == 409
    r = client.post(
        f"/api/agent-runs/{run_id}/tasks/{assemble['id']}/action",
        headers=H, json={"action": "reprompt"},
    )
    assert r.status_code == 400


# ── 附加:后台规划失败 → run 落 error 态(不再同步 503)────────────────────────


def test_create_plan_failure_lands_error(ctx, monkeypatch):
    client, token, _, _ = ctx
    H = _h(token)

    async def boom(premise, num_shots=8, style=""):  # noqa: ANN001
        raise storyboard.StoryboardError("LLM 不可用:连接超时")

    monkeypatch.setattr(storyboard, "parse_script", boom)
    # 创建仍秒回 200(规划已转后台);失败在后台落 error 终态 + 原因
    body = _create_run(client, H, goal="拍一个短剧:x")
    detail = _wait_run(client, H, body["run_id"], "error")
    assert "规划失败" in detail["error"]
    assert "连接超时" in detail["error"]


def test_create_plan_unexpected_error_lands_error(ctx, monkeypatch):
    client, token, _, _ = ctx
    H = _h(token)

    async def boom(premise, num_shots=8, style=""):  # noqa: ANN001
        raise RuntimeError("意外的内部错误")

    monkeypatch.setattr(storyboard, "parse_script", boom)
    body = _create_run(client, H, goal="拍一个短剧:y")
    detail = _wait_run(client, H, body["run_id"], "error")
    assert "规划拆解失败" in detail["error"]  # 意外异常不透原始细节,给规范文案


# ── ⑥ Director Gate:LLM 分级成功,后台校准 run.level ─────────────────────────


def test_classify_llm_success_uses_llm_level(ctx, monkeypatch):
    client, token, engine, _ = ctx
    H = _h(token)
    _mock_pipeline(monkeypatch)

    async def fake_chat(messages, tools=None, max_tokens=None, temperature=0.4):  # noqa: ANN001
        return {"content": '{"level": "L2", "reason": "多镜头叙事属于复杂项目"}'}

    monkeypatch.setattr(llm, "chat", fake_chat)
    # 无 L0/L2 关键词 → 启发式即时分流判 L1(创建秒回即此值);
    # 后台 LLM 判 L2 → 规划完成后 run.level 校准为 L2
    body = _create_run(client, H, goal="小猫的一天")
    assert body["level"] == "L1"
    detail = _wait_run(client, H, body["run_id"], "awaiting_confirm")
    assert detail["level"] == "L2"
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
    _wait_run(client, H, body["run_id"], "awaiting_confirm")
    with Session(engine) as s:
        meta = json.loads(s.get(AgentRun, body["run_id"]).plan_json)["meta"]["classify"]
    assert meta["source"] == "heuristic"
    assert meta["level"] == "L2"

    # 场景二:LLM 返回非法 JSON(非 JSON 文本)→ 同样回退,不阻塞规划
    async def garbage(messages, tools=None, max_tokens=None, temperature=0.4):  # noqa: ANN001
        return {"content": "我觉得这个任务挺复杂的……"}

    monkeypatch.setattr(llm, "chat", garbage)
    body2 = _create_run(client, H, goal="拍一个短剧:雨夜告别")
    assert body2["level"] == "L2"
    _wait_run(client, H, body2["run_id"], "awaiting_confirm")
    with Session(engine) as s:
        meta2 = json.loads(s.get(AgentRun, body2["run_id"]).plan_json)["meta"]["classify"]
    assert meta2["source"] == "heuristic"


# ── ⑧ verdict 序列化契约:任何状态一律返回字符串(React #31 崩溃根因修复)──────


def test_verdict_serialized_as_string(ctx, monkeypatch):
    client, token, engine, _ = ctx
    H = _h(token)
    _mock_pipeline(monkeypatch)
    detail = _create_planned(client, H)
    run_id = detail["id"]
    task_id = detail["plan"][0]["id"]

    def _set_verdict(raw: str) -> str:
        with Session(engine) as s:
            t = s.get(AgentTask, task_id)
            t.verdict_json = raw
            s.add(t)
            s.commit()
        plan = client.get(f"/api/agent-runs/{run_id}", headers=H).json()["plan"]
        return [t for t in plan if t["id"] == task_id][0]["verdict"]

    # 空(初始)→ 空串;空 dict → 空串;JSON 字符串 → 原样;dict 提取文本键;
    # dict 无已知键 → 紧凑 JSON;损坏串 → 空串。全部为 string 类型。
    assert _set_verdict("") == ""
    assert _set_verdict("{}") == ""
    assert _set_verdict('{"error": "显存不足,请降帧"}') == "显存不足,请降帧"
    assert _set_verdict('{"summary": "验收通过", "score": 9}') == "验收通过"
    assert _set_verdict('"人工评语:构图合格"') == "人工评语:构图合格"
    assert _set_verdict('{"score": 3, "tags": ["a"]}') == '{"score":3,"tags":["a"]}'
    assert _set_verdict("corrupt-not-json") == ""
    for raw in ('', "{}", '{"error": "x"}', '"s"', '{"a": 1}', "bad"):
        v = _set_verdict(raw)
        assert isinstance(v, str), f"verdict 必须是字符串,实际 {type(v)}({raw!r})"


# ── ⑨ 创建秒回:慢拆解不挡响应;规划中状态可见;完成后进确认门 ──────────────────


def test_create_returns_immediately_while_planning_runs_in_bg(ctx, monkeypatch):
    client, token, _, _ = ctx
    H = _h(token)

    async def slow_parse(premise, num_shots=8, style=""):  # noqa: ANN001
        await asyncio.sleep(2)  # 模拟真实 LLM 拆解耗时(实测 20-30s 的缩放)
        return await _fake_parse()(premise, num_shots, style)

    monkeypatch.setattr(storyboard, "parse_script", slow_parse)
    started = time.monotonic()
    body = _create_run(client, H)
    elapsed = time.monotonic() - started
    assert elapsed < 2.0, f"创建必须秒回(实际 {elapsed:.2f}s,撞上 2s 慢拆解)"
    assert body["run_id"]
    # 规划未完成:状态 planning,计划为空(前端经 SSE/轮询等 plan)
    detail = client.get(f"/api/agent-runs/{body['run_id']}", headers=H).json()
    assert detail["status"] == "planning"
    assert detail["plan"] == []
    # 后台规划完成 → 进计划确认门,任务卡片就绪
    detail = _wait_run(client, H, body["run_id"], "awaiting_confirm", timeout=15.0)
    assert len(detail["plan"]) == 4


# ── ⑩ 规划进行中不可 approve(防空计划启动执行器)─────────────────────────────


def test_resume_approve_during_planning_409(ctx, monkeypatch):
    client, token, _, _ = ctx
    H = _h(token)

    async def slow_parse(premise, num_shots=8, style=""):  # noqa: ANN001
        await asyncio.sleep(2)
        return await _fake_parse()(premise, num_shots, style)

    monkeypatch.setattr(storyboard, "parse_script", slow_parse)
    body = _create_run(client, H)
    r = client.post(
        f"/api/agent-runs/{body['run_id']}/resume",
        headers=H,
        json={"gate": "plan", "action": "approve"},
    )
    assert r.status_code == 409
    assert "规划拆解进行中" in r.json()["detail"]
    # 清理:取消进终态;后台规划醒来看见终态静默退出(不覆盖 canceled)
    client.post(f"/api/agent-runs/{body['run_id']}/cancel", headers=H)
    detail = _wait_run(client, H, body["run_id"], "canceled", timeout=15.0)
    assert detail["status"] == "canceled"


# ── ⑪ 启动恢复:planning 且无任务的 run 重挂规划;reject 挂起态不推进 ──────────


def test_resume_unfinished_plans_respawns_stuck_planning(ctx, monkeypatch):
    client, token, engine, _ = ctx
    H = _h(token)
    _mock_pipeline(monkeypatch)
    from app.routes import agent_team as at

    with Session(engine) as s:
        uid = s.exec(select(User).where(User.email == "leader@toiv.ai")).first().id
        # 进程在后台规划中途重启的现场:run 停 planning 且 plan 无任务
        stuck = AgentRun(
            user_id=uid, level="L2", goal="拍一个短剧:重启恢复", status="planning",
            plan_json=json.dumps({"tasks": [], "opts": {}, "meta": {}}, ensure_ascii=False),
        )
        # reject 打回挂起态:planning 但已有任务(等用户裁决,不自动推进)
        rejected = AgentRun(
            user_id=uid, level="L2", goal="打回挂起", status="planning",
            plan_json=json.dumps(
                {"tasks": [{"id": "t1"}], "opts": {}, "meta": {}}, ensure_ascii=False
            ),
        )
        s.add(stuck)
        s.add(rejected)
        s.commit()
        s.refresh(stuck)
        s.refresh(rejected)
        stuck_id, rejected_id = stuck.id, rejected.id

    n = at.resume_unfinished_plans(engine)
    assert n == 1, "仅重挂『无任务』的规划中断 run"
    # 重挂的规划协程跑完 → 进确认门
    detail = _wait_run(client, H, stuck_id, "awaiting_confirm")
    assert len(detail["plan"]) == 4
    # reject 挂起态原样保留
    detail2 = client.get(f"/api/agent-runs/{rejected_id}", headers=H).json()
    assert detail2["status"] == "planning"
