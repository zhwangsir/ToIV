import importlib.util
import sys
from unittest.mock import MagicMock

import pytest
from fastapi import HTTPException

from app.models import User
from app.routes.score import BestOfRequest, ScoreRequest, score_best, score_health, score_image
from app.scoring import (
    CompositeScorer,
    ImageRewardScorer,
    ScoreResult,
    Scorer,
    ScorerUnavailable,
    ScoringService,
    VideoScorer,
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


class _Settings:
    """score 路由 SSRF 白名单(复用 audio_orchestrate._allowed_source)的配置替身。"""

    api_base_url = "http://127.0.0.1:8090"
    worker_urls = ["http://worker1:8188"]


@pytest.fixture
def _score_settings(monkeypatch):
    monkeypatch.setattr(
        "app.routes.audio_orchestrate.get_settings", lambda: _Settings()
    )


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


async def test_score_image_endpoint(user, _score_settings):
    service = ScoringService(MockScorer())
    req = ScoreRequest(image_url="/api/images/a.png", prompt="cat")
    response = await score_image(req, service, user)
    assert response.total == 0.75


async def test_score_best_endpoint(user, _score_settings):
    service = ScoringService(CompositeScorer([(VariableScorer(), 1.0)]))
    req = BestOfRequest(
        images=["/api/images/a.png", "/api/images/b.png"],
        prompt="cat",
    )
    response = await score_best(req, service, user)
    # 相对路径经 _resolve_url 解析为本 API 绝对 URL 后再下发评分
    assert response.best == "http://127.0.0.1:8090/api/images/b.png"


# ── SSRF 白名单(T0 安全红线):用户直控 image_url 不得打到内网 ──────────


async def test_score_rejects_intranet_urls(user, _score_settings):
    """内网服务地址(trainer :9100 / Redis :6379)不在白名单 → 400,不进 scoring 层。"""
    service = ScoringService(MockScorer())
    for bad in ("http://192.168.71.127:9100/x", "http://127.0.0.1:6379/"):
        with pytest.raises(HTTPException) as ei:
            await score_image(ScoreRequest(image_url=bad), service, user)
        assert ei.value.status_code == 400
        assert "白名单" in ei.value.detail


async def test_score_best_rejects_intranet_url(user, _score_settings):
    service = ScoringService(CompositeScorer([(MockScorer(), 1.0)]))
    req = BestOfRequest(
        images=["/api/images/a.png", "http://169.254.169.254/latest/meta-data"],
    )
    with pytest.raises(HTTPException) as ei:
        await score_best(req, service, user)
    assert ei.value.status_code == 400


async def test_score_allows_worker_and_api_loopback(user, _score_settings):
    """白名单 worker host 与本机 API 端口(同源绝对 URL)放行;外网任址拒绝。"""
    service = ScoringService(MockScorer())
    r = await score_image(
        ScoreRequest(image_url="http://worker1:8188/view?filename=a.png"), service, user
    )
    assert r.total == 0.75
    r2 = await score_image(
        ScoreRequest(image_url="http://127.0.0.1:8090/api/images/a.png"), service, user
    )
    assert r2.total == 0.75
    with pytest.raises(HTTPException) as ei:
        await score_image(ScoreRequest(image_url="http://evil.example.com/a.png"), service, user)
    assert ei.value.status_code == 400


async def test_score_health_endpoint(user):
    service = ScoringService(MockScorer())
    response = await score_health(service, user)
    assert response["available"] is True


# ── VideoScorer 默认端点(P1-23:不再写死已停用 Nemotron :8000) ──────────


def test_video_scorer_default_url_reads_settings(monkeypatch):
    """vlm_url 缺省时读 settings.vlm_server_url(生产由 .env 指向当前可用 VLM)。"""
    from types import SimpleNamespace

    monkeypatch.setattr(
        "app.scoring.get_settings",
        lambda: SimpleNamespace(vlm_server_url="http://studio04:9303/"),
    )
    scorer = VideoScorer()
    assert scorer.vlm_url == "http://studio04:9303"  # 尾斜杠已去
    assert scorer.endpoint == "http://studio04:9303/v1/chat/completions"


def test_video_scorer_explicit_url_overrides_settings(monkeypatch):
    """显式传 vlm_url 时不读配置(jobs.py 就是显式传 settings.vlm_server_url)。"""
    from types import SimpleNamespace

    monkeypatch.setattr(
        "app.scoring.get_settings",
        lambda: SimpleNamespace(vlm_server_url="http://should-not-use:1"),
    )
    scorer = VideoScorer("http://explicit:8000")
    assert scorer.vlm_url == "http://explicit:8000"
