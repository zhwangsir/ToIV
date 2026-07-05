import importlib.util
import sys
from unittest.mock import MagicMock

import pytest

from app.models import User
from app.routes.score import BestOfRequest, ScoreRequest, score_best, score_health, score_image
from app.scoring import (
    CompositeScorer,
    ImageRewardScorer,
    ScoreResult,
    Scorer,
    ScorerUnavailable,
    ScoringService,
)


class MockScorer(Scorer):
    name = "mock"

    async def score(self, image_url: str, prompt: str | None = None) -> ScoreResult:
        return ScoreResult(total=0.75, breakdown={"aesthetic": 0.75}, critique="looks good")


class StaticScorer(Scorer):
    name = "static"

    def __init__(self, total: float):
        self._total = total

    async def score(self, image_url: str, prompt: str | None = None) -> ScoreResult:
        return ScoreResult(total=self._total, breakdown={"static": self._total})


class VariableScorer(Scorer):
    name = "variable"

    async def score(self, image_url: str, prompt: str | None = None) -> ScoreResult:
        total = 0.9 if image_url.endswith("b.png") else 0.3
        return ScoreResult(total=total, breakdown={"variable": total})


@pytest.fixture
def user():
    return User(id="u-1", email="u", hashed_password="x", tenant_id="t-1")


async def test_composite_scorer_weights_sub_scores():
    composite = CompositeScorer(scorers=[(MockScorer(), 0.6), (StaticScorer(0.5), 0.4)])
    result = await composite.score("http://example.com/a.png", "prompt")
    assert result.total == pytest.approx(0.65)
    assert result.breakdown["mock:aesthetic"] == 0.75
    assert result.breakdown["static:static"] == 0.5
    assert result.critique == "mock: looks good"


async def test_scoring_service_best_picks_highest_score():
    service = ScoringService(CompositeScorer([(VariableScorer(), 1.0)]))
    result = await service.best(
        ["http://example.com/a.png", "http://example.com/b.png"], prompt="prompt"
    )
    assert result.best == "http://example.com/b.png"
    assert len(result.scores) == 2


async def test_scoring_service_unavailable_when_no_scorer():
    service = ScoringService(CompositeScorer([]))
    with pytest.raises(ScorerUnavailable):
        await service.score("http://example.com/a.png", "prompt")


async def test_image_reward_scorer_unavailable_without_package(monkeypatch):
    monkeypatch.setattr(
        importlib.util,
        "find_spec",
        lambda name: None if name == "image_reward" else object(),
    )
    scorer = ImageRewardScorer()
    assert not scorer.available
    with pytest.raises(ScorerUnavailable):
        await scorer.score("http://example.com/a.png", "prompt")


async def test_image_reward_scorer_normalizes_score(monkeypatch):
    import importlib.util
    monkeypatch.setattr(
        importlib.util,
        "find_spec",
        lambda name: object() if name == "image_reward" else None,
    )
    mock_ir = MagicMock()
    mock_ir.load_reward_model.return_value = "model"
    mock_ir.get_score.return_value = 2.0
    monkeypatch.setitem(sys.modules, "image_reward", mock_ir)

    scorer = ImageRewardScorer()
    async def _fake_download(url: str) -> str:
        return "pil_image"
    monkeypatch.setattr(scorer, "_download_image", _fake_download)
    assert scorer.available
    result = await scorer.score("http://example.com/a.png", "prompt")
    assert 0 < result.total < 1
    assert "aesthetic" in result.breakdown
    mock_ir.load_reward_model.assert_called_once()
    mock_ir.get_score.assert_called_once_with("model", "pil_image", "prompt")


async def test_score_image_endpoint(user):
    service = ScoringService(MockScorer())
    req = ScoreRequest(image_url="http://example.com/a.png", prompt="cat")
    response = await score_image(req, service, user)
    assert response.total == 0.75


async def test_score_best_endpoint(user):
    service = ScoringService(CompositeScorer([(VariableScorer(), 1.0)]))
    req = BestOfRequest(
        images=["http://example.com/a.png", "http://example.com/b.png"],
        prompt="cat",
    )
    response = await score_best(req, service, user)
    assert response.best == "http://example.com/b.png"


async def test_score_health_endpoint(user):
    service = ScoringService(MockScorer())
    response = await score_health(service, user)
    assert response["available"] is True
