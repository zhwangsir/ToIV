"""画布事件总线 —— 进程内 pub/sub + Redis 跨进程 relay,供 Agent 工具(M1.2)向 SSE 端点(M1.1)推送节点变更。

进程内投递仍是主路径(零延迟);publish 同时尽力投递到 Redis channel
`toiv:canvas:{canvas_id}`,每个进程为本地有订阅者的画布起一个 relay 任务回投本进程,
实现多 worker 跨进程可达。Redis 不可达时自动降级为纯进程内(单进程行为),
恢复后自动回切 —— 见 app/services/redis_client.py。

深化要点(2026-07-26):
1. 背压:每个订阅 Queue 设 maxsize(默认 256),满时丢弃最旧事件并记日志,
   防止慢消费者(SSE 客户端不消费)撑爆内存。
2. 订阅计数:subscriber_count(canvas_id) 供 /health 和调试使用。
3. 心跳支持:publish 心跳事件不被背压丢弃(标记 priority=True)。
4. 全局统计:总订阅数、累计丢弃数,供运维监控。
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass, field

import redis as redis_lib

from app.services import redis_client

logger = logging.getLogger(__name__)

# 单订阅队列容量上限:超过则丢弃最旧事件(背压)
_QUEUE_MAXSIZE = 256

# 本进程标识:relay 回投时跳过自己发出的事件,防回声重复投递
_ORIGIN = uuid.uuid4().hex

# 画布事件订阅者:canvas_id → set[_Subscriber]
_subscribers: dict[str, set[_Subscriber]] = {}

# Redis relay 任务:canvas_id → asyncio.Task(仅当本地有订阅者且 Redis 可达)
_relay_tasks: dict[str, asyncio.Task] = {}

# 全局统计(运维监控用)
_stats = {"total_publishes": 0, "total_dropped": 0, "total_subscribers_peak": 0}


@dataclass(eq=False)
class _Subscriber:
    """单个 SSE 订阅者的状态。

    eq=False 使 dataclass 使用默认身份哈希(基于 id()),可放入 set;
    避免含可变字段(queue/dropped)导致 unhashable。
    """
    queue: asyncio.Queue
    canvas_id: str
    dropped: int = 0  # 该订阅者累计被丢弃的事件数
    created_at: float = field(default_factory=time.monotonic)


def _make_subscriber(canvas_id: str) -> _Subscriber:
    """创建订阅者并登记到 _subscribers。"""
    sub = _Subscriber(queue=asyncio.Queue(maxsize=_QUEUE_MAXSIZE), canvas_id=canvas_id)
    subs = _subscribers.setdefault(canvas_id, set())
    subs.add(sub)
    # 更新峰值订阅数
    total = sum(len(s) for s in _subscribers.values())
    if total > _stats["total_subscribers_peak"]:
        _stats["total_subscribers_peak"] = total
    _ensure_relay(canvas_id)
    return sub


def _drop_subscriber(canvas_id: str, sub: _Subscriber) -> None:
    """从 _subscribers 移除订阅者;空集合时清理键并停 relay,防内存泄漏。"""
    subs = _subscribers.get(canvas_id)
    if subs is None:
        return
    subs.discard(sub)
    if not subs:
        _subscribers.pop(canvas_id, None)
        task = _relay_tasks.pop(canvas_id, None)
        if task is not None:
            task.cancel()


# ────────────────────────────────
# Redis relay(跨进程投递;不可达时自动降级纯进程内)
# channel: toiv:canvas:{canvas_id};消息 {"origin": 进程标识, "event": {...}}
# ────────────────────────────────


def _channel(canvas_id: str) -> str:
    return f"toiv:canvas:{canvas_id}"


def _ensure_relay(canvas_id: str) -> None:
    """本地有订阅者时确保 Redis relay 任务在跑(Redis 不可达则不建,纯进程内)。"""
    if canvas_id in _relay_tasks:
        return
    if redis_client.get_redis() is None:
        return
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return  # 无运行中的事件循环(同步上下文),跳过 relay
    _relay_tasks[canvas_id] = loop.create_task(_relay_loop(canvas_id))


async def _relay_loop(canvas_id: str) -> None:
    """订阅 Redis channel,把其他进程发出的事件回投到本进程订阅者。"""
    r = redis_client.get_redis()
    if r is None:
        return
    pubsub = r.pubsub()
    try:
        await pubsub.subscribe(_channel(canvas_id))
        async for msg in pubsub.listen():
            if msg.get("type") != "message":
                continue
            try:
                payload = json.loads(msg["data"])
            except (TypeError, ValueError):
                continue
            if payload.get("origin") == _ORIGIN:
                continue  # 自己发出的事件,进程内已投递,跳过防回声
            event = payload.get("event")
            if isinstance(event, dict):
                _deliver_local(canvas_id, event)
    except asyncio.CancelledError:
        raise
    except (redis_lib.RedisError, OSError) as exc:
        redis_client.mark_down(exc)
    finally:
        try:
            await pubsub.unsubscribe(_channel(canvas_id))
            await pubsub.aclose()
        except Exception:  # noqa: BLE001 - 清理尽力而为
            pass
        _relay_tasks.pop(canvas_id, None)


async def _publish_remote(canvas_id: str, event: dict) -> None:
    """尽力投递到 Redis channel;失败记降级,不影响进程内投递。"""
    r = redis_client.get_redis()
    if r is None:
        return
    try:
        await r.publish(_channel(canvas_id),
                        json.dumps({"origin": _ORIGIN, "event": event}))
    except (redis_lib.RedisError, OSError) as exc:
        redis_client.mark_down(exc)


def _deliver_local(canvas_id: str, event: dict, *, priority: bool = False) -> None:
    """进程内投递:复制事件到该画布每个订阅者的 asyncio.Queue(含背压保护)。"""
    for sub in list(_subscribers.get(canvas_id, ())):
        try:
            if sub.queue.full():
                # 队列满:丢弃最旧事件腾位(背压)
                try:
                    sub.queue.get_nowait()
                    sub.dropped += 1
                    _stats["total_dropped"] += 1
                    if sub.dropped % 50 == 1:  # 限频日志,避免日志洪水
                        logger.warning(
                            "画布事件背压丢弃 canvas_id=%s dropped=%d total_dropped=%d",
                            canvas_id, sub.dropped, _stats["total_dropped"],
                        )
                except asyncio.QueueEmpty:
                    pass
            sub.queue.put_nowait(event)
        except asyncio.QueueFull:
            # priority 事件最后兜底:put_nowait 在 full 后仍可能因竞态失败,记录但不丢
            if priority:
                logger.error("画布 priority 事件入队失败 canvas_id=%s", canvas_id)
            else:
                logger.debug(
                    "画布事件入队失败(竞态) canvas_id=%s", canvas_id
                )


async def publish(canvas_id: str, event: dict, *, priority: bool = False) -> None:
    """向画布的所有 SSE 订阅者推送事件(M1.2 Agent 工具调用)。

    进程内投递(主路径)+ 尽力投递到 Redis channel(跨进程 relay 回投其他 worker)。

    Args:
        canvas_id: 画布 ID。
        event: 事件 payload(dict)。
        priority: True 时为心跳/控制事件,即使队列满也强制入队(挤掉最旧);
                  False 时队列满则丢弃最旧并记日志。

    深化:背压保护——队列满时丢弃最旧事件,防止慢消费者撑爆内存。
    """
    _stats["total_publishes"] += 1
    _deliver_local(canvas_id, event, priority=priority)
    await _publish_remote(canvas_id, event)


async def subscribe(canvas_id: str) -> AsyncIterator[dict]:
    """订阅画布事件(对外公共接口)。返回异步迭代器,迭代器退出时自动清理订阅。

    用法::

        async for event in subscribe(canvas_id):
            ...
    """
    sub = _make_subscriber(canvas_id)
    try:
        while True:
            yield await sub.queue.get()
    finally:
        _drop_subscriber(canvas_id, sub)


def subscribe_queue(canvas_id: str) -> asyncio.Queue:
    """订阅画布事件(SSE 端点内部用,返回原始 Queue 便于与心跳做超时竞争)。

    SSE 端点关闭时必须调 unsubscribe_queue 清理,否则订阅泄漏。

    注意:返回的 Queue 容量有限(_QUEUE_MAXSIZE),慢消费时事件会被丢弃。
    """
    return _make_subscriber(canvas_id).queue


def unsubscribe_queue(canvas_id: str, queue: asyncio.Queue) -> None:
    """清理 SSE 端点的订阅(SSE 关闭时调用)。

    兼容旧接口:通过 queue 对象反查订阅者(可能找不到,做容错)。
    """
    subs = _subscribers.get(canvas_id)
    if subs is None:
        return
    # 找到对应订阅者并移除(queue 是 _Subscriber 的字段)
    target = next((s for s in subs if s.queue is queue), None)
    if target is not None:
        _drop_subscriber(canvas_id, target)
    else:
        # 兜底:直接 discard 任意一个匹配 canvas_id 的(不该发生,防泄漏)
        logger.debug("unsubscribe_queue 反查失败 canvas_id=%s", canvas_id)


def subscriber_count(canvas_id: str) -> int:
    """返回指定画布的当前订阅者数(供 /health 和调试)。"""
    return len(_subscribers.get(canvas_id, ()))


def stats() -> dict:
    """返回事件总线全局统计(供 /health 展示)。"""
    return {
        "total_publishes": _stats["total_publishes"],
        "total_dropped": _stats["total_dropped"],
        "active_canvases": len(_subscribers),
        "total_subscribers": sum(len(s) for s in _subscribers.values()),
        "subscribers_peak": _stats["total_subscribers_peak"],
        "queue_maxsize": _QUEUE_MAXSIZE,
        "backend": redis_client.backend_status(),
    }
