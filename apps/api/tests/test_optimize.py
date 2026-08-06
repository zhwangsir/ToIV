"""内容感知 AI 润色(/api/optimize)测试。

不依赖真实 LLM:用 monkeypatch 替换 app.agent.llm.chat,断言:
- 图像类返回 {optimized, negative} 且 negative 随题材而变(content-aware);
- LLM 没给 negative 时,启发式按题材兜底(人像→解剖词,动漫→排除写实…);
- 解析失败时整段当正向 + 启发式负面;
- 其它类(audio/threed/train)返回单段;video 与图像类同构返回 {optimized, negative}(视频引擎吃 negative);
- 启发式负面函数本身按题材产出不同结果。
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.db import get_session
from app.main import app
from app.models import Tenant, User
from app.routes.optimize import (
    _ANATOMY_NEGATIVE,
    _heuristic_negative,
    _image_system_for,
)
from app.workflows.model_profiles import detect_model_family
from app.security import create_token, hash_password


@pytest.fixture()
def client_token():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)

    def override() -> Session:
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override
    with Session(engine) as s:
        tenant = Tenant(name="opt")
        s.add(tenant)
        s.commit()
        s.refresh(tenant)
        user = User(
            email="opt@toiv.ai",
            hashed_password=hash_password("password1"),
            tenant_id=tenant.id,
            role="user",
        )
        s.add(user)
        s.commit()
        s.refresh(user)
        uid = user.id
    yield TestClient(app), create_token(uid)
    app.dependency_overrides.clear()


def _patch_llm(monkeypatch, content: str) -> None:
    async def fake_chat(messages, tools=None, max_tokens=None, temperature=0.4):  # noqa: ANN001
        return {"content": content}

    monkeypatch.setattr("app.routes.optimize.llm.chat", fake_chat)


# ── 启发式负面:纯函数,确定性,按题材不同 ───────────────────────────────
def test_heuristic_portrait_has_anatomy():
    neg = _heuristic_negative("a portrait of a woman")
    assert "deformed hands" in neg and "extra fingers" in neg


def test_heuristic_anime_excludes_realism():
    neg = _heuristic_negative("anime girl, cel shading")
    assert "photorealistic" in neg and "realistic" in neg
    # 动漫不该塞解剖词块(取首个命中题材)
    assert "deformed hands" not in neg


def test_heuristic_realistic_excludes_cartoon():
    neg = _heuristic_negative("photorealistic raw photo, dslr")
    assert "cartoon" in neg and "anime" in neg


def test_heuristic_landscape_quality_words():
    neg = _heuristic_negative("a mountain landscape at sunset")
    assert "oversaturated" in neg
    assert "deformed hands" not in neg


def test_heuristic_nsfw_not_censored():
    # NSFW 命中人像规则,补解剖词,不拒绝
    neg = _heuristic_negative("性感 portrait, 裸")
    assert _ANATOMY_NEGATIVE.split(",")[0] in neg


def test_heuristic_dedupes():
    neg = _heuristic_negative("realistic photo of a man")
    parts = [p.strip().lower() for p in neg.split(",")]
    assert len(parts) == len(set(parts))  # 无重复


# ── 路由:图像类返回正向+负面 ─────────────────────────────────────────────
def test_image_optimize_returns_pos_and_neg(client_token, monkeypatch):
    client, token = client_token
    _patch_llm(
        monkeypatch,
        '{"category": "portrait", "positive": "a stunning portrait, highly detailed, '
        'cinematic lighting", "negative": "deformed hands, extra fingers, bad anatomy, blurry"}',
    )
    r = client.post(
        "/api/optimize",
        headers={"Authorization": f"Bearer {token}"},
        json={"prompt": "一个女孩的肖像", "kind": "image"},
    )
    assert r.status_code == 200, r.text
    data = r.json()
    assert "portrait" in data["optimized"]
    assert "deformed hands" in data["negative"]


def test_image_optimize_heuristic_when_llm_omits_negative(client_token, monkeypatch):
    client, token = client_token
    # LLM 只给 positive(anime),negative 缺失 → 启发式按 anime 补排除写实词
    _patch_llm(monkeypatch, '{"positive": "anime girl, vibrant, cel shading"}')
    r = client.post(
        "/api/optimize",
        headers={"Authorization": f"Bearer {token}"},
        json={"prompt": "动漫女孩", "kind": "image"},
    )
    assert r.status_code == 200, r.text
    neg = r.json()["negative"]
    assert "photorealistic" in neg or "realistic" in neg


def test_image_optimize_parse_failure_falls_back(client_token, monkeypatch):
    client, token = client_token
    # 非 JSON 文本 → 整段当正向 + 启发式负面
    _patch_llm(monkeypatch, "photorealistic raw photo of a man, dslr, sharp focus")
    r = client.post(
        "/api/optimize",
        headers={"Authorization": f"Bearer {token}"},
        json={"prompt": "写实男人", "kind": "image"},
    )
    assert r.status_code == 200, r.text
    data = r.json()
    assert "photorealistic" in data["optimized"]
    assert "cartoon" in data["negative"]  # 写实题材排除卡通


# ── 模型族识别:纯函数,按文件名判方言 ───────────────────────────────────────
@pytest.mark.parametrize(
    "name,family",
    [
        ("ponyDiffusionV6XL.safetensors", "pony"),
        ("flux1-dev.safetensors", "flux"),
        ("qwen_image_fp8.safetensors", "qwen_image"),  # A 期:Qwen-Image 独立次世代族
        ("flux-2-klein-4b.safetensors", "flux2"),
        ("z_image_turbo_bf16.safetensors", "z_image"),
        ("prefectIllustriousXL_v3.safetensors", "sdxl_anime"),
        ("noobaiXL_vpred.safetensors", "sdxl_anime"),
        ("sd_xl_base_1.0.safetensors", "sdxl"),
        ("realisticVision_v6.safetensors", "sd15"),
        ("", "sd15"),
    ],
)
def test_detect_model_family(name, family):
    assert detect_model_family(name) == family


# ── 方言注入:目标模型决定 positive 写法 ─────────────────────────────────────
def test_image_system_no_model_is_base():
    # 不传 model → 退回通用基底(向后兼容,不含方言段)
    assert "目标模型方言" not in _image_system_for("image", None)


def test_image_system_flux_demands_natural_language():
    sys = _image_system_for("image", "flux1-dev.safetensors")
    assert "自然语言" in sys and "danbooru" in sys  # 要求长句、禁标签堆砌


def test_image_system_pony_demands_score_tags():
    sys = _image_system_for("image", "ponyDiffusionV6XL.safetensors")
    assert "score_9" in sys


def test_optimize_passes_model_dialect_to_llm(client_token, monkeypatch):
    # 端到端:所选模型的方言必须进入发给 LLM 的 system 提示
    captured: dict = {}

    async def fake_chat(messages, tools=None, max_tokens=None, temperature=0.4):  # noqa: ANN001
        captured["system"] = messages[0]["content"]
        return {"content": '{"category": "anime", "positive": "1girl, masterpiece", "negative": "lowres"}'}

    monkeypatch.setattr("app.routes.optimize.llm.chat", fake_chat)
    client, token = client_token
    r = client.post(
        "/api/optimize",
        headers={"Authorization": f"Bearer {token}"},
        json={"prompt": "一个女孩", "kind": "image", "model": "ponyDiffusionV6XL.safetensors"},
    )
    assert r.status_code == 200, r.text
    assert "score_9" in captured["system"]  # Pony 方言到达 LLM


def test_video_optimize_returns_negative(client_token, monkeypatch):
    """video kind 与图像类同构:返回 {optimized, negative}。

    LLM 没按 JSON 输出时,整段当正向 + 视频通用兜底负面。
    """
    client, token = client_token
    _patch_llm(monkeypatch, "a serene lake, slow pan, gentle wind")
    r = client.post(
        "/api/optimize",
        headers={"Authorization": f"Bearer {token}"},
        json={"prompt": "湖", "kind": "video"},
    )
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["optimized"]
    assert data["negative"] is not None
    assert "flickering" in data["negative"]  # 视频通用兜底负面


def test_video_optimize_json_negative(client_token, monkeypatch):
    """LLM 按 JSON 输出时,video 的 negative 用 LLM 定制结果。"""
    client, token = client_token
    _patch_llm(monkeypatch, '{"positive": "a serene lake, slow pan", "negative": "blurry, watermark, shaky camera"}')
    r = client.post(
        "/api/optimize",
        headers={"Authorization": f"Bearer {token}"},
        json={"prompt": "湖", "kind": "video"},
    )
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["optimized"] == "a serene lake, slow pan"
    assert data["negative"] == "blurry, watermark, shaky camera"


# ── 风格预设 llm_layer 路由:带预设走预设层,不带保持 L1 ─────────────────────
def test_optimize_with_style_preset_uses_preset_layer(client_token, monkeypatch):
    """带 style 预设(cinematic 预设 llm_layer=L3)时,走 chat_layered(layer=L3)。"""
    captured: dict = {}

    async def fake_chat_layered(messages, layer="L1", max_tokens=None, temperature=0.5):  # noqa: ANN001
        captured["layer"] = layer
        return {"content": '{"positive": "cinematic shot, film grain", "negative": "amateur"}'}

    monkeypatch.setattr("app.routes.optimize.llm.chat_layered", fake_chat_layered)
    client, token = client_token
    r = client.post(
        "/api/optimize",
        headers={"Authorization": f"Bearer {token}"},
        json={"prompt": "电影感画面", "kind": "image", "style": "cinematic"},
    )
    assert r.status_code == 200, r.text
    assert captured["layer"] == "L3"


def test_optimize_without_style_stays_l1(client_token, monkeypatch):
    """不带 style 预设时,chat_layered 层参数保持 L1(现有行为不变)。"""
    captured: dict = {}

    async def fake_chat_layered(messages, layer="L1", max_tokens=None, temperature=0.5):  # noqa: ANN001
        captured["layer"] = layer
        return {"content": '{"positive": "a girl", "negative": "bad anatomy"}'}

    monkeypatch.setattr("app.routes.optimize.llm.chat_layered", fake_chat_layered)
    client, token = client_token
    r = client.post(
        "/api/optimize",
        headers={"Authorization": f"Bearer {token}"},
        json={"prompt": "一个女孩", "kind": "image"},
    )
    assert r.status_code == 200, r.text
    assert captured["layer"] == "L1"


def test_optimize_unknown_style_falls_back_l1(client_token, monkeypatch):
    """style 预设不存在时,自动回落 L1。"""
    captured: dict = {}

    async def fake_chat_layered(messages, layer="L1", max_tokens=None, temperature=0.5):  # noqa: ANN001
        captured["layer"] = layer
        return {"content": "a serene lake, slow pan"}

    monkeypatch.setattr("app.routes.optimize.llm.chat_layered", fake_chat_layered)
    client, token = client_token
    r = client.post(
        "/api/optimize",
        headers={"Authorization": f"Bearer {token}"},
        json={"prompt": "湖", "kind": "video", "style": "no_such_preset"},
    )
    assert r.status_code == 200, r.text
    assert captured["layer"] == "L1"


# ── 自定义风格 style_hint:最高优先级注入系统提示 ─────────────────────────
def test_optimize_style_hint_reaches_llm(client_token, monkeypatch):
    """style_hint 必须进入发给 LLM 的 system 提示,且带最高优先级措辞。"""
    captured: dict = {}

    async def fake_chat_layered(messages, layer="L1", max_tokens=None, temperature=0.5):  # noqa: ANN001
        captured["system"] = messages[0]["content"]
        return {"content": '{"positive": "cyberpunk girl, neon lights", "negative": "daylight"}'}

    monkeypatch.setattr("app.routes.optimize.llm.chat_layered", fake_chat_layered)
    client, token = client_token
    r = client.post(
        "/api/optimize",
        headers={"Authorization": f"Bearer {token}"},
        json={"prompt": "一个女孩", "kind": "image", "style_hint": "赛博朋克霓虹夜景"},
    )
    assert r.status_code == 200, r.text
    assert "赛博朋克霓虹夜景" in captured["system"]
    assert "最高优先级" in captured["system"]


def test_optimize_style_hint_precedes_agent_prefix(client_token, monkeypatch):
    """style_hint 与智能体共存时:风格块在人格前缀之前(优先级最高)。"""
    from app.models import Agent

    captured: dict = {}

    async def fake_chat_layered(messages, layer="L1", max_tokens=None, temperature=0.5):  # noqa: ANN001
        captured["system"] = messages[0]["content"]
        return {"content": '{"positive": "ink wash girl", "negative": "blurry"}'}

    monkeypatch.setattr("app.routes.optimize.llm.chat_layered", fake_chat_layered)
    client, token = client_token

    # 在测试库里塞一个适用 image 的智能体
    session_gen = app.dependency_overrides[get_session]()
    session = next(session_gen)
    session.add(
        Agent(
            id="ag_style_test",
            name="测试画师",
            icon="brush",
            applies_to="image",
            system_prompt="你是一位水彩插画师。",
            sort=1,
        )
    )
    session.commit()
    session.close()

    r = client.post(
        "/api/optimize",
        headers={"Authorization": f"Bearer {token}"},
        json={
            "prompt": "一个女孩",
            "kind": "image",
            "agent_id": "ag_style_test",
            "style_hint": "水墨风",
        },
    )
    assert r.status_code == 200, r.text
    sys = captured["system"]
    assert "水墨风" in sys and "水彩插画师" in sys
    assert sys.index("水墨风") < sys.index("水彩插画师")  # 风格块优先级最高,排最前


def test_optimize_without_style_hint_unchanged(client_token, monkeypatch):
    """不传 style_hint 时系统提示不含风格块(向后兼容)。"""
    captured: dict = {}

    async def fake_chat_layered(messages, layer="L1", max_tokens=None, temperature=0.5):  # noqa: ANN001
        captured["system"] = messages[0]["content"]
        return {"content": '{"positive": "a girl", "negative": "bad anatomy"}'}

    monkeypatch.setattr("app.routes.optimize.llm.chat_layered", fake_chat_layered)
    client, token = client_token
    r = client.post(
        "/api/optimize",
        headers={"Authorization": f"Bearer {token}"},
        json={"prompt": "一个女孩", "kind": "image"},
    )
    assert r.status_code == 200, r.text
    assert "最高优先级" not in captured["system"]


def test_train_kind_uses_trigger_word_system(client_token, monkeypatch):
    """train kind 走专属触发词系统提示,不再落 video 兜底。"""
    captured: dict = {}

    async def fake_chat_layered(messages, layer="L1", max_tokens=None, temperature=0.5):  # noqa: ANN001
        captured["system"] = messages[0]["content"]
        return {"content": "zhenyu_girl"}

    monkeypatch.setattr("app.routes.optimize.llm.chat_layered", fake_chat_layered)
    client, token = client_token
    r = client.post(
        "/api/optimize",
        headers={"Authorization": f"Bearer {token}"},
        json={"prompt": "我的女孩模型", "kind": "train"},
    )
    assert r.status_code == 200, r.text
    assert "触发词" in captured["system"]
    assert r.json()["optimized"] == "zhenyu_girl"
