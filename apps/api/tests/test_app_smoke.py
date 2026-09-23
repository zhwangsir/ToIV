"""自愈闭环 Phase1(2026-09-15):归因器 / 默认参数合成 / combo 校准修复器 / smoke 列契约。"""
from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.db import get_session
from app.main import app
from app.models import App, Job, Tenant, User
from app.security import create_token, hash_password
from app.services import app_smoke as svc


# ---------------------------------------------------------------------------
# 归因器
# ---------------------------------------------------------------------------
def test_classify_missing_node():
    r = svc.classify_failure(
        '{"error": {"type": "missing_node_type", "message": "Node \'SDPoseOODLoader\' not found."}}', {})
    assert r["cls"] == "missing_node"
    assert r["repairable"] is True
    assert "SDPoseOODLoader" in r["detail"]


def test_classify_missing_model():
    msg = ("工作流校验未通过,主保存节点不会执行: UNETLoader: Value not in list model: "
           "'wan2.2_t2v_low_noise_14B_fp8_scaled.safetensors' not in (list of length 157)")
    r = svc.classify_failure(msg, {})
    assert r["cls"] == "missing_model"
    assert r["repairable"] is True


def test_classify_validation_and_cuda_and_timeout_and_transport():
    assert svc.classify_failure("Required input is missing", {})["cls"] == "validation"
    assert svc.classify_failure("mat1 and mat2 shapes cannot be multiplied", {})["cls"] == "runtime_cuda"
    assert svc.classify_failure("integer overflow", {})["cls"] == "runtime_cuda"
    assert svc.classify_failure("still queued after 240s", {})["cls"] == "timeout"
    assert svc.classify_failure("poll exceeded 480s (last=running)", {})["cls"] == "timeout"
    assert svc.classify_failure("媒体文件无法转运到运行实例", {})["cls"] == "transport"
    assert svc.classify_failure("InsightFace: No face detected.", {})["cls"] == "app_data"
    assert svc.classify_failure("division by zero", {})["cls"] == "app_data"
    assert svc.classify_failure("一种全新没人见过的错误", {})["cls"] == "product"


# ---------------------------------------------------------------------------
# 默认参数合成
# ---------------------------------------------------------------------------
def test_default_values_media_fixture_names_and_types():
    schema = [
        {"key": "loadimage_image", "type": "images", "required": True},
        {"key": "loadimage_image_2", "type": "images", "required": True},
        {"key": "vhs_loadvideo_video", "type": "video", "required": True},
        {"key": "audio_in", "type": "audio", "required": True},
        {"key": "steps", "type": "number", "default": 20},
        {"key": "style", "type": "select", "options": [{"value": "a"}, {"value": "b"}]},
        {"key": "note", "type": "text"},
        {"key": "loras", "type": "loras"},
    ]
    v = svc.default_values(schema)
    assert v["loadimage_image"].startswith("smoke_loadimage_image_")
    assert v["loadimage_image"].endswith((".jpg", ".png"))
    # 多图槽须不同 fixture 内容,避免 FL2VA first+last 同指纹撞 encode cache
    assert v["loadimage_image"] != v["loadimage_image_2"]
    assert v["vhs_loadvideo_video"].endswith(".mp4")
    assert v["audio_in"].endswith(".wav")
    assert v["steps"] == 20
    assert v["style"] == "a"
    assert v["note"] == "smoke test"
    assert v["loras"] == []


# ---------------------------------------------------------------------------
# combo 校准修复器
# ---------------------------------------------------------------------------
def test_default_values_empty_text_default_becomes_smoke_test():
    """text/textarea default="" 时烟测改用 smoke test(避免 H3 prompt 空)。"""
    schema = [
        {"key": "cr_text_text", "type": "textarea", "default": ""},
        {"key": "positive", "type": "text", "default": "keep"},
        {"key": "steps", "type": "number", "default": 0},
    ]
    v = svc.default_values(schema)
    assert v["cr_text_text"] == "smoke test"
    assert v["positive"] == "keep"
    assert v["steps"] == 0


def test_combo_repair_rewrites_class_alias_and_model_variant():
    graph = {
        "1": {"class_type": "stringtoint", "inputs": {"string": "5"}},
        "2": {"class_type": "UNETLoader", "inputs": {"unet_name": "wan2.2_t2v_low_noise_14B_fp8_scaled.safetensors"}},
    }
    objinfo = {
        "StringToInt": {"input": {"required": {"string": ["STRING", {}]}}},
        "UNETLoader": {"input": {"required": {"unet_name": [[
            "wan2_2_t2v_low_noise_14B_fp8_scaled.safetensors",
            "wan22_t2v_low_noise_14B_fp8_scaled_v2.safetensors",
        ], {}]}}},
    }
    fixes = svc.combo_repair(graph, objinfo)
    assert graph["1"]["class_type"] == "StringToInt"
    assert graph["2"]["inputs"]["unet_name"] == "wan2_2_t2v_low_noise_14B_fp8_scaled.safetensors"
    assert len(fixes) == 2


def test_combo_repair_ambiguous_match_leaves_value():
    graph = {"2": {"class_type": "VAELoader", "inputs": {"vae_name": "wan_2.1_vae.safetensors"}}}
    objinfo = {"VAELoader": {"input": {"required": {"vae_name": [[
        "wan21_vae_a.safetensors", "wan21_vae_b.safetensors"], {}]}}}}
    fixes = svc.combo_repair(graph, objinfo)
    assert fixes == []  # 多候选不瞎猜
    assert graph["2"]["inputs"]["vae_name"] == "wan_2.1_vae.safetensors"


def test_best_match_requires_containment():
    assert svc._best_match("flux1-dev.safetensors", ["flux1-dev-fp8.safetensors", "sd3.safetensors"]) == "flux1-dev-fp8.safetensors"
    assert svc._best_match("gemma3", ["flux1-dev-fp8.safetensors"]) == ""


# ---------------------------------------------------------------------------
# ComfyUI 0.34 动态 COMBO:object_info 槽位可能是 ["COMBO", {"options": [...]}]
# (取 [0] 会得到 "COMBO" 字符串,逐字符迭代/成员判断全错)
# ---------------------------------------------------------------------------
def test_combo_opts_handles_both_formats():
    assert svc._combo_opts([["a.safetensors", "b.pth"], {}]) == ["a.safetensors", "b.pth"]
    assert svc._combo_opts(["COMBO", {"multiselect": False, "options": ["a.safetensors", "b.pth"]}]) == ["a.safetensors", "b.pth"]
    assert svc._combo_opts(["COMBO"]) == []  # 纯动态无 options → 空,不误杀
    assert svc._combo_opts([]) == []
    assert svc._combo_opts(None) == []


def test_combo_repair_new_dynamic_combo_format():
    graph = {"2": {"class_type": "VAELoader", "inputs": {"vae_name": "wan_2.1_vae.safetensors"}}}
    objinfo = {"VAELoader": {"input": {"required": {"vae_name": [
        "COMBO", {"multiselect": False, "options": ["wan21_vae.safetensors"]},
    ]}}}}
    fixes = svc.combo_repair(graph, objinfo)
    assert graph["2"]["inputs"]["vae_name"] == "wan21_vae.safetensors"
    assert len(fixes) == 1


def test_preflight_check_new_dynamic_combo_format():
    """新版动态 COMBO 下值在列不得误报 missing(旧实现把 'COMBO' 当列表逐字符比)。"""
    workflow = {"1": {"class_type": "UpscaleModelLoader",
                      "inputs": {"model_name": "4x-UltraSharp.pth"}}}
    objinfo = {"UpscaleModelLoader": {"input": {"required": {"model_name": [
        "COMBO", {"multiselect": False, "options": ["4x-UltraSharp.pth"]},
    ]}}}}
    # preflight_check 需要 pool(仅拉并集失败时容错),这里 monkeypatch _union_objinfo
    import app.services.app_smoke as smoke
    orig = smoke._union_objinfo
    async def _fake(pool):
        return objinfo
    smoke._union_objinfo = _fake
    try:
        import asyncio
        res = asyncio.run(smoke.preflight_check(None, workflow))
    finally:
        smoke._union_objinfo = orig
    assert res["procurable"] is True
    assert res["missing_models"] == []


# ---------------------------------------------------------------------------
# smoke 列契约:建表/迁移后 App 可写可读,AppOut 透出
# ---------------------------------------------------------------------------
def _client_with_admin():
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    with Session(engine) as s:
        t = Tenant(name="t"); s.add(t); s.commit(); s.refresh(t)
        u = User(email="a@t.io", hashed_password=hash_password("x1"), tenant_id=t.id, role="admin")
        s.add(u); s.commit(); s.refresh(u)
        tok = create_token(u.id)
    return engine, tok


def test_app_smoke_columns_roundtrip_and_out():
    engine, tok = _client_with_admin()
    with Session(engine) as s:
        a = App(id="smoke-1", name="S", description="d", category="image",
                workflow_json={}, smoke_status="pass", smoke_at=None)
        s.add(a); s.commit()

    def _get_session():
        with Session(engine) as s:
            yield s
    app.dependency_overrides[get_session] = _get_session
    try:
        c = TestClient(app)
        out = c.get("/api/apps/smoke-1", headers={"Authorization": f"Bearer {tok}"}).json()
        assert out["smoke_status"] == "pass"
        assert out["smoke_cls"] == ""
        assert out["smoke_at"] is None
    finally:
        app.dependency_overrides.pop(get_session, None)


# ---------------------------------------------------------------------------
# LLM 修复器(Phase1-P1.6):补丁白名单 / combo 沙箱 / 提案还原
# ---------------------------------------------------------------------------
def test_apply_patch_whitelist():
    from app.services.selfheal_llm import apply_patch

    graph = {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": "old.safetensors"}},
        "2": {"class_type": "KSampler", "inputs": {"steps": 4}},
    }
    objinfo = {"UNETLoader": {}}
    patch = [
        {"op": "set_input", "node": "1", "field": "unet_name", "value": "new.safetensors"},
        {"op": "set_input", "node": "1", "field": "model", "value": ["9", 0]},  # 连线拒绝
        {"op": "set_input", "node": "2", "field": "not_allowed", "value": 1},  # 字段白名单外
        {"op": "delete_node", "node": "2"},
        {"op": "add_node", "node": "9"},  # 不在白名单,丢弃
    ]
    g, applied = apply_patch(graph, patch, objinfo)
    assert g["1"]["inputs"]["unet_name"] == "new.safetensors"
    assert "2" not in g
    assert len(applied) == 2


def test_combo_violations():
    from app.services.selfheal_llm import combo_violations

    graph = {"1": {"class_type": "UNETLoader", "inputs": {"unet_name": "nope.safetensors"}}}
    objinfo = {"UNETLoader": {"input": {"required": {"unet_name": [["ok.safetensors"], {}]}}}}
    bad = combo_violations(graph, objinfo)
    assert len(bad) == 1 and "nope.safetensors" in bad[0]
    graph["1"]["inputs"]["unet_name"] = "ok.safetensors"
    assert combo_violations(graph, objinfo) == []


def test_reject_proposal_restores_original():
    from app.services.selfheal_llm import record_proposal, reject_proposal

    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    with Session(engine) as s:
        a = App(id="p1", name="P", description="d", category="image",
                workflow_json={"1": {"class_type": "Orig", "inputs": {}}})
        s.add(a); s.commit()
        patched = {"1": {"class_type": "Patched", "inputs": {}}}
        p = record_proposal(s, a, "missing_model", "err", [{"op": "x"}],
                            original_workflow={"1": {"class_type": "Orig", "inputs": {}}},
                            note="trial=pass")
        a.workflow_json = patched
        s.add(a); s.commit()
        out = reject_proposal(s, p.id)
        s.refresh(a)
        assert out["restored"] is True
        assert a.workflow_json == {"1": {"class_type": "Orig", "inputs": {}}}
        assert a.smoke_status == ""
        s.refresh(p)
        assert p.status == "rejected"


# ---------------------------------------------------------------------------
# demo 封面(2026-09-14):素材注入 / 提示词注入规则 / 目标清单排序
# ---------------------------------------------------------------------------
from app.services import app_cover_demo as demo_svc


def _mk_app(**kw) -> App:
    base = dict(id="demo-t", name="t", workflow_json={},
                params_schema=[], output_kind="image", is_public=True)
    base.update(kw)
    return App(**base)


def test_demo_values_media_use_beauty_pack_and_smoke_prefix():
    app = _mk_app(params_schema=[
        {"key": "loadimage_image", "type": "images", "required": True},
        {"key": "vhs_loadvideo_video", "type": "video", "required": True},
        {"key": "audio_in", "type": "audio", "required": True},
    ])
    values, injected = demo_svc.demo_values(app, idx=0)
    # 2026-09-17 素材按应用 ID 哈希选取(防同批撞车),该固定 id 的哈希落在 3 号素材
    assert values["loadimage_image"] == "smoke_loadimage_image_beauty03.png"
    assert values["vhs_loadvideo_video"] == "smoke_vhs_loadvideo_video_drive_2s.mp4"
    assert values["audio_in"] == "smoke_audio_in_dlg_h3b.wav"
    assert injected == ""  # 带媒体的图片应用=编辑类,不注入提示词
    # 上传名必须能命中 fixtures 目录里的真实文件(app_smoke._upload_fixtures 契约)
    from app.services.app_smoke import _FIXTURES
    for name in (values["loadimage_image"], values["vhs_loadvideo_video"], values["audio_in"]):
        stem = name.rsplit(".", 1)[0]
        assert any(stem.endswith(f.stem) for f in _FIXTURES.iterdir()), name


def test_demo_values_generative_image_gets_scene_prompt():
    app = _mk_app(params_schema=[{"key": "prompt", "type": "text", "default": "a cat"}])
    values, injected = demo_svc.demo_values(app, idx=0)
    assert values["prompt"] == injected
    assert "beautiful young woman" in injected


def test_demo_values_video_app_with_image_input_gets_motion_prompt():
    app = _mk_app(output_kind="video", params_schema=[
        {"key": "prompt", "type": "textarea"},
        {"key": "negative_prompt", "type": "textarea"},
        {"key": "ref_image", "type": "images", "required": True},
    ])
    values, injected = demo_svc.demo_values(app, idx=2)
    assert values["prompt"] == injected  # 视频类即使带图输入也注入动作模板
    assert "negative" not in values["prompt"].lower()
    assert "negative_prompt" not in values  # 负向槽不注入(运行时吃 schema 默认)
    assert values["ref_image"].endswith("beauty03.png")


def test_demo_values_video_length_capped():
    app = _mk_app(output_kind="video", params_schema=[
        {"key": "prompt", "type": "textarea"},
        {"key": "length", "type": "number", "default": 121},
    ])
    values, _ = demo_svc.demo_values(app, idx=0)
    assert values["length"] == demo_svc._VIDEO_LEN_CAP


def _mk_target(i: int, **kw) -> App:
    base = dict(id=f"rh-{i}", name=f"a{i}", is_public=True, is_builtin=True,
                cover_url="", usage_count=0)
    base.update(kw)
    return App(**base)


def test_plan_demo_targets_order_and_excludes():
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    with Session(engine) as s:
        rows = [
            _mk_target(1, featured=True),
            _mk_target(2, usage_count=99, cover_url="/api/apps/covers/file/appcover-demo-x.png"),  # 已有 demo 封面
            _mk_target(3, is_nsfw=True),
            _mk_target(4, output_kind="audio"),
            _mk_target(5, usage_count=10, cover_url="/api/apps/covers/file/appcover-old.png"),
            _mk_target(6, smoke_status="pass", usage_count=1),
        ]
        for r in rows:
            s.add(r)
        # rh-7:已达尝试上限(3 次 app_cover_demo 存档)→ 不再续发
        for i in range(3):
            s.add(Job(tenant_id="", user_id="", prompt_id="", worker="",
                      kind="app_cover_demo", status="error",
                      params=json.dumps({"app_id": "rh-7"})))
        s.add(_mk_target(7))
        s.commit()
        got = [a.id for a in demo_svc.plan_demo_targets(s, limit=10)]
    assert "rh-2" not in got and "rh-3" not in got and "rh-4" not in got
    assert "rh-7" not in got  # 尝试上限排除(2026-09-19 autorefire 暴走修复)
    assert got[0] == "rh-1"  # featured 最优先
    assert "rh-6" in got and "rh-5" in got


def test_archive_demo_attempt_counts_toward_cap():
    """失败落档(_archive_demo_attempt)计入上限;成功路径落档不受影响。"""
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    demo_svc.engine = engine  # helper 内部用模块级 engine 建 Session
    try:
        demo_svc._archive_demo_attempt("rh-x", ok=False, error="boom")
        demo_svc._archive_demo_attempt("rh-x", ok=False, error="boom2")
        with Session(engine) as s:
            s.add(_mk_target(20))
            s.commit()
            counts = demo_svc._demo_attempt_counts(s)
            got = [a.id for a in demo_svc.plan_demo_targets(s, limit=10)]
        assert counts.get("rh-x") == 2
        assert "rh-20" in got  # 2 次 < 上限 3,仍在清单
        demo_svc._archive_demo_attempt("rh-x", ok=False, error="boom3")
        with Session(engine) as s:
            counts = demo_svc._demo_attempt_counts(s)
        assert counts.get("rh-x") == 3  # 达上限
    finally:
        from app.db import engine as real_engine
        demo_svc.engine = real_engine


def test_demo_cover_endpoint_needs_admin():
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    with Session(engine) as s:
        t = Tenant(name="t"); s.add(t); s.commit(); s.refresh(t)
        u = User(email="u@t.io", hashed_password=hash_password("x1"), tenant_id=t.id, role="user")
        s.add(u); s.commit(); s.refresh(u)
        tok = create_token(u.id)

    def _get_session():
        with Session(engine) as s2:
            yield s2
    app.dependency_overrides[get_session] = _get_session
    try:
        c = TestClient(app)
        assert c.post("/api/admin/apps/covers/demo", json={"limit": 5},
                      headers={"Authorization": f"Bearer {tok}"}).status_code in (401, 403)
    finally:
        app.dependency_overrides.pop(get_session, None)
