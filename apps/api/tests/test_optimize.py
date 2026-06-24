"""内容感知 AI 润色(/api/optimize)测试。

不依赖真实 LLM:用 monkeypatch 替换 app.agent.llm.chat,断言:
- 图像类返回 {optimized, negative} 且 negative 随题材而变(content-aware);
- LLM 没给 negative 时,启发式按题材兜底(人像→解剖词,动漫→排除写实…);
- 解析失败时整段当正向 + 启发式负面;
- 其它类(video/audio/threed)返回单段;
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
)
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
    async def fake_chat(messages, tools=None):  # noqa: ANN001
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


def test_video_optimize_single_segment(client_token, monkeypatch):
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
    assert data["negative"] is None
