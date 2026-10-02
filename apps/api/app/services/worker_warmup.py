"""热门卡空闲预热(02:41 / 03:20 父代理)。

目标:文生图 / H3 / 音乐在空闲 worker 上常驻,避免用户首枪冷启动 ~110s。
约束:
- **禁止**向 :8196 生产口与 :8205 提交预热(03:20 硬性)
- 预热只走 :8195 / :8261–:8263 空闲口
- 不清 :8196 缓存、不 interrupt 生产任务、不开 :8205、不用 cuda:3
- 目标 worker 队列非空则跳过
- 预热作业标记 filename_prefix=ToIV_warmup/*,产物可丢
"""
from __future__ import annotations

import asyncio
import json
import logging
import secrets
import uuid
from typing import Any
from urllib.parse import urlparse

import httpx

from app.config import get_settings

log = logging.getLogger("toiv.worker_warmup")

# 生产口 / 禁开端口:预热绝不提交
_FORBIDDEN_WARMUP_PORTS = frozenset({8196, 8205})
# 允许预热的端口(父代理 03:20)
_ALLOWED_WARMUP_PORTS = frozenset({8195, 8261, 8262, 8263})


def _port_of(url: str) -> int | None:
    try:
        p = urlparse(url if "://" in url else f"http://{url}")
        if p.port is not None:
            return int(p.port)
        return 443 if p.scheme == "https" else 80
    except Exception:  # noqa: BLE001
        return None


def is_warmup_allowed_url(url: str) -> bool:
    """预热目标是否允许(禁 :8196/:8205;仅 :8195/:8261-8263)。"""
    port = _port_of((url or "").strip())
    if port is None:
        return False
    if port in _FORBIDDEN_WARMUP_PORTS:
        return False
    return port in _ALLOWED_WARMUP_PORTS


def warmup_pool_urls(settings: Any | None = None) -> list[str]:
    """文生图/音乐预热候选:优先超分口 :8261-8263,再 :8195;永不含 :8196。"""
    s = settings or get_settings()
    out: list[str] = []
    seen: set[str] = set()

    def _add(raw: str) -> None:
        u = (raw or "").strip().rstrip("/")
        if not u or u in seen:
            return
        if not is_warmup_allowed_url(u):
            return
        seen.add(u)
        out.append(u)

    # upscale fleet 先(常装通用图模)
    raw_up = getattr(s, "upscale_workers", "") or ""
    for part in str(raw_up).replace(" ", ",").split(","):
        _add(part)
    # H3 口也可暖图模(若空闲)
    _add(getattr(s, "h3_base_url", "") or "")
    # 若 pool 里误配了允许口也收(但仍滤掉 8196)
    try:
        pool = list(s.worker_urls)
    except Exception:  # noqa: BLE001
        pool = []
    for u in pool:
        _add(u)
    return out


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


async def pick_idle_warmup_worker(candidates: list[str]) -> str | None:
    """按候选顺序取第一个空闲且允许的 worker。"""
    for url in candidates:
        if not is_warmup_allowed_url(url):
            log.warning("warmup skip forbidden url %s", url)
            continue
        q = await fetch_queue(url)
        if _queue_busy(q):
            continue
        return url
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

    if not is_warmup_allowed_url(worker_url):
        log.error("warmup refused forbidden worker %s", worker_url)
        return None
    client = ComfyUIClient(worker_url, timeout=60.0)
    try:
        pid = await client.queue_prompt(graph, client_id=client_id)
        return pid
    except Exception as e:  # noqa: BLE001
        log.warning("warmup submit %s failed: %s", worker_url, e)
        return None


async def warm_one(worker_url: str, kind: str, seed: int) -> dict[str, Any]:
    if not is_warmup_allowed_url(worker_url):
        return {"worker": worker_url, "kind": kind, "status": "skipped_forbidden_port"}
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
    """一轮空闲预热:仅 :8195/:8261-8263;H3 枪走 h3_base(须为允许口)。

    绝不 interrupt / clear。busy 跳过。绝不打 :8196。
    """
    settings = get_settings()
    base_seed = int(seed if seed is not None else secrets.randbelow(2_147_483_647))
    results: list[dict[str, Any]] = []

    pool_candidates = warmup_pool_urls(settings)
    if not pool_candidates:
        results.append({"kind": "txt2img", "status": "skipped_no_allowed_worker"})
    else:
        idle = await pick_idle_warmup_worker(pool_candidates)
        if not idle:
            results.append(
                {
                    "kind": "txt2img",
                    "status": "skipped_all_busy",
                    "candidates": pool_candidates,
                }
            )
        else:
            results.append(await warm_one(idle, "txt2img", base_seed))
            await asyncio.sleep(1.0)
            # 同口若仍空闲再暖音乐;忙则换下一个候选
            idle2 = await pick_idle_warmup_worker(pool_candidates)
            if idle2:
                results.append(await warm_one(idle2, "audio", base_seed + 1))
            else:
                results.append({"kind": "audio", "status": "skipped_all_busy"})

    if include_h3:
        h3 = (settings.h3_base or "").rstrip("/")
        if not h3:
            results.append({"kind": "h3-t2v", "status": "skipped_no_h3"})
        elif not is_warmup_allowed_url(h3):
            results.append({"worker": h3, "kind": "h3-t2v", "status": "skipped_forbidden_port"})
        else:
            results.append(await warm_one(h3, "h3-t2v", base_seed + 2))
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
