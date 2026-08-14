"""剧本拆解 LLM 输出 pydantic validation_context 校验测试(链 A drama / 链 B studio)。

覆盖:
  链 A(POST /api/drama/projects/{pid}/storyboard):
    ① 合法角色名精确命中 → 通过
    ② 大小写/空白近匹配 → 自动纠正为集合内名字
    ③ 全新角色名 → 放行且走既有自动建行路径(不破坏旧特性)
    ④ 输出结构非法 → 校验错误摘要反馈进 prompt 重试一次 → 成功
    ⑤ 重试仍结构非法 → 502 带明确 detail
    ⑦ 分镜视频回写 wait_for_jobs 超时 → 不再标 error(保持 generating);
       作业已 error / 超时瞬间恰好 done 的竞态路径行为不变
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
# 链 A ⑦:回写等待超时 → 不标 error,保持 generating(分裂修复)
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
async def test_writeback_timeout_keeps_generating(ctx):
    """wait_for_jobs 超时(作业仍 running)→ 保持 generating,不标 error。"""
    from app.db import engine
    import app.routes.drama_studio as ds

    sid, prompt_id = _seed_generating_shot(ctx, job_status="running")
    with patch(
        "app.routes.drama_studio.wait_for_jobs",
        AsyncMock(side_effect=RuntimeError("等待作业超时: {'pid-wb'}")),
    ):
        ok = await ds._await_shot_video_writeback(sid, prompt_id)
    assert ok is False
    with Session(engine) as s:
        shot = s.get(DramaShot, sid)
        assert shot.video_status == "generating"  # 超时豁免:不再标 error
        assert shot.error == ""


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
