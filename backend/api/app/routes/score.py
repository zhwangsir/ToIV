"""评分 / Best-of-N 相关端点。"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.deps import get_current_user
from app.models import User
from app.routes.audio_orchestrate import _allowed_source, _resolve_url
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


def _checked_image_url(url: str) -> str:
    """image_url SSRF 白名单(与 audio_orchestrate._allowed_source 同一语义):
    相对路径(本 API)/白名单 worker host/本机 API 端口放行并解析为绝对 URL;
    白名单外(任意内网/外网地址)一律 400, scoring 层不得直取用户 URL。"""
    if not _allowed_source(url):
        raise HTTPException(status_code=400, detail="图像来源不在白名单内")
    return _resolve_url(url)


@router.post("/score", response_model=ScoreResponse)
async def score_image(
    req: ScoreRequest,
    service: ScoringService = Depends(get_scoring_service),
    user: User = Depends(get_current_user),
):
    try:
        return await service.score(_checked_image_url(req.image_url), req.prompt)
    except ScorerUnavailable as e:
        raise HTTPException(status_code=503, detail=str(e)) from e


@router.post("/score/best", response_model=BestOfResult)
async def score_best(
    req: BestOfRequest,
    service: ScoringService = Depends(get_scoring_service),
    user: User = Depends(get_current_user),
):
    try:
        return await service.best([_checked_image_url(u) for u in req.images], req.prompt)
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
