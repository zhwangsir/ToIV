"""设备舰队主动探测引擎(services/fleet.py)。

模式与 routes/observability.py 一致:整网一次并发探测 → 15s 缓存(asyncio.Lock
单飞重建)→ 缓存重建时采样一条进进程内环形缓冲(10-15s 粒度,maxlen 720 ≈ 2h+)。

探测语义:
- http:短超时 GET,任何 HTTP 响应(含 404/405)= up,记 status_code + latency_ms;
  kind="comfyui" 再拉 /system_stats 带 VRAM(extra.vram_*);
  kind="vllm" 解析 /v1/models 模型 id 列表(extra.models);
- tcp:纯 connect,通即 up;
- none:声明式占位,恒 unknown,不计入 services_up/total;
- 任何异常(拒绝/超时/DNS)降级 status=down,绝不向上抛——设备离线是正常态。

设备级 online:任一服务 up → True;全部 down → False;全部 unknown → None(灰点)。
headline 一句话指标:workstation 取 sysmetrics GPU VRAM 峰值,NAS 取剩余空间,
其余默认 "x/y 服务在线" / "离线" / "未知"。
"""
from __future__ import annotations

import asyncio
import time
from collections import deque
from datetime import datetime, timezone

import httpx

from app.services.fleet_registry import DEVICE_REGISTRY, DEVICES_BY_ID, SYSMETRICS_URL

HTTP_TIMEOUT_SEC = 2.0
TCP_TIMEOUT_SEC = 1.5
CACHE_TTL_SEC = 15.0
_SERIES_MAXLEN = 720  # ≈ 2h+ @ 15s 缓存周期(缓存重建才采样)

_GB = 1024**3

_cache: dict | None = None
_cache_at: float = 0.0
_cache_lock = asyncio.Lock()

# 时序环形缓冲:{ts, devices: {device_id: {"online": 0/1/None, "latency": {svc: ms|None}}}}
_series: deque[dict] = deque(maxlen=_SERIES_MAXLEN)


def reset_fleet_cache() -> None:
    """清空快照缓存与时序缓冲(测试隔离/运维即时刷新用)。"""
    global _cache, _cache_at
    _cache = None
    _cache_at = 0.0
    _series.clear()


# ─────────────────────────── 单服务探测 ───────────────────────────


async def _probe_tcp(host: str, port: int) -> tuple[bool, float | None]:
    """TCP connect 探测;返回 (通否, 延迟ms)。任何异常 → (False, None)。"""
    t0 = time.monotonic()
    try:
        reader, writer = await asyncio.wait_for(
            asyncio.open_connection(host, port), timeout=TCP_TIMEOUT_SEC
        )
        writer.close()
        try:
            await writer.wait_closed()
        except Exception:
            pass
        return True, round((time.monotonic() - t0) * 1000, 1)
    except Exception:
        return False, None


async def _comfyui_extra(client: httpx.AsyncClient, base: str) -> dict:
    """ComfyUI 实例顺手带 VRAM/队列(/system_stats + /queue);失败返回 {}。"""
    try:
        stats_res, queue_res = await asyncio.gather(
            client.get(f"{base}/system_stats"), client.get(f"{base}/queue")
        )
        stats_res.raise_for_status()
        devices = stats_res.json().get("devices", [])
        if not devices:
            return {}
        dev = devices[0]
        total = float(dev.get("vram_total") or 0)
        free = float(dev.get("vram_free") or 0)
        if total <= 0:
            return {}
        queue_body = queue_res.json() if queue_res.status_code == 200 else {}
        used = total - free
        return {
            "vram_total_gb": round(total / _GB, 1),
            "vram_used_gb": round(used / _GB, 1),
            "vram_used_pct": round(used / total * 100, 1),
            "queue_running": len(queue_body.get("queue_running", [])),
            "queue_pending": len(queue_body.get("queue_pending", [])),
        }
    except Exception:
        return {}


async def _vllm_extra(client: httpx.AsyncClient, base: str) -> dict:
    """vLLM /v1/models → 模型 id 列表;失败返回 {}。"""
    try:
        res = await client.get(f"{base}/v1/models")
        res.raise_for_status()
        ids = [m.get("id") for m in res.json().get("data", []) if m.get("id")]
        return {"models": ids}
    except Exception:
        return {}


async def _probe_service(client: httpx.AsyncClient, host: str, svc: dict) -> dict:
    """探测单服务;永不抛异常,失败降级 status=down。"""
    base = {"name": svc["name"], "port": svc["port"], "status": "unknown",
            "latency_ms": None, "extra": {}}
    if svc.get("note"):
        base["note"] = svc["note"]
    probe = svc.get("probe", "none")
    if probe == "none":
        return base
    if probe == "tcp":
        ok, latency = await _probe_tcp(host, svc["port"])
        return {**base, "status": "up" if ok else "down", "latency_ms": latency}
    # http:任何 HTTP 响应即 up(404/405 也算——进程活着,只是没这个路由)
    t0 = time.monotonic()
    try:
        res = await client.get(f"http://{host}:{svc['port']}{svc.get('path', '/')}")
        latency = round((time.monotonic() - t0) * 1000, 1)
        extra: dict = {"status_code": res.status_code}
        url_base = f"http://{host}:{svc['port']}"
        if svc.get("kind") == "comfyui":
            extra.update(await _comfyui_extra(client, url_base))
        elif svc.get("kind") == "vllm":
            extra.update(await _vllm_extra(client, url_base))
        return {**base, "status": "up", "latency_ms": latency, "extra": extra}
    except Exception:
        return {**base, "status": "down"}


# ─────────────────────────── sysmetrics ───────────────────────────


async def _fetch_sysmetrics(client: httpx.AsyncClient) -> dict | None:
    """拉 workstation :9403 系统指标;不可达返回 None(详情页 sys=null 降级)。"""
    try:
        res = await client.get(SYSMETRICS_URL)
        res.raise_for_status()
        return res.json()
    except Exception:
        return None


# ─────────────────────────── 聚合 ───────────────────────────


def _headline(device: dict, services: list[dict], sysm: dict | None) -> str:
    """设备卡一句话关键指标。"""
    up = sum(1 for s in services if s["status"] == "up")
    total = sum(1 for s in services if s["status"] != "unknown")
    if device["id"] == "workstation" and sysm:
        gpus = sysm.get("gpus") or []
        pcts = [g.get("vram_used_pct") for g in gpus if g.get("vram_used_pct") is not None]
        if pcts:
            return f"VRAM 峰值 {max(pcts):.0f}% · RAM {sysm['memory']['used_pct']:.0f}%"
    if device["id"] == "nas" and sysm:
        nas = sysm.get("nas") or {}
        if nas.get("mounted") and nas.get("free_gb") is not None:
            free = nas["free_gb"]
            return f"NAS 剩 {free / 1024:.1f}T" if free >= 1024 else f"NAS 剩 {free:.0f}G"
        if nas.get("mounted") is False:
            return "NAS 未挂载!"
    if total == 0:
        return "状态未知"
    if up == 0:
        return "全部离线"
    return f"{up}/{total} 服务在线"


async def _probe_device(client: httpx.AsyncClient, device: dict,
                        sysm: dict | None) -> dict:
    services = await asyncio.gather(*(
        _probe_service(client, device["probe_host"], svc) for svc in device["services"]
    ))
    services = list(services)
    up = sum(1 for s in services if s["status"] == "up")
    total = sum(1 for s in services if s["status"] != "unknown")
    if total == 0:
        online = None
    else:
        online = up > 0
    result = {
        "id": device["id"],
        "name": device["name"],
        "role": device["role"],
        "online": online,
        "services_up": up,
        "services_total": total,
        "services": services,
        "headline": _headline(device, services, sysm),
    }
    # sysmetrics:workstation 挂全量;NAS 只取 nas 段(挂载点在工作站上观测)
    if device.get("sysmetrics"):
        result["sys"] = sysm
    elif device["id"] == "nas" and sysm:
        result["sys"] = {"nas": sysm.get("nas")}
    else:
        result["sys"] = None
    return result


def _sample_series(snapshot: dict) -> None:
    _series.append({
        "ts": snapshot["generated_at"],
        "devices": {
            d["id"]: {
                "online": None if d["online"] is None else (1 if d["online"] else 0),
                "latency": {s["name"]: s["latency_ms"] for s in d["services"]},
            }
            for d in snapshot["devices"]
        },
    })


def _series_payload(device_id: str) -> dict:
    """设备详情时序:online 0/1 + 各服务延迟数组(等长对齐,未知/离线 null)。"""
    samples = list(_series)
    svc_names = [s["name"] for s in DEVICES_BY_ID[device_id]["services"]]
    return {
        "timestamps": [s["ts"] for s in samples],
        "online": [s["devices"].get(device_id, {}).get("online") for s in samples],
        "latency": {
            name: [s["devices"].get(device_id, {}).get("latency", {}).get(name)
                   for s in samples]
            for name in svc_names
        },
    }


async def build_snapshot() -> dict:
    """全设备并发探测(单飞缓存内调用)。总耗时 ≈ 最慢单探测(<2.5s)。"""
    timeout = httpx.Timeout(HTTP_TIMEOUT_SEC)
    async with httpx.AsyncClient(timeout=timeout) as client:
        sysm, *device_results = await asyncio.gather(
            _fetch_sysmetrics(client),
            *(_probe_device(client, d, None) for d in DEVICE_REGISTRY),
        )
    # sysmetrics 是 gather 第一批拿不到的依赖(设备 headline 要用),补一轮纯聚合:
    # 不重探,直接把 sysm 注入各设备结果并重算 headline/sys 字段。
    devices = []
    for spec, result in zip(DEVICE_REGISTRY, device_results):
        if spec.get("sysmetrics"):
            result["sys"] = sysm
        elif spec["id"] == "nas" and sysm:
            result["sys"] = {"nas": sysm.get("nas")}
        result["headline"] = _headline(spec, result["services"], sysm)
        devices.append(result)
    snapshot = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "cache_ttl_sec": int(CACHE_TTL_SEC),
        "devices": devices,
    }
    _sample_series(snapshot)
    return snapshot


async def get_snapshot() -> dict:
    """15s 缓存 + asyncio.Lock 单飞(照 observability 模式)。"""
    global _cache, _cache_at
    now = time.monotonic()
    if _cache is not None and now - _cache_at < CACHE_TTL_SEC:
        return _cache
    async with _cache_lock:
        now = time.monotonic()
        if _cache is not None and now - _cache_at < CACHE_TTL_SEC:
            return _cache
        snapshot = await build_snapshot()
        _cache = snapshot
        _cache_at = time.monotonic()
        return snapshot


def device_detail(snapshot: dict, device_id: str) -> dict | None:
    """快照切片 → 设备详情(meta + services + sys + series)。"""
    spec = DEVICES_BY_ID.get(device_id)
    if spec is None:
        return None
    result = next((d for d in snapshot["devices"] if d["id"] == device_id), None)
    if result is None:
        return None
    return {
        "id": spec["id"],
        "name": spec["name"],
        "role": spec["role"],
        "meta": {
            "lan_ip": spec.get("lan_ip"),
            "ts_ip": spec.get("ts_ip"),
            "hardware": spec.get("hardware"),
        },
        "online": result["online"],
        "services_up": result["services_up"],
        "services_total": result["services_total"],
        "headline": result["headline"],
        "services": result["services"],
        "sys": result["sys"],
        "series": _series_payload(device_id),
        "generated_at": snapshot["generated_at"],
    }
