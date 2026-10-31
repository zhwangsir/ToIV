"""直播助手(数字人 M5):知识库问答 + 违禁词 + 互动事件 + OpenTalking 播报。

通用互动网关(对标 aigcpanel 智能直播,但不做平台弹幕抓取):
外部来源(手动输入 / webhook)POST /api/live/ingest 摄入一条观众消息,
流水线:违禁词拦截 → KB 触发词匹配(priority 小优先) → LLM 兜底(≤80 字口语,
LLM 不可用回退固定文案,不阻塞) → 事件落库 → 有活跃 OpenTalking 会话且
回复为文本时调 sessions/{id}/speak 播报。

- 会话管理:用户级单例(内存 dict,api 重启即清,OpenTalking 侧会话自有过期机制)。
- OpenTalking 基址解析与 opentalking.py 一致(settings.opentalking_base_url);
  httpx trust_env=False 防 SSRF,超时 30s。
- 全部端点 get_current_user 鉴权 + user_id 属主隔离(他人数据 404 防枚举)。
"""
from __future__ import annotations

import json
import logging
from datetime import datetime
from typing import Any, Literal

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field, field_validator, model_validator
from sqlmodel import Session, select

from app.config import get_settings
from app.db import get_session
from app.deps import get_current_user
from app.models import LiveBannedWord, LiveEvent, LiveKB, User, _now

logger = logging.getLogger(__name__)

router = APIRouter(tags=["live-assistant"])

_OT_TIMEOUT = 30.0
# LLM 兜底不可用时的固定文案(不阻塞互动链路)
_LLM_FALLBACK_TEXT = "这个问题我暂时答不上来"

# 用户级活跃 OpenTalking 会话单例:user_id → session_id。进程内存即可,
# 重启即清(清后 ingest 回落 no_session,语义安全);不落库。
_SESSIONS: dict[str, str] = {}


# ---------------------------------------------------------------------------
# OpenTalking 直连(与 routes/opentalking.py 同一 base 解析;服务端调用不走代理路由)
# ---------------------------------------------------------------------------
def _ot_base() -> str:
    return get_settings().opentalking_base_url.strip().rstrip("/")


async def _ot_post(path: str, body: dict | None = None) -> httpx.Response:
    """POST OpenTalking;网络层错误抛 httpx.HTTPError 由调用方分派(502/speak_failed)。"""
    async with httpx.AsyncClient(timeout=_OT_TIMEOUT, trust_env=False) as client:
        return await client.post(f"{_ot_base()}{path}", json=body)


# ---------------------------------------------------------------------------
# LLM 兜底回复(复用 agent 层 chat;失败回退固定文案)
# ---------------------------------------------------------------------------
async def _llm_reply(text: str, author: str, kb_summary: str) -> str:
    """无 KB 命中时让 LLM 生成简短口语化回复;任何失败回退固定文案,绝不阻塞。"""
    from app.agent import llm as agent_llm

    system = (
        "你是直播间数字人主播,正在实时口播回答观众提问。"
        "要求:回复必须是口语化中文,≤80 字,不要列表/ markdown/ emoji,"
        "不知道就如实说不知道,不要编造。"
    )
    if kb_summary:
        system += f"\n主播预设的常见问题知识库(仅供参考,不要逐字复述):\n{kb_summary}"
    user_msg = f"观众「{author}」问:{text}" if author else f"观众问:{text}"
    try:
        msg = await agent_llm.chat(
            [
                {"role": "system", "content": system},
                {"role": "user", "content": user_msg},
            ],
            max_tokens=200,
            temperature=0.7,
        )
        reply = str(msg.get("content") or "").strip()
        return reply or _LLM_FALLBACK_TEXT
    except Exception as exc:  # noqa: BLE001 — LLM 故障不阻断直播互动
        logger.warning("直播助手 LLM 兜底失败,回退固定文案: %r", exc)
        return _LLM_FALLBACK_TEXT


# ---------------------------------------------------------------------------
# 请求 / 响应模型
# ---------------------------------------------------------------------------
class KBCreate(BaseModel):
    trigger_words: list[str] = Field(min_length=1, max_length=50)
    reply_type: Literal["text", "video"] = "text"
    reply_text: str = Field(default="", max_length=2000)
    reply_asset_url: str = Field(default="", max_length=2000)
    priority: int = 100
    enabled: bool = True

    @field_validator("trigger_words")
    @classmethod
    def _words_ok(cls, v: list[str]) -> list[str]:
        words = [w.strip() for w in v if w.strip()]
        if not words:
            raise ValueError("触发词不能为空")
        return words

    @model_validator(mode="after")
    def _reply_ok(self) -> "KBCreate":
        if self.reply_type == "text" and not self.reply_text.strip():
            raise ValueError("文本回复 reply_text 不能为空")
        if self.reply_type == "video" and not self.reply_asset_url.strip():
            raise ValueError("视频回复 reply_asset_url 不能为空")
        return self


class KBPatch(BaseModel):
    """部分更新:仅非 None 字段生效;更新后整体校验回复组合。"""

    trigger_words: list[str] | None = Field(default=None, min_length=1, max_length=50)
    reply_type: Literal["text", "video"] | None = None
    reply_text: str | None = Field(default=None, max_length=2000)
    reply_asset_url: str | None = Field(default=None, max_length=2000)
    priority: int | None = None
    enabled: bool | None = None

    @field_validator("trigger_words")
    @classmethod
    def _words_ok(cls, v: list[str] | None) -> list[str] | None:
        if v is None:
            return None
        words = [w.strip() for w in v if w.strip()]
        if not words:
            raise ValueError("触发词不能为空")
        return words


class KBOut(BaseModel):
    id: str
    trigger_words: list[str]
    reply_type: str
    reply_text: str
    reply_asset_url: str
    priority: int
    enabled: bool
    created_at: datetime
    updated_at: datetime


class BannedCreate(BaseModel):
    word: str = Field(min_length=1, max_length=100)

    @field_validator("word")
    @classmethod
    def _word_ok(cls, v: str) -> str:
        w = v.strip()
        if not w:
            raise ValueError("违禁词不能为空")
        return w


class BannedOut(BaseModel):
    id: str
    word: str
    created_at: datetime


class IngestIn(BaseModel):
    text: str = Field(min_length=1, max_length=2000)
    author: str = Field(default="", max_length=100)
    source: Literal["manual", "webhook"] = "manual"


class EventOut(BaseModel):
    id: str
    source: str
    author: str
    text: str
    matched_kb_id: str | None
    reply_text: str
    reply_type: str
    status: str
    created_at: datetime


class SessionStartIn(BaseModel):
    avatar_image: str = Field(min_length=1, max_length=255)
    avatar_worker: str = Field(min_length=1, max_length=255)


class SessionStatusOut(BaseModel):
    active: bool
    session_id: str | None = None


# ---------------------------------------------------------------------------
# 辅助
# ---------------------------------------------------------------------------
def _kb_out(kb: LiveKB) -> KBOut:
    try:
        words = json.loads(kb.trigger_words)
        if not isinstance(words, list):
            words = []
    except (ValueError, TypeError):
        words = []
    return KBOut(
        id=kb.id,
        trigger_words=[str(w) for w in words],
        reply_type=kb.reply_type,
        reply_text=kb.reply_text,
        reply_asset_url=kb.reply_asset_url,
        priority=kb.priority,
        enabled=kb.enabled,
        created_at=kb.created_at,
        updated_at=kb.updated_at,
    )


def _event_out(ev: LiveEvent) -> EventOut:
    return EventOut(
        id=ev.id,
        source=ev.source,
        author=ev.author,
        text=ev.text,
        matched_kb_id=ev.matched_kb_id,
        reply_text=ev.reply_text,
        reply_type=ev.reply_type,
        status=ev.status,
        created_at=ev.created_at,
    )


def _get_own_kb(session: Session, kb_id: str, user: User) -> LiveKB:
    kb = session.get(LiveKB, kb_id)
    if kb is None or kb.user_id != user.id:
        raise HTTPException(status_code=404, detail="知识库条目不存在")
    return kb


def _validate_reply_combo(reply_type: str, reply_text: str, reply_asset_url: str) -> None:
    if reply_type == "text" and not reply_text.strip():
        raise HTTPException(status_code=422, detail="文本回复 reply_text 不能为空")
    if reply_type == "video" and not reply_asset_url.strip():
        raise HTTPException(status_code=422, detail="视频回复 reply_asset_url 不能为空")


def _banned_hit(text: str, words: list[str]) -> bool:
    """大小写不敏感子串匹配(输入与回复文本双向复用)。"""
    low = text.lower()
    return any(w.lower() in low for w in words if w.strip())


# ---------------------------------------------------------------------------
# 知识库 CRUD
# ---------------------------------------------------------------------------
@router.get("/live/kb", response_model=list[KBOut])
def list_kb(session: Session = Depends(get_session), user: User = Depends(get_current_user)):
    rows = session.exec(
        select(LiveKB)
        .where(LiveKB.user_id == user.id)
        .order_by(LiveKB.priority, LiveKB.created_at)  # type: ignore[arg-type]
    ).all()
    return [_kb_out(kb) for kb in rows]


@router.post("/live/kb", response_model=KBOut, status_code=201)
def create_kb(
    body: KBCreate,
    session: Session = Depends(get_session),
    user: User = Depends(get_current_user),
):
    kb = LiveKB(
        user_id=user.id,
        trigger_words=json.dumps(body.trigger_words, ensure_ascii=False),
        reply_type=body.reply_type,
        reply_text=body.reply_text,
        reply_asset_url=body.reply_asset_url,
        priority=body.priority,
        enabled=body.enabled,
    )
    session.add(kb)
    session.commit()
    session.refresh(kb)
    return _kb_out(kb)


@router.patch("/live/kb/{kb_id}", response_model=KBOut)
def patch_kb(
    kb_id: str,
    body: KBPatch,
    session: Session = Depends(get_session),
    user: User = Depends(get_current_user),
):
    kb = _get_own_kb(session, kb_id, user)
    if body.trigger_words is not None:
        kb.trigger_words = json.dumps(body.trigger_words, ensure_ascii=False)
    if body.reply_type is not None:
        kb.reply_type = body.reply_type
    if body.reply_text is not None:
        kb.reply_text = body.reply_text
    if body.reply_asset_url is not None:
        kb.reply_asset_url = body.reply_asset_url
    if body.priority is not None:
        kb.priority = body.priority
    if body.enabled is not None:
        kb.enabled = body.enabled
    _validate_reply_combo(kb.reply_type, kb.reply_text, kb.reply_asset_url)
    kb.updated_at = _now()
    session.add(kb)
    session.commit()
    session.refresh(kb)
    return _kb_out(kb)


@router.delete("/live/kb/{kb_id}", status_code=204)
def delete_kb(
    kb_id: str,
    session: Session = Depends(get_session),
    user: User = Depends(get_current_user),
):
    kb = _get_own_kb(session, kb_id, user)
    session.delete(kb)
    session.commit()


# ---------------------------------------------------------------------------
# 违禁词
# ---------------------------------------------------------------------------
@router.get("/live/banned", response_model=list[BannedOut])
def list_banned(
    session: Session = Depends(get_session), user: User = Depends(get_current_user)
):
    rows = session.exec(
        select(LiveBannedWord)
        .where(LiveBannedWord.user_id == user.id)
        .order_by(LiveBannedWord.created_at)  # type: ignore[arg-type]
    ).all()
    return [BannedOut(id=w.id, word=w.word, created_at=w.created_at) for w in rows]


@router.post("/live/banned", response_model=BannedOut, status_code=201)
def create_banned(
    body: BannedCreate,
    session: Session = Depends(get_session),
    user: User = Depends(get_current_user),
):
    w = LiveBannedWord(user_id=user.id, word=body.word)
    session.add(w)
    session.commit()
    session.refresh(w)
    return BannedOut(id=w.id, word=w.word, created_at=w.created_at)


@router.delete("/live/banned/{word_id}", status_code=204)
def delete_banned(
    word_id: str,
    session: Session = Depends(get_session),
    user: User = Depends(get_current_user),
):
    w = session.get(LiveBannedWord, word_id)
    if w is None or w.user_id != user.id:
        raise HTTPException(status_code=404, detail="违禁词不存在")
    session.delete(w)
    session.commit()


# ---------------------------------------------------------------------------
# 会话管理(用户级单例)
# ---------------------------------------------------------------------------
@router.post("/live/session/start", response_model=SessionStatusOut)
async def session_start(
    body: SessionStartIn, user: User = Depends(get_current_user)
) -> SessionStatusOut:
    """创建 OpenTalking 会话并启动;成功后记为用户活跃会话(覆盖旧单例)。"""
    create_body: dict[str, Any] = {
        # 直播助手场景:关闭 OpenTalking 内置 agent/memory/knowledge,
        # 问答由本层 KB/LLM 完成,OpenTalking 只负责播报(speak)
        "avatar_image": body.avatar_image,
        "avatar_worker": body.avatar_worker,
        "tts_provider": "indextts",
        "agent_enabled": False,
        "memory_enabled": False,
        "knowledge_enabled": False,
    }
    try:
        r = await _ot_post("/sessions", create_body)
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=502, detail=f"数字人引擎不可达,无法开播: {exc!r}"
        ) from exc
    if r.status_code >= 300:
        raise HTTPException(
            status_code=502,
            detail=f"数字人引擎创建会话失败(上游 {r.status_code}): {r.text[:200]}",
        )
    try:
        payload = r.json()
        sid = str(payload.get("session_id") or "")
    except ValueError:
        sid = ""
    if not sid:
        raise HTTPException(status_code=502, detail="数字人引擎未返回 session_id")
    try:
        rs = await _ot_post(f"/sessions/{sid}/start", {})
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=502, detail=f"数字人引擎启动会话失败: {exc!r}"
        ) from exc
    if rs.status_code >= 300:
        raise HTTPException(
            status_code=502,
            detail=f"数字人引擎启动会话失败(上游 {rs.status_code}): {rs.text[:200]}",
        )
    _SESSIONS[user.id] = sid
    return SessionStatusOut(active=True, session_id=sid)


@router.post("/live/session/stop", response_model=SessionStatusOut)
async def session_stop(user: User = Depends(get_current_user)) -> SessionStatusOut:
    """停止活跃会话:打断播报(best-effort)并清除单例;无会话时幂等返回。"""
    sid = _SESSIONS.pop(user.id, None)
    if sid:
        try:
            await _ot_post(f"/sessions/{sid}/interrupt", {})
        except httpx.HTTPError as exc:
            # 停止是尽力而为:引擎不可达也视为已停(本地单例已清)
            logger.warning("直播助手停止会话 interrupt 失败(忽略): %r", exc)
    return SessionStatusOut(active=False, session_id=None)


@router.get("/live/session/status", response_model=SessionStatusOut)
def session_status(user: User = Depends(get_current_user)) -> SessionStatusOut:
    sid = _SESSIONS.get(user.id)
    return SessionStatusOut(active=bool(sid), session_id=sid)


# ---------------------------------------------------------------------------
# 互动摄入
# ---------------------------------------------------------------------------
@router.post("/live/ingest", response_model=EventOut)
async def ingest(
    body: IngestIn,
    session: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> EventOut:
    banned_words = [
        w.word
        for w in session.exec(
            select(LiveBannedWord).where(LiveBannedWord.user_id == user.id)
        ).all()
    ]

    matched_kb: LiveKB | None = None
    reply_text = ""
    reply_type = "text"
    status = "replied"

    # ① 违禁词:输入命中 → 直接拦截,不匹配不播报
    if _banned_hit(body.text, banned_words):
        status = "banned"
    else:
        # ② KB 匹配:priority 小优先,首个 enabled 触发词子串命中(大小写不敏感)
        kbs = session.exec(
            select(LiveKB)
            .where(LiveKB.user_id == user.id, LiveKB.enabled == True)  # noqa: E712
            .order_by(LiveKB.priority, LiveKB.created_at)  # type: ignore[arg-type]
        ).all()
        low_text = body.text.lower()
        for kb in kbs:
            try:
                words = json.loads(kb.trigger_words)
            except (ValueError, TypeError):
                continue
            if not isinstance(words, list):
                continue
            if any(str(w).strip() and str(w).lower() in low_text for w in words):
                matched_kb = kb
                break
        if matched_kb is not None:
            reply_type = matched_kb.reply_type
            reply_text = (
                matched_kb.reply_text
                if matched_kb.reply_type == "text"
                else matched_kb.reply_asset_url
            )
        else:
            # ③ LLM 兜底:KB 摘要作上下文;不可用回退固定文案
            summary_lines = []
            for kb in kbs[:20]:
                try:
                    words = json.loads(kb.trigger_words)
                except (ValueError, TypeError):
                    words = []
                summary_lines.append(
                    f"- 触发词 {words} → {kb.reply_text or kb.reply_asset_url}"
                )
            reply_text = await _llm_reply(body.text, body.author, "\n".join(summary_lines))
        # 违禁词双向:回复文本命中同样拦截(不播报)
        if reply_type == "text" and _banned_hit(reply_text, banned_words):
            status = "banned"
            reply_text = ""

    event = LiveEvent(
        user_id=user.id,
        source=body.source,
        author=body.author,
        text=body.text,
        matched_kb_id=matched_kb.id if matched_kb else None,
        reply_text=reply_text,
        reply_type=reply_type,
        status=status,
    )
    session.add(event)
    session.commit()
    session.refresh(event)

    # ⑤ 播报:仅文本回复 + 有活跃会话;video 回复保持 replied(不走 speak)
    if event.status == "replied" and event.reply_type == "text":
        sid = _SESSIONS.get(user.id)
        if not sid:
            event.status = "no_session"
        else:
            try:
                r = await _ot_post(f"/sessions/{sid}/speak", {"text": event.reply_text})
                event.status = "spoken" if r.status_code < 300 else "speak_failed"
            except httpx.HTTPError as exc:
                logger.warning("直播助手 speak 调用失败: %r", exc)
                event.status = "speak_failed"
        session.add(event)
        session.commit()
        session.refresh(event)

    return _event_out(event)


# ---------------------------------------------------------------------------
# 互动历史
# ---------------------------------------------------------------------------
@router.get("/live/events", response_model=list[EventOut])
def list_events(
    limit: int = Query(default=50, ge=1, le=200),
    session: Session = Depends(get_session),
    user: User = Depends(get_current_user),
):
    rows = session.exec(
        select(LiveEvent)
        .where(LiveEvent.user_id == user.id)
        .order_by(LiveEvent.created_at.desc())  # type: ignore[union-attr]
        .limit(limit)
    ).all()
    return [_event_out(ev) for ev in rows]
