"""图像/产物评分服务 —— 为 Best-of-N 与质量评估提供可插拔打分器。"""
from __future__ import annotations

import asyncio
import importlib.util
import io
import math
from abc import ABC, abstractmethod
from typing import Any

import httpx
from pydantic import BaseModel, Field


class ScoreResult(BaseModel):
    total: float = Field(..., ge=0.0, le=1.0)
    breakdown: dict[str, float] = Field(default_factory=dict)
    critique: str | None = None


class BestOfResult(BaseModel):
    best: str
    scores: list[dict]
    ranked: list[str]


class ScorerUnavailable(RuntimeError):
    """打分器未就绪或缺少依赖时抛出。"""


class Scorer(ABC):
    name: str

    @abstractmethod
    async def score(self, image_url: str, prompt: str | None) -> ScoreResult:
        ...


class CompositeScorer(Scorer):
    """按权重聚合多个打分器。权重不必为 1;结果会 clamp 到 [0,1]。"""

    name = "composite"

    def __init__(self, scorers: list[tuple[Scorer, float]]):
        self.scorers = scorers

    async def score(self, image_url: str, prompt: str | None) -> ScoreResult:
        if not self.scorers:
            raise ScorerUnavailable("没有可用的打分器")
        breakdown: dict[str, float] = {}
        total = 0.0
        critiques: list[str] = []
        for scorer, weight in self.scorers:
            res = await scorer.score(image_url, prompt)
            total += res.total * weight
            for key, value in res.breakdown.items():
                breakdown[f"{scorer.name}:{key}"] = value
            if res.critique:
                critiques.append(f"{scorer.name}: {res.critique}")
        return ScoreResult(
            total=max(0.0, min(1.0, total)),
            breakdown=breakdown,
            critique="\n".join(critiques) if critiques else None,
        )


class ImageRewardScorer(Scorer):
    """ImageReward 美学/图文对齐打分器。依赖未安装时优雅不可用。"""

    name = "image_reward"

    def __init__(self) -> None:
        self._available = self._check_available()
        self._model: Any | None = None
        if self._available:
            self._model = self._load_model()

    @property
    def available(self) -> bool:
        return self._available

    def _check_available(self) -> bool:
        return importlib.util.find_spec("image_reward") is not None

    def _load_model(self) -> Any:
        import image_reward
        return image_reward.load_reward_model()

    async def _download_image(self, url: str) -> Any:
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                resp = await client.get(url)
                resp.raise_for_status()
        except httpx.HTTPError as e:
            raise ScorerUnavailable(f"下载图片失败: {e}") from e
        try:
            from PIL import Image
            return Image.open(io.BytesIO(resp.content)).convert("RGB")
        except Exception as e:
            raise ScorerUnavailable(f"解析图片失败: {e}") from e

    async def score(self, image_url: str, prompt: str | None) -> ScoreResult:
        if not self._available or self._model is None:
            raise ScorerUnavailable("ImageReward 未安装")
        image = await self._download_image(image_url)
        raw = await asyncio.to_thread(
            self._get_score, image, prompt or ""
        )
        # ImageReward 原始分范围未知，用 sigmoid 归一到 [0,1]。
        normalized = 1.0 / (1.0 + math.exp(-float(raw)))
        return ScoreResult(
            total=normalized,
            breakdown={"aesthetic": normalized, "align": 0.0},
            critique=None,
        )

    def _get_score(self, image: Any, prompt: str) -> float:
        import image_reward
        return image_reward.get_score(self._model, image, prompt)


class ScoringService:
    def __init__(self, scorer: Scorer):
        self.scorer = scorer

    async def score(self, image_url: str, prompt: str | None) -> ScoreResult:
        return await self.scorer.score(image_url, prompt)

    async def best(self, candidates: list[str], prompt: str | None) -> BestOfResult:
        if len(candidates) < 2:
            raise ValueError("Best-of-N 至少需要 2 个候选")
        results = await asyncio.gather(
            *(self.scorer.score(url, prompt) for url in candidates)
        )
        ranked = sorted(
            range(len(candidates)), key=lambda i: results[i].total, reverse=True
        )
        best_idx = ranked[0]
        return BestOfResult(
            best=candidates[best_idx],
            scores=[
                {
                    "image_url": candidates[i],
                    "score": r.total,
                    "breakdown": r.breakdown,
                }
                for i, r in enumerate(results)
            ],
            ranked=[candidates[i] for i in ranked],
        )

    def health(self) -> dict:
        available = not isinstance(self.scorer, CompositeScorer) or bool(self.scorer.scorers)
        return {"available": available}


def get_default_scorer() -> Scorer:
    scorers: list[tuple[Scorer, float]] = []
    ir = ImageRewardScorer()
    if ir.available:
        scorers.append((ir, 1.0))
    return CompositeScorer(scorers)


_scoring_service: ScoringService | None = None


def get_scoring_service() -> ScoringService:
    global _scoring_service
    if _scoring_service is None:
        _scoring_service = ScoringService(get_default_scorer())
    return _scoring_service
