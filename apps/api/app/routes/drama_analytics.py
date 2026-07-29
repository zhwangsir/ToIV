"""短剧播放分析 API。

POST /api/drama/event                       批量接收前端埋点事件
GET  /api/drama/metrics/{session_id}        单会话实时指标
GET  /api/drama/metrics/{drama_id}/summary  全剧聚合指标
GET  /api/drama/video/{drama_id}.mp4        短剧视频静态文件代理
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import func
from sqlmodel import Session, select

from app.db import get_session
from app.models import DramaEvent, DramaSession

router = APIRouter()


# ────────────────────────────────
# 静态视频文件落位
# 生产环境优先挂载 NAS;NAS 不可达时自动降级到本地路径。
# ────────────────────────────────

import logging
import os

logger = logging.getLogger(__name__)


def _drama_root() -> Path:
    """解析短剧成片根目录。

    优先级:
    1. TOIV_DRAMA_VIDEO_DIR 环境变量(生产环境指向 NAS 挂载点)
    2. 本地候选路径(开发/Docker 回退)

    若环境变量指向的 NAS 路径不可访问,自动降级到本地路径并记录警告。
    """
    if env_dir := os.environ.get("TOIV_DRAMA_VIDEO_DIR"):
        env_path = Path(env_dir)
        try:
            if env_path.is_dir():
                return env_path
        except OSError as exc:
            logger.warning(
                "TOIV_DRAMA_VIDEO_DIR NAS 路径不可访问,降级到本地路径: %s (%s)",
                env_dir,
                exc,
            )
        else:
            logger.warning(
                "TOIV_DRAMA_VIDEO_DIR 目录不存在,降级到本地路径: %s", env_dir
            )

    # 候选路径:本地开发时 apps/api 位于项目根下;Docker 中 /app 即 apps/api 内容
    file = Path(__file__).resolve()
    candidates = [
        file.parent.parent.parent.parent.parent / "drama" / "output" / "final",  # 本地
        file.parent.parent.parent / "drama" / "output" / "final",  # Docker
        Path("/app/drama/output/final"),
    ]
    for p in candidates:
        if p.is_dir():
            return p
    return candidates[0]


DRAMA_ROOT = _drama_root()


def _drama_video_path(drama_id: str) -> Path | None:
    """按 drama_id 查找成片文件;目前只服务 short_drama_v1.mp4。"""
    candidates = [
        DRAMA_ROOT / f"{drama_id}.mp4",
        DRAMA_ROOT / "short_drama_v1.mp4",
    ]
    for p in candidates:
        if p.is_file():
            return p
    return None


# ────────────────────────────────
# Pydantic schemas
# ────────────────────────────────

class DeviceInfo(BaseModel):
    ua: str = ""
    screen: str = ""
    language: str = ""
    platform: str = ""


class FrontendEvent(BaseModel):
    event_id: str = Field(min_length=1, max_length=64)
    session_id: str = Field(min_length=1, max_length=64)
    user_id: str = Field(min_length=1, max_length=64)
    drama_id: str = Field(min_length=1, max_length=128)
    event_type: str = Field(min_length=1, max_length=32)
    current_time: float | None = Field(default=None, ge=0)
    duration: float | None = Field(default=None, ge=0)
    payload: dict[str, Any] | None = Field(default=None)
    client_ts: int = Field(ge=0)

    @field_validator("event_type")
    @classmethod
    def _valid_event_type(cls, v: str) -> str:
        allowed = {
            "play",
            "pause",
            "seek",
            "completed",
            "timeupdate",
            "chapter_enter",
            "chapter_exit",
            "like",
            "replay",
            "rate_change",
            "fullscreen_change",
            "mark_good",
            "mark_boring",
            "share_click",
            "drop_off",
            "first_play_delay",
            "buffering",
        }
        if v not in allowed:
            raise ValueError(f"invalid event_type: {v}")
        return v


class EventBatchRequest(BaseModel):
    events: list[FrontendEvent] = Field(max_length=100)
    device: DeviceInfo = Field(default_factory=DeviceInfo)
    video_url: str = ""

    @field_validator("events")
    @classmethod
    def _not_empty(cls, v: list[FrontendEvent]) -> list[FrontendEvent]:
        if len(v) == 0:
            raise ValueError("events cannot be empty")
        return v


class EventBatchResponse(BaseModel):
    ingested: int
    session_id: str | None = None


class ChapterMetric(BaseModel):
    chapter_id: str
    avg_drop: float | None = None
    peak_rewind: float = 0.0
    peak_skip: float = 0.0
    enter_count: int = 0
    exit_count: int = 0


class DramaMetrics(BaseModel):
    drama_id: str
    sessions: int
    plays: int
    completed: int
    completion_rate: float
    avg_watch_sec: float
    replay_rate: float
    engagement_rate: float
    heatmap: list[dict[str, Any]]
    chapters: list[ChapterMetric]


# ────────────────────────────────
# Helpers
# ────────────────────────────────

def _now() -> datetime:
    return datetime.now(timezone.utc)


def _get_or_create_session(
    session: Session,
    session_id: str,
    user_id: str,
    drama_id: str,
    video_url: str,
    device: DeviceInfo,
) -> DramaSession:
    row = session.get(DramaSession, session_id)
    if row is None:
        row = DramaSession(
            session_id=session_id,
            user_id=user_id,
            drama_id=drama_id,
            video_url=video_url,
            device_ua=device.ua,
            device_screen=device.screen,
            device_lang=device.language,
            device_platform=device.platform,
            started_at=_now(),
        )
        session.add(row)
    return row


def _update_session_from_events(sess: DramaSession, events: list[FrontendEvent]) -> None:
    """根据事件批次刷新会话聚合字段。"""
    for ev in events:
        if ev.event_type == "completed":
            sess.is_completed = True
            sess.drop_off_at = ev.current_time or sess.duration_sec
        elif ev.event_type == "drop_off" and ev.payload:
            sess.drop_off_at = ev.payload.get("last_time")
        elif ev.event_type == "timeupdate" and ev.current_time is not None:
            sess.duration_sec = ev.duration
            if not sess.is_completed:
                sess.drop_off_at = ev.current_time
        sess.ended_at = _now()


# ────────────────────────────────
# Routes
# ────────────────────────────────

@router.post("/drama/event")
async def ingest_events(
    req: EventBatchRequest,
    db: Session = Depends(get_session),
) -> EventBatchResponse:
    """批量写入事件;幂等(event_id 唯一)。"""
    if not req.events:
        raise HTTPException(status_code=400, detail="events empty")

    # 取第一条事件定位 session(同批应属同一会话)
    first = req.events[0]
    session = _get_or_create_session(
        db,
        first.session_id,
        first.user_id,
        first.drama_id,
        req.video_url,
        req.device,
    )

    ingested = 0
    for ev in req.events:
        # 幂等:已存在则跳过
        exists = db.exec(
            select(DramaEvent).where(DramaEvent.event_id == ev.event_id)
        ).first()
        if exists:
            continue

        db.add(
            DramaEvent(
                event_id=ev.event_id,
                session_id=ev.session_id,
                user_id=ev.user_id,
                drama_id=ev.drama_id,
                event_type=ev.event_type,
                current_time=ev.current_time,
                duration=ev.duration,
                payload=json.dumps(ev.payload, ensure_ascii=False) if ev.payload else "",
                client_ts=ev.client_ts,
                server_ts=_now(),
            )
        )
        ingested += 1

    _update_session_from_events(session, req.events)
    db.commit()

    return EventBatchResponse(ingested=ingested, session_id=first.session_id)


@router.get("/drama/metrics/{session_id}")
async def session_metrics(
    session_id: str,
    db: Session = Depends(get_session),
) -> dict[str, Any]:
    """单个会话的实时指标。"""
    sess = db.get(DramaSession, session_id)
    if sess is None:
        raise HTTPException(status_code=404, detail="session not found")

    events = db.exec(
        select(DramaEvent).where(DramaEvent.session_id == session_id)
    ).all()

    watch_sec = sess.drop_off_at or 0
    completed = sess.is_completed
    likes = sum(1 for e in events if e.event_type == "like")
    marks = sum(1 for e in events if e.event_type in ("mark_good", "mark_boring"))

    return {
        "session_id": session_id,
        "drama_id": sess.drama_id,
        "watch_sec": watch_sec,
        "completed": completed,
        "liked": likes > 0,
        "marked": marks > 0,
        "event_count": len(events),
    }


@router.get("/drama/metrics/{drama_id}/summary")
async def drama_summary(
    drama_id: str,
    db: Session = Depends(get_session),
) -> DramaMetrics:
    """全剧聚合指标。"""
    sessions = db.exec(
        select(DramaSession).where(DramaSession.drama_id == drama_id)
    ).all()
    if not sessions:
        raise HTTPException(status_code=404, detail="drama not found")

    total = len(sessions)
    completed = sum(1 for s in sessions if s.is_completed)
    plays = len(
        db.exec(
            select(DramaEvent.session_id)
            .where(DramaEvent.drama_id == drama_id)
            .where(DramaEvent.event_type == "play")
            .distinct()
        ).all()
    )
    replays = len(
        db.exec(
            select(DramaEvent.session_id)
            .where(DramaEvent.drama_id == drama_id)
            .where(DramaEvent.event_type == "replay")
            .distinct()
        ).all()
    )
    engaged = len(
        db.exec(
            select(DramaEvent.session_id)
            .where(DramaEvent.drama_id == drama_id)
            .where(
                DramaEvent.event_type.in_(
                    ["like", "mark_good", "mark_boring", "share_click"]
                )
            )
            .distinct()
        ).all()
    )

    avg_watch = sum(s.drop_off_at or 0 for s in sessions) / total if total else 0.0

    # 热力图:每秒仍在线的会话数(单条 GROUP BY 查询)
    heatmap: list[dict[str, Any]] = []
    max_duration = max((s.duration_sec or 0 for s in sessions), default=0)
    heartbeat_rows = db.exec(
        select(
            func.floor(DramaEvent.current_time).label("sec"),
            func.count(func.distinct(DramaEvent.session_id)).label("online"),
        )
        .where(DramaEvent.drama_id == drama_id)
        .where(DramaEvent.event_type == "timeupdate")
        .where(DramaEvent.current_time.isnot(None))
        .group_by("sec")
        .order_by("sec")
    ).all()
    online_by_sec = {int(row.sec): row.online for row in heartbeat_rows}
    for sec in range(int(max_duration) + 1):
        online = online_by_sec.get(sec, 0)
        heatmap.append(
            {"second": sec, "online": online, "retention": online / total if total else 0}
        )

    # Chapter 指标
    chapter_rows: list[ChapterMetric] = []
    chapter_ids: set[str] = set()
    for ev in db.exec(
        select(DramaEvent)
        .where(DramaEvent.drama_id == drama_id)
        .where(DramaEvent.event_type.in_(["chapter_enter", "chapter_exit", "seek"]))
    ).all():
        if ev.payload:
            chapter_ids.add(json.loads(ev.payload).get("chapter_id", ""))

    for cid in filter(None, chapter_ids):
        exits = db.exec(
            select(DramaEvent).where(
                DramaEvent.drama_id == drama_id,
                DramaEvent.event_type == "chapter_exit",
                DramaEvent.payload.contains(f'"chapter_id": "{cid}"'),
            )
        ).all()
        enters = db.exec(
            select(DramaEvent).where(
                DramaEvent.drama_id == drama_id,
                DramaEvent.event_type == "chapter_enter",
                DramaEvent.payload.contains(f'"chapter_id": "{cid}"'),
            )
        ).all()
        avg_drop = sum(e.current_time or 0 for e in exits) / len(exits) if exits else None

        peak_rewind = 0.0
        peak_skip = 0.0
        for ev in db.exec(
            select(DramaEvent).where(
                DramaEvent.drama_id == drama_id,
                DramaEvent.event_type == "seek",
            )
        ).all():
            if not ev.payload:
                continue
            p = json.loads(ev.payload)
            delta = (p.get("to_time") or 0) - (p.get("from_time") or 0)
            # 简单归属:to_time 落在该 chapter 内则计入
            if any(
                e.current_time and abs(e.current_time - (p.get("to_time") or 0)) < 1
                for e in enters
            ):
                if delta < 0 and abs(delta) > peak_rewind:
                    peak_rewind = abs(delta)
                if delta > 0 and delta > peak_skip:
                    peak_skip = delta

        chapter_rows.append(
            ChapterMetric(
                chapter_id=cid,
                avg_drop=avg_drop,
                peak_rewind=peak_rewind,
                peak_skip=peak_skip,
                enter_count=len(enters),
                exit_count=len(exits),
            )
        )

    return DramaMetrics(
        drama_id=drama_id,
        sessions=total,
        plays=plays,
        completed=completed,
        completion_rate=completed / total if total else 0.0,
        avg_watch_sec=avg_watch,
        replay_rate=replays / total if total else 0.0,
        engagement_rate=engaged / total if total else 0.0,
        heatmap=heatmap,
        chapters=chapter_rows,
    )


@router.get("/drama/video/{drama_id}.mp4", response_model=None)
async def drama_video(drama_id: str, request: Request) -> FileResponse | StreamingResponse:
    """代理本地成片 MP4,支持 range 请求。"""
    path = _drama_video_path(drama_id)
    if path is None:
        raise HTTPException(status_code=404, detail="video not found")

    # 简单支持 range,大文件分片播放
    range_header = request.headers.get("range")
    if range_header:
        file_size = path.stat().st_size
        try:
            start_str, end_str = range_header.replace("bytes=", "").split("-")
            start = int(start_str) if start_str else 0
            end = int(end_str) if end_str else file_size - 1
        except ValueError:
            raise HTTPException(status_code=416, detail="invalid range") from None

        def file_iterator():
            with open(path, "rb") as f:
                f.seek(start)
                remaining = end - start + 1
                chunk_size = 1024 * 1024
                while remaining > 0:
                    data = f.read(min(chunk_size, remaining))
                    if not data:
                        break
                    remaining -= len(data)
                    yield data

        return StreamingResponse(
            file_iterator(),
            status_code=206,
            media_type="video/mp4",
            headers={
                "Content-Range": f"bytes {start}-{end}/{file_size}",
                "Accept-Ranges": "bytes",
                "Content-Length": str(end - start + 1),
            },
        )

    return FileResponse(
        path,
        media_type="video/mp4",
        filename=f"{drama_id}.mp4",
    )
