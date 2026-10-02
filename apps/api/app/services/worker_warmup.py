"""热门卡空闲预热(02:41 父代理)。

目标:文生图 / H3 / 音乐在空闲 worker 上常驻,避免用户首枪冷启动 ~110s。
约束:
- 不清 :8196 缓存、不 interrupt 生产任务、不开 :8205、不用 cuda:3
- 目标 worker 队列非空则跳过
- 预热作业标记 filename_prefix=ToIV_warmup/*,产物可丢
"""
from __future__ import annotations

import asyncio
import json
import logging
import secrets
import time
import uuid
from typing import Any

import httpx

from app.config import get_settings

log = logging.getLogger("toiv.worker_warmup")


def _queue_busy(queue_payload: dict[str, Any] | None) -> bool:
    if not isinstance(queue_payload, dict):
        return True  # 探活失败当忙,宁可不预热
    running = queue_payload.get("queue_running") or []
    pending = queue_payload.get("queue_pending") or []
    return bool(running) or bool(pending)


async def fetch_queue(worker_url: str, timeout: float = 5.0) -> dict[str, Any] | None:
    url = worker_url.rstrip("/") + "/queue"
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            r = await client.get(url)
            if r.status_code != 200:
                return None
            return r.json()
    except Exception as e:  # noqa: BLE001
        log.warning("warmup queue probe %s failed: %s", worker_url, e)
        return None


def build_warmup_graph(kind: str, seed: int) -> dict[str, Any]:
    """按 kind 构造最小可加载图(与生产 builder 同码)。"""
    if kind == "txt2img":
        from app.workflows.txt2img import Txt2ImgParams, build_txt2img_graph

        settings = get_settings()
        return build_txt2img_graph(
            Txt2ImgParams(
                positive="warmup keep models hot",
                negative="",
                width=512,
                height=512,
                steps=4,
                seed=seed,
                ckpt_name=settings.default_ckpt,
                filename_prefix="ToIV_warmup/txt2img",
            )
        )
    if kind == "h3-t2v":
        from app.workflows.h3_video import H3T2VParams, build_h3_t2v_graph

        # 最短合法帧网格附近:仍会加载 H3 权重;加速档由节点默认
        return build_h3_t2v_graph(
            H3T2VParams(
                positive="warmup keep H3 hot, short clip",
                width=768,
                height=448,
                length=29,
                steps=8,
                seed=seed,
                filename_prefix="ToIV_warmup/h3",
            )
        )
    if kind == "audio":
        from app.workflows.ace_step import AceStep15Params, build_ace_step_15_graph

        return build_ace_step_15_graph(
            AceStep15Params(
                tags="ambient warmup",
                lyrics="",
                seconds=10.0,
                quality="turbo",
                seed=seed,
                filename_prefix="ToIV_warmup/audio",
            )
        )
    raise ValueError(f"unknown warmup kind: {kind}")


async def submit_prompt(worker_url: str, graph: dict[str, Any], client_id: str) -> str | None:
    from app.comfy.client import ComfyUIClient

    client = ComfyUIClient(worker_url, timeout=60.0)
    try:
        pid = await client.queue_prompt(graph, client_id=client_id)
        return pid
    except Exception as e:  # noqa: BLE001
        log.warning("warmup submit %s failed: %s", worker_url, e)
        return None


async def warm_one(worker_url: str, kind: str, seed: int) -> dict[str, Any]:
    q = await fetch_queue(worker_url)
    if _queue_busy(q):
        return {"worker": worker_url, "kind": kind, "status": "skipped_busy"}
    try:
        graph = build_warmup_graph(kind, seed)
    except Exception as e:  # noqa: BLE001
        return {"worker": worker_url, "kind": kind, "status": "build_fail", "error": str(e)[:200]}
    client_id = f"warmup-{uuid.uuid4().hex[:10]}"
    pid = await submit_prompt(worker_url, graph, client_id)
    if not pid:
        return {"worker": worker_url, "kind": kind, "status": "submit_fail", "seed": seed}
    return {
        "worker": worker_url,
        "kind": kind,
        "status": "submitted",
        "prompt_id": pid,
        "client_id": client_id,
        "seed": seed,
    }


async def warm_popular_idle(*, seed: int | None = None, include_h3: bool = True) -> list[dict[str, Any]]:
    """一轮空闲预热:pool 上文生图+音乐;H3 专用实例单独一枪(可选)。

    绝不 interrupt / clear。busy 跳过。
    """
    settings = get_settings()
    base_seed = int(seed if seed is not None else secrets.randbelow(2_147_483_647))
    results: list[dict[str, Any]] = []
    pool = settings.worker_urls[0] if settings.worker_urls else ""
    if pool:
        results.append(await warm_one(pool, "txt2img", base_seed))
        # 等第一枪进队后再探,避免两枪叠在同 worker;若仍空闲再暖音乐
        await asyncio.sleep(1.0)
        results.append(await warm_one(pool, "audio", base_seed + 1))
    if include_h3 and settings.h3_base:
        results.append(await warm_one(settings.h3_base, "h3-t2v", base_seed + 2))
    return results


async def warmup_loop() -> None:
    """空闲预热循环。"""
    while True:
        settings = get_settings()
        interval = max(60.0, float(getattr(settings, "worker_warmup_interval_sec", 900.0)))
        await asyncio.sleep(interval)
        if not bool(getattr(settings, "worker_warmup_enabled", False)):
            continue
        try:
            out = await warm_popular_idle()
            log.info("worker_warmup tick: %s", json.dumps(out, ensure_ascii=False)[:800])
        except Exception:  # noqa: BLE001
            log.exception("worker_warmup tick failed")
