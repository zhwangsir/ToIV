"""ComfyUI worker 池 —— 多 GPU 水平扩展的接缝。

P0 通常只配置一个 worker；但 pick() 已按队列长度选最闲实例。
P2 把 4 张 GPU 各自的 ComfyUI 进程地址填进 TOIV_COMFY_WORKERS，即可零改动水平扩展。
"""
from __future__ import annotations

import asyncio

from app.comfy.client import ComfyUIClient

_UNREACHABLE = 10**9


class WorkerPool:
    def __init__(self, clients: list[ComfyUIClient]):
        if not clients:
            raise ValueError("WorkerPool 至少需要一个 ComfyUI worker")
        self._clients = list(clients)
        self._rr = 0  # 轮询计数,用于在负载相同的 worker 间均匀分配

    @property
    def clients(self) -> list[ComfyUIClient]:
        return list(self._clients)

    async def pick(self) -> ComfyUIClient:
        """选队列最短的 worker;若多个并列(如都空闲),则在它们之间轮询,
        确保并发任务真正分散到多张 GPU,而非总落到第一个。"""
        if len(self._clients) == 1:
            return self._clients[0]

        async def load(c: ComfyUIClient) -> int:
            try:
                return await c.queue_len()
            except Exception:
                return _UNREACHABLE

        loads = await asyncio.gather(*(load(c) for c in self._clients))
        min_load = min(loads)
        candidates = [i for i, value in enumerate(loads) if value == min_load]
        chosen = candidates[self._rr % len(candidates)]
        self._rr += 1
        return self._clients[chosen]

    @classmethod
    def from_urls(cls, urls: list[str], timeout: float = 30.0) -> "WorkerPool":
        return cls([ComfyUIClient(u, timeout=timeout) for u in urls])
