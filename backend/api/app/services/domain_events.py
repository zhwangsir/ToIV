"""进程内同步领域事件总线(双域收敛用)。

与 harness.EventBus(async/agent 域)分离:tracker.mark_done / studio 回写是同步路径,
转写钩子须 fan-out 单点,禁止 tracker 与 orchestrator 各自直调 on_artifacts_done。

默认订阅:ARTIFACTS_VIDEO_DONE → packed transcript 产出。
"""
from __future__ import annotations

import logging
from collections import defaultdict
from collections.abc import Callable
from typing import Any

logger = logging.getLogger(__name__)

# 视频产物落库完成(URL 列表已可消费)。payload: {urls: list[str], source: str}
ARTIFACTS_VIDEO_DONE = "artifacts/video-done"

Listener = Callable[[dict[str, Any]], Any]

_listeners: dict[str, list[Listener]] = defaultdict(list)
_defaults_registered = False


def on(event: str, listener: Listener) -> Callable[[], None]:
    """订阅;返回退订器(幂等)。"""
    _listeners[event].append(listener)

    def off() -> None:
        try:
            _listeners[event].remove(listener)
        except ValueError:
            pass

    return off


def listeners(event: str) -> list[Listener]:
    return list(_listeners.get(event, ()))


def clear_listeners(event: str | None = None) -> None:
    """测试用:清空某事件或全部监听器。"""
    if event is None:
        _listeners.clear()
    else:
        _listeners.pop(event, None)


def emit(event: str, payload: dict[str, Any] | None = None) -> None:
    """同步 fan-out;单监听器异常记日志不阻断其他/调用方。"""
    body = dict(payload or {})
    for ln in list(_listeners.get(event, ())):
        try:
            ln(body)
        except Exception:  # noqa: BLE001
            logger.exception("domain_events 监听器异常 event=%s", event)


def emit_artifacts_video_done(urls: list[str], *, source: str = "") -> None:
    """视频产物完成通知(唯一推荐入口)。"""
    ensure_default_subscribers()
    cleaned = [u for u in (urls or []) if isinstance(u, str) and u.strip()]
    if not cleaned:
        return
    emit(ARTIFACTS_VIDEO_DONE, {"urls": cleaned, "source": source})


def _transcript_subscriber(payload: dict[str, Any]) -> None:
    from app.services.media.artifact_transcript import on_artifacts_done

    on_artifacts_done(list(payload.get("urls") or []))


def ensure_default_subscribers() -> None:
    """幂等注册默认订阅(transcript)。"""
    global _defaults_registered
    if _defaults_registered:
        return
    # 避免重复注册同名函数
    if _transcript_subscriber not in _listeners[ARTIFACTS_VIDEO_DONE]:
        on(ARTIFACTS_VIDEO_DONE, _transcript_subscriber)
    _defaults_registered = True


# 导入即挂默认订阅,保证 tracker/studio 早于显式 ensure 也能 fan-out
ensure_default_subscribers()
