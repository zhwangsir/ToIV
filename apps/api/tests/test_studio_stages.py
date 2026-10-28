"""C1c 阶段状态机与确认门禁——真实 HTTP 切片测试。

覆盖:状态机(确认顺序/就绪/幂等/409 并发)、跳过与重开、审计历史归属、
上游失效(save_shots/reflow/premise/style/ckpt/角色定向)、批量渲染门禁
(空批次不设防)、assemble 门禁(voice + final stale)、无对白路径、迁移。
"""
from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

import app.db as db_mod
from app.db import get_session
from app.main import app
from app.models import (
    StudioProject,
    StudioStageConfirmation,
    Tenant,
    User,
)
from app.security import create_token, hash_password
from app.services.studio import orchestrator as orch
from app.services.studio import stages as stages_svc


@pytest.fixture()
def ctx(monkeypatch):
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    SQLModel.metadata.create_all(engine)

    def override():
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override
    monkeypatch.setattr(db_mod, "engine", engine)
    with Session(engine) as s:
        t = Tenant(name="stage"); s.add(t); s.commit(); s.refresh(t)
        u = User(email="stg@toiv.ai", hashed_password=hash_password("p"), tenant_id=t.id)
        s.add(u); s.commit(); s.refresh(u)
        uid = u.id
        t2 = Tenant(name="stage2"); s.add(t2); s.commit(); s.refresh(t2)
        u2 = User(email="stg2@toiv.ai", hashed_password=hash_password("p"), tenant_id=t2.id)
        s.add(u2); s.commit(); s.refresh(u2)
        uid2 = u2.id
    yield TestClient(app), create_token(uid), create_token(uid2), engine
    app.dependency_overrides.clear()


def _h(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def _mk_project(client, H, title="阶段", premise="雨夜重逢的故事", **over):
    body = {"title": title, "premise": premise}
    body.update(over)
    r = client.post("/api/studio/projects", headers=H, json=body)
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _put_shots(client, H, pid, shots):
    r = client.put(f"/api/studio/projects/{pid}/shots", headers=H, json={"shots": shots})
    assert r.status_code == 200, r.text
    return r.json()["shots"]


def _transition(client, H, pid, stage, action, note="", expected=None):
    body = {"stage": stage, "action": action, "note": note}
    if expected is not None:
        body["expected_stage_revision"] = expected
    return client.post(f"/api/studio/projects/{pid}/stage-transition", headers=H, json=body)


def _stages(client, H, pid):
    r = client.get(f"/api/studio/projects/{pid}", headers=H)
    assert r.status_code == 200, r.text
    return r.json()["stage_states"], r.json()["stage_revision"]


def _confirm_storyboard(client, H, pid):
    # script → assets(跳过) → storyboard 依序确认(前序须 confirmed/skipped)
    r = _transition(client, H, pid, "script", "confirm", "剧本定稿")
    assert r.status_code == 200, r.text
    r = _transition(client, H, pid, "assets", "skip", "无角色,跳过资产确认")
    assert r.status_code == 200, r.text
    r = _transition(client, H, pid, "storyboard", "confirm", "分镜定稿")
    assert r.status_code == 200, r.text


def _fake_render(monkeypatch, url="/api/studio/files/r.mp4"):
    class FakeRenderer:
        name = "video"

        async def render(self, shot, cast, pool, **kw):
            return type("RR", (), {"kind": "video", "url": url, "pipeline_meta": {}})()

    monkeypatch.setattr(orch, "get_renderer", lambda shot: FakeRenderer())


# ── 状态机:初态/就绪/确认顺序/幂等/409 ──────────────────────────────────────


def test_initial_states_and_readiness(ctx):
    """旧项目/空项目不自动 confirmed;ready/blockers 由产物现算。"""
    client, token, _, _ = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    states, rev = _stages(client, H, pid)
    assert rev == 0
    assert states["script"]["state"] == "pending_confirmation"  # premise 非空 → 就绪
    assert states["assets"]["state"] == "draft"
    assert states["assets"]["ready"] is False
    assert states["storyboard"]["state"] == "draft"
    assert states["storyboard"]["blockers"] == ["尚无分镜"]

    _put_shots(client, H, pid, [{"scene": "A", "prompt": "a"}])
    states, _ = _stages(client, H, pid)
    assert states["storyboard"]["state"] == "pending_confirmation"
    assert states["storyboard"]["ready"] is True
    # generate 未渲染 → 不就绪(draft)
    assert states["generate"]["state"] == "draft"
    assert any("视觉产物未就绪" in b for b in states["generate"]["blockers"])


def test_confirm_order_and_ready_gate(ctx):
    """确认需就绪 + 前序 confirmed/skipped;未就绪确认被拒。"""
    client, token, _, _ = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    _put_shots(client, H, pid, [{"scene": "A", "prompt": "a"}])
    # 跳级:storyboard 先于 script → 409
    r = _transition(client, H, pid, "storyboard", "confirm", "定稿")
    assert r.status_code == 409 and "前序" in r.json()["detail"]
    # generate 未就绪 → 确认被拒(即便前序全过)
    _confirm_storyboard(client, H, pid)
    r = _transition(client, H, pid, "generate", "confirm", "生成定稿")
    assert r.status_code == 409 and "未就绪" in r.json()["detail"]
    # assets 无角色但未就绪 → 不可确认(可显式跳过)
    assert _transition(client, H, pid, "assets", "confirm", "").status_code == 409
    r = _transition(client, H, pid, "assets", "skip", "无角色项目,跳过")
    assert r.status_code == 200, r.text


def test_confirm_idempotent_and_revision_conflict(ctx):
    """重复确认不重复写历史;expected_stage_revision 不符 409。"""
    client, token, _, _ = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    _put_shots(client, H, pid, [{"scene": "A", "prompt": "a"}])
    _, rev0 = _stages(client, H, pid)
    r = _transition(client, H, pid, "script", "confirm", "定稿", expected=999)
    assert r.status_code == 409 and "stage_revision" in r.json()["detail"]
    r = _transition(client, H, pid, "script", "confirm", "定稿", expected=rev0)
    assert r.status_code == 200, r.text
    _, rev1 = _stages(client, H, pid)
    assert rev1 == rev0 + 1
    # 重复 confirm:幂等,无新历史、revision 不动
    hist_before = client.get(f"/api/studio/projects/{pid}/stages/history", headers=H).json()["history"]
    r = _transition(client, H, pid, "script", "confirm", "又确认")
    assert r.status_code == 200, r.text
    _, rev2 = _stages(client, H, pid)
    assert rev2 == rev1, "幂等确认不得递增 stage_revision"
    hist_after = client.get(f"/api/studio/projects/{pid}/stages/history", headers=H).json()["history"]
    assert len(hist_after) == len(hist_before), "重复确认不重复写历史"


def test_skip_requires_note_and_reopen(ctx):
    client, token, _, _ = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    # skip 无说明 → 422
    r = _transition(client, H, pid, "assets", "skip", "")
    assert r.status_code == 422 or r.status_code == 409, r.text
    assert "说明" in r.json()["detail"]
    # skip → reopen → pending_confirmation
    assert _transition(client, H, pid, "assets", "skip", "空项目跳过").status_code == 200
    states, _ = _stages(client, H, pid)
    assert states["assets"]["state"] == "skipped"
    r = _transition(client, H, pid, "assets", "reopen", "重新检查")
    assert r.status_code == 200, r.text
    states, _ = _stages(client, H, pid)
    assert states["assets"]["state"] == "pending_confirmation"
    # reopen 幂等(pending 再 reopen 无历史增长)
    hist = client.get(f"/api/studio/projects/{pid}/stages/history", headers=H).json()["history"]
    assert _transition(client, H, pid, "assets", "reopen", "").status_code == 200
    hist2 = client.get(f"/api/studio/projects/{pid}/stages/history", headers=H).json()["history"]
    assert len(hist2) == len(hist)
    # 审计:from/to 正确
    hist3 = client.get(f"/api/studio/projects/{pid}/stages/history?stage=assets", headers=H).json()["history"]
    assert hist3[0]["from_state"] == "skipped" and hist3[0]["to_state"] == "pending_confirmation"
    assert hist3[0]["note"] == "重新检查"


def test_history_tenant_isolated(ctx):
    client, token, token2, _ = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    _transition(client, H, pid, "script", "confirm", "定稿")
    H2 = _h(token2)
    assert client.get(f"/api/studio/projects/{pid}/stages/history", headers=H2).status_code == 404
    assert client.post(f"/api/studio/projects/{pid}/stage-transition", headers=H2,
                       json={"stage": "script", "action": "reopen"}).status_code == 404
    # stage 过滤
    hist = client.get(f"/api/studio/projects/{pid}/stages/history?stage=script", headers=H).json()["history"]
    assert len(hist) == 1 and hist[0]["stage"] == "script"
    assert client.get(f"/api/studio/projects/{pid}/stages/history?stage=generate", headers=H).json()["history"] == []


# ── 上游失效 ────────────────────────────────────────────────────────────────


def test_save_shots_invalidates_confirmed_downstream(ctx):
    """真实内容保存 → storyboard/generate/voice/timeline 标 needs_review + 审计;
    重复无变化保存不误标。"""
    client, token, _, _ = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    shots = _put_shots(client, H, pid, [{"scene": "A", "prompt": "a"}])
    _confirm_storyboard(client, H, pid)
    # 真实变更
    _put_shots(client, H, pid, [{"id": shots[0]["id"], "scene": "A", "prompt": "a2"}])
    states, _ = _stages(client, H, pid)
    assert states["storyboard"]["state"] == "needs_review"
    assert states["generate"]["state"] == "draft"  # 从未确认,不标
    hist = client.get(f"/api/studio/projects/{pid}/stages/history?stage=storyboard", headers=H).json()["history"]
    assert hist[0]["to_state"] == "needs_review" and hist[0]["source"] == "system"
    # 再次确认后,无变化保存 → 不再误标
    _transition(client, H, pid, "storyboard", "reopen", "再看")
    _transition(client, H, pid, "storyboard", "confirm", "定稿2")
    hist_base = client.get(f"/api/studio/projects/{pid}/stages/history", headers=H).json()["history"]
    _put_shots(client, H, pid, [{"id": shots[0]["id"], "scene": "A", "prompt": "a2"}])
    states, _ = _stages(client, H, pid)
    assert states["storyboard"]["state"] == "confirmed", "无变化保存不得误标 needs_review"
    hist_now = client.get(f"/api/studio/projects/{pid}/stages/history", headers=H).json()["history"]
    assert len(hist_now) == len(hist_base), "无变化保存不得新增审计"


def test_project_and_character_upstream_invalidation(ctx):
    """premise/style/ckpt 与角色视觉/音色 → 定向下游失效;无变化不误标。"""
    client, token, _, _ = ctx
    H = _h(token)
    pid = _mk_project(client, H, style="古风")
    _put_shots(client, H, pid, [{"scene": "A", "prompt": "a"}])
    cr = client.post(f"/api/studio/projects/{pid}/characters", headers=H,
                     json={"name": "楚生", "visual_prompt": "1boy"})
    cid = cr.json()["id"]
    client.patch(f"/api/studio/characters/{cid}", headers=H,
                 json={"voice_ref_url": "/api/studio/files/ref.wav"})
    # 依序确认 script/assets/storyboard(有角色 → assets 可确认)
    for stage in ("script", "assets", "storyboard"):
        assert _transition(client, H, pid, stage, "confirm", "ok").status_code == 200
    assert _transition(client, H, pid, "generate", "skip", "逐镜迭代中").status_code == 200
    assert _transition(client, H, pid, "voice", "skip", "稍后统一配").status_code == 200

    # premise 变更 → script + storyboard 失效;style/ckpt → storyboard/generate(已 skip→失效)/timeline
    client.patch(f"/api/studio/projects/{pid}", headers=H, json={"premise": "新的故事"})
    states, _ = _stages(client, H, pid)
    assert states["script"]["state"] == "needs_review"
    assert states["storyboard"]["state"] == "needs_review"
    assert states["voice"]["state"] == "skipped", "无关下游不动"
    client.patch(f"/api/studio/projects/{pid}", headers=H, json={"style": "赛博"})
    states, _ = _stages(client, H, pid)
    assert states["generate"]["state"] == "needs_review"
    assert states["voice"]["state"] == "skipped"

    # 角色音色变更 → voice 失效;视觉变更 → generate 失效(已 needs_review 幂等)
    client.patch(f"/api/studio/characters/{cid}", headers=H,
                 json={"voice_ref_url": "/api/studio/files/ref2.wav"})
    states, _ = _stages(client, H, pid)
    assert states["voice"]["state"] == "needs_review"
    # generate 已 needs_review(幂等不再写);重开并显式跳过后,视觉变更应再次标记
    _transition(client, H, pid, "generate", "reopen", "复查")
    _transition(client, H, pid, "generate", "skip", "仍跳过")
    n_hist = len(client.get(f"/api/studio/projects/{pid}/stages/history", headers=H).json()["history"])
    client.patch(f"/api/studio/characters/{cid}", headers=H, json={"visual_prompt": "2boys"})
    states, _ = _stages(client, H, pid)
    assert states["generate"]["state"] == "needs_review"
    n_hist2 = len(client.get(f"/api/studio/projects/{pid}/stages/history", headers=H).json()["history"])
    assert n_hist2 > n_hist
    # 无变化 PATCH 不误标
    client.patch(f"/api/studio/characters/{cid}", headers=H, json={"visual_prompt": "2boys"})
    n_hist3 = len(client.get(f"/api/studio/projects/{pid}/stages/history", headers=H).json()["history"])
    assert n_hist3 == n_hist2, "无变化角色保存不得新增审计"


# ── 门禁:批量渲染 / assemble ───────────────────────────────────────────────


def _rendered_project(client, H, pid, monkeypatch):
    _fake_render(monkeypatch)
    shots = _put_shots(client, H, pid, [{"scene": "A", "prompt": "a"}])
    r = client.post(f"/api/studio/shots/{shots[0]['id']}/render", headers=H,
                    json={"num_candidates": 1, "wait": True, "force_direct": True})
    assert r.status_code == 200, r.text


def test_batch_render_requires_storyboard_confirmed(ctx, monkeypatch):
    client, token, _, _ = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    _put_shots(client, H, pid, [{"scene": "A", "prompt": "a"}])
    # 未确认 → 409
    r = client.post(f"/api/studio/projects/{pid}/render", headers=H, json={"wait": False})
    assert r.status_code == 409 and "storyboard" in r.json()["detail"]
    # 确认后 → direct 专家夹具放行(替身渲染后台跑);keyframe 反例由 D0 契约覆盖。
    _confirm_storyboard(client, H, pid)
    assert client.patch(f"/api/studio/projects/{pid}", headers=H,
                        json={"preferred_drive_mode": "direct"}).status_code == 200
    r = client.post(f"/api/studio/projects/{pid}/render", headers=H, json={"wait": False})
    assert r.status_code == 202, r.text


def test_batch_render_empty_batch_not_gated(ctx, monkeypatch):
    """全部镜已终态 → 空批次,不设门禁(原语义)。"""
    client, token, _, _ = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    _rendered_project(client, H, pid, monkeypatch)
    r = client.post(f"/api/studio/projects/{pid}/render", headers=H, json={"wait": False})
    assert r.status_code == 202, r.text


def test_single_shot_render_not_gated(ctx, monkeypatch):
    """单镜迭代不受 storyboard 门禁(产出待确认结果的路径)。"""
    client, token, _, _ = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    shots = _put_shots(client, H, pid, [{"scene": "A", "prompt": "a"}])
    _fake_render(monkeypatch)
    r = client.post(f"/api/studio/shots/{shots[0]['id']}/render", headers=H,
                    json={"num_candidates": 1, "wait": True, "force_direct": True})
    assert r.status_code == 200, r.text


def test_assemble_requires_voice_confirmed_and_no_stale_final(ctx, monkeypatch):
    client, token, _, _ = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    shots = _put_shots(client, H, pid, [
        {"scene": "A", "prompt": "a", "dialogue": "台词"},
    ])
    sid = shots[0]["id"]
    _fake_render(monkeypatch)
    r = client.post(f"/api/studio/shots/{sid}/render", headers=H,
                    json={"num_candidates": 1, "wait": True, "force_direct": True})
    assert r.status_code == 200, r.text
    # voice 未确认 → 409(即便产物已在)
    r = client.post(f"/api/studio/projects/{pid}/assemble", headers=H)
    assert r.status_code == 409 and "voice" in r.json()["detail"]
    # voice 未就绪(有对白未配音,state=draft)→ confirm 被就绪门禁拦
    _confirm_storyboard(client, H, pid)
    assert _transition(client, H, pid, "generate", "confirm", "已出片").status_code == 200
    r = _transition(client, H, pid, "voice", "confirm", "已配音")
    assert r.status_code == 409 and "未就绪" in r.json()["detail"]
    # 显式跳过 voice → 门禁通过,落入 assemble 原有缺件 422 语义(无 final/配音)
    _transition(client, H, pid, "voice", "skip", "本镜用默认音,稍后配")
    r = client.post(f"/api/studio/projects/{pid}/assemble", headers=H)
    # 门禁通过 → 落入 assemble 原有错误语义(替身文件不在盘 → 片段缺失)
    assert r.status_code == 502 and "片段" in r.json()["detail"], r.text


def test_assemble_rejects_stale_final(ctx, monkeypatch):
    """final stale(改词后未重配音)→ 409 点名,不只查 final_clip_url。"""
    from app.services.studio import voice as voice_mod

    client, token, _, _ = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    shots = _put_shots(client, H, pid, [
        {"scene": "A", "prompt": "a", "dialogue": "台词"},
    ])
    sid = shots[0]["id"]
    _fake_render(monkeypatch)
    client.post(f"/api/studio/shots/{sid}/render", headers=H,
                json={"num_candidates": 1, "wait": True, "force_direct": True})
    monkeypatch.setattr(voice_mod, "_save_wav", lambda data: "/api/studio/files/v.wav")

    class FakeClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return None

        async def post(self, url, data=None, files=None):
            return type("R", (), {"status_code": 200, "content": b"RIFF" + b"\x00" * 8})()

        async def get(self, url):
            raise AssertionError("无参考音")

    monkeypatch.setattr(voice_mod.httpx, "AsyncClient", lambda **kw: FakeClient())
    monkeypatch.setattr(voice_mod, "get_settings", lambda: type(
        "S", (), {"tts_url": "http://tts:9200", "tts_multilingual_url": "",
                  "api_base_url": "http://api.test"})())
    r = client.post(f"/api/studio/shots/{sid}/voice", headers=H)
    assert r.status_code == 200, r.text
    # 对口型(skip 路径,全替身)
    from app.services.studio import lipsync as ls

    async def _dl(http, url):
        return b"x"

    monkeypatch.setattr(ls, "_download", _dl)
    monkeypatch.setattr(ls, "pad_audio_to_video_length", lambda v, a: _co(a))
    monkeypatch.setattr(ls, "mux_voice_into_clip", lambda v, a: _co(b"mux"))
    monkeypatch.setattr(ls, "_save_clip", lambda data: "/api/studio/files/f.mp4")
    r = client.post(f"/api/studio/shots/{sid}/lipsync/skip", headers=H)
    assert r.status_code == 200, r.text
    assert r.json()["final_media_status"] == "current"

    # 确认 voice → 改台词(不重配音)→ voice 被标 needs_review + final stale
    _confirm_storyboard(client, H, pid)
    _transition(client, H, pid, "generate", "confirm", "已出片")
    _transition(client, H, pid, "voice", "confirm", "已配音对口型")
    _put_shots(client, H, pid, [
        {"id": sid, "scene": "A", "prompt": "a", "dialogue": "改过的台词"},
    ])
    states, _ = _stages(client, H, pid)
    assert states["voice"]["state"] == "needs_review", "上游改词须标 voice 失效"
    _transition(client, H, pid, "voice", "skip", "接受现状,待重配")
    r = client.post(f"/api/studio/projects/{pid}/assemble", headers=H)
    assert r.status_code == 409 and "过期" in r.json()["detail"], r.text


async def _co(v):
    return v


# ── 无对白路径 ──────────────────────────────────────────────────────────────


def test_no_dialogue_shot_not_stuck_by_empty_pointers(ctx, monkeypatch):
    """无对白镜:render 后 final(raw)=current;voice 阶段不被空指针卡死。"""
    client, token, _, _ = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    shots = _put_shots(client, H, pid, [{"scene": "A", "prompt": "a"}])  # 无 dialogue
    sid = shots[0]["id"]
    _fake_render(monkeypatch)
    r = client.post(f"/api/studio/shots/{sid}/render", headers=H,
                    json={"num_candidates": 1, "wait": True, "force_direct": True})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["final_clip_url"] == "/api/studio/files/r.mp4"
    assert body["final_media_status"] == "current", "raw final 不得因空指针卡 unknown"
    # voice 阶段:无对白镜不阻塞 → 可确认
    _confirm_storyboard(client, H, pid)
    _transition(client, H, pid, "assets", "skip", "无角色")
    _transition(client, H, pid, "generate", "confirm", "已出片")
    r = _transition(client, H, pid, "voice", "confirm", "无对白镜,无需配音")
    assert r.status_code == 200, r.text
    states, _ = _stages(client, H, pid)
    assert states["voice"]["state"] == "confirmed"
    # assemble 门禁通过(合成服务内部会因无片之外的原因失败,但门禁不拦)
    # —— 这里只验证 stale 检查不拦:final 全 current → 不 409
    _transition(client, H, pid, "timeline", "confirm", "时间线就绪")
    r = client.post(f"/api/studio/projects/{pid}/assemble", headers=H)
    assert r.status_code != 409, r.text


# ── 原子并发 / 审计精确性(CAS)───────────────────────────────────────────────


def test_concurrent_transition_no_last_write_wins(ctx):
    """两个独立 Session 并发 transition:后到者须 CAS 冲突,不得静默覆盖。

    复现写后写:s1/s2 同读 rev=N 均成功落库,revision 只 +1、审计重复——
    丢一次跃迁。修复后第二会话抛 StageConflictError,revision/审计各一份。
    """
    client, token, _, engine = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    _, rev0 = _stages(client, H, pid)
    s1 = Session(engine)
    s2 = Session(engine)
    try:
        p1 = s1.get(StudioProject, pid)
        p2 = s2.get(StudioProject, pid)
        assert int(p1.stage_revision) == int(p2.stage_revision) == rev0
        states = stages_svc.transition(
            s1, p1, stage="assets", action="skip",
            note="会话1 跳过资产", user_id="u-s1",
        )
        assert states["assets"]["state"] == "skipped"
        with pytest.raises(stages_svc.StageConflictError) as ei:
            stages_svc.transition(
                s2, p2, stage="assets", action="skip",
                note="会话2 跳过资产", user_id="u-s2",
            )
        assert "stage_revision" in str(ei.value)
    finally:
        s1.close()
        s2.close()
    with Session(engine) as s:
        p = s.get(StudioProject, pid)
        assert int(p.stage_revision) == rev0 + 1, "并发写后写不得只递增一次版本"
        store = json.loads(p.stage_states_json)
        assert store.get("assets") == "skipped"
        rows = s.exec(select(StudioStageConfirmation)).all()
        assert len(rows) == 1, "失败方的审计行不得入库"
        assert rows[0].created_by == "u-s1"


def test_transition_expected_revision_conflict_at_persist(ctx):
    """expected_stage_revision 须在持久化层原子生效(非仅路由预检)。"""
    client, token, _, engine = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    _, rev0 = _stages(client, H, pid)
    s1 = Session(engine)
    s2 = Session(engine)
    try:
        p1 = s1.get(StudioProject, pid)
        p2 = s2.get(StudioProject, pid)
        stages_svc.transition(
            s1, p1, stage="assets", action="skip",
            note="先跳过", user_id="u-a",
        )
        with pytest.raises(stages_svc.StageConflictError):
            stages_svc.transition(
                s2, p2, stage="assets", action="skip",
                note="陈旧版本跳过", user_id="u-b",
                expected_stage_revision=rev0,
            )
    finally:
        s1.close()
        s2.close()


def test_invalidate_merges_concurrent_transition(ctx):
    """失效遇版本竞争:重读合并重试,不得静默丢他人已提交跃迁/审计。"""
    client, token, _, engine = ctx
    H = _h(token)
    pid = _mk_project(client, H, style="古风")
    _put_shots(client, H, pid, [{"scene": "A", "prompt": "a"}])
    _transition(client, H, pid, "script", "confirm", "定稿")
    _transition(client, H, pid, "assets", "skip", "无角色")
    _transition(client, H, pid, "storyboard", "confirm", "定稿")
    s_main = Session(engine)
    s_other = Session(engine)
    try:
        p_main = s_main.get(StudioProject, pid)  # 先读,随后被并发提交置陈旧
        p_other = s_other.get(StudioProject, pid)
        stages_svc.transition(
            s_other, p_other, stage="generate", action="skip",
            note="并发先跳过生成", user_id="u-other",
        )
        rev_other = int(s_other.get(StudioProject, pid).stage_revision)
        changed = stages_svc.invalidate_stages(
            s_main, p_main, stages=["storyboard"],
            source="system", note="premise 变更,下游失效", created_by="u-main",
        )
        assert changed == ["storyboard"]
    finally:
        s_main.close()
        s_other.close()
    with Session(engine) as s:
        p = s.get(StudioProject, pid)
        store = json.loads(p.stage_states_json)
        assert store.get("storyboard") == "needs_review"
        assert store.get("generate") == "skipped", "并发已提交的跃迁不得被失效覆盖"
        assert int(p.stage_revision) == rev_other + 1
        rows = s.exec(
            select(StudioStageConfirmation).where(
                StudioStageConfirmation.stage == "storyboard",
                StudioStageConfirmation.to_state == "needs_review",
            )
        ).all()
        assert len(rows) == 1 and rows[0].from_state == "confirmed"


def test_invalidate_audit_records_actual_from_state(ctx):
    """上游失效审计 from_state 记真实原态(skipped 不得写成 confirmed)。"""
    client, token, _, _ = ctx
    H = _h(token)
    pid = _mk_project(client, H, style="古风")
    _put_shots(client, H, pid, [{"scene": "A", "prompt": "a"}])
    _transition(client, H, pid, "script", "confirm", "定稿")
    _transition(client, H, pid, "assets", "skip", "无角色,跳过")
    _transition(client, H, pid, "storyboard", "confirm", "定稿")
    _transition(client, H, pid, "generate", "skip", "逐镜迭代,跳过")
    client.patch(f"/api/studio/projects/{pid}", headers=H, json={"style": "赛博"})
    hist = client.get(
        f"/api/studio/projects/{pid}/stages/history?stage=generate", headers=H
    ).json()["history"]
    assert hist[0]["to_state"] == "needs_review" and hist[0]["source"] == "system"
    assert hist[0]["from_state"] == "skipped", "审计须记真实原态,不得恒写 confirmed"


def test_delete_last_shot_invalidates_confirmed_storyboard(ctx):
    """删除最后一个镜 → 已确认 storyboard 须失效(不留 confirmed 空壳过门禁)。"""
    client, token, _, _ = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    _put_shots(client, H, pid, [{"scene": "A", "prompt": "a"}])
    _confirm_storyboard(client, H, pid)
    r = client.put(f"/api/studio/projects/{pid}/shots", headers=H, json={"shots": []})
    assert r.status_code == 200, r.text
    states, _ = _stages(client, H, pid)
    assert states["storyboard"]["state"] == "needs_review", "删空分镜须标待复核"
    hist = client.get(
        f"/api/studio/projects/{pid}/stages/history?stage=storyboard", headers=H
    ).json()["history"]
    assert hist[0]["to_state"] == "needs_review" and hist[0]["source"] == "system"
    # 失效后门关闭:重新加镜后不得再凭陈旧 confirmed 批量渲染
    # (删空后的空批次本身按既有"空批次不设防"语义放行,不在此破坏)
    _put_shots(client, H, pid, [{"scene": "B", "prompt": "b"}])
    r = client.post(f"/api/studio/projects/{pid}/render", headers=H, json={"wait": False})
    assert r.status_code == 409 and "storyboard" in r.json()["detail"]


# ── 失效去重 / 真独立连接 CAS / 损坏态回退 ──────────────────────────────────


def test_patch_premise_and_style_no_duplicate_invalidate_audit(ctx):
    """premise+style 同时 PATCH:stages 含重复项(storyboard×2),审计不得重复写。"""
    client, token, _, _ = ctx
    H = _h(token)
    pid = _mk_project(client, H, style="古风")
    _put_shots(client, H, pid, [{"scene": "A", "prompt": "a"}])
    _transition(client, H, pid, "script", "confirm", "定稿")
    _transition(client, H, pid, "assets", "skip", "无角色")
    _transition(client, H, pid, "storyboard", "confirm", "定稿")
    hist_base = client.get(f"/api/studio/projects/{pid}/stages/history", headers=H).json()["history"]
    r = client.patch(f"/api/studio/projects/{pid}", headers=H,
                     json={"premise": "新的故事", "style": "赛博"})
    assert r.status_code == 200, r.text
    states, _ = _stages(client, H, pid)
    assert states["storyboard"]["state"] == "needs_review"
    hist = client.get(f"/api/studio/projects/{pid}/stages/history", headers=H).json()["history"]
    sys_rows = [
        h for h in hist
        if h["source"] == "system" and h["to_state"] == "needs_review"
    ]
    assert len(hist) == len(hist_base) + len(sys_rows)
    sb_rows = [h for h in sys_rows if h["stage"] == "storyboard"]
    assert len(sb_rows) == 1, "storyboard 在 stages 中重复,审计只许写一行"
    assert {h["stage"] for h in sys_rows} == {"script", "storyboard"}


def test_invalidate_stages_dedup_stable_order(ctx):
    """重复+乱序输入:按 STUDIO_STAGES 稳定顺序去重,返回/审计序确定。"""
    client, token, _, engine = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    _put_shots(client, H, pid, [{"scene": "A", "prompt": "a"}])
    _transition(client, H, pid, "script", "confirm", "定稿")
    _transition(client, H, pid, "assets", "skip", "无角色")
    _transition(client, H, pid, "storyboard", "confirm", "定稿")
    _transition(client, H, pid, "generate", "skip", "逐镜迭代")
    _transition(client, H, pid, "voice", "skip", "稍后配")
    with Session(engine) as s:
        p = s.get(StudioProject, pid)
        changed = stages_svc.invalidate_stages(
            s, p,
            stages=["voice", "script", "voice", "bogus",
                    "assets", "script", "storyboard", "generate"],
            source="system", note="乱序重复输入", created_by="u",
        )
    assert changed == ["script", "assets", "storyboard", "generate", "voice"]
    with Session(engine) as s:
        rows = s.exec(
            select(StudioStageConfirmation).where(
                StudioStageConfirmation.to_state == "needs_review",
                StudioStageConfirmation.source == "system",
            )
        ).all()
        assert len(rows) == 5
        assert {r.stage for r in rows} == {"script", "assets", "storyboard",
                                           "generate", "voice"}


def test_cas_conflict_independent_connections(tmp_path):
    """两个独立连接(临时文件 SQLite,双 engine)竞争同一跃迁:后到者 CAS 冲突。

    StaticPool 共享连接不足以代表生产;此处为真实双 DBAPI 连接的同进程竞争
    测试(非多进程压测),验证 DB 级条件 UPDATE 原子性可重复生效。
    """
    url = f"sqlite:///{tmp_path / 'race.db'}"
    engine_a = create_engine(url)
    engine_b = create_engine(url)
    SQLModel.metadata.create_all(engine_a)
    with Session(engine_a) as s:
        p = StudioProject(tenant_id="t", user_id="u", title="race", premise="x")
        s.add(p)
        s.commit()
        s.refresh(p)
        pid = p.id
    sa_ = Session(engine_a)
    sb = Session(engine_b)
    try:
        pa = sa_.get(StudioProject, pid)
        pb = sb.get(StudioProject, pid)
        assert engine_a.pool is not engine_b.pool
        stages_svc.transition(
            sa_, pa, stage="assets", action="skip",
            note="连接A 跳过", user_id="u-a",
        )
        with pytest.raises(stages_svc.StageConflictError):
            stages_svc.transition(
                sb, pb, stage="assets", action="skip",
                note="连接B 跳过", user_id="u-b",
            )
    finally:
        sa_.close()
        sb.close()
        engine_a.dispose()
        engine_b.dispose()
    check = create_engine(url)
    try:
        with Session(check) as s:
            p = s.get(StudioProject, pid)
            assert int(p.stage_revision) == 1, "两个连接并发写后写不得只递增一次版本"
            assert json.loads(p.stage_states_json).get("assets") == "skipped"
            rows = s.exec(select(StudioStageConfirmation)).all()
            assert len(rows) == 1 and rows[0].created_by == "u-a"
    finally:
        check.dispose()


def test_compute_states_corrupt_store_falls_back(ctx):
    """损坏的人工态值(未知字符串)不得流进前端投影,安全回退 draft/pending。"""
    client, token, _, engine = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    with Session(engine) as s:
        p = s.get(StudioProject, pid)
        p.stage_states_json = json.dumps({
            "script": "bogus", "assets": "confirmed ", "storyboard": "",
            "generate": None, "voice": "CONFIRMED", "timeline": "needs_review",
        })
        s.add(p)
        s.commit()
    states, _ = _stages(client, H, pid)
    known = {"draft", "pending_confirmation", "confirmed", "skipped",
             "needs_review", "generating", "failed"}
    for stage, info in states.items():
        assert info["state"] in known, f"{stage} 泄漏未知状态:{info['state']!r}"
    assert states["script"]["state"] == "pending_confirmation"  # premise 非空 → 就绪
    assert states["assets"]["state"] == "draft"  # 无角色 → 不就绪
    assert states["storyboard"]["state"] == "draft"  # 无分镜 → 不就绪
    assert states["timeline"]["state"] == "needs_review"  # 合法值原样保留


# ── 迁移 ────────────────────────────────────────────────────────────────────


def test_migration_stage_columns_and_table_idempotent(monkeypatch, tmp_path):
    old_engine = create_engine(f"sqlite:///{tmp_path}/old_stage.db")
    with old_engine.begin() as conn:
        conn.exec_driver_sql(
            "CREATE TABLE studioproject (id TEXT PRIMARY KEY, title TEXT DEFAULT '')"
        )
    monkeypatch.setattr(db_mod, "engine", old_engine)
    db_mod._run_column_migrations()
    db_mod._run_column_migrations()
    with old_engine.begin() as conn:
        cols = {row[1] for row in conn.exec_driver_sql("PRAGMA table_info(studioproject)")}
        assert {"stage_states_json", "stage_revision"} <= cols
        tables = {
            row[0]
            for row in conn.exec_driver_sql(
                "SELECT name FROM sqlite_master WHERE type='table'"
            )
        }
        assert "studiostageconfirmation" in tables
        tcols = {row[1] for row in conn.exec_driver_sql("PRAGMA table_info(studiostageconfirmation)")}
        assert {"project_id", "stage", "from_state", "to_state", "source", "note",
                "created_by", "created_at"} <= tcols


# ── D0 阶段失效补漏 ─────────────────────────────────────────────────────────


def _force_stage_store(engine, pid, states):
    with Session(engine) as s:
        p = s.get(StudioProject, pid)
        p.stage_states_json = json.dumps(states)
        s.add(p)
        s.commit()


def test_character_create_delete_and_sheet_invalidate_real_downstream(ctx, monkeypatch):
    client, token, _, engine = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    _force_stage_store(engine, pid, {"assets": "skipped", "storyboard": "confirmed"})
    r = client.post(f"/api/studio/projects/{pid}/characters", headers=H,
                    json={"name": "林夏", "visual_prompt": "1girl"})
    assert r.status_code == 200, r.text
    cid = r.json()["id"]
    states, _ = _stages(client, H, pid)
    assert states["assets"]["state"] == "needs_review"
    assert states["storyboard"]["state"] == "confirmed"

    shots = _put_shots(client, H, pid, [{
        "scene": "A", "prompt": "a", "characters": ["林夏"],
        "speaker": "林夏", "dialogue": "你好",
    }])
    assert shots[0]["characters"] == ["林夏"]
    _force_stage_store(engine, pid, {
        "assets": "confirmed", "generate": "confirmed",
        "voice": "skipped", "timeline": "confirmed",
    })
    r = client.delete(f"/api/studio/characters/{cid}", headers=H)
    assert r.status_code == 200, r.text
    states, _ = _stages(client, H, pid)
    for stage in ("assets", "generate", "voice", "timeline"):
        assert states[stage]["state"] == "needs_review", stage


def test_character_sheet_reference_write_invalidates_generate(ctx, monkeypatch):
    import app.routes.studio as studio_rt
    from app.services.studio import character_sheet as sheet_svc

    client, token, _, engine = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    cid = client.post(f"/api/studio/projects/{pid}/characters", headers=H,
                      json={"name": "林夏", "visual_prompt": "1girl"}).json()["id"]
    _force_stage_store(engine, pid, {"generate": "confirmed"})

    async def fake_sheet(**kw):
        return "/api/studio/files/sheet.png", b"png", {"front": "/api/studio/files/front.png"}

    monkeypatch.setattr(sheet_svc, "generate_character_sheet", fake_sheet)
    monkeypatch.setattr(studio_rt, "_note_asset_regeneration", lambda *a, **kw: None)
    r = client.post(f"/api/studio/characters/{cid}/character-sheet", headers=H,
                    json={"style": "anime", "apply_to_video_refs": True})
    assert r.status_code == 200, r.text
    assert r.json()["reference_images_by_style"]["anime"]
    states, _ = _stages(client, H, pid)
    assert states["generate"]["state"] == "needs_review"


def test_rollback_invalidates_only_on_real_content_change(ctx):
    client, token, _, engine = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    shot = _put_shots(client, H, pid, [{"scene": "A", "prompt": "v1"}])[0]
    sid = shot["id"]
    first_rev = shot["current_revision_id"]
    _put_shots(client, H, pid, [{"id": sid, "scene": "A", "prompt": "v2"}])
    confirmed = {
        "storyboard": "confirmed", "generate": "confirmed",
        "voice": "skipped", "timeline": "confirmed",
    }
    _force_stage_store(engine, pid, confirmed)
    r = client.post(f"/api/studio/shots/{sid}/rollback", headers=H,
                    json={"revision_id": first_rev})
    assert r.status_code == 200, r.text
    states, _ = _stages(client, H, pid)
    for stage in confirmed:
        assert states[stage]["state"] == "needs_review", stage

    _force_stage_store(engine, pid, confirmed)
    r = client.post(f"/api/studio/shots/{sid}/rollback", headers=H,
                    json={"revision_id": first_rev})
    assert r.status_code == 200, r.text
    states, _ = _stages(client, H, pid)
    for stage in confirmed:
        assert states[stage]["state"] == confirmed[stage], "无变化回滚不得误标"
