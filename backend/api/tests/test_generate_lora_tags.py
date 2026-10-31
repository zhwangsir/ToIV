"""`<lora:NAME:WEIGHT>` 标签解析与 generate 链路 LoRA 注入的测试。

覆盖 P0-4 修复:场景预设 LoRA 经 LoraLoader 链真正进入工作流(而非标签污染 prompt),
用户手写标签同样生效;非法标签只剔除不炸请求。
"""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

import app.routes.generate as generate
from app.models import User
from app.routes.generate import Txt2ImgRequest, _submit_txt2img
from app.workflows.lora import LoraSpec, parse_lora_tags


# ─────────────────────────────────────────────────────────────────────────────
# parse_lora_tags 单元测试
# ─────────────────────────────────────────────────────────────────────────────


def test_parse_single_tag_stripped_and_extracted():
    cleaned, loras = parse_lora_tags("a warrior <lora:hanfu_flux_v2.safetensors:0.8>")
    assert cleaned == "a warrior"
    assert loras == (LoraSpec("hanfu_flux_v2.safetensors", 0.8),)


def test_parse_multiple_tags_in_order():
    cleaned, loras = parse_lora_tags(
        "a cat <lora:a.safetensors:0.8>, sitting <lora:sub/b.safetensors:-0.5>"
    )
    assert "<lora" not in cleaned
    assert "a cat" in cleaned and "sitting" in cleaned
    assert loras == (LoraSpec("a.safetensors", 0.8), LoraSpec("sub/b.safetensors", -0.5))


def test_parse_invalid_weight_tag_dropped_not_loaded():
    """权重不可解析的非法标签:从文本剔除但不产生 LoraSpec,不抛异常。"""
    cleaned, loras = parse_lora_tags("a cat <lora:bad.safetensors:notanumber>")
    assert "<lora" not in cleaned
    assert "a cat" in cleaned
    assert loras == ()


def test_parse_no_tags_passthrough():
    cleaned, loras = parse_lora_tags("a cat, masterpiece")
    assert cleaned == "a cat, masterpiece"
    assert loras == ()


# ─────────────────────────────────────────────────────────────────────────────
# generate 路由级测试
# ─────────────────────────────────────────────────────────────────────────────


@pytest.fixture
def db(monkeypatch):
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    SQLModel.metadata.create_all(engine)
    monkeypatch.setattr(generate, "engine", engine)
    return engine


@pytest.fixture
def user():
    return User(id="u-lora", email="u", hashed_password="x", tenant_id="t")


@pytest.fixture
def fake_pool():
    pool = MagicMock()
    client = AsyncMock()
    client.base_url = "http://worker"
    client.queue_prompt = AsyncMock(return_value="pid-1")
    pool.pick = AsyncMock(return_value=client)
    pool.first_available = AsyncMock(return_value=None)
    return pool


def _lora_nodes(graph: dict) -> list[dict]:
    return [n for n in graph.values() if n["class_type"] == "LoraLoader"]


def _positive_texts(graph: dict) -> list[str]:
    return [
        n["inputs"].get("text", n["inputs"].get("prompt", ""))
        for n in graph.values()
        if n["class_type"] in ("CLIPTextEncode", "TextEncodeZImageOmni")
    ]


async def test_txt2img_preset_and_manual_lora_reach_nextgen_graph(
    user, db, fake_pool, monkeypatch
):
    """场景预设(flux2 次世代族)LoRA + 手写 <lora:> 标签都编成 LoraLoader 链,
    标签从 prompt 文本剔除。"""
    monkeypatch.setattr(generate, "spawn_tracker", lambda client, prompt_id: None)
    captured: dict = {}

    async def _queue(graph, client_id):
        captured["graph"] = graph
        return "pid-1"

    fake_pool.pick.return_value.queue_prompt = AsyncMock(side_effect=_queue)

    req = Txt2ImgRequest(
        positive="a warrior <lora:extra_style.safetensors:0.6>",
        style_preset="ancient_chinese",
    )
    resp = await _submit_txt2img(req, fake_pool, user, Session(db))

    assert resp["prompt_id"] == "pid-1"
    graph = captured["graph"]
    names = {n["inputs"]["lora_name"] for n in _lora_nodes(graph)}
    assert "ancient_chinese/hanfu_flux_v2.safetensors" in names  # 预设 LoRA
    assert "extra_style.safetensors" in names  # 手写标签 LoRA
    # 标签不残留在任何编码节点的文本里
    assert all("<lora" not in t for t in _positive_texts(graph))


async def test_txt2img_invalid_tag_dropped_request_survives(
    user, db, fake_pool, monkeypatch
):
    """非法标签:请求不炸、标签不进 prompt、不产生 LoraLoader。"""
    monkeypatch.setattr(generate, "spawn_tracker", lambda client, prompt_id: None)
    captured: dict = {}

    async def _queue(graph, client_id):
        captured["graph"] = graph
        return "pid-1"

    fake_pool.pick.return_value.queue_prompt = AsyncMock(side_effect=_queue)

    req = Txt2ImgRequest(
        positive="a cat <lora:bad.safetensors:oops>",
        ckpt_name="majicMIX realistic 麦橘写实_v7.safetensors",
    )
    resp = await _submit_txt2img(req, fake_pool, user, Session(db))

    assert resp["prompt_id"] == "pid-1"
    assert _lora_nodes(captured["graph"]) == []
    assert all("<lora" not in t for t in _positive_texts(captured["graph"]))
