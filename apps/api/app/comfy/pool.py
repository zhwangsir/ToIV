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

    async def pick(
        self,
        required: Iterable[str] = (),
        required_nodes: Iterable[str] = (),
    ) -> ComfyUIClient:
        """选一个可用 worker:可达 + 拥有 required 里全部模型 + required_nodes 里全部节点,
        在并列最闲者间轮询。

        required/required_nodes 均空时退化为纯"最闲 + 轮询"。多机异构下据此路由:
        避免派到缺模型(如无 Wan 权重)或缺自定义节点(如 PC01 无 VHS_VideoCombine)的
        worker 而 400。
        """
        required = set(required)
        required_nodes = set(required_nodes)
        if not required and not required_nodes and len(self._clients) == 1:
            return self._clients[0]

        async def probe(c: ComfyUIClient) -> tuple[bool, int]:
            try:
                ql = await c.queue_len()
            except Exception:
                return (False, _UNREACHABLE)  # 不可达
            try:
                if required and not required.issubset(await c.model_names()):
                    return (False, ql)  # 缺所需模型
                if required_nodes and not required_nodes.issubset(await c.node_names()):
                    return (False, ql)  # 缺所需节点(有模型但无 VHS 等自定义节点)
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
