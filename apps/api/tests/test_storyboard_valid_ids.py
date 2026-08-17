"""剧本拆解 LLM 输出 pydantic validation_context 校验测试(链 A drama / 链 B studio)。

覆盖:
  链 A(POST /api/drama/projects/{pid}/storyboard):
    ① 合法角色名精确命中 → 通过
    ② 大小写/空白近匹配 → 自动纠正为集合内名字
    ③ 全新角色名 → 放行且走既有自动建行路径(不破坏旧特性)
    ④ 输出结构非法 → 校验错误摘要反馈进 prompt 重试一次 → 成功
    ⑤ 重试仍结构非法 → 502 带明确 detail
    ⑦ 分镜视频回写预算内循环续等:首轮超时(作业非终态)→ 续等第二轮 done → 回写;
       预算(job_track_timeout)耗尽 → 标 error(超出 tracker 兜底窗口);
       作业已 error / 超时瞬间恰好 done 的竞态路径行为不变;
       同款修复推广到多候选回写 _writeback_candidate(续等回写并自动 pick)
    ⑧ reconcile_interrupted 两段匹配:prompt_override 致 prompt 精确匹配落空且
       seed 非 0 → seed+属主兜底找回;seed=0 不兜底,标 error
  链 B(services/studio/storyboard.parse_script):
    ⑥ known_characters 注入后近匹配纠正 + 新名放行;缺省 None 不启用校验(旧行为)
  兼容:
    链 A _coerce_shot 委托 ShotOut 后与旧手工规整行为等价(duration 钳制/类型回退)
"""
from __future__ import annotations

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

from app.db import get_session
from app.main import app
from app.models import DramaCharacter, DramaShot, Job, Tenant, User
from app.security import create_token, hash_password
from app.services.studio import storyboard


@pytest.fixture()
def ctx():
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    SQLModel.metadata.create_all(engine)

    def override() -> Session:
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override
    # 后台回写任务用 `from app.db import engine` 取独立 Session,patch 指向测试内存库
    with patch.object(__import__("app.db", fromlist=["engine"]), "engine", engine):
        with Session(engine) as s:
            tenant = Tenant(name="v")
            s.add(tenant)
            s.commit()
            s.refresh(tenant)
            user = User(
                email="v@toiv.ai",
                hashed_password=hash_password("password1"),
                tenant_id=tenant.id,
            )
            s.add(user)
            s.commit()
            s.refresh(user)
            uid = user.id
        yield TestClient(app), create_token(uid)
    app.dependency_overrides.clear()


def _h(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def _make_project_with_chars(
    client: TestClient, token: str, chars: list[dict]
) -> str:
    """建项目(带剧本)+ 批量建角色,返回 pid。"""
    H = _h(token)
    pid = client.post(
        "/api/drama/projects",
        headers=H,
        json={"title": "校验测试", "script": "阿明在街上遇到小红。"},
    ).json()["id"]
    for c in chars:
        r = client.post(f"/api/drama/projects/{pid}/characters", headers=H, json=c)
        assert r.status_code == 200, r.text
    return pid


def _shot_payload(characters: list[str], prompt: str = "1boy, walking, cinematic") -> str:
    return json.dumps(
        {"shots": [{"scene": "街道", "prompt": prompt, "characters": characters,
                    "dialogue": "", "speaker": "", "duration_sec": 6}]},
        ensure_ascii=False,
    )


def _char_names(client: TestClient, token: str, pid: str) -> list[str]:
    detail = client.get(f"/api/drama/projects/{pid}", headers=_h(token)).json()
    return [c["name"] for c in detail["characters"]]


# ---------------------------------------------------------------------------
# 链 A ①:合法角色名精确命中 → 通过,不产生新角色行
# ---------------------------------------------------------------------------
def test_valid_names_pass(ctx):
    client, token = ctx
    H = _h(token)
    pid = _make_project_with_chars(client, token, [
        {"name": "阿明", "visual_prompt": "1boy, black hair"},
        {"name": "Mary", "visual_prompt": "1girl, red dress"},
    ])

    fake_msg = {"content": _shot_payload(["阿明", "Mary"])}
    with patch("app.routes.drama_studio.llm.chat", AsyncMock(return_value=fake_msg)):
        r = client.post(f"/api/drama/projects/{pid}/storyboard", headers=H,
                        json={"num_shots": 1})
    assert r.status_code == 200, r.text
    assert r.json()["shots"][0]["characters"] == ["阿明", "Mary"]
    # 无新增角色行
    assert sorted(_char_names(client, token, pid)) == ["Mary", "阿明"]


# ---------------------------------------------------------------------------
# 链 A ②:大小写/空白近匹配 → 自动纠正为集合内名字
# ---------------------------------------------------------------------------
def test_near_match_corrected(ctx):
    client, token = ctx
    H = _h(token)
    pid = _make_project_with_chars(client, token, [
        {"name": "Mary", "visual_prompt": "1girl, red dress"},
        {"name": "阿明", "visual_prompt": "1boy, black hair"},
    ])

    # " mary " 大小写+空白近匹配;" 阿明 " 首尾空白近匹配
    fake_msg = {"content": _shot_payload([" mary ", " 阿明 "])}
    with patch("app.routes.drama_studio.llm.chat", AsyncMock(return_value=fake_msg)):
        r = client.post(f"/api/drama/projects/{pid}/storyboard", headers=H,
                        json={"num_shots": 1})
    assert r.status_code == 200, r.text
    assert r.json()["shots"][0]["characters"] == ["Mary", "阿明"]
    # 纠正后不留新角色行
    assert sorted(_char_names(client, token, pid)) == ["Mary", "阿明"]


# ---------------------------------------------------------------------------
# 链 A ③:全新角色名 → 放行且自动建行(既有特性不破坏)
# ---------------------------------------------------------------------------
def test_new_name_passes_and_autocreates(ctx):
    client, token = ctx
    H = _h(token)
    pid = _make_project_with_chars(client, token, [
        {"name": "阿明", "visual_prompt": "1boy, black hair"},
    ])

    fake_msg = {"content": _shot_payload(["阿明", "新角色"])}
    with patch("app.routes.drama_studio.llm.chat", AsyncMock(return_value=fake_msg)):
        r = client.post(f"/api/drama/projects/{pid}/storyboard", headers=H,
                        json={"num_shots": 1})
    assert r.status_code == 200, r.text
    assert r.json()["shots"][0]["characters"] == ["阿明", "新角色"]
    # 新角色走既有自动建行路径落库
    assert sorted(_char_names(client, token, pid)) == ["新角色", "阿明"]


# ---------------------------------------------------------------------------
# 链 A ④:结构非法 → 校验错误摘要反馈进 prompt 重试一次 → 成功
# ---------------------------------------------------------------------------
def test_invalid_structure_retries_once_then_succeeds(ctx):
    client, token = ctx
    H = _h(token)
    pid = _make_project_with_chars(client, token, [{"name": "阿明"}])

    bad_msg = {"content": '{"shots": "not-a-list"}'}  # shots 类型错 → ValidationError
    good_msg = {"content": _shot_payload(["阿明"])}
    mock_chat = AsyncMock(side_effect=[bad_msg, good_msg])
    with patch("app.routes.drama_studio.llm.chat", mock_chat):
        r = client.post(f"/api/drama/projects/{pid}/storyboard", headers=H,
                        json={"num_shots": 1})
    assert r.status_code == 200, r.text
    assert mock_chat.await_count == 2  # 重试了一次
    # 第二次调用的 user prompt 携带校验失败修正指令与错误摘要
    retry_user_prompt = mock_chat.await_args_list[1][0][0][1]["content"]
    assert "上次输出未通过结构校验" in retry_user_prompt
    assert "shots" in retry_user_prompt
    assert r.json()["shots"][0]["characters"] == ["阿明"]


# ---------------------------------------------------------------------------
# 链 A ⑤:重试仍结构非法 → 502 带明确 detail
# ---------------------------------------------------------------------------
def test_invalid_structure_retry_exhausted_502(ctx):
    client, token = ctx
    H = _h(token)
    pid = _make_project_with_chars(client, token, [{"name": "阿明"}])

    bad_msg = {"content": "这不是 JSON"}
    mock_chat = AsyncMock(return_value=bad_msg)
    with patch("app.routes.drama_studio.llm.chat", mock_chat):
        r = client.post(f"/api/drama/projects/{pid}/storyboard", headers=H,
                        json={"num_shots": 1})
    assert r.status_code == 502, r.text
    assert "分镜生成失败" in r.json()["detail"]
    assert "合法 JSON" in r.json()["detail"]  # 明确 detail 带失败原因
    assert mock_chat.await_count == 2  # 首次 + 重试各一次


# ---------------------------------------------------------------------------
# 链 A ⑦:回写预算内循环续等(永久 generating 修复)
#   首轮超时(作业非终态)→ 续等第二轮 done → 回写;预算耗尽 → 标 error;
#   作业 error / 竞态 done 路径旧语义不变
# ---------------------------------------------------------------------------
def _seed_generating_shot(ctx, *, job_status: str, job_result: str = ""):
    """落库:1 项目 + 1 generating 分镜 + 1 配套 Job。返回 (shot_id, prompt_id)。"""
    from app.db import engine

    client, token = ctx
    pid = client.post("/api/drama/projects", headers=_h(token),
                      json={"title": "writeback"}).json()["id"]
    with Session(engine) as s:
        user = s.exec(select(User).where(User.email == "v@toiv.ai")).first()
        shot = DramaShot(project_id=pid, idx=0, prompt="a boy runs", seed=42,
                         video_status="generating")
        s.add(shot)
        s.commit()
        s.refresh(shot)
        s.add(Job(tenant_id=user.tenant_id, user_id=user.id, prompt_id="pid-wb",
                  worker="http://w:8188", kind="drama_shot_video", status=job_status,
                  prompt="a boy runs", seed=42, result=job_result))
        s.commit()
        return shot.id, "pid-wb"


@pytest.mark.asyncio
async def test_writeback_timeout_resumes_and_writes_back(ctx):
    """首轮超时(作业仍 running)→ 预算内续等第二轮,done 后正常回写 video_url。

    回归「豁免 return 后无人收口 → 永久 generating」:续等期间 tracker 落库 done,
    第二轮重读 Job 必须完成回写,而不是保持 generating 返回。
    """
    from app.db import engine
    import app.routes.drama_studio as ds

    url = "/api/images?filename=x.mp4&worker=w"
    sid, prompt_id = _seed_generating_shot(ctx, job_status="running")
    calls: list[float] = []

    async def _fake_wait(session, prompt_ids, timeout=300.0, poll_interval=1.0):
        calls.append(timeout)
        if len(calls) == 1:
            raise RuntimeError("等待作业超时: {'pid-wb'}")
        # 第二轮:模拟 tracker 在续等期间已把作业落库 done(经同一 Session 提交,
        # 回写函数随后 commit 刷新快照必然可见)
        job = session.exec(select(Job).where(Job.prompt_id == "pid-wb")).first()
        job.status = "done"
        job.result = json.dumps([url])
        session.add(job)
        session.commit()
        return {"pid-wb": [url]}

    with patch("app.routes.drama_studio.wait_for_jobs", _fake_wait):
        ok = await ds._await_shot_video_writeback(sid, prompt_id)
    assert ok is True
    assert len(calls) == 2  # 首轮超时后续等了一轮,未豁免返回
    assert all(t <= 900.0 for t in calls)  # 每轮窗口不超 900s 上限
    with Session(engine) as s:
        shot = s.get(DramaShot, sid)
        assert shot.video_status == "done"
        assert shot.video_url == url


@pytest.mark.asyncio
async def test_writeback_budget_exhausted_marks_error(ctx):
    """预算(job_track_timeout)耗尽作业仍非终态 → 标 error(超出 tracker 兜底窗口)。"""
    from app.db import engine
    import app.routes.drama_studio as ds

    sid, prompt_id = _seed_generating_shot(ctx, job_status="running")
    wait_mock = AsyncMock(side_effect=RuntimeError("等待作业超时: {'pid-wb'}"))
    fake_settings = MagicMock()
    fake_settings.job_track_timeout = 0.0  # 预算为 0 → 立即耗尽
    with patch("app.routes.drama_studio.wait_for_jobs", wait_mock), \
         patch("app.routes.drama_studio.get_settings", return_value=fake_settings):
        ok = await ds._await_shot_video_writeback(sid, prompt_id)
    assert ok is False
    assert wait_mock.await_count == 0  # 预算已尽,一轮都不再等待
    with Session(engine) as s:
        shot = s.get(DramaShot, sid)
        assert shot.video_status == "error"
        assert "超出 tracker 兜底窗口" in shot.error


@pytest.mark.asyncio
async def test_writeback_job_error_still_marks_error(ctx):
    """作业已 error(非超时豁免路径)→ 维持标 error 旧语义。"""
    from app.db import engine
    import app.routes.drama_studio as ds

    sid, prompt_id = _seed_generating_shot(ctx, job_status="error")
    with patch(
        "app.routes.drama_studio.wait_for_jobs",
        AsyncMock(side_effect=RuntimeError("作业 pid-wb 执行失败")),
    ):
        ok = await ds._await_shot_video_writeback(sid, prompt_id)
    assert ok is False
    with Session(engine) as s:
        shot = s.get(DramaShot, sid)
        assert shot.video_status == "error"
        assert "回写异常" in shot.error


@pytest.mark.asyncio
async def test_writeback_timeout_race_done_writes_back(ctx):
    """竞态:wait 抛超时瞬间作业恰好 done → 仍正常回写 video_url,不标 error。"""
    from app.db import engine
    import app.routes.drama_studio as ds

    url = "/api/images?filename=x.mp4&worker=w"
    sid, prompt_id = _seed_generating_shot(
        ctx, job_status="done", job_result=json.dumps([url])
    )
    with patch(
        "app.routes.drama_studio.wait_for_jobs",
        AsyncMock(side_effect=RuntimeError("等待作业超时: {'pid-wb'}")),
    ):
        ok = await ds._await_shot_video_writeback(sid, prompt_id)
    assert ok is True
    with Session(engine) as s:
        shot = s.get(DramaShot, sid)
        assert shot.video_status == "done"
        assert shot.video_url == url


# ---------------------------------------------------------------------------
# 链 A ⑦ 推广:多候选回写 _writeback_candidate 同款预算内循环续等
#   首轮超时 → 续等第二轮 done 回写并自动 pick / 作业 error 标 error / 竞态 done 回写
# ---------------------------------------------------------------------------
def _seed_candidate(ctx, *, job_status: str, job_result: str = ""):
    """落库:1 项目 + 1 generating 分镜 + 1 generating 候选 + 1 配套 Job。
    返回 (shot_id, candidate_id, prompt_id)。"""
    from app.db import engine
    from app.models import DramaShotCandidate

    client, token = ctx
    pid = client.post("/api/drama/projects", headers=_h(token),
                      json={"title": "candidate-wb"}).json()["id"]
    with Session(engine) as s:
        user = s.exec(select(User).where(User.email == "v@toiv.ai")).first()
        shot = DramaShot(project_id=pid, idx=0, prompt="a boy runs", seed=42,
                         video_status="generating")
        s.add(shot)
        s.commit()
        s.refresh(shot)
        cand = DramaShotCandidate(shot_id=shot.id, project_id=pid, seed=42,
                                  status="generating")
        s.add(cand)
        s.commit()
        s.refresh(cand)
        s.add(Job(tenant_id=user.tenant_id, user_id=user.id, prompt_id="pid-cand",
                  worker="http://w:8188", kind="drama_shot_video", status=job_status,
                  prompt="a boy runs", seed=42, result=job_result))
        s.commit()
        return shot.id, cand.id, "pid-cand"


@pytest.mark.asyncio
async def test_candidate_writeback_timeout_resumes_and_writes_back(ctx):
    """首轮超时(作业仍 running)→ 预算内续等第二轮,done 后回写 url 并自动 pick。

    与 _await_shot_video_writeback 同款「豁免后无人收口 → 永久 generating」回归。
    """
    from app.db import engine
    from app.models import DramaShotCandidate
    import app.routes.drama_studio as ds

    url = "/api/images?filename=c.mp4&worker=w"
    sid, cid, prompt_id = _seed_candidate(ctx, job_status="running")
    calls: list[float] = []

    async def _fake_wait(session, prompt_ids, timeout=300.0, poll_interval=1.0):
        calls.append(timeout)
        if len(calls) == 1:
            raise RuntimeError("等待作业超时: {'pid-cand'}")
        # 第二轮:模拟 tracker 在续等期间已把作业落库 done
        job = session.exec(select(Job).where(Job.prompt_id == "pid-cand")).first()
        job.status = "done"
        job.result = json.dumps([url])
        session.add(job)
        session.commit()
        return {"pid-cand": [url]}

    with patch("app.routes.drama_studio.wait_for_jobs", _fake_wait):
        await ds._writeback_candidate(prompt_id, cid, sid)
    assert len(calls) == 2  # 首轮超时后续等了一轮,未豁免返回
    with Session(engine) as s:
        cand = s.get(DramaShotCandidate, cid)
        assert cand.status == "done"
        assert cand.url == url
        assert cand.is_picked is True  # 首个完成者自动 pick
        shot = s.get(DramaShot, sid)
        assert shot.video_status == "done"
        assert shot.video_url == url


@pytest.mark.asyncio
async def test_candidate_writeback_job_error_still_marks_error(ctx):
    """作业已 error(非超时豁免路径)→ 维持标 error 旧语义。"""
    from app.db import engine
    from app.models import DramaShotCandidate
    import app.routes.drama_studio as ds

    sid, cid, prompt_id = _seed_candidate(ctx, job_status="error")
    with patch(
        "app.routes.drama_studio.wait_for_jobs",
        AsyncMock(side_effect=RuntimeError("作业 pid-cand 执行失败")),
    ):
        await ds._writeback_candidate(prompt_id, cid, sid)
    with Session(engine) as s:
        cand = s.get(DramaShotCandidate, cid)
        assert cand.status == "error"
        assert "回写异常" in cand.error


@pytest.mark.asyncio
async def test_candidate_writeback_timeout_race_done_writes_back(ctx):
    """竞态:wait 抛超时瞬间作业恰好 done → 正常回写 url 并自动 pick 到分镜。"""
    from app.db import engine
    from app.models import DramaShotCandidate
    import app.routes.drama_studio as ds

    url = "/api/images?filename=c.mp4&worker=w"
    sid, cid, prompt_id = _seed_candidate(
        ctx, job_status="done", job_result=json.dumps([url])
    )
    with patch(
        "app.routes.drama_studio.wait_for_jobs",
        AsyncMock(side_effect=RuntimeError("等待作业超时: {'pid-cand'}")),
    ):
        await ds._writeback_candidate(prompt_id, cid, sid)
    with Session(engine) as s:
        cand = s.get(DramaShotCandidate, cid)
        assert cand.status == "done"
        assert cand.url == url
        assert cand.is_picked is True  # 首个完成者自动 pick
        shot = s.get(DramaShot, sid)
        assert shot.video_status == "done"
        assert shot.video_url == url


# ---------------------------------------------------------------------------
# 链 A ⑧:reconcile_interrupted 两段匹配(prompt_override 误标 error 修复)
#   prompt 精确匹配落空且 seed 非 0 → seed+属主兜底找回;seed=0 不兜底,标 error
# ---------------------------------------------------------------------------
def _seed_reconcile_override(ctx, *, shot_seed: int, job_status: str = "done"):
    """落库:1 项目 + 1 个 generating 分镜(prompt 为原 LLM 提示词)+ 1 个
    prompt 被 prompt_override 改写的配套 Job(模拟 generate-video-v2 存 override
    文本导致精确匹配落空的现场)。返回 (shot_id, pid)。"""
    from app.db import engine

    client, token = ctx
    pid = client.post("/api/drama/projects", headers=_h(token),
                      json={"title": "reconcile-override"}).json()["id"]
    with Session(engine) as s:
        user = s.exec(select(User).where(User.email == "v@toiv.ai")).first()
        shot = DramaShot(project_id=pid, idx=0, prompt="original llm prompt",
                         seed=shot_seed, video_status="generating")
        s.add(shot)
        s.commit()
        s.refresh(shot)
        s.add(Job(tenant_id=user.tenant_id, user_id=user.id, prompt_id="pid-ovr",
                  worker="http://w:8188", kind="drama_shot_video_v2", status=job_status,
                  prompt="override text", seed=shot_seed,
                  result='["/api/images?filename=o.mp4&worker=w"]'
                  if job_status == "done" else ""))
        s.commit()
        return shot.id, pid


def test_reconcile_fallback_seed_owner_recovers_done_job(ctx):
    """prompt_override 致 prompt 精确匹配落空,但 seed 非 0 → seed+属主兜底找回
    done Job → 直接回写 video_url,不误标 error。"""
    from app.db import engine
    import app.routes.drama_studio as ds

    sid, _ = _seed_reconcile_override(ctx, shot_seed=42)
    stats = ds.reconcile_interrupted()

    assert stats["writeback"] == 1
    assert stats["error"] == 0
    with Session(engine) as s:
        shot = s.get(DramaShot, sid)
        assert shot.video_status == "done"
        assert shot.video_url == "/api/images?filename=o.mp4&worker=w"
        assert shot.error == ""


def test_reconcile_no_fallback_when_seed_zero(ctx):
    """seed=0(默认值碰撞率高)且 prompt 不匹配 → 不启用兜底,维持标 error。"""
    from app.db import engine
    import app.routes.drama_studio as ds

    sid, _ = _seed_reconcile_override(ctx, shot_seed=0)
    stats = ds.reconcile_interrupted()

    assert stats["error"] == 1
    assert stats["writeback"] == 0
    with Session(engine) as s:
        shot = s.get(DramaShot, sid)
        assert shot.video_status == "error"
        assert "服务重启中断" in shot.error


# ---------------------------------------------------------------------------
# 链 B ⑥:known_characters 注入 → 近匹配纠正 + 新名放行;缺省不启用校验
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_chain_b_known_characters_reconcile(monkeypatch):
    payload = {
        "characters": [
            {"name": "楚 生", "description": "落魄青年", "visual_prompt": "1boy, worn jacket"}
        ],
        "shots": [
            {"scene": "雨夜", "prompt": "rainy alley, neon",
             "characters": ["楚 生", "新面孔"], "render_mode": "video"},
        ],
    }

    async def fake_chat_layered(messages, layer="L1", max_tokens=None, temperature=0.5):
        return {"role": "assistant", "content": json.dumps(payload, ensure_ascii=False)}

    monkeypatch.setattr(storyboard.llm, "chat_layered", fake_chat_layered)
    chars, shots = await storyboard.parse_script(
        "雨夜重逢", num_shots=4, known_characters=["楚生"]
    )
    # CharacterDraft.name 空白近匹配 → 纠正为 "楚生"
    assert chars[0].name == "楚生"
    # 分镜 characters:"楚 生" 纠正为集合内名字;"新面孔" 全新名字放行
    assert shots[0].characters == ["楚生", "新面孔"]


@pytest.mark.asyncio
async def test_chain_b_no_known_characters_passthrough(monkeypatch):
    """known_characters 缺省 None → 校验不启用,角色名原样放行(旧行为)。"""
    payload = {
        "characters": [{"name": "楚生", "description": "", "visual_prompt": "1boy"}],
        "shots": [{"scene": "雨夜", "prompt": "rainy alley",
                   "characters": ["楚 生"], "render_mode": "video"}],
    }

    async def fake_chat_layered(messages, layer="L1", max_tokens=None, temperature=0.5):
        return {"role": "assistant", "content": json.dumps(payload, ensure_ascii=False)}

    monkeypatch.setattr(storyboard.llm, "chat_layered", fake_chat_layered)
    _, shots = await storyboard.parse_script("雨夜", num_shots=4)
    assert shots[0].characters == ["楚 生"]  # 未注入合法集合 → 不纠正


# ---------------------------------------------------------------------------
# 兼容:链 A _coerce_shot 委托 ShotOut 后与旧手工规整行为等价
# ---------------------------------------------------------------------------
def test_coerce_shot_pydantic_equivalence():
    from app.routes.drama_studio import _coerce_shot

    d = _coerce_shot(
        {"scene": " s ", "prompt": 123, "characters": "not-a-list", "duration_sec": 99},
        0,
    )
    assert d == {
        "scene": "s", "prompt": "123", "characters": [],
        "dialogue": "", "speaker": "", "duration_sec": 15,  # 钳制上限
        # P1 衔接策略层:新增两字段随 model_dump 透出(缺省空=未规划)
        "seam_to_next": "", "seam_anchor": "",
        # WORKBENCH 补齐:mood/beat 随 model_dump 透出(缺省空)
        "mood": "", "beat": "",
    }
    # 非数字 duration 回退 6;1 触发下限钳制 2(0 为 falsy 走「or 6」回退,旧逻辑同)
    assert _coerce_shot({"duration_sec": "abc"}, 0)["duration_sec"] == 6
    assert _coerce_shot({"duration_sec": 1}, 0)["duration_sec"] == 2
    assert _coerce_shot({"duration_sec": 0}, 0)["duration_sec"] == 6
    # 非 dict 输入 → 全默认
    d3 = _coerce_shot("garbage", 0)
    assert d3["duration_sec"] == 6 and d3["prompt"] == "" and d3["characters"] == []
    # characters 元素 strip + 空串过滤(无 context → 原名放行)
    d4 = _coerce_shot({"characters": [" 阿明 ", "", None]}, 0)
    assert d4["characters"] == ["阿明", "None"]
