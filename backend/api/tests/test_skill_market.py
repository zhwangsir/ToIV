"""Skill 市场与资产互通(2026-08-18)测试:
  ① /skills/import:普通用户导入个人技能(id 自动生成/冲突 409);列表仅见公共+本人;
    他人私有不可见;属主可改可删;公共技能普通用户改/删 403;内置拒删
  ② /studio/optimize-shot:brief → 结构化分镜(LLM mock);角色名幻觉过滤回库内名;
    非 LLM JSON 502 兜底
  ③ /assets/from-job:归属校验(他人 Job 404/filename 不在 result 404);路径穿越 400;
    转运链(取字节→上传)成功返回句柄
"""
from sqlmodel import Session, SQLModel
from sqlalchemy import create_engine
from sqlalchemy.pool import StaticPool
from unittest.mock import AsyncMock, patch

from app.db import get_session
from app.main import app
from app.models import Job, StudioCharacter, StudioProject, StudioShot, Tenant, User
from app.security import hash_password, create_token
from fastapi.testclient import TestClient

import pytest


@pytest.fixture()
def ctx():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    SQLModel.metadata.create_all(engine)

    def override():
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override
    with Session(engine) as s:
        from app.agents_seed import seed_builtin_agents

        seed_builtin_agents(s)  # 内置技能入库(撞 id/拒删断言的前提)
        t = Tenant(name="s")
        s.add(t)
        s.commit()
        s.refresh(t)
        u = User(email="s@toiv.ai", hashed_password=hash_password("p1"), tenant_id=t.id)
        u2 = User(email="other@toiv.ai", hashed_password=hash_password("p1"), tenant_id=t.id)
        admin = User(email="admin@toiv.ai", hashed_password=hash_password("p1"), tenant_id=t.id, role="admin")
        s.add_all([u, u2, admin])
        s.commit()
        for x in (u, u2, admin):
            s.refresh(x)
        j = Job(tenant_id=t.id, user_id=u.id, prompt_id="pid-a", worker="http://w1", kind="txt2img",
                status="done", prompt="cat",
                result='["/api/images?filename=ComfyUI_001_.png&subfolder=&type=output&worker=http%3A%2F%2Fw1"]')
        s.add(j)
        s.commit()
        s.refresh(j)
        sp = StudioProject(tenant_id=t.id, user_id=u.id, title="T", premise="黑帮复仇")
        s.add(sp)
        s.commit()
        s.refresh(sp)
        c = StudioCharacter(project_id=sp.id, name="阿豪", description="黑帮老大",
                            visual_prompt="middle-aged asian man, slick hair, black suit")
        s.add(c)
        s.commit()
        s.refresh(c)
        shot = StudioShot(project_id=sp.id, idx=0, scene="天台对峙", prompt="rooftop standoff")
        s.add(shot)
        s.commit()
        s.refresh(shot)
        yield TestClient(app), create_token(u.id), create_token(u2.id), create_token(admin.id), {
            "job": j, "project": sp, "char": c, "shot": shot,
        }, engine
    app.dependency_overrides.clear()


def _h(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


# ── ① Skill 市场导入与可见性 ──────────────────────────────────────

_SKILL_DEF = {
    "name": "赛璐璐复古风",
    "description": "90 年代赛璐璐上色",
    "icon": "palette",
    "applies_to": "image,video",
    "system_prompt": "你是赛璐璐风格提示词工程师…",
}


def test_skill_import_and_visibility(ctx):
    client, tok, tok2, tok_admin, ids, engine = ctx
    H, H2, HA = _h(tok), _h(tok2), _h(tok_admin)
    # 普通用户导入:id 留空自动生成
    r = client.post("/api/skills/import", headers=H, json=_SKILL_DEF)
    assert r.status_code == 200, r.text
    skill = r.json()
    assert skill["is_mine"] is True and skill["id"]
    # 属主列表可见
    mine = client.get("/api/agents", headers=H).json()
    assert any(a["id"] == skill["id"] for a in mine)
    # 他人列表不可见 + 详情 404(不泄露存在性)
    theirs = client.get("/api/agents", headers=H2).json()
    assert not any(a["id"] == skill["id"] for a in theirs)
    assert client.get(f"/api/agents/{skill['id']}", headers=H2).status_code == 404
    # 他人改/删 404
    assert client.put(f"/api/agents/{skill['id']}", headers=H2,
                      json={"name": "x"}).status_code == 404
    assert client.delete(f"/api/agents/{skill['id']}", headers=H2).status_code == 404
    # 属主改+删成功
    assert client.put(f"/api/agents/{skill['id']}", headers=H,
                      json={"name": "赛璐璐(改)"}).status_code == 200
    assert client.delete(f"/api/agents/{skill['id']}", headers=H).status_code == 200


def test_skill_import_id_conflict(ctx):
    client, tok, tok2, tok_admin, ids, engine = ctx
    r = client.post("/api/skills/import", headers=_h(tok),
                    json={**_SKILL_DEF, "id": "realist"})
    assert r.status_code == 409  # 撞内置主键


def test_public_agent_requires_admin(ctx):
    client, tok, tok2, tok_admin, ids, engine = ctx
    H, HA = _h(tok), _h(tok_admin)
    # 普通用户改/删公共(非内置)需 admin:先由 admin 建一个公共自定义
    pub = client.post("/api/agents", headers=HA, json={
        "id": "pub-style", "name": "公共风格", "system_prompt": "x"}).json()
    assert client.put("/api/agents/pub-style", headers=H,
                      json={"name": "y"}).status_code == 403
    assert client.delete("/api/agents/pub-style", headers=H).status_code == 403
    assert client.delete("/api/agents/pub-style", headers=HA).status_code == 200  # admin 可删
    # 内置拒删(即便 admin)
    assert client.delete("/api/agents/realist", headers=HA).status_code == 403


# ── ② 分镜 AI 扩写 ────────────────────────────────────────────────

def _fake_llm(content: str):
    """伪造 harness ctx:get_ctx().service('llm') 同步返回 svc,chat_layered 可 await。"""
    from unittest.mock import MagicMock

    svc = MagicMock()
    svc.chat_layered = AsyncMock(return_value={"content": content})
    ctxmock = MagicMock()
    ctxmock.service = MagicMock(return_value=svc)
    return ctxmock


def test_optimize_shot_structured(ctx):
    client, tok, tok2, tok_admin, ids, engine = ctx
    payload = {
        "brief": "阿豪在雨夜天台点烟",
        "shot_id": ids["shot"].id,
        "style_hint": "王家卫式霓虹",
    }
    llm_json = (
        '{"scene": "雨夜天台,霓虹逆光", "camera": "中近景缓慢推近", '
        '"prompt": "middle-aged asian man, slick hair, black suit, smoking on rooftop, '
        'rain, neon backlight", "negative": "blurry, low quality", '
        '"characters": ["阿豪", "幻觉角色"]}'
    )
    # get_ctx 为函数内局部 import,patch 源模块 app.harness.ctx
    with patch("app.harness.ctx.get_ctx", return_value=_fake_llm(llm_json)):
        r = client.post(f"/api/studio/projects/{ids['project'].id}/optimize-shot",
                        headers=_h(tok), json=payload)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["scene"] and body["camera"] and body["prompt"]
    # 角色幻觉过滤:「幻觉角色」被剔除,只留库内「阿豪」
    assert body["characters"] == ["阿豪"]


def test_optimize_shot_bad_json(ctx):
    client, tok, tok2, tok_admin, ids, engine = ctx
    with patch("app.harness.ctx.get_ctx", return_value=_fake_llm("这不是 JSON")):
        r = client.post(f"/api/studio/projects/{ids['project'].id}/optimize-shot",
                        headers=_h(tok), json={"brief": "x"})
    assert r.status_code == 502


def test_optimize_shot_with_skill(ctx):
    """skill_id 注入:内置技能 system_prompt 拼在分镜系统提示前;他人私有技能 404。"""
    client, tok, tok2, tok_admin, ids, engine = ctx
    H, H2 = _h(tok), _h(tok2)
    pid = ids["project"].id
    llm_json = '{"scene": "s", "camera": "c", "prompt": "p", "negative": "n", "characters": []}'

    # ① 内置技能(公共)可用,system prompt 被 LLM 收到
    with patch("app.harness.ctx.get_ctx", return_value=_fake_llm(llm_json)) as m:
        r = client.post(f"/api/studio/projects/{pid}/optimize-shot", headers=H,
                        json={"brief": "x", "skill_id": "ghibli"})
    assert r.status_code == 200, r.text
    sent = m.return_value.service.return_value.chat_layered.call_args[0][0]
    assert sent[0]["content"].startswith("你是吉卜力工作室风格")
    assert "资深影视分镜师" in sent[0]["content"]  # 分镜系统提示仍在(人格拼接而非替换)

    # ② 他人私有技能 404(先让 tok2 导入一个)
    sk = client.post("/api/skills/import", headers=H2, json=_SKILL_DEF).json()
    r = client.post(f"/api/studio/projects/{pid}/optimize-shot", headers=H,
                    json={"brief": "x", "skill_id": sk["id"]})
    assert r.status_code == 404
    # 属主本人可用
    with patch("app.harness.ctx.get_ctx", return_value=_fake_llm(llm_json)):
        r = client.post(f"/api/studio/projects/{pid}/optimize-shot", headers=H2,
                        json={"brief": "x", "skill_id": sk["id"]})
    assert r.status_code == 200


# ── ③ 产物 → 参考图转运 ────────────────────────────────────────────

class _FakeClient:
    def __init__(self, base_url: str):
        self.base_url = base_url

    async def get_image_bytes(self, filename, subfolder, type_):
        assert type_ == "output"
        return (b"\x89PNG\r\n\x1a\nfake", "image/png")

    async def upload_image(self, content, filename):
        return filename

    async def model_names(self):
        return set()

    async def node_names(self):
        return set()


def _no_caps(module: str):
    """转运链测试只验证归属与搬运,capabilities 门控置空(img2img 默认要求模型会 503)。"""
    return patch.multiple(module, required_models=lambda k: set(), required_nodes=lambda k: set())


def test_asset_from_job_ok(ctx):
    client, tok, tok2, tok_admin, ids, engine = ctx
    fake = _FakeClient("http://w1")
    with _no_caps("app.routes.assets"), \
            patch("app.routes.assets.resolve_worker", return_value=fake) as rw:
        r = client.post("/api/assets/from-job", headers=_h(tok), json={
            "job_id": ids["job"].id, "filename": "ComfyUI_001_.png",
            "kind": "img2img", "worker": "http://w1"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["filename"].startswith("toivasset-") and body["worker"] == "http://w1"
    # 取自 output 目录、落到目标 input(upload_image);源/目标各 resolve 一次
    assert rw.call_count == 2


def test_asset_from_job_ownership(ctx):
    client, tok, tok2, tok_admin, ids, engine = ctx
    H2 = _h(tok2)
    # 同租户他人:归属放行(images 口径),转运链 mock 钉定 worker
    with _no_caps("app.routes.assets"), \
            patch("app.routes.assets.resolve_worker", return_value=_FakeClient("http://w1")):
        r = client.post("/api/assets/from-job", headers=H2, json={
            "job_id": ids["job"].id, "filename": "ComfyUI_001_.png", "worker": "http://w1"})
        assert r.status_code == 200
    # filename 不在 result → 404
    r = client.post("/api/assets/from-job", headers=_h(tok), json={
        "job_id": ids["job"].id, "filename": "other.png"})
    assert r.status_code == 404
    # 路径穿越 → 400
    r = client.post("/api/assets/from-job", headers=_h(tok), json={
        "job_id": ids["job"].id, "filename": "../../etc/passwd"})
    assert r.status_code == 400
