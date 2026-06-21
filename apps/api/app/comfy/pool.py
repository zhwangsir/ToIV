"""ComfyUI worker 池 —— 多 GPU 水平扩展的接缝。

P0 通常只配置一个 worker；但 pick() 已按队列长度选最闲实例。
P2 把 4 张 GPU 各自的 ComfyUI 进程地址填进 TOIV_COMFY_WORKERS，即可零改动水平扩展。
"""
from __future__ import annotations

import asyncio
from collections.abc import Iterable

from app.comfy.client import ComfyUIClient, ComfyUIError

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

    async def pick(self, required: Iterable[str] = ()) -> ComfyUIClient:
        """选一个可用 worker:可达 + 拥有 required 里全部模型,在并列最闲者间轮询。

        required 为空时退化为纯"最闲 + 轮询"。多机异构(不同卡装不同模型)下,
        据此把任务只路由到具备对应模型的节点,避免路由到缺模型的 worker 而失败。
        """
        required = set(required)
        if not required and len(self._clients) == 1:
            return self._clients[0]

        async def probe(c: ComfyUIClient) -> tuple[bool, int]:
            try:
                ql = await c.queue_len()
            except Exception:
                return (False, _UNREACHABLE)  # 不可达
            if required:
                try:
                    if not required.issubset(await c.model_names()):
                        return (False, ql)  # 缺所需模型
                except Exception:
                    return (False, ql)
            return (True, ql)

        probed = await asyncio.gather(*(probe(c) for c in self._clients))
        capable = [(i, ql) for i, (ok, ql) in enumerate(probed) if ok]
        if not capable:
            raise ComfyUIError("没有具备所需模型且可用的 worker")
        min_load = min(ql for _, ql in capable)
        candidates = [i for i, ql in capable if ql == min_load]
        chosen = candidates[self._rr % len(candidates)]
        self._rr += 1
        return self._clients[chosen]

    @classmethod
    def from_urls(cls, urls: list[str], timeout: float = 30.0) -> "WorkerPool":
        return cls([ComfyUIClient(u, timeout=timeout) for u in urls])
