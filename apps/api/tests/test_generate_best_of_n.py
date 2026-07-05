"""Best-of-N 生成端点测试。"""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

import app.routes.generate as generate
from app.models import User
from app.routes.generate import BestOfNRequest, generate_best_of_n
from app.scoring import ScoreResult, Scorer, ScoringService


class _MockScorer(Scorer):
    name = "mock"

    async def score(self, image_url: str, prompt: str | None = None) -> ScoreResult:
        total = 0.9 if "pid-2" in image_url else 0.5
        return ScoreResult(total=total, breakdown={"mock": total})


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
    return User(id="u-bon", email="u", hashed_password="x", tenant_id="t")


@pytest.fixture
def fake_pool():
    pool = MagicMock()
    client = AsyncMock()
    client.base_url = "http://worker"
    client.queue_prompt = AsyncMock(side_effect=["pid-1", "pid-2"])
    pool.pick = AsyncMock(return_value=client)
    return pool


@pytest.fixture
def fake_scoring():
    return ScoringService(_MockScorer())


async def test_generate_best_of_n_returns_best(
    user, db, fake_pool, fake_scoring, monkeypatch
):
    """并发提交 2 个候选，评分后返回最优图与完整元信息。"""
    from app.ratelimit import _hits

    _hits.clear()
    monkeypatch.setattr(generate, "spawn_tracker", lambda client, prompt_id: None)

    async def _fake_wait(session, prompt_ids, timeout, poll_interval):
        return {
            pid: [f"/api/images?filename={pid}.png&worker=http://worker"]
            for pid in prompt_ids
        }

    monkeypatch.setattr(generate, "wait_for_jobs", _fake_wait)

    req = BestOfNRequest(
        positive="a cat", n=2, seed=42, ckpt_name="test_model.safetensors"
    )
    resp = await generate_best_of_n(req, fake_pool, user, Session(db), fake_scoring)

    assert resp.best == "/api/images?filename=pid-2.png&worker=http://worker"
    assert len(resp.scores) == 2
    assert resp.ranked[0] == resp.best
    assert len(resp.prompt_ids) == 2
    assert len(resp.seeds) == 2
    assert resp.seeds == [42, 43]
    fake_pool.pick.assert_awaited()
