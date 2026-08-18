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


# ── 视频引擎方言 + Wan NSFW 触发词确定性注入(2026-08-17 参考 DashBox 提示词 RFC)──
# 触发词是确定性知识:system 注入 + 后处理补齐双保险,不靠 LLM 记忆;SFW 上下文静默忽略。

_WAN_LORAS = ["NSFW-22-H-e8.safetensors", "DR34ML4Y_I2V_14B_LOW_V2.safetensors"]
_NSFW_H = {"X-NSFW": "1"}


def _patch_layered(monkeypatch, content: str, captured: dict) -> None:
    async def fake_chat_layered(messages, layer="L1", max_tokens=None, temperature=0.5):  # noqa: ANN001
        captured["system"] = messages[0]["content"]
        return {"content": content}

    monkeypatch.setattr("app.routes.optimize.llm.chat_layered", fake_chat_layered)


def test_video_wan_nsfw_dialect_and_trigger_injection(client_token, monkeypatch):
    """wan-nsfw-i2v 引擎 + R18 上下文:system 含 Wan 方言与触发词清单;LLM 写全则原样返回。"""
    captured: dict = {}
    _patch_layered(monkeypatch, '{"positive": "nsfwsks, bl0wj0b, she kneels, side view", "negative": "blur"}', captured)
    client, token = client_token
    r = client.post(
        "/api/optimize",
        headers={"Authorization": f"Bearer {token}", **_NSFW_H},
        json={"prompt": "跪姿口交", "kind": "video", "engine": "wan-nsfw-i2v", "loras": _WAN_LORAS},
    )
    assert r.status_code == 200, r.text
    assert "Wan2.2" in captured["system"]  # 引擎方言,非通用视频模板
    assert "nsfwsks" in captured["system"]  # 必选触发词注入 system
    assert "bl0wj0b" in captured["system"] or "m15510n4ry" in captured["system"]  # 候选组透出
    assert r.json()["optimized"] == "nsfwsks, bl0wj0b, she kneels, side view"  # 写全不补


def test_video_wan_trigger_backfill_when_llm_omits(client_token, monkeypatch):
    """LLM 漏写触发词:必选逐个补齐,pick_one 组全缺补预选(确定性兜底,不靠 LLM 记忆)。"""
    captured: dict = {}
    _patch_layered(monkeypatch, '{"positive": "she kneels and leans forward", "negative": "blur"}', captured)
    client, token = client_token
    r = client.post(
        "/api/optimize",
        headers={"Authorization": f"Bearer {token}", **_NSFW_H},
        json={"prompt": "kneeling blowjob", "kind": "video", "engine": "wan-nsfw-i2v", "loras": _WAN_LORAS},
    )
    assert r.status_code == 200, r.text
    out = r.json()["optimized"]
    assert "nsfwsks" in out  # 必选补齐
    # 种子含 blowjob → 预选 bl0wj0b 排组首;LLM 没写任何组内词 → 补 bl0wj0b
    assert out.startswith("nsfwsks, bl0wj0b, ")


def test_video_wan_triggers_ignored_in_sfw_context(client_token, monkeypatch):
    """SFW 上下文(无 X-NSFW):注册表 LoRA 触发词不注入 system、后处理不补(防主站诱导 R18 词)。"""
    captured: dict = {}
    _patch_layered(monkeypatch, '{"positive": "she kneels", "negative": "blur"}', captured)
    client, token = client_token
    r = client.post(
        "/api/optimize",
        headers={"Authorization": f"Bearer {token}"},
        json={"prompt": "kneeling blowjob", "kind": "video", "engine": "wan-nsfw-i2v", "loras": _WAN_LORAS},
    )
    assert r.status_code == 200, r.text
    assert "nsfwsks" not in captured["system"]
    assert r.json()["optimized"] == "she kneels"  # 原样,不补触发词


def test_video_wan_trigger_backfill_on_parse_failure(client_token, monkeypatch):
    """LLM 输出坏 JSON 走整段兜底时,触发词同样确定性补齐。"""
    _patch_layered(monkeypatch, "not a json at all", {})
    client, token = client_token
    r = client.post(
        "/api/optimize",
        headers={"Authorization": f"Bearer {token}", **_NSFW_H},
        json={"prompt": "kneeling blowjob", "kind": "video", "engine": "wan-nsfw-i2v", "loras": _WAN_LORAS},
    )
    assert r.status_code == 200, r.text
    assert r.json()["optimized"].startswith("nsfwsks, bl0wj0b, not a json at all")


def test_video_engine_dialect_h3(client_token, monkeypatch):
    """h3 系引擎(h3-nsfw-i2v 前缀匹配):全正向方言(负向不可靠实证),触发词逻辑不介入。"""
    captured: dict = {}
    _patch_layered(monkeypatch, '{"positive": "a cat walks, slow motion", "negative": "blur"}', captured)
    client, token = client_token
    r = client.post(
        "/api/optimize",
        headers={"Authorization": f"Bearer {token}"},
        json={"prompt": "一只猫走过", "kind": "video", "engine": "h3-nsfw-i2v"},
    )
    assert r.status_code == 200, r.text
    assert "正向指令" in captured["system"]  # H3 方言
    assert r.json()["optimized"] == "a cat walks, slow motion"


def test_video_engine_dialect_ltx25_audio(client_token, monkeypatch):
    """ltx25 系引擎:音画同出方言(positive 可含声音描述)。"""
    captured: dict = {}
    _patch_layered(monkeypatch, '{"positive": "waves, gentle surf sound", "negative": "blur"}', captured)
    client, token = client_token
    r = client.post(
        "/api/optimize",
        headers={"Authorization": f"Bearer {token}"},
        json={"prompt": "海浪", "kind": "video", "engine": "ltx25-t2v"},
    )
    assert r.status_code == 200, r.text
    assert "音画同出" in captured["system"]


def test_pick_trigger_words_modes():
    """pick_trigger_words 纯函数:all 全选 / pick_one 场景命中与兜底 / 未注册静默跳过 / 保序去重。"""
    from app.workflows.wan_i2v import pick_trigger_words

    assert pick_trigger_words(["NSFW-22-H-e8.safetensors"]) == ["nsfwsks"]  # all
    # pick_one:场景关键词命中
    assert pick_trigger_words(["DR34ML4Y_I2V_14B_LOW_V2.safetensors"], "a blowjob scene") == ["bl0wj0b"]
    assert pick_trigger_words(["DR34ML4Y_I2V_14B_LOW_V2.safetensors"], "doggy style") == ["d0gg1e"]
    # pick_one 无命中取第一个
    assert pick_trigger_words(["DR34ML4Y_I2V_14B_LOW_V2.safetensors"], "") == ["m15510n4ry"]
    # 组合:all + pick_one 保序,未注册静默跳过
    out = pick_trigger_words(
        ["NSFW-22-H-e8.safetensors", "unknown.safetensors", "DR34ML4Y_I2V_14B_LOW_V2.safetensors"],
        "doggy style",
    )
    assert out == ["nsfwsks", "d0gg1e"]


# ── 三层联动(2026-08-18):风格预设 → 优化提示词 ──────────────────────────

def _patch_layered_capture_layer(monkeypatch, content: str, captured: dict) -> None:
    """同 _patch_layered,额外捕获 layer 参数(断言预设 llm_layer 路由)。"""
    async def fake_chat_layered(messages, layer="L1", max_tokens=None, temperature=0.5):  # noqa: ANN001
        captured["system"] = messages[0]["content"]
        captured["layer"] = layer
        return {"content": content}

    monkeypatch.setattr("app.routes.optimize.llm.chat_layered", fake_chat_layered)


def test_style_context_injected_into_system(client_token, monkeypatch):
    """预设→优化:选 cinematic 预设,system 注入【风格预设上下文】+ prompt_hint 要素;
    realistic 预设(带推荐负向)注入 negative 参考。"""
    captured: dict = {}
    _patch_layered_capture_layer(
        monkeypatch,
        '{"positive": "wide cinematic shot, neon city in rain", "negative": "blurry"}',
        captured,
    )
    client, token = client_token
    r = client.post(
        "/api/optimize",
        headers={"Authorization": f"Bearer {token}"},
        json={"prompt": "雨夜城市", "kind": "image", "style": "cinematic"},
    )
    assert r.status_code == 200, r.text
    sysmsg = captured["system"]
    assert "【风格预设上下文】" in sysmsg
    assert "电影感" in sysmsg  # 预设 label
    assert "cinematic lighting" in sysmsg  # prompt_hint 要素
    assert "film grain" in sysmsg

    # realistic 预设带推荐负向 → negative 参考注入(cinematic 是 CFG1 族,负向为空合法)
    captured2: dict = {}
    _patch_layered_capture_layer(
        monkeypatch, '{"positive": "realistic portrait photo", "negative": "ugly"}', captured2
    )
    r2 = client.post(
        "/api/optimize",
        headers={"Authorization": f"Bearer {token}"},
        json={"prompt": "写实人像", "kind": "image", "style": "realistic"},
    )
    assert r2.status_code == 200, r2.text
    assert "negative 参考" in captured2["system"]
    assert "bad anatomy" in captured2["system"]


def test_style_preset_ckpt_supplies_dialect_when_no_model(client_token, monkeypatch):
    """预设底模补位方言:style=fantasy(Pony)且未显式传 model → system 含 pony 族方言(booru 标签);
    用户显式传 model 时 model 优先(预设方言让位)。"""
    captured: dict = {}
    _patch_layered_capture_layer(
        monkeypatch, '{"positive": "1girl, fantasy castle", "negative": "worst quality"}', captured
    )
    client, token = client_token
    r = client.post(
        "/api/optimize",
        headers={"Authorization": f"Bearer {token}"},
        json={"prompt": "奇幻城堡少女", "kind": "image", "style": "fantasy"},
    )
    assert r.status_code == 200, r.text
    assert "【目标模型方言" in captured["system"]  # pony 底模触发了方言块
    assert "booru" in captured["system"].lower()

    # 显式 model 优先于预设底模
    captured2: dict = {}
    _patch_layered_capture_layer(
        monkeypatch, '{"positive": "photo of a man", "negative": "ugly"}', captured2
    )
    r2 = client.post(
        "/api/optimize",
        headers={"Authorization": f"Bearer {token}"},
        json={"prompt": "奇幻城堡少女", "kind": "image", "style": "fantasy",
              "model": "flux2_dev_fp8mixed.safetensors"},
    )
    assert r2.status_code == 200, r2.text
    assert "FLUX" in captured2["system"]
    # pony 方言特征(质量分标签)让位给 FLUX 方言(FLUX 块含「禁止 danbooru」字样,故断言 pony 特征词)
    assert "score_9" not in captured2["system"]


def test_style_context_compose_order(client_token, monkeypatch):
    """三层叠加顺序:style_hint(最高) → 风格上下文 → kind 基底;无 style 不注入。
    (agent 人格拼接顺序已由 test_skill_market.test_optimize_shot_with_skill 覆盖)"""
    captured: dict = {}
    _patch_layered_capture_layer(
        monkeypatch, '{"positive": "cyberpunk street market", "negative": "ugly"}', captured
    )
    client, token = client_token
    r = client.post(
        "/api/optimize",
        headers={"Authorization": f"Bearer {token}"},
        json={"prompt": "夜市", "kind": "image", "style": "cinematic",
              "style_hint": "赛博朋克霓虹"},
    )
    assert r.status_code == 200, r.text
    sysmsg = captured["system"]
    i_hint = sysmsg.index("【用户指定风格")
    i_style = sysmsg.index("【风格预设上下文】")
    i_base = sysmsg.index("提示词工程师") if "提示词工程师" in sysmsg else len(sysmsg) - 50
    assert i_hint < i_style  # 用户手打风格最高优先
    assert i_style < i_base  # 风格上下文在 kind 基底之前

    # 无 style:不注入风格上下文(向后兼容)
    captured2: dict = {}
    _patch_layered_capture_layer(monkeypatch, '{"positive": "a cat", "negative": "ugly"}', captured2)
    r2 = client.post(
        "/api/optimize",
        headers={"Authorization": f"Bearer {token}"},
        json={"prompt": "一只猫", "kind": "image"},
    )
    assert r2.status_code == 200, r2.text
    assert "【风格预设上下文】" not in captured2["system"]


def test_style_llm_layer_routing(client_token, monkeypatch):
    """预设 llm_layer 路由:cinematic 预设(L3)→ chat_layered 收 layer='L3';无预设回 L1。"""
    captured: dict = {}
    _patch_layered_capture_layer(
        monkeypatch, '{"positive": "moody night scene", "negative": "blurry"}', captured
    )
    client, token = client_token
    r = client.post(
        "/api/optimize",
        headers={"Authorization": f"Bearer {token}"},
        json={"prompt": "夜景", "kind": "image", "style": "cinematic"},
    )
    assert r.status_code == 200, r.text
    assert captured["layer"] == "L3"
