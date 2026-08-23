"""模型百科(WIKI-2026-08-18)测试:

① workflows/model_wiki.card_for:curated 卡片前缀/类目匹配;list_card_summaries 完整
② services/model_wiki:build_cards 三层合并(curated∪富化缓存);clean_model_name 噪音清洗;
   _keyword_hits 关键词兜底;ask_model_wiki LLM 失败降级卡片直出(embedding mock 失败)
③ 路由:/models/wiki 列表+R18 过滤;/models/wiki/detail;/models/wiki/enrich admin 门+
   civitai mock 落库幂等;/models/ask 空 question 422、正常路径走 mock
④ 助手工具:exec_model_qa 关键词路径返回卡片文本;tool_seam 注册表含 model_qa
"""
from __future__ import annotations

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel

from app.db import get_session
from app.deps import get_pool
from app.main import app
from app.models import ModelCard, Tenant, User
from app.security import create_token, hash_password
from app.workflows.model_wiki import card_for, list_card_summaries


# ---------------------------------------------------------------------------
# 替身
# ---------------------------------------------------------------------------

class _FakeWorkerClient:
    """worker 替身:object_info 返回可控枚举。"""

    base_url = "http://fake-worker"

    def __init__(self, ckpts: list[str], loras: list[str]) -> None:
        self._ckpts = ckpts
        self._loras = loras

    async def object_info(self, node: str) -> dict:
        if node == "CheckpointLoaderSimple":
            return {node: {"input": {"required": {"ckpt_name": [self._ckpts]}}}}
        if node == "LoraLoader":
            return {node: {"input": {"required": {"lora_name": [self._loras]}}}}
        return {node: {"input": {"required": {"_": [[]]}}}}


class _FakePool:
    def __init__(self, ckpts, loras) -> None:
        self.clients = [_FakeWorkerClient(ckpts, loras)]


@pytest.fixture()
def ctx(monkeypatch):
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    SQLModel.metadata.create_all(engine)

    def override():
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override
    with Session(engine) as s:
        t = Tenant(name="w")
        s.add(t)
        s.commit()
        s.refresh(t)
        u = User(email="u@toiv.ai", hashed_password=hash_password("p1"), tenant_id=t.id)
        admin = User(email="a@toiv.ai", hashed_password=hash_password("p1"), tenant_id=t.id, role="admin")
        s.add_all([u, admin])
        s.commit()
        for x in (u, admin):
            s.refresh(x)

    ckpts = ["majicMIX realistic 麦橘写实_v7.safetensors", "lustifySDXLNSFW_apexV8.safetensors", "unknownModel_v2.safetensors"]
    loras = ["campus_classroom_v1.safetensors", "myStyleLoRA.safetensors"]
    fake_pool = _FakePool(ckpts, loras)
    app.dependency_overrides[get_pool] = lambda: fake_pool
    yield TestClient(app), create_token(u.id), create_token(admin.id), Session(engine)
    app.dependency_overrides.clear()
    app.dependency_overrides.pop(get_pool, None)


def _h(tok: str) -> dict:
    return {"Authorization": f"Bearer {tok}"}


# ── ① curated 匹配 ────────────────────────────────────────────────────────

def test_card_for_prefix_match():
    card = card_for("majicMIX realistic 麦橘写实_v7.safetensors", "checkpoints")
    assert card and card["label"].startswith("麦橘写实")
    assert "采样 25 步" in card["usage"] or "25" in card["usage"]
    assert card["source"] == "curated"


def test_card_for_nsfw_flag():
    card = card_for("lustifySDXLNSFW_apexV8.safetensors", "checkpoints")
    assert card and card["nsfw"] is True


def test_card_for_unknown_returns_none():
    assert card_for("totally_unknown_thing.safetensors", "checkpoints") is None


def test_card_for_qwen_image_family_longest_prefix():
    """qwen_image 族:基础模与两个编辑专用 DiT 各命中各卡(最长前缀优先)。"""
    base = card_for("qwen_image_fp8_e4m3fn.safetensors", "checkpoints")
    assert base and "中文文字渲染" in base["label"]
    e2509 = card_for("qwen_image_edit_2509_fp8_e4m3fn.safetensors", "checkpoints")
    assert e2509 and "2509" in e2509["label"]
    e2511 = card_for("qwen_image_edit_2511_fp8mixed.safetensors", "checkpoints")
    assert e2511 and "2511" in e2511["label"]


def test_card_for_case_and_underscore_variants():
    """历史前缀不匹配回归:waiSHUFFLENOOB(无下划线)须命中卡片。"""
    card = card_for("waiSHUFFLENOOB_vPred04.safetensors", "checkpoints")
    assert card and "ShuffleNoob" in card["label"]


def test_card_for_elie_lora_trigger_words():
    """elie-xl-nvwls-v1 实为角色 LoRA(误放 checkpoints 已归位),卡片带触发词。"""
    card = card_for("elie-xl-nvwls-v1.safetensors", "loras")
    assert card and "elie macdowell" in card["trigger_words"]


def test_list_card_summaries_complete():
    rows = list_card_summaries()
    assert len(rows) >= 20
    for r in rows:
        assert r["filename_prefix"] and r["description"] and r["usage"]


# ── ② 服务层 ──────────────────────────────────────────────────────────────

def test_clean_model_name_strips_noise():
    from app.services.model_wiki import clean_model_name

    assert clean_model_name("waiIllustriousSDXL_v170.safetensors").lower().count("sdxl") == 0
    assert "fp8" not in clean_model_name("myModel_fp8_scaled.safetensors").lower()
    assert clean_model_name("flux2_dev_fp8mixed.safetensors").strip() != ""


def test_build_cards_merges_curated_and_enriched():
    from app.services.model_wiki import _card_id, build_cards

    with Session(create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)) as _:
        pass  # 占位,实际用 ctx 的 session

    engine2 = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    SQLModel.metadata.create_all(engine2)
    with Session(engine2) as s:
        # unknownModel 无 curated → 富化卡片提供 description
        s.merge(ModelCard(
            id=_card_id("unknownModel_v2.safetensors", "checkpoints"),
            filename="unknownModel_v2.safetensors", model_type="checkpoints",
            description="社区模型:赛博人像专精", trigger_words='["cyberface"]',
            civitai_url="https://civitai.red/models/123", downloads=500,
        ))
        s.commit()
        inv = {"checkpoints": ["majicMIX realistic 麦橘写实_v7.safetensors", "unknownModel_v2.safetensors"]}
        cards = {c["filename"]: c for c in build_cards(inv, s)}
    assert cards["majicMIX realistic 麦橘写实_v7.safetensors"]["has_detail"]  # curated
    unk = cards["unknownModel_v2.safetensors"]
    assert unk["has_detail"] and "赛博人像" in unk["description"]
    assert unk["trigger_words"] == ["cyberface"]
    assert unk["civitai_url"].endswith("/models/123")


def test_keyword_hits_ranks():
    from app.services.model_wiki import _keyword_hits

    cards = [
        {"filename": "wai_x.safetensors", "label": "WAI", "tags": ["二次元"], "description": ""},
        {"filename": "flux.safetensors", "label": "FLUX", "tags": ["写实"], "description": ""},
    ]
    hits = _keyword_hits("二次元 模型", cards)
    assert hits and hits[0]["filename"] == "wai_x.safetensors"


# ── ③ 路由 ────────────────────────────────────────────────────────────────

def test_wiki_list_and_r18_filter(ctx):
    client, tok, tok_admin, _ = ctx
    r = client.get("/api/models/wiki", headers=_h(tok))
    assert r.status_code == 200, r.text
    names = [c["filename"] for c in r.json()["cards"]]
    assert "majicMIX realistic 麦橘写实_v7.safetensors" in names
    assert "lustifySDXLNSFW_apexV8.safetensors" not in names  # 主站 R18 剔除
    assert "campus_classroom_v1.safetensors" in names  # loras 类目
    # 搜索过滤
    r = client.get("/api/models/wiki", headers=_h(tok), params={"q": "麦橘"})
    assert all("麦橘" in c["filename"] for c in r.json()["cards"])


def test_wiki_detail(ctx):
    client, tok, _, _ = ctx
    r = client.get("/api/models/wiki/detail", headers=_h(tok), params={
        "filename": "majicMIX realistic 麦橘写实_v7.safetensors", "type": "checkpoints"})
    assert r.status_code == 200
    assert r.json()["has_detail"] is True
    # R18 模型主站 404
    r2 = client.get("/api/models/wiki/detail", headers=_h(tok), params={
        "filename": "lustifySDXLNSFW_apexV8.safetensors", "type": "checkpoints"})
    assert r2.status_code == 404


def test_enrich_admin_gate_and_upsert(ctx):
    client, tok, tok_admin, session = ctx

    async def fake_search(query, model_type):
        return {"id": 999, "name": "Unknown Model", "nsfw": False,
                "description": "<p>Community model for cyber portraits.</p>",
                "creator": {"username": "alice"}, "stats": {"downloadCount": 42},
                "modelVersions": [{"baseModel": "SDXL 1.0", "trainedWords": ["unkface"]}]}

    with patch("app.services.model_wiki._search_civitai", new=fake_search):
        r = client.post("/api/models/wiki/enrich", headers=_h(tok), json={})
        assert r.status_code == 403  # 非 admin
        r = client.post("/api/models/wiki/enrich", headers=_h(tok_admin),
                        json={"targets": [["unknownModel_v2.safetensors", "checkpoints"]]})
        assert r.status_code == 200
        assert r.json()["enriched"] == 1
        # 幂等:第二次 force=False 跳过
        r2 = client.post("/api/models/wiki/enrich", headers=_h(tok_admin),
                         json={"targets": [["unknownModel_v2.safetensors", "checkpoints"]]})
        assert r2.json()["skipped"] == 1
    # 富化后列表可见介绍
    r3 = client.get("/api/models/wiki", headers=_h(tok))
    unk = next(c for c in r3.json()["cards"] if c["filename"] == "unknownModel_v2.safetensors")
    assert unk["has_detail"] and unk["trigger_words"] == ["unkface"]
    assert unk["creator"] == "alice"


def test_ask_route(ctx):
    client, tok, _, _ = ctx
    r = client.post("/api/models/ask", headers=_h(tok), json={"question": ""})
    assert r.status_code == 422
    fallback_card = {
        "filename": "majicMIX realistic 麦橘写实_v7.safetensors", "model_type": "checkpoints",
        "label": "麦橘写实", "description": "亚洲人像", "usage": "", "tags": [],
        "trigger_words": [], "nsfw": False,
    }
    with patch("app.services.model_wiki._topk_by_embed", new=AsyncMock(return_value=[])), \
         patch("app.services.model_wiki.get_ctx", side_effect=Exception("llm down")), \
         patch("app.services.model_wiki._keyword_hits", return_value=[fallback_card]):
        r = client.post("/api/models/ask", headers=_h(tok), json={"question": "写实人像用哪个模型"})
        assert r.status_code == 200
        data = r.json()
        assert data["matched"], "LLM 挂了也应有关键词兜底"
        assert "麦橘" in data["answer"]  # 降级文案直出卡片


def test_ask_no_match(ctx):
    client, tok, _, _ = ctx
    with patch("app.services.model_wiki._topk_by_embed", new=AsyncMock(return_value=[])), \
         patch("app.services.model_wiki._keyword_hits", return_value=[]):
        r = client.post("/api/models/ask", headers=_h(tok), json={"question": "量子计算机模型"})
        assert r.status_code == 200
        assert "没有匹配" in r.json()["answer"]


# ── ④ 助手工具 ────────────────────────────────────────────────────────────

def test_exec_model_qa_keyword_fallback():
    import asyncio

    from app.agent import tools
    from app.services.model_wiki import _keyword_hits

    cards = [
        {"filename": "flux2_dev.safetensors", "model_type": "checkpoints", "label": "FLUX.2",
         "tags": ["写实"], "description": "画质天花板", "usage": "28 步 CFG1",
         "trigger_words": [], "nsfw": False},
    ]
    with patch("app.services.model_wiki.local_inventory",
               new=AsyncMock(return_value={"checkpoints": ["flux2_dev.safetensors"]})), \
         patch("app.services.model_wiki.build_cards", return_value=cards), \
         patch("app.services.model_wiki._topk_by_embed", new=AsyncMock(return_value=[])), \
         patch("app.services.model_wiki._keyword_hits", return_value=_keyword_hits("写实", cards)):
        text, events = asyncio.run(tools.exec_model_qa(
            {"question": "写实用什么"}, _FakePool([], []), MagicMock(), MagicMock()))
    assert "FLUX.2" in text and "28 步" in text


def test_tool_registry_contains_model_qa():
    from app.harness.tool_seam import builtin_tool_specs

    names = [s.name for s in builtin_tool_specs()]
    assert "model_qa" in names
