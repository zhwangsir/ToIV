"""C1b 用户生成配方(StudioRecipe)——真实 HTTP 切片测试。

覆盖:从替身渲染成功的 shot 建配方→CRUD/克隆/默认唯一/删除→导出/导入(含
无效导入)→diff 预览→apply(409/去重/superseded/项目规格显式选择)→用 apply
返回的 render_params 走真实 render_one(auto_pick 传递);跨用户 404;旧 shot
无修订兼容;空集合;旧库迁移。
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
    Job,
    StudioProject,
    StudioRecipe,
    StudioShot,
    StudioShotRevision,
    Tenant,
    User,
)
from app.security import create_token, hash_password
from app.services.studio import orchestrator as orch


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
        t = Tenant(name="recipe"); s.add(t); s.commit(); s.refresh(t)
        u = User(email="rcp@toiv.ai", hashed_password=hash_password("p"), tenant_id=t.id)
        s.add(u); s.commit(); s.refresh(u)
        uid = u.id
        t2 = Tenant(name="recipe2"); s.add(t2); s.commit(); s.refresh(t2)
        u2 = User(email="rcp2@toiv.ai", hashed_password=hash_password("p"), tenant_id=t2.id)
        s.add(u2); s.commit(); s.refresh(u2)
        uid2 = u2.id
    yield TestClient(app), create_token(uid), create_token(uid2), engine
    app.dependency_overrides.clear()


def _h(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def _mk_project(client, H, title="配方", **over):
    body = {"title": title}
    body.update(over)
    r = client.post("/api/studio/projects", headers=H, json=body)
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _put_shots(client, H, pid, shots):
    r = client.put(f"/api/studio/projects/{pid}/shots", headers=H, json={"shots": shots})
    assert r.status_code == 200, r.text
    return r.json()["shots"]


def _fake_render(monkeypatch, captured: dict, url="/api/studio/files/r.mp4"):
    """同步渲染替身:捕获 render_kw(auto_pick 等真实传递)。"""
    class _R:
        kind = "video"
        pipeline_meta: dict = {}

    class FakeRenderer:
        name = "video"

        async def render(self, shot, cast, pool, **kw):
            captured.update(kw)
            return _R() if False else type("RR", (), {"kind": "video", "url": url, "pipeline_meta": {}})()

    monkeypatch.setattr(orch, "get_renderer", lambda shot: FakeRenderer())


def _render(client, H, sid, monkeypatch, captured=None, **body):
    _fake_render(monkeypatch, captured if captured is not None else {})
    payload = {"num_candidates": 1, "wait": True, "force_direct": True}
    payload.update(body)
    r = client.post(f"/api/studio/shots/{sid}/render", headers=H, json=payload)
    assert r.status_code == 200, r.text
    return r.json()


def _rendered_shot(client, H, pid, monkeypatch, captured=None, **shot_over):
    item = {"scene": "雨夜", "prompt": "rain alley", "camera": "推镜",
            "dialogue": "你来了", "speaker": "", "duration_sec": 5}
    item.update(shot_over)
    shot = _put_shots(client, H, pid, [item])[0]
    _render(client, H, shot["id"], monkeypatch, captured,
            seed=42, ref_images=["/api/studio/files/ref.png?sig=SECRET"])
    return shot


def _recipe_of(client, H, rid):
    r = client.get(f"/api/studio/recipes/{rid}", headers=H)
    assert r.status_code == 200, r.text
    return r.json()


# ── 建配方:出处/脱敏/字段口径 ────────────────────────────────────────────────


def test_create_from_shot_uses_render_revision_and_strips_secrets(ctx, monkeypatch):
    client, token, _, _ = ctx
    H = _h(token)
    captured: dict = {}
    pid = _mk_project(client, H)
    shot = _rendered_shot(client, H, pid, monkeypatch, captured)

    r = client.post("/api/studio/recipes/from-shot", headers=H,
                    json={"shot_id": shot["id"], "name": "雨夜配方",
                          "description": "雨夜镜复用"})
    assert r.status_code == 200, r.text
    recipe = r.json()
    assert recipe["name"] == "雨夜配方"
    assert recipe["source_shot_id"] == shot["id"]
    assert recipe["is_default"] is False
    snap = recipe["snapshot"]
    assert snap["prompt"] == "rain alley"
    assert snap["camera"] == "推镜"
    assert snap["duration_sec"] == 5
    assert snap["pipeline"] == "ref2va"
    assert snap["num_candidates"] == 1
    assert snap["seed"] == 42
    assert snap["pick_strategy"] == "auto_best"
    # 生成输入快照来自 render 修订(shot.rendered_revision_id)
    body = client.get(f"/api/studio/projects/{pid}", headers=H).json()
    s0 = [x for x in body["shots"] if x["id"] == shot["id"]][0]
    assert recipe["source_revision_id"] == s0["rendered_revision_id"]
    # URL 脱敏:签名/密钥 query 被剥除;worker/上下文/父链键不存在
    assert snap["ref_images"] == ["/api/studio/files/ref.png"]
    assert "sig=" not in json.dumps(snap)
    for banned in ("worker_url", "context_latent_path", "parent_chain_job_id",
                   "scene", "dialogue", "speaker", "idx", "beats_json", "characters"):
        assert banned not in snap, f"快照不得含 {banned}"


def test_create_from_shot_requires_inputs(ctx, monkeypatch):
    """无媒体且无修订的 shot → 422(不虚构渲染历史)。"""
    client, token, _, _ = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    shot = _put_shots(client, H, pid, [{"scene": "A", "prompt": "a"}])[0]
    # 旧行直插语义:无修订、无媒体 → 无可快照生成输入
    with Session(ctx[3]) as s:
        sh = s.get(StudioShot, shot["id"])
        sh.current_revision_id = ""
        s.add(sh)
        s.commit()
        for rev in s.exec(select(StudioShotRevision)).all():
            s.delete(rev)
        s.commit()
    r = client.post("/api/studio/recipes/from-shot", headers=H,
                    json={"shot_id": shot["id"]})
    assert r.status_code == 422


def test_create_from_legacy_shot_without_revisions(ctx, monkeypatch):
    """旧 shot(有媒体无修订)→ 可说明 live 快照,source_revision_id 为空。"""
    client, token, _, engine = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    shot = _rendered_shot(client, H, pid, monkeypatch)
    with Session(engine) as s:
        sh = s.get(StudioShot, shot["id"])
        sh.current_revision_id = ""
        sh.rendered_revision_id = ""
        s.add(sh)
        s.commit()
        for rev in s.exec(select(StudioShotRevision)).all():
            s.delete(rev)
        s.commit()
    r = client.post("/api/studio/recipes/from-shot", headers=H,
                    json={"shot_id": shot["id"], "name": "legacy"})
    assert r.status_code == 200, r.text
    recipe = r.json()
    assert recipe["source_revision_id"] == ""
    assert recipe["snapshot"]["prompt"] == "rain alley"


# ── CRUD / 克隆 / 默认唯一 / 删除 ───────────────────────────────────────────


def test_crud_clone_default_delete(ctx, monkeypatch):
    client, token, _, engine = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    shot = _rendered_shot(client, H, pid, monkeypatch)
    rid = client.post("/api/studio/recipes/from-shot", headers=H,
                      json={"shot_id": shot["id"], "name": "原配方"}).json()["id"]

    # 编辑:名称/描述/prompt/negative/pick_strategy
    r = client.patch(f"/api/studio/recipes/{rid}", headers=H, json={
        "name": "改名配方", "description": "新描述",
        "prompt": "heavy rain, neon", "negative": "blur", "pick_strategy": "manual",
    })
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["name"] == "改名配方"
    assert body["pick_strategy"] == "manual"
    assert body["snapshot"]["prompt"] == "heavy rain, neon"
    assert body["snapshot"]["negative"] == "blur"

    # 非法 pick_strategy → 422
    assert client.patch(f"/api/studio/recipes/{rid}", headers=H,
                        json={"pick_strategy": "whatever"}).status_code == 422

    # 克隆:独立行,默认 False
    dup = client.post(f"/api/studio/recipes/{rid}/clone", headers=H, json={}).json()
    assert dup["id"] != rid and dup["is_default"] is False
    assert dup["snapshot"]["prompt"] == "heavy rain, neon"

    # 默认唯一(同引擎互斥,跨引擎可各有默认)
    d1 = client.post(f"/api/studio/recipes/{rid}/set-default", headers=H).json()
    assert d1["is_default"] is True
    d2 = client.post(f"/api/studio/recipes/{dup['id']}/set-default", headers=H).json()
    assert d2["is_default"] is True
    assert _recipe_of(client, H, rid)["is_default"] is False, "同引擎新默认应清旧默认"

    # 列表/过滤
    lst = client.get("/api/studio/recipes", headers=H).json()["recipes"]
    assert len(lst) == 2
    assert client.get("/api/studio/recipes?engine=ltx", headers=H).json()["recipes"] == []
    # ltx 配方可另立默认(不同引擎不互斥):先把 h3 默认还给 rid,再挪 dup 到 ltx
    client.post(f"/api/studio/recipes/{rid}/set-default", headers=H)
    with Session(engine) as s:
        row = s.get(StudioRecipe, dup["id"])
        row.engine = "ltx"
        s.add(row)
        s.commit()
    assert client.post(f"/api/studio/recipes/{dup['id']}/set-default", headers=H).status_code == 200
    assert _recipe_of(client, H, rid)["is_default"] is True, "跨引擎默认互不影响"

    # 删除:不碰源镜/产物
    assert client.delete(f"/api/studio/recipes/{rid}", headers=H).json()["deleted"] is True
    assert client.get(f"/api/studio/recipes/{rid}", headers=H).status_code == 404
    body = client.get(f"/api/studio/projects/{pid}", headers=H).json()
    s0 = [x for x in body["shots"] if x["id"] == shot["id"]][0]
    assert s0["video_url"], "删除配方不得碰源镜产物"


# ── 导出 / 导入 ─────────────────────────────────────────────────────────────


def test_export_import_roundtrip(ctx, monkeypatch):
    client, token, _, _ = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    shot = _rendered_shot(client, H, pid, monkeypatch)
    rid = client.post("/api/studio/recipes/from-shot", headers=H,
                      json={"shot_id": shot["id"], "name": "导出源"}).json()["id"]
    exported = client.get(f"/api/studio/recipes/{rid}/export", headers=H).json()
    assert exported["schema"] == "toiv_generation_recipe_v1"

    exported["name"] = "导入配方"
    r = client.post("/api/studio/recipes/import", headers=H, json=exported)
    assert r.status_code == 200, r.text
    imported = r.json()
    assert imported["name"] == "导入配方"
    assert imported["source_revision_id"] == "" and imported["source_shot_id"] == ""
    assert imported["is_default"] is False
    assert imported["snapshot"] == exported["snapshot"]


@pytest.mark.parametrize("mutate,needle", [
    (lambda b: b.update(schema="other_v9"), "schema"),
    (lambda b: b["snapshot"].update(ref_images=["http://evil.example/x.png"]), "SSRF"),
    (lambda b: b["snapshot"].update(worker_url="http://10.0.0.1:8264"), "worker_url"),
    (lambda b: b["snapshot"].update(context_latent_path="/ctx.safetensors"), "context_latent_path"),
    (lambda b: b.update(pipeline="nope"), "pipeline"),
    (lambda b: b["snapshot"].update(num_candidates=9), "num_candidates"),
    (lambda b: b["snapshot"].update(prompt="p" * 4001), "提示词超长"),
    (lambda b: b.update(name=""), "name"),
])
def test_import_validation(ctx, monkeypatch, mutate, needle):
    client, token, _, _ = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    shot = _rendered_shot(client, H, pid, monkeypatch)
    rid = client.post("/api/studio/recipes/from-shot", headers=H,
                      json={"shot_id": shot["id"]}).json()["id"]
    exported = client.get(f"/api/studio/recipes/{rid}/export", headers=H).json()
    mutate(exported)
    r = client.post("/api/studio/recipes/import", headers=H, json=exported)
    assert r.status_code == 422, (needle, r.text)
    assert needle in r.json()["detail"]


def test_import_rejects_oversize(ctx, monkeypatch):
    client, token, _, _ = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    shot = _rendered_shot(client, H, pid, monkeypatch)
    rid = client.post("/api/studio/recipes/from-shot", headers=H,
                      json={"shot_id": shot["id"]}).json()["id"]
    exported = client.get(f"/api/studio/recipes/{rid}/export", headers=H).json()
    exported["description"] = "x" * (70 * 1024)
    assert client.post("/api/studio/recipes/import", headers=H, json=exported).status_code == 422


# ── diff 预览 / apply ───────────────────────────────────────────────────────


def _mk_recipe(client, H, pid, monkeypatch, **patch):
    shot = _rendered_shot(client, H, pid, monkeypatch)
    rid = client.post("/api/studio/recipes/from-shot", headers=H,
                      json={"shot_id": shot["id"], "name": "应用源"}).json()["id"]
    if patch:
        r = client.patch(f"/api/studio/recipes/{rid}", headers=H, json=patch)
        assert r.status_code == 200, r.text
    return rid


def test_diff_preview(ctx, monkeypatch):
    client, token, _, _ = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    rid = _mk_recipe(client, H, pid, monkeypatch, prompt="storm night")
    shot_b = _put_shots(client, H, pid, [
        {"scene": "B 镜", "prompt": "sunny day", "duration_sec": 8},
    ])[0]
    r = client.get(f"/api/studio/recipes/{rid}/diff", headers=H,
                   params={"shot_id": shot_b["id"]})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["fields"]["prompt"] == {"from": "sunny day", "to": "storm night"}
    assert body["fields"]["duration_sec"] == {"from": 8, "to": 5}
    assert "scene" not in body["fields"] and "dialogue" not in body["fields"]
    assert body["render_params"]["pipeline"] == "ref2va"


def test_apply_preserves_story_dedup_and_409(ctx, monkeypatch):
    client, token, _, _ = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    rid = _mk_recipe(client, H, pid, monkeypatch, prompt="storm night")
    beat = {"text": "你来了", "cues": [], "anchor_words": "", "kind": "v", "block": 0}
    shot_b = _put_shots(client, H, pid, [
        {"scene": "B 镜场景", "prompt": "sunny day", "dialogue": "你来了",
         "speaker": "", "duration_sec": 8, "beats": [beat]},
    ])[0]
    sid_b = shot_b["id"]
    revs_before = client.get(f"/api/studio/shots/{sid_b}/revisions", headers=H).json()["revisions"]

    r = client.post(f"/api/studio/recipes/{rid}/apply", headers=H,
                    json={"shot_id": sid_b})
    assert r.status_code == 200, r.text
    body = r.json()
    shot = body["shot"]
    assert shot["prompt"] == "storm night"
    assert shot["duration_sec"] == 5
    assert shot["camera"] == "推镜"
    assert shot["scene"] == "B 镜场景", "剧情字段必须保留"
    assert shot["dialogue"] == "你来了"
    assert shot["beats"], "词锚结构必须保留"
    # apply 留 revision(内容变化)
    revs_after = client.get(f"/api/studio/shots/{sid_b}/revisions", headers=H).json()["revisions"]
    assert len(revs_after) == len(revs_before) + 1
    # 重复 apply 相同内容 → 去重,不造新版本
    r2 = client.post(f"/api/studio/recipes/{rid}/apply", headers=H,
                     json={"shot_id": sid_b})
    assert r2.status_code == 200
    revs3 = client.get(f"/api/studio/shots/{sid_b}/revisions", headers=H).json()["revisions"]
    assert len(revs3) == len(revs_after), "相同内容重复 apply 不得造版本"
    # expected_revision 不符 → 409(不静默覆盖人工编辑)
    assert client.post(f"/api/studio/recipes/{rid}/apply", headers=H, json={
        "shot_id": sid_b, "expected_revision": "not-current",
    }).status_code == 409
    # 项目规格默认不动
    proj = client.get(f"/api/studio/projects/{pid}", headers=H).json()
    assert proj["width"] == 768 and proj["height"] == 1344 and proj["fps"] == 24


def test_apply_project_specs_explicit_only(ctx, monkeypatch):
    client, token, _, _ = ctx
    H = _h(token)
    pid = _mk_project(client, H, width=768, height=1344, fps=24)
    rid = _mk_recipe(client, H, pid, monkeypatch)
    # 构造项目规格不同的配方(导入导出改写)
    exported = client.get(f"/api/studio/recipes/{rid}/export", headers=H).json()
    exported["name"] = "横屏规格"
    exported["snapshot"].update(width=768, height=384, fps=16, ckpt_name="film.ckpt")
    imported = client.post("/api/studio/recipes/import", headers=H, json=exported).json()

    shot_b = _put_shots(client, H, pid, [{"scene": "C", "prompt": "c"}])[0]
    # 默认不覆盖项目规格
    r = client.post(f"/api/studio/recipes/{imported['id']}/apply", headers=H,
                    json={"shot_id": shot_b["id"]})
    assert r.status_code == 200
    assert r.json()["project_specs_changed"] == []
    proj = client.get(f"/api/studio/projects/{pid}", headers=H).json()
    assert proj["height"] == 1344 and proj["fps"] == 24
    # 显式选择才修改
    r = client.post(f"/api/studio/recipes/{imported['id']}/apply", headers=H,
                    json={"shot_id": shot_b["id"], "apply_project_specs": True})
    assert r.status_code == 200
    assert set(r.json()["project_specs_changed"]) == {"height", "fps", "ckpt_name"}
    proj = client.get(f"/api/studio/projects/{pid}", headers=H).json()
    assert proj["height"] == 384 and proj["fps"] == 16 and proj["ckpt_name"] == "film.ckpt"


def test_apply_render_mode_switch_supersedes_queued(ctx, monkeypatch):
    client, token, _, engine = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    # 目标 shot:异步渲染产生 queued 候选
    shot_b = _put_shots(client, H, pid, [{"scene": "D", "prompt": "d"}])[0]
    sid_b = shot_b["id"]

    class FakeRenderer:
        name = "video"

        async def render(self, shot, cast, pool, **kw):
            with Session(engine) as s:
                job = Job(tenant_id="t", user_id="u", prompt_id="p", worker="w",
                          kind="studio_pipeline_c", status="queued", prompt="p")
                s.add(job)
                s.commit()
                s.refresh(job)
                jid = job.id
            return type("RR", (), {"kind": "video", "url": "", "pipeline_meta": {
                "waited": False, "db_job_id": jid, "job_id": "p",
                "seed": 1, "pipeline": "ref2va"}})()

    monkeypatch.setattr(orch, "get_renderer", lambda shot: FakeRenderer())
    r = client.post(f"/api/studio/shots/{sid_b}/render", headers=H,
                    json={"num_candidates": 1, "wait": False, "force_direct": True})
    assert r.status_code == 200, r.text

    # image_motion 配方(导入构造)
    exported = {
        "schema": "toiv_generation_recipe_v1",
        "name": "运镜配方", "engine": "h3", "render_mode": "image_motion",
        "pipeline": "legacy", "pick_strategy": "auto_best",
        "snapshot": {"prompt": "motion pan", "duration_sec": 6},
    }
    recipe = client.post("/api/studio/recipes/import", headers=H, json=exported).json()
    r = client.post(f"/api/studio/recipes/{recipe['id']}/apply", headers=H,
                    json={"shot_id": sid_b})
    assert r.status_code == 200, r.text
    shot = r.json()["shot"]
    assert shot["render_mode"] == "image_motion"
    cands = shot["candidates"]
    assert cands and all(c["status"] == "superseded" for c in cands), cands
    assert shot["video_url"] == "" and shot["status"] == "draft"


def test_apply_then_render_with_returned_params(ctx, monkeypatch):
    """apply 返回的 render_params 直接喂 render_one;manual 策略 auto_pick=False 真实传递。"""
    client, token, _, _ = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    rid = _mk_recipe(client, H, pid, monkeypatch, pick_strategy="manual")
    shot_b = _put_shots(client, H, pid, [{"scene": "E", "prompt": "e"}])[0]
    r = client.post(f"/api/studio/recipes/{rid}/apply", headers=H,
                    json={"shot_id": shot_b["id"]})
    assert r.status_code == 200
    params = r.json()["render_params"]
    assert params["auto_pick"] is False
    assert params["pipeline"] == "ref2va" and params["num_candidates"] == 1

    _fake_render(monkeypatch, {})
    seen: dict = {}
    real_render_shot = orch.render_shot

    async def spy_render(session, shot, **kw):
        seen["auto_pick"] = kw.get("auto_pick")
        return await real_render_shot(session, shot, **kw)

    monkeypatch.setattr(orch, "render_shot", spy_render)
    body = {k: v for k, v in params.items() if k != "wait"}
    body["wait"] = True
    body["force_direct"] = True
    r = client.post(f"/api/studio/shots/{shot_b['id']}/render", headers=H, json=body)
    assert r.status_code == 200, r.text
    assert seen.get("auto_pick") is False, "manual 选优必须传到 orchestrator"
    assert r.json()["video_url"] == "/api/studio/files/r.mp4"


# ── 隔离 / 空集合 / 迁移 ────────────────────────────────────────────────────


def test_cross_user_404_and_empty_list(ctx, monkeypatch):
    client, token, token2, _ = ctx
    H = _h(token)
    H2 = _h(token2)
    pid = _mk_project(client, H)
    shot = _rendered_shot(client, H, pid, monkeypatch)
    rid = client.post("/api/studio/recipes/from-shot", headers=H,
                      json={"shot_id": shot["id"], "name": "私有"}).json()["id"]

    assert client.get(f"/api/studio/recipes/{rid}", headers=H2).status_code == 404
    assert client.patch(f"/api/studio/recipes/{rid}", headers=H2,
                        json={"name": "抢"}).status_code == 404
    assert client.post(f"/api/studio/recipes/{rid}/clone", headers=H2, json={}).status_code == 404
    assert client.post(f"/api/studio/recipes/{rid}/set-default", headers=H2).status_code == 404
    assert client.delete(f"/api/studio/recipes/{rid}", headers=H2).status_code == 404
    assert client.post(f"/api/studio/recipes/{rid}/apply", headers=H2,
                       json={"shot_id": shot["id"]}).status_code == 404
    exported = client.get(f"/api/studio/recipes/{rid}/export", headers=H).json()
    assert client.post("/api/studio/recipes/import", headers=H2, json=exported).status_code == 200
    assert client.get("/api/studio/recipes", headers=H2).json()["recipes"], "导入后属导入者"
    # 跨用户 diff 也不泄露
    assert client.get(f"/api/studio/recipes/{rid}/diff", headers=H2,
                      params={"shot_id": shot["id"]}).status_code == 404
    # 全新用户空集合
    t3 = None
    with Session(ctx[3]) as s:
        t3 = Tenant(name="recipe3"); s.add(t3); s.commit(); s.refresh(t3)
        u3 = User(email="rcp3@toiv.ai", hashed_password=hash_password("p"), tenant_id=t3.id)
        s.add(u3); s.commit(); s.refresh(u3)
    H3 = _h(create_token(u3.id))
    assert client.get("/api/studio/recipes", headers=H3).json() == {"recipes": []}


def test_migration_recipe_table_idempotent(monkeypatch, tmp_path):
    old_engine = create_engine(f"sqlite:///{tmp_path}/old_recipe.db")
    with old_engine.begin() as conn:
        conn.exec_driver_sql(
            "CREATE TABLE studioshot (id TEXT PRIMARY KEY, project_id TEXT NOT NULL)"
        )
    monkeypatch.setattr(db_mod, "engine", old_engine)
    db_mod._run_column_migrations()
    db_mod._run_column_migrations()
    with old_engine.begin() as conn:
        tables = {
            row[0]
            for row in conn.exec_driver_sql(
                "SELECT name FROM sqlite_master WHERE type='table'"
            )
        }
        assert "studiorecipe" in tables
        indexes = {
            row[0]
            for row in conn.exec_driver_sql(
                "SELECT name FROM sqlite_master WHERE type='index'"
            )
        }
        assert "uq_studiorecipe_user_engine_default" in indexes
        cols = {row[1] for row in conn.exec_driver_sql("PRAGMA table_info(studiorecipe)")}
        assert {"user_id", "name", "engine", "pick_strategy", "snapshot_json",
                "source_revision_id", "source_shot_id", "is_default"} <= cols


# ── C1b 修正包 RED:content/legacy refs、脱敏、导入校验 ───────────────────────


def test_content_snapshot_keeps_ref_images(ctx, monkeypatch):
    """content 修订/live 快照必须保留参考图(先 parse 再脱敏),不再恒丢。"""
    client, token, _, engine = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    shot = _put_shots(client, H, pid, [{"scene": "A", "prompt": "rain"}])[0]
    # 模拟 orchestrator 回写参考(无渲染 → 走 content 修订快照)
    with Session(engine) as s:
        sh = s.get(StudioShot, shot["id"])
        sh.ref_images_json = json.dumps(
            ["/api/studio/files/ref.png?sig=SECRET", "/api/images?filename=a.png&type=output&sig=X",
             "http://user:pass@worker1:8196/view?filename=b.png"]
        )
        s.add(sh)
        s.commit()
    r = client.post("/api/studio/recipes/from-shot", headers=H,
                    json={"shot_id": shot["id"], "name": "content 源"})
    assert r.status_code == 200, r.text
    snap = r.json()["snapshot"]
    assert snap["ref_images"] == [
        "/api/studio/files/ref.png",
        "/api/images?filename=a.png&type=output",
        "http://worker1:8196/view",
    ], snap["ref_images"]


def test_ref_only_apply_creates_revision_and_diff_has_no_false_positive(ctx, monkeypatch):
    """仅参考图变化:apply 新建 revision、applied_fields 只含真实变化;
    diff 对 sig 不敏感(无假差异);无变化不造版本。"""
    client, token, _, engine = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    captured: dict = {}
    shot_a = _rendered_shot(client, H, pid, monkeypatch, captured)
    rid = client.post("/api/studio/recipes/from-shot", headers=H,
                      json={"shot_id": shot_a["id"], "name": "refs"}).json()["id"]

    # 目标镜:内容与配方一致,仅参考不同(且带 sig → 脱敏后相同)
    shot_b = _put_shots(client, H, pid, [
        {"scene": "雨夜", "prompt": "rain alley", "camera": "推镜", "duration_sec": 5},
    ])[0]
    with Session(engine) as s:
        sh = s.get(StudioShot, shot_b["id"])
        sh.ref_images_json = json.dumps(["/api/studio/files/ref.png?sig=DIFFERENT"])
        s.add(sh)
        s.commit()

    # diff:脱敏后一致 → 不得出现 ref_images 假差异
    d = client.get(f"/api/studio/recipes/{rid}/diff", headers=H,
                   params={"shot_id": shot_b["id"]}).json()
    assert "ref_images" not in d["fields"], d["fields"]

    # 改为真正不同的参考 → diff 出现
    with Session(engine) as s:
        sh = s.get(StudioShot, shot_b["id"])
        sh.ref_images_json = json.dumps(["/api/studio/files/other.png"])
        s.add(sh)
        s.commit()
    d = client.get(f"/api/studio/recipes/{rid}/diff", headers=H,
                   params={"shot_id": shot_b["id"]}).json()
    assert d["fields"]["ref_images"] == {
        "from": ["/api/studio/files/other.png"], "to": ["/api/studio/files/ref.png"],
    }

    # ref-only apply:新建 revision、applied_fields 精确、再 apply 不造版本
    revs_before = client.get(f"/api/studio/shots/{shot_b['id']}/revisions", headers=H).json()["revisions"]
    content_rev = revs_before[0]["id"] if revs_before else ""
    # 先对齐内容(配方内容与 B 一致,唯一差异是 ref)——直接 apply
    r = client.post(f"/api/studio/recipes/{rid}/apply", headers=H,
                    json={"shot_id": shot_b["id"]})
    assert r.status_code == 200, r.text
    assert r.json()["applied_fields"] == ["ref_images_json"], r.json()["applied_fields"]
    revs_mid = client.get(f"/api/studio/shots/{shot_b['id']}/revisions", headers=H).json()["revisions"]
    assert len(revs_mid) == len(revs_before) + 1, "ref-only 变化必须新建 revision"
    body = client.get(f"/api/studio/projects/{pid}", headers=H).json()
    sb = [x for x in body["shots"] if x["id"] == shot_b["id"]][0]
    assert sb["ref_images"] == ["/api/studio/files/ref.png"]
    assert sb["current_revision_id"] != content_rev
    # 重复 apply:无变化 → 不造版本
    r2 = client.post(f"/api/studio/recipes/{rid}/apply", headers=H,
                     json={"shot_id": shot_b["id"]})
    assert r2.status_code == 200
    assert r2.json()["applied_fields"] == []
    revs_after = client.get(f"/api/studio/shots/{shot_b['id']}/revisions", headers=H).json()["revisions"]
    assert len(revs_after) == len(revs_mid)


def test_scene_ref_sanitized_and_remote_rejected(ctx, monkeypatch):
    """scene_ref_json.anchor_image 同法脱敏;/api/images 定位字段保留、sig 剥除;
    导入对 anchor_image 远程引用按 ref 同一 SSRF 规则拒绝。"""
    client, token, _, engine = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    shot = _put_shots(client, H, pid, [{"scene": "A", "prompt": "p"}])[0]
    scene_ref = {
        "scene_id": "sc1", "anchor_id": "an1",
        "anchor_image": "/api/images?filename=anchor.png&type=output&sig=SECRET",
        "anchor_sha256": "abc",
    }
    with Session(engine) as s:
        sh = s.get(StudioShot, shot["id"])
        sh.scene_ref_json = json.dumps(scene_ref, ensure_ascii=False)
        s.add(sh)
        s.commit()
        # 让内容修订反映 scene_ref(再编辑一次生成新修订)
    _put_shots(client, H, pid, [{"id": shot["id"], "scene": "A", "prompt": "p",
                                 "characters": []}])
    with Session(engine) as s:
        sh = s.get(StudioShot, shot["id"])
        sh.scene_ref_json = json.dumps(scene_ref, ensure_ascii=False)
        s.add(sh)
        s.commit()
    r = client.post("/api/studio/recipes/from-shot", headers=H,
                    json={"shot_id": shot["id"], "name": "锚点"})
    assert r.status_code == 200, r.text
    stored = json.loads(r.json()["snapshot"]["scene_ref_json"])
    assert stored["anchor_image"] == "/api/images?filename=anchor.png&type=output"
    assert "sig" not in stored["anchor_image"]

    # 导入:anchor_image 远程引用 → 422(SSRF,与 ref_images 同规则)
    exported = client.get(f"/api/studio/recipes/{r.json()['id']}/export", headers=H).json()
    exported["name"] = "远程锚点"
    bad_ref = json.loads(exported["snapshot"]["scene_ref_json"])
    bad_ref["anchor_image"] = "http://evil.example/anchor.png"
    exported["snapshot"]["scene_ref_json"] = json.dumps(bad_ref, ensure_ascii=False)
    r2 = client.post("/api/studio/recipes/import", headers=H, json=exported)
    assert r2.status_code == 422, r2.text


def test_import_numeric_and_spec_validation(ctx, monkeypatch):
    """int 非数字/规格越界/对齐/scene_images 上限/engine 归一:全部 422 不 500。"""
    client, token, _, _ = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    shot = _rendered_shot(client, H, pid, monkeypatch)
    rid = client.post("/api/studio/recipes/from-shot", headers=H,
                      json={"shot_id": shot["id"]}).json()["id"]
    exported = client.get(f"/api/studio/recipes/{rid}/export", headers=H).json()

    def _import(mutate):
        body = json.loads(json.dumps(exported))
        mutate(body)
        return client.post("/api/studio/recipes/import", headers=H, json=body)

    assert _import(lambda b: b["snapshot"].update(num_candidates="two")).status_code == 422
    assert _import(lambda b: b["snapshot"].update(duration_sec="abc")).status_code == 422
    assert _import(lambda b: b["snapshot"].update(width=770)).status_code == 422      # 未 8 对齐
    assert _import(lambda b: b["snapshot"].update(width=2560)).status_code == 422     # 超界
    assert _import(lambda b: b["snapshot"].update(height=192)).status_code == 422     # 低于 256
    assert _import(lambda b: b["snapshot"].update(fps=60)).status_code == 422
    assert _import(lambda b: b["snapshot"].update(ckpt_name="c" * 513)).status_code == 422
    assert _import(
        lambda b: b["snapshot"].update(scene_images=[f"/s{i}.png" for i in range(5)])
    ).status_code == 422, "scene_images 上限应同 RenderShotBody=4"

    # engine/render_mode 双真源归一:顶层为准
    r = _import(lambda b: (b.update(engine="ltx"), b["snapshot"].update(engine="h3"))[0])
    assert r.status_code == 200, r.text
    assert r.json()["engine"] == "ltx"
    assert r.json()["snapshot"]["engine"] == "ltx"


def test_apply_project_specs_rejects_invalid(ctx, monkeypatch):
    """显式 apply_project_specs 也不得写入非法规格(复用 ProjectPatch 校验)。"""
    from app.services.studio import recipes as recipe_svc

    client, token, _, engine = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    rid = _mk_recipe(client, H, pid, monkeypatch)
    shot_b = _put_shots(client, H, pid, [{"scene": "F", "prompt": "f"}])[0]
    # DB 篡改快照为非法规格(绕过导入校验,验证 apply 侧守卫)
    with Session(engine) as s:
        recipe = s.get(StudioRecipe, rid)
        snap = json.loads(recipe.snapshot_json)
        snap["width"] = 770
        recipe.snapshot_json = json.dumps(snap)
        s.add(recipe)
        s.commit()
    r = client.post(f"/api/studio/recipes/{rid}/apply", headers=H,
                    json={"shot_id": shot_b["id"], "apply_project_specs": True})
    assert r.status_code == 422, r.text
    proj = client.get(f"/api/studio/projects/{pid}", headers=H).json()
    assert proj["width"] == 768, "非法规格不得落库"


# ── 最后小修:非法 URL 422 不泄露 / scene_ref 原文脱敏 / diff None 口径 ──────


def test_strip_url_secret_malformed_url_422_without_leak(ctx, monkeypatch):
    """非法 URL(坏端口)→ 422,错误信息不得含 URL 原文(防 sig 泄露)。"""
    client, token, _, engine = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    shot = _put_shots(client, H, pid, [{"scene": "A", "prompt": "p"}])[0]
    bad_url = "http://worker1:badport/view?filename=a.png&sig=SECRET"
    with Session(engine) as s:
        sh = s.get(StudioShot, shot["id"])
        sh.ref_images_json = json.dumps([bad_url])
        s.add(sh)
        s.commit()
    # 建配方(快照路径)→ 422
    r = client.post("/api/studio/recipes/from-shot", headers=H,
                    json={"shot_id": shot["id"]})
    assert r.status_code == 422, r.text
    assert "SECRET" not in r.text and bad_url not in r.text
    # 导入(校验路径)→ 422 同样不泄露
    exported = {
        "schema": "toiv_generation_recipe_v1",
        "name": "坏 URL", "engine": "h3", "render_mode": "video",
        "pipeline": "ref2va", "pick_strategy": "auto_best",
        "snapshot": {"prompt": "p", "ref_images": [bad_url]},
    }
    r2 = client.post("/api/studio/recipes/import", headers=H, json=exported)
    assert r2.status_code == 422, r2.text
    assert "SECRET" not in r2.text and bad_url not in r2.text


def test_scene_ref_non_json_raw_still_stripped(ctx, monkeypatch):
    """scene_ref 非 JSON 原文也做 query 脱敏(sig 不落配方快照)。"""
    client, token, _, engine = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    shot = _put_shots(client, H, pid, [{"scene": "A", "prompt": "p"}])[0]
    with Session(engine) as s:
        sh = s.get(StudioShot, shot["id"])
        sh.scene_ref_json = "legacy-anchor-ref?sig=SECRET&token=ABC"
        s.add(sh)
        s.commit()
    # 让内容修订带上 scene_ref(改 prompt 强制新修订,快照取当前 live 字段)
    _put_shots(client, H, pid, [{"id": shot["id"], "scene": "A", "prompt": "p2"}])
    r = client.post("/api/studio/recipes/from-shot", headers=H,
                    json={"shot_id": shot["id"], "name": "非JSON锚"})
    assert r.status_code == 200, r.text
    stored = r.json()["snapshot"]["scene_ref_json"]
    assert "sig" not in stored and "token" not in stored
    assert stored == "legacy-anchor-ref"


def test_diff_skips_none_fields_including_ref_epoch(ctx, monkeypatch):
    """snapshot 未声明的字段(含 ref_epoch)一律不比较/不应用,None 无假差异。"""
    client, token, _, _ = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    exported = {
        "schema": "toiv_generation_recipe_v1",
        "name": "极简", "engine": "h3", "render_mode": "video",
        "pipeline": "ref2va", "pick_strategy": "auto_best",
        "snapshot": {"prompt": "p"},  # 无 ref_epoch/duration_sec 等键
    }
    recipe = client.post("/api/studio/recipes/import", headers=H, json=exported).json()
    shot = _put_shots(client, H, pid, [{"scene": "S", "prompt": "other",
                                        "duration_sec": 9}])[0]
    d = client.get(f"/api/studio/recipes/{recipe['id']}/diff", headers=H,
                   params={"shot_id": shot["id"]}).json()
    assert "ref_epoch" not in d["fields"], d["fields"]
    assert "duration_sec" not in d["fields"], "未声明字段不得产生假差异"
    assert d["fields"] == {"prompt": {"from": "other", "to": "p"}}

    # apply 同样不写入未声明字段(ref_epoch/duration_sec 保持 shot 原值)
    r = client.post(f"/api/studio/recipes/{recipe['id']}/apply", headers=H,
                    json={"shot_id": shot["id"]})
    assert r.status_code == 200, r.text
    assert r.json()["applied_fields"] == ["prompt"]
    body = r.json()["shot"]
    assert body["prompt"] == "p"
    assert body["duration_sec"] == 9 and body["ref_epoch"] == 0


def test_import_ref_path_classification(ctx, monkeypatch):
    """路径分类:// =远程拒绝;绝对路径仅 /api/ 站内;裸文件名可用;http(s) 拒绝。"""
    client, token, _, _ = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    shot = _rendered_shot(client, H, pid, monkeypatch)
    rid = client.post("/api/studio/recipes/from-shot", headers=H,
                      json={"shot_id": shot["id"]}).json()["id"]
    exported = client.get(f"/api/studio/recipes/{rid}/export", headers=H).json()

    def _import(refs):
        body = json.loads(json.dumps(exported))
        body["name"] = "边界"
        body["snapshot"]["ref_images"] = refs
        return client.post("/api/studio/recipes/import", headers=H, json=body)

    assert _import(["//evil.example/x.png"]).status_code == 422      # 协议相对=远程
    assert _import(["/etc/passwd"]).status_code == 422               # 非 /api 绝对路径
    assert _import(["/../secret"]).status_code == 422
    assert _import(["http://evil.example/x.png"]).status_code == 422
    # 合法:站内 /api 引用(含 /api/images 定位 query)与裸文件名
    ok = _import([
        "/api/studio/files/ref.png",
        "/api/images?filename=a.png&worker=http%3A%2F%2Fw%3A8196&type=output",
        "bare-ref.png",
    ])
    assert ok.status_code == 200, ok.text
    assert ok.json()["snapshot"]["ref_images"] == [
        "/api/studio/files/ref.png",
        "/api/images?filename=a.png&worker=http%3A%2F%2Fw%3A8196&type=output",
        "bare-ref.png",
    ]

    # scene_ref 的 anchor_image 同规则
    def _import_scene_ref(image):
        body = json.loads(json.dumps(exported))
        body["name"] = "锚边界"
        body["snapshot"]["scene_ref_json"] = json.dumps(
            {"scene_id": "s", "anchor_id": "a", "anchor_image": image}, ensure_ascii=False)
        return client.post("/api/studio/recipes/import", headers=H, json=body)

    assert _import_scene_ref("//evil.example/a.png").status_code == 422
    assert _import_scene_ref("/etc/passwd").status_code == 422
    assert _import_scene_ref("http://evil.example/a.png").status_code == 422
    ok2 = _import_scene_ref("/api/studio/files/anchor.png")
    assert ok2.status_code == 200, ok2.text


def test_apply_invalidates_downstream_only_on_real_change(ctx, monkeypatch):
    client, token, _, engine = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    rid = _mk_recipe(client, H, pid, monkeypatch, prompt="changed")
    shot = _put_shots(client, H, pid, [{"scene": "B", "prompt": "original"}])[0]
    confirmed = {
        "storyboard": "confirmed", "generate": "confirmed",
        "voice": "skipped", "timeline": "confirmed",
    }

    def reset_stages():
        with Session(engine) as s:
            project = s.get(StudioProject, pid)
            project.stage_states_json = json.dumps(confirmed)
            s.add(project)
            s.commit()

    reset_stages()
    r = client.post(f"/api/studio/recipes/{rid}/apply", headers=H, json={"shot_id": shot["id"]})
    assert r.status_code == 200, r.text
    states = client.get(f"/api/studio/projects/{pid}", headers=H).json()["stage_states"]
    for stage in confirmed:
        assert states[stage]["state"] == "needs_review", stage

    reset_stages()
    r = client.post(f"/api/studio/recipes/{rid}/apply", headers=H, json={"shot_id": shot["id"]})
    assert r.status_code == 200 and r.json()["applied_fields"] == []
    states = client.get(f"/api/studio/projects/{pid}", headers=H).json()["stage_states"]
    for stage, expected in confirmed.items():
        assert states[stage]["state"] == expected, "无变化 apply 不得误标"
