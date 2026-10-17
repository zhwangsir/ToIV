"""FU2/FU5 成片工具 API 面(video-use MIT 并码服务的对外契约;FU5 manifest 同面)。

词级转写→Packed Transcript、EDL 校验/剪点计划、成片 QA 自检、视觉下钻 PNG、
管线 manifest 校验。视频路径类操作限定 drama 输出根内(防任意文件读取)。
"""
from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field

from app.deps import get_current_user
from app.models import User

router = APIRouter()


def _safe_media_path(video_path: str) -> Path:
    """仅允许 drama 输出根内的媒体文件(realpath 防穿越)。"""
    from app.storage import drama_output_root

    root = drama_output_root().resolve()
    p = Path(video_path).expanduser().resolve()
    if not p.is_relative_to(root):
        raise HTTPException(status_code=403, detail="视频路径不在允许的媒体目录内")
    if not p.is_file():
        raise HTTPException(status_code=404, detail="视频文件不存在")
    return p


class PackTranscriptRequest(BaseModel):
    payload: list | dict
    silence_threshold: float | None = Field(default=None, ge=0.1, le=10)
    max_segment_seconds: float | None = Field(default=None, ge=5, le=300)


class EdlValidateRequest(BaseModel):
    edl: dict
    source_durations: dict[str, float] | None = None
    fps: float | None = Field(default=None, gt=0)
    words_by_source: dict[str, list[dict]] | None = None


class CutPlanRequest(BaseModel):
    words: list[dict]
    min_silence: float = Field(default=0.4, ge=0.05, le=5)
    pad_ms: float = Field(default=120, ge=0)  # clamp_pad 夹 30-200ms,不在此拒


class QaReviewRequest(BaseModel):
    video_path: str = Field(min_length=1, max_length=1000)
    cut_points: list[float] = Field(min_length=1, max_length=200)
    fps: float = Field(default=8.0, gt=0, le=30)
    window: float = Field(default=1.5, gt=0, le=5)


class TimelinePngRequest(BaseModel):
    video_path: str = Field(min_length=1, max_length=1000)
    words: list[dict] = Field(default_factory=list, max_length=100000)
    ambiguity_points: list[float] = Field(default_factory=list, max_length=50)
    start: float | None = None
    end: float | None = None


class ManifestValidateRequest(BaseModel):
    manifest: dict


@router.post("/fusion/transcript/pack")
def fusion_pack_transcript(
    body: PackTranscriptRequest,
    user: User = Depends(get_current_user),
) -> dict:
    """词级转写 → 短语级 Packed Transcript(带 [start-end] markdown)。"""
    from app.services.media.packed_transcript import pack_transcript

    try:
        packed = pack_transcript(
            body.payload,
            **{k: v for k, v in {
                "silence_threshold": body.silence_threshold,
                "max_segment_seconds": body.max_segment_seconds,
            }.items() if v is not None},
        )
    except (ValueError, TypeError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return {"segments": packed.segments, "markdown": packed.to_markdown()}


@router.post("/fusion/edl/validate")
def fusion_edl_validate(
    body: EdlValidateRequest,
    user: User = Depends(get_current_user),
) -> dict:
    """EDL 硬规则体检:词内切/越界/非法时间,空 issues=可渲染。"""
    from app.services.media.edl import Edl

    try:
        edl = Edl.from_dict(body.edl)
        issues = edl.validate(
            source_durations=body.source_durations,
            fps=body.fps,
            words_by_source=body.words_by_source,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return {"ok": not issues, "issues": issues, "item_count": len(edl.items)}


@router.post("/fusion/edl/cut-plan")
def fusion_cut_plan(
    body: CutPlanRequest,
    user: User = Depends(get_current_user),
) -> dict:
    """词边界剪点计划:安全切点窗+pad 夹值(词边界硬规则)。"""
    from app.services.media.cut_rules import clamp_pad, cut_points, safe_cut_windows

    windows = safe_cut_windows(body.words, min_silence=body.min_silence)
    points = cut_points(body.words, min_silence=body.min_silence)
    return {
        "safe_windows": windows,
        "cut_points": points,
        "pad_ms": clamp_pad(body.pad_ms),
        "note": "绝不词内切;静音≥400ms 才是安全切点;字幕最后烧",
    }


@router.post("/fusion/qa/review")
def fusion_qa_review(
    body: QaReviewRequest,
    user: User = Depends(get_current_user),
) -> dict:
    """渲染后自评:每个剪点 ±window 自检跳帧/爆音/字幕遮挡+响度。"""
    from app.services.qa.self_review import review_render, suggest_fixes

    video = _safe_media_path(body.video_path)
    try:
        review = review_render(video, body.cut_points, fps=body.fps, window=body.window)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return {**review, "fixes": suggest_fixes(review)}


@router.post("/fusion/qa/timeline-png")
def fusion_timeline_png(
    body: TimelinePngRequest,
    user: User = Depends(get_current_user),
) -> Response:
    """按需视觉下钻:胶片条+波形+词标签复合 PNG(单张给 VLM)。"""
    from app.services.qa.timeline_view import timeline_png_bytes

    video = _safe_media_path(body.video_path)
    try:
        png = timeline_png_bytes(
            video,
            body.words,
            ambiguity_points=body.ambiguity_points,
            start=body.start,
            end=body.end,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return Response(content=png, media_type="image/png")


@router.post("/fusion/manifest/validate")
def fusion_manifest_validate(
    body: ManifestValidateRequest,
    user: User = Depends(get_current_user),
) -> dict:
    """FU5 管线 manifest 声明校验(缺字段/未知键/重复 id 拒绝)。"""
    from app.services.pipeline.manifest import validate_manifest

    try:
        m = validate_manifest(body.manifest)
    except Exception as exc:  # noqa: BLE001 — ManifestError 等校验族
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return {"ok": True, "stage_count": len(m.stages), "stages": [s.id for s in m.stages]}
