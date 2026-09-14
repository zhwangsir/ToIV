"""自愈闭环 Phase1(2026-09-15):归因器 / 默认参数合成 / combo 校准修复器 / smoke 列契约。"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.db import get_session
from app.main import app
from app.models import App, Tenant, User
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
        {"key": "vhs_loadvideo_video", "type": "video", "required": True},
        {"key": "audio_in", "type": "audio", "required": True},
        {"key": "steps", "type": "number", "default": 20},
        {"key": "style", "type": "select", "options": [{"value": "a"}, {"value": "b"}]},
        {"key": "note", "type": "text"},
        {"key": "loras", "type": "loras"},
    ]
    v = svc.default_values(schema)
    assert v["loadimage_image"].startswith("smoke_loadimage_image_face_ref.")
    assert v["vhs_loadvideo_video"].endswith(".mp4")
    assert v["audio_in"].endswith(".wav")
    assert v["steps"] == 20
    assert v["style"] == "a"
    assert v["note"] == "smoke test"
    assert v["loras"] == []


# ---------------------------------------------------------------------------
# combo 校准修复器
# ---------------------------------------------------------------------------
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
