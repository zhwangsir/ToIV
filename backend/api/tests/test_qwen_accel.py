"""Qwen-Image 加速档(2026-08-28 Phase 3A:Lightning LoRA + CacheDiT)路由级测试。

覆盖:
- Txt2ImgRequest/Img2ImgRequest 的 accel 校验(仅 off/turbo/turbo_cache);
- qwen_image 底模 + accel=turbo_cache → 图内含 8 步 Lightning LoRA + CacheDiT 节点,
  KSampler 强制 steps=8/cfg=1.0(用户传入的 steps/cfg 被加速档覆盖);
- 非 qwen_image 底模显式请求加速档 → 422(不静默忽略);
- 图像引擎参数表含 accel 选择器(引擎注册表同步)。
"""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

import app.routes.generate as generate
from app.models import User
from app.routes.generate import Img2ImgRequest, Txt2ImgRequest, _submit_txt2img
from app.services.engine_registry import _image_sampling_params

QWEN_CKPT = "qwen_image_fp8_e4m3fn.safetensors"


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
    return User(id="u-accel", email="u", hashed_password="x", tenant_id="t")


@pytest.fixture
def fake_pool():
    pool = MagicMock()
    client = AsyncMock()
    client.base_url = "http://worker"
    client.queue_prompt = AsyncMock(return_value="pid-1")
    pool.pick = AsyncMock(return_value=client)
    pool.first_available = AsyncMock(return_value=None)
    return pool


def _by_type(graph: dict, ctype: str) -> dict:
    for node in graph.values():
        if node["class_type"] == ctype:
            return node["inputs"]
    raise KeyError(ctype)


# ─────────────────────────────────────────────────────────────────────────────
# 请求模型校验
# ─────────────────────────────────────────────────────────────────────────────

def test_txt2img_accel_validator_accepts_three_tiers_and_none():
    for tier in (None, "off", "turbo", "turbo_cache"):
        req = Txt2ImgRequest(positive="海报", accel=tier)
        assert req.accel == tier


def test_txt2img_accel_validator_rejects_unknown():
    with pytest.raises(ValidationError):
        Txt2ImgRequest(positive="海报", accel="ludicrous")


def test_img2img_accel_validator_rejects_unknown():
    with pytest.raises(ValidationError):
        Img2ImgRequest(positive="海报", image="in.png", worker="w1", accel="ludicrous")


# ─────────────────────────────────────────────────────────────────────────────
# txt2img 链路:加速档进图
# ─────────────────────────────────────────────────────────────────────────────

async def test_txt2img_qwen_turbo_cache_graph(user, db, fake_pool, monkeypatch):
    """qwen_image + turbo_cache:8 步 Lightning LoRA + CacheDiT 入图,steps/cfg 被档位强制。"""
    monkeypatch.setattr(generate, "spawn_tracker", lambda client, prompt_id: None)
    captured: dict = {}

    async def _queue(graph, client_id):
        captured["graph"] = graph
        return "pid-1"

    fake_pool.pick.return_value.queue_prompt = AsyncMock(side_effect=_queue)

    req = Txt2ImgRequest(
        positive="春节海报,大字「新年快乐」",
        ckpt_name=QWEN_CKPT,
        steps=50,  # 加速档应覆盖用户/档案步数
        cfg=9.0,
        accel="turbo_cache",
    )
    resp = await _submit_txt2img(req, fake_pool, user, Session(db))

    assert resp["prompt_id"] == "pid-1"
    graph = captured["graph"]
    lora = _by_type(graph, "LoraLoaderModelOnly")
    assert lora["lora_name"] == "Qwen-Image-Lightning-8steps-V2.0-bf16.safetensors"
    assert _by_type(graph, "CacheDiT_Model_Optimizer")["model_type"] == "Qwen-Image"
    ks = _by_type(graph, "KSampler")
    assert ks["steps"] == 8 and ks["cfg"] == 1.0
    # 加速 LoRA 参与 worker 匹配(避免派到缺文件的机)
    required = fake_pool.pick.call_args.kwargs["required"]
    assert "Qwen-Image-Lightning-8steps-V2.0-bf16.safetensors" in required


async def test_txt2img_qwen_default_unchanged(user, db, fake_pool, monkeypatch):
    """不传 accel:满血 20 步 cfg 3.5,无加速节点(向后兼容)。"""
    monkeypatch.setattr(generate, "spawn_tracker", lambda client, prompt_id: None)
    captured: dict = {}

    async def _queue(graph, client_id):
        captured["graph"] = graph
        return "pid-1"

    fake_pool.pick.return_value.queue_prompt = AsyncMock(side_effect=_queue)

    req = Txt2ImgRequest(positive="一只狐狸", ckpt_name=QWEN_CKPT)
    await _submit_txt2img(req, fake_pool, user, Session(db))

    graph = captured["graph"]
    types = {n["class_type"] for n in graph.values()}
    assert "LoraLoaderModelOnly" not in types
    assert "CacheDiT_Model_Optimizer" not in types
    ks = _by_type(graph, "KSampler")
    assert ks["steps"] == 20 and ks["cfg"] == 3.5


async def test_txt2img_accel_rejected_for_non_qwen_ckpt(user, db, fake_pool, monkeypatch):
    """非 qwen_image 底模显式请求加速档 → 422,不静默忽略。"""
    monkeypatch.setattr(generate, "spawn_tracker", lambda client, prompt_id: None)
    req = Txt2ImgRequest(
        positive="一只狐狸",
        ckpt_name="DreamShaper_8_pruned.safetensors",
        accel="turbo",
    )
    with pytest.raises(HTTPException) as exc:
        await _submit_txt2img(req, fake_pool, user, Session(db))
    assert exc.value.status_code == 422


async def test_txt2img_accel_off_allowed_for_any_ckpt(user, db, fake_pool, monkeypatch):
    """accel="off" 等价满血默认,任意底模可用(不 422)。"""
    monkeypatch.setattr(generate, "spawn_tracker", lambda client, prompt_id: None)
    req = Txt2ImgRequest(
        positive="一只狐狸",
        ckpt_name="DreamShaper_8_pruned.safetensors",
        accel="off",
    )
    resp = await _submit_txt2img(req, fake_pool, user, Session(db))
    assert resp["prompt_id"] == "pid-1"


# ─────────────────────────────────────────────────────────────────────────────
# 引擎注册表同步:图像引擎参数表含 accel 选择器
# ─────────────────────────────────────────────────────────────────────────────

def test_image_sampling_params_include_qwen_accel_select():
    params = _image_sampling_params()
    accel = next(p for p in params if p["key"] == "accel")
    assert accel["type"] == "select"
    assert accel["default"] == "off"
    assert {o["value"] for o in accel["options"]} == {"off", "turbo", "turbo_cache"}
