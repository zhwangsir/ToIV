"""POST /api/agent/chat —— AI 智能体对话(SSE 流式:文本/工具事件/媒体结果)。"""
from __future__ import annotations

import json

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlmodel import Session
from sse_starlette.sse import EventSourceResponse

from app.agent import runner
from app.comfy.pool import WorkerPool
from app.db import get_session
from app.deps import get_current_user, get_pool
from app.models import User
from app.ratelimit import enforce_generation_rate_limit

router = APIRouter()


class ChatMessage(BaseModel):
    role: str
    content: str = Field(max_length=8000)


class ImageRef(BaseModel):
    filename: str = Field(max_length=512)
    worker: str = Field(max_length=256)


class ChatRequest(BaseModel):
    messages: list[ChatMessage] = Field(min_length=1, max_length=40)
    image: ImageRef | None = None


@router.post("/agent/chat")
async def agent_chat(
    body: ChatRequest,
    user: User = Depends(get_current_user),
    pool: WorkerPool = Depends(get_pool),
    session: Session = Depends(get_session),
):
    enforce_generation_rate_limit(user)
    msgs = [{"role": m.role, "content": m.content} for m in body.messages]
    attachment = body.image.model_dump() if body.image else None

    async def stream():
        async for ev in runner.run(msgs, pool, user, session, attachment):
            yield {"event": "msg", "data": json.dumps(ev, ensure_ascii=False)}
        yield {"event": "done", "data": "{}"}

    return EventSourceResponse(stream())
