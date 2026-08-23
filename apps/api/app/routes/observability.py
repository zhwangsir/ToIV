"""观测面板聚合端点 —— GET /api/observability。

一接口聚合三类信号,替代 SSH 上机看日志:
1. 作业队列分桶计数(queued/held/running,软删除不计);
2. 近 24h 成功率(done vs error,按 created_at 窗口);
3. 各 GPU 卡 VRAM 负载:逐一探测各 ComfyUI 实例 /system_stats(vram_total/free)
   + /queue(运行/排队深度),按写死的 GPU 拓扑归并到卡。

设计约束:
- 单实例探测 2s 超时,任一实例挂了只标 offline,不拖垮整接口;
- 整响应 10s 短缓存(面板 10-15s 轮询,命中率近 100%),缓存由 asyncio.Lock
  单飞重建,避免轮询叠加打爆一串 /system_stats;
- GPU 利用率/温度 HTTP 侧拿不到(需 nvidia-smi),只展示 VRAM 维度——
  /system_stats 的 vram_free 是整卡口径(含同卡其他进程),故同卡多实例
  上报一致,卡级取 max 即可,无需去重;
- 仅管理员(与 /system/gpu 同口径,避免普通用户窥探集群拓扑)。

GPU 拓扑(2026-08-23 AGENTS.md 分配表,写死+注释;变更时同步此处):
- GPU0(workstation 192.168.71.127):ComfyUI 通用 :8189(另 TTS :9200/:9201 非 ComfyUI,无 /system_stats 不探)
- GPU1:超分 :8261(另 Embedding :9302 / LiveAct :9400 非 ComfyUI)
- GPU2:H3 主力视频 :8195 / LongCat :8197 / 超分 :8262(另 JoyCaption :9304 transformers 直跑)
- GPU3:超分 :8263(另 FlashTalk :9004 非 ComfyUI 链路;LTX2.5 :8198 已退役)
- PC01(192.168.71.115 RTX 5090):ComfyUI worker :8188
- PC02(192.168.71.114 RTX 5090):ComfyUI worker :8193
core→workstation/pc 服务间调用走 LAN(共址直连,AGENTS.md 跨地区访问原则)。
"""
from __future__ import annotations

import asyncio
import time
from datetime import datetime, timedelta, timezone

import httpx
from fastapi import APIRouter, Depends
from sqlalchemy import func
from sqlmodel import Session, select

from app.db import get_session
from app.deps import get_current_admin
from app.models import Job, User

router = APIRouter(tags=["observability"])

_CACHE_TTL_SEC = 10.0
_PROBE_TIMEOUT_SEC = 2.0
_SUCCESS_WINDOW_HOURS = 24

# (卡 id, 主机说明, [(实例名, base_url), ...]) —— 拓扑变更时同步模块 docstring。
GPU_TOPOLOGY: list[tuple[str, str, list[tuple[str, str]]]] = [
    ("GPU0", "workstation · ComfyUI 通用", [
        ("ComfyUI 通用", "http://192.168.71.127:8189"),
    ]),
    ("GPU1", "workstation · Embedding/LiveAct/超分", [
        ("超分 #1", "http://192.168.71.127:8261"),
    ]),
    ("GPU2", "workstation · H3/LongCat/ASR/超分", [
        ("H3 主力视频", "http://192.168.71.127:8195"),
        ("LongCat", "http://192.168.71.127:8197"),
        ("超分 #2", "http://192.168.71.127:8262"),
    ]),
    ("GPU3", "workstation · FlashTalk/超分", [
        ("超分 #3", "http://192.168.71.127:8263"),
    ]),
    ("PC01", "pc01 · RTX 5090 ComfyUI worker", [
        ("ComfyUI worker", "http://192.168.71.115:8188"),
    ]),
    ("PC02", "pc02 · RTX 5090 ComfyUI worker", [
        ("ComfyUI worker", "http://192.168.71.114:8193"),
    ]),
]

_GB = 1024**3

_cache: dict | None = None
_cache_at: float = 0.0
_cache_lock = asyncio.Lock()


def reset_observability_cache() -> None:
    """清空快照缓存(测试隔离/运维即时刷新用)。"""
    global _cache, _cache_at
    _cache = None
    _cache_at = 0.0


async def _fetch_instance_stats(client: httpx.AsyncClient, url: str) -> dict:
    """拉一个 ComfyUI 实例的 /system_stats + /queue;异常向上抛,由调用方降级。"""
    stats_res, queue_res = await asyncio.gather(
        client.get(f"{url}/system_stats"),
        client.get(f"{url}/queue"),
    )
    stats_res.raise_for_status()
    queue_res.raise_for_status()
    devices = stats_res.json().get("devices", [])
    if not devices:
        raise ValueError("system_stats 无 devices")
    dev = devices[0]
    total = float(dev.get("vram_total") or 0)
    free = float(dev.get("vram_free") or 0)
    if total <= 0:
        raise ValueError("vram_total 非法")
    body = queue_res.json()
    return {
        "vram_total": total,
        "vram_free": free,
        "queue_running": len(body.get("queue_running", [])),
        "queue_pending": len(body.get("queue_pending", [])),
    }


async def _probe_instance(client: httpx.AsyncClient, name: str, url: str) -> dict:
    """探测单实例;任何失败降级为 online=false(不拖垮整接口)。"""
    base = {"name": name, "url": url, "online": False,
            "vram_total_gb": None, "vram_used_gb": None, "vram_used_pct": None,
            "queue_running": 0, "queue_pending": 0}
    try:
        stats = await _fetch_instance_stats(client, url)
    except Exception:
        return base
    used = stats["vram_total"] - stats["vram_free"]
    return {
        **base,
        "online": True,
        "vram_total_gb": round(stats["vram_total"] / _GB, 1),
        "vram_used_gb": round(used / _GB, 1),
        "vram_used_pct": round(used / stats["vram_total"] * 100, 1),
        "queue_running": stats["queue_running"],
        "queue_pending": stats["queue_pending"],
    }


async def _probe_gpus() -> list[dict]:
    """并行探测拓扑内全部实例,按卡归并(卡级 VRAM 取在线实例 max——整卡口径)。"""
    timeout = httpx.Timeout(_PROBE_TIMEOUT_SEC)
    async with httpx.AsyncClient(timeout=timeout) as client:
        per_card = await asyncio.gather(*(
            asyncio.gather(*(_probe_instance(client, n, u) for n, u in instances))
            for _card_id, _host, instances in GPU_TOPOLOGY
        ))
    cards: list[dict] = []
    for (card_id, host, _instances), instances in zip(GPU_TOPOLOGY, per_card):
        online_insts = [i for i in instances if i["online"]]
        vram_total = max((i["vram_total_gb"] for i in online_insts), default=None)
        vram_used = max((i["vram_used_gb"] for i in online_insts), default=None)
        cards.append({
            "id": card_id,
            "host": host,
            "online": bool(online_insts),
            "vram_total_gb": vram_total,
            "vram_used_gb": vram_used,
            "vram_used_pct": (
                round(vram_used / vram_total * 100, 1)
                if vram_total and vram_used is not None else None
            ),
            "queue_running": sum(i["queue_running"] for i in instances),
            "queue_pending": sum(i["queue_pending"] for i in instances),
            "instances": instances,
        })
    return cards


_ACTIVE_STATUSES = ("queued", "held", "running")


def _queue_snapshot(session: Session) -> tuple[dict, dict, dict]:
    """DB 侧三路聚合:队列分桶 / 24h 成功率 / held 原因分布。"""
    rows = session.exec(
        select(Job.status, func.count())
        .where(Job.deleted_at.is_(None))
        .group_by(Job.status)
    ).all()
    counts = {status: n for status, n in rows}
    queue = {s: counts.get(s, 0) for s in _ACTIVE_STATUSES}
    terminal = {"done", "error"}
    queue["other"] = sum(
        n for s, n in counts.items() if s not in _ACTIVE_STATUSES and s not in terminal
    )

    since = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(
        hours=_SUCCESS_WINDOW_HOURS
    )
    win_rows = session.exec(
        select(Job.status, func.count())
        .where(Job.deleted_at.is_(None), Job.created_at >= since,
               Job.status.in_(["done", "error"]))
        .group_by(Job.status)
    ).all()
    win = {status: n for status, n in win_rows}
    done = win.get("done", 0)
    error = win.get("error", 0)
    total = done + error
    success = {
        "window_hours": _SUCCESS_WINDOW_HOURS,
        "done": done,
        "error": error,
        "total": total,
        "rate": round(done / total, 4) if total > 0 else None,
    }

    reason_rows = session.exec(
        select(Job.hold_reason, func.count())
        .where(Job.deleted_at.is_(None), Job.status == "held")
        .group_by(Job.hold_reason)
    ).all()
    reasons = sorted(
        ({"reason": r or "(无原因记录)", "count": n} for r, n in reason_rows),
        key=lambda x: x["count"],
        reverse=True,
    )
    held = {"total": queue["held"], "reasons": reasons[:5]}
    return queue, success, held


async def _build_snapshot(session: Session) -> dict:
    queue, success, held = _queue_snapshot(session)
    gpus = await _probe_gpus()
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "cache_ttl_sec": int(_CACHE_TTL_SEC),
        "queue": queue,
        "success_24h": success,
        "held": held,
        "gpus": gpus,
    }


@router.get("/observability")
async def observability(
    _: User = Depends(get_current_admin),
    session: Session = Depends(get_session),
) -> dict:
    """观测面板聚合快照(队列分桶 + 24h 成功率 + GPU 卡 VRAM)。仅管理员。"""
    global _cache, _cache_at
    now = time.monotonic()
    if _cache is not None and now - _cache_at < _CACHE_TTL_SEC:
        return _cache
    async with _cache_lock:
        # 双检:等锁期间可能已被并发请求重建
        now = time.monotonic()
        if _cache is not None and now - _cache_at < _CACHE_TTL_SEC:
            return _cache
        snapshot = await _build_snapshot(session)
        _cache = snapshot
        _cache_at = time.monotonic()
        return snapshot
