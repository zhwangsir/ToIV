"""ToIV 系统指标小服务(sysmetrics,:9403)—— workstation 本机系统指标。

GET /metrics 返回:
- cpu:percent(采样 0.1s /proc/stat 差分)+ load1/5/15 + cores;
- memory:total/used/available/used_pct(/proc/meminfo,GB);
- disk_root:/ 分区用量(shutil.disk_usage);
- nas:/home/merlin/nas_mount —— 先 os.path.ismount 验证,mounted=false 时
  不再 df(防读到根分区假数据),用量字段为 null;
- gpus:nvidia-smi --query-gpu CSV 解析(used/total MiB、pct、温度);
  nvidia-smi 缺失/失败时 gpus=null 降级,接口不炸。

设计约束:仅依赖 fastapi/uvicorn,指标采集全 stdlib,任何单项失败只影响该字段。
"""
from __future__ import annotations

import os
import shutil
import subprocess
import time

from fastapi import FastAPI

NAS_MOUNTPOINT = "/home/merlin/nas_mount"
_GB = 1024**3

app = FastAPI(title="toiv-sysmetrics")


def _cpu() -> dict:
    def read_stat() -> tuple[int, int]:
        with open("/proc/stat", encoding="utf-8") as f:
            parts = f.readline().split()[1:]
        nums = [int(x) for x in parts]
        idle = nums[3] + (nums[4] if len(nums) > 4 else 0)  # idle + iowait
        return sum(nums), idle

    try:
        total0, idle0 = read_stat()
        time.sleep(0.1)
        total1, idle1 = read_stat()
        dt, di = total1 - total0, idle1 - idle0
        percent = round((1 - di / dt) * 100, 1) if dt > 0 else None
    except Exception:
        percent = None
    try:
        load1, load5, load15 = (round(x, 2) for x in os.getloadavg())
    except OSError:
        load1 = load5 = load15 = None
    return {
        "percent": percent,
        "load1": load1, "load5": load5, "load15": load15,
        "cores": os.cpu_count(),
    }


def _memory() -> dict:
    info: dict[str, int] = {}
    with open("/proc/meminfo", encoding="utf-8") as f:
        for line in f:
            key, _, rest = line.partition(":")
            info[key] = int(rest.strip().split()[0])  # kB
    total = info["MemTotal"] / 1024**2
    available = info.get("MemAvailable", info.get("MemFree", 0)) / 1024**2
    used = total - available
    return {
        "total_gb": round(total, 1),
        "used_gb": round(used, 1),
        "available_gb": round(available, 1),
        "used_pct": round(used / total * 100, 1) if total > 0 else None,
    }


def _disk(path: str) -> dict:
    usage = shutil.disk_usage(path)
    return {
        "total_gb": round(usage.total / _GB, 1),
        "used_gb": round(usage.used / _GB, 1),
        "free_gb": round(usage.free / _GB, 1),
        "used_pct": round(usage.used / usage.total * 100, 1) if usage.total else None,
    }


def _nas() -> dict:
    # 先验证挂载再 df:mount 掉了读到的会是根分区,标 mounted=false 给面板告警
    mounted = os.path.ismount(NAS_MOUNTPOINT)
    result: dict = {"mountpoint": NAS_MOUNTPOINT, "mounted": mounted,
                    "total_gb": None, "used_gb": None, "free_gb": None}
    if mounted:
        try:
            result.update(_disk(NAS_MOUNTPOINT))
        except OSError:
            pass
    return result


def _gpus() -> list[dict] | None:
    # systemd 默认 PATH 极简(Environment= 空),必须用绝对路径
    binary = shutil.which("nvidia-smi") or "/usr/bin/nvidia-smi"
    try:
        out = subprocess.run(
            [binary,
             "--query-gpu=index,name,memory.used,memory.total,temperature.gpu",
             "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=5, check=True,
        ).stdout
    except Exception:
        return None
    gpus = []
    for line in out.strip().splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) < 5:
            continue
        used, total = float(parts[2]), float(parts[3])
        gpus.append({
            "index": int(parts[0]),
            "name": parts[1],
            "vram_used_mb": int(used),
            "vram_total_mb": int(total),
            "vram_used_pct": round(used / total * 100, 1) if total > 0 else None,
            "temp_c": int(float(parts[4])),
        })
    return gpus or None


@app.get("/metrics")
def metrics() -> dict:
    body: dict = {"cpu": None, "memory": None, "disk_root": None,
                  "nas": None, "gpus": None}
    for key, fn in (("cpu", _cpu), ("memory", _memory),
                    ("disk_root", lambda: _disk("/")), ("nas", _nas),
                    ("gpus", _gpus)):
        try:
            body[key] = fn()
        except Exception:
            pass  # 单项失败只置空该字段,接口不炸
    return body


@app.get("/health")
def health() -> dict:
    return {"ok": True}
