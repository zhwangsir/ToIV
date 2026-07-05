"""评分 / Best-of-N 相关端点。"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.deps import get_current_user
from app.models import User
from app.scoring import BestOfResult, ScorerUnavailable, ScoringService, get_scoring_service

router = APIRouter()


class ScoreRequest(BaseModel):
    image_url: str = Field(min_length=1)
    prompt: str | None = Field(default=None)


class BestOfRequest(BaseModel):
    images: list[str] = Field(min_length=2)
    prompt: str | None = Field(default=None)
    return_all: bool = Field(default=False)


class ScoreResponse(BaseModel):
    total: float
    breakdown: dict[str, float]
    critique: str | None = None


@router.post("/score", response_model=ScoreResponse)
async def score_image(
    req: ScoreRequest,
    service: ScoringService = Depends(get_scoring_service),
    user: User = Depends(get_current_user),
):
    try:
        return await service.score(req.image_url, req.prompt)
    except ScorerUnavailable as e:
        raise HTTPException(status_code=503, detail=str(e)) from e


@router.post("/score/best", response_model=BestOfResult)
async def score_best(
    req: BestOfRequest,
    service: ScoringService = Depends(get_scoring_service),
    user: User = Depends(get_current_user),
):
    try:
        return await service.best(req.images, req.prompt)
    except ScorerUnavailable as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e


@router.get("/score/health")
async def score_health(
    service: ScoringService = Depends(get_scoring_service),
    user: User = Depends(get_current_user),
):
    return service.health()
