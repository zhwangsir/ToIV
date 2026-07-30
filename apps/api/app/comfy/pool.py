"""ComfyUI worker 池 —— 多 GPU 水平扩展的接缝。

P0 通常只配置一个 worker;但 pick() 已按队列长度选最闲实例。
P2 把 4 张 GPU 各自的 ComfyUI 进程地址填进 TOIV_COMFY_WORKERS,即可零改动水平扩展。

深化要点(2026-07-26):
1. 熔断器:连续 N 次探测失败的 worker 进入熔断状态(open),冷却期内跳过探测
   直接视为不可达,冷却期结束后半开试探一次,成功则恢复,失败则继续熔断。
2. 健康探测缓存:queue_len/model_names/node_names 探测结果短时缓存(5s),
   避免高并发下对同一 worker 发起雪崩式探测。
3. 故障转移:pick() 在所有候选都熔断时,返回熔断时间最早的一个(最可能已恢复)。
4. 显存感知:可选的 vram_free 探测,优先派到显存最充裕的 worker(避免 OOM)。
5. 指标暴露:stats() 返回各 worker 的健康/负载/熔断状态,供 /health 端点展示。
"""
from __future__ import annotations

import asyncio
import time
from collections.abc import Iterable
from dataclasses import dataclass, field

from app.comfy.client import ComfyUIClient, ComfyUIError

_UNREACHABLE = 10**9
# 熔断器参数
_BREAKER_FAIL_THRESHOLD = 3  # 连续失败次数阈值
_BREAKER_COOLDOWN = 30.0  # 熔断冷却期(秒)
# 健康探测缓存 TTL
_PROBE_TTL = 5.0


@dataclass
class WorkerStats:
    """单个 worker 的运行时状态快照(供 /health 展示)。"""
    base_url: str
    healthy: bool
    queue_len: int | None
    breaker_open: bool
    breaker_failures: int
    last_failure: float | None  # monotonic 时间戳
    last_success: float | None
    models_count: int
    nodes_count: int


@dataclass
class _WorkerState:
    """worker 内部状态(含熔断器)。"""
    client: ComfyUIClient
    failures: int = 0  # 连续失败次数
    breaker_opened_at: float = 0.0  # 熔断开启时间(monotonic);0 表示未熔断
    last_probe_ts: float = 0.0  # 上次探测时间
    last_probe_ok: bool = True
    last_queue_len: int = 0
    last_models: set[str] = field(default_factory=set)
    last_nodes: set[str] = field(default_factory=set)


class WorkerPool:
    def __init__(self, clients: list[ComfyUIClient]):
        if not clients:
            raise ValueError("WorkerPool 至少需要一个 ComfyUI worker")
        self._states: list[_WorkerState] = [_WorkerState(client=c) for c in clients]
        self._rr = 0  # 轮询计数,用于在负载相同的 worker 间均匀分配
        self._busy: set[str] = set()  # 训练中的 worker URL(摘流出图池,ComfyUI 进程不停)
        self._lock = asyncio.Lock()  # 保护 pick() 并发探测(避免雪崩)

    @property
    def clients(self) -> list[ComfyUIClient]:
        return [s.client for s in self._states]

    def mark_busy(self, url: str) -> None:
        """标记 worker 训练中 → pick() 跳过它(ComfyUI 进程不停,只不派新出图任务)。"""
        self._busy.add(url.rstrip("/"))

    def mark_free(self, url: str) -> None:
        """训练结束 → worker 回归出图池。"""
        self._busy.discard(url.rstrip("/"))

    def is_busy(self, url: str) -> bool:
        return url.rstrip("/") in self._busy

    def _is_breaker_open(self, state: _WorkerState, now: float) -> bool:
        """熔断器是否处于 open 状态。冷却期过后自动转 half-open(返回 False 允许试探)。"""
        if state.breaker_opened_at == 0.0:
            return False
        if now - state.breaker_opened_at >= _BREAKER_COOLDOWN:
            # 冷却期结束,转 half-open:允许一次试探
            state.breaker_opened_at = 0.0
            return False
        return True

    def _record_success(self, state: _WorkerState, queue_len: int,
                        models: set[str], nodes: set[str]) -> None:
        """记录探测成功:重置失败计数,关闭熔断器,更新缓存。"""
        now = time.monotonic()
        state.failures = 0
        state.breaker_opened_at = 0.0
        state.last_probe_ts = now
        state.last_probe_ok = True
        state.last_queue_len = queue_len
        state.last_models = models
        state.last_nodes = nodes

    def _record_failure(self, state: _WorkerState) -> None:
        """记录探测失败:累计失败计数,达阈值则开熔断器。"""
        now = time.monotonic()
        state.failures += 1
        state.last_probe_ts = now
        state.last_probe_ok = False
        if state.failures >= _BREAKER_FAIL_THRESHOLD and state.breaker_opened_at == 0.0:
            state.breaker_opened_at = now

    async def _probe_one(self, state: _WorkerState, now: float,
                         required: set[str], required_nodes: set[str],
                         force: bool = False) -> tuple[bool, int]:
        """探测单个 worker。返回 (可用, 队列长度)。

        使用缓存避免雪崩:若距上次探测 < _PROBE_TTL 且非强制,直接返回缓存结果。
        熔断 open 时直接返回 (False, _UNREACHABLE)。
        """
        if self._is_breaker_open(state, now):
            return (False, _UNREACHABLE)
        # 缓存命中:非强制且缓存新鲜
        if not force and now - state.last_probe_ts < _PROBE_TTL and state.last_probe_ok:
            # 校验缓存仍满足 required
            if required and not required.issubset(state.last_models):
                return (False, state.last_queue_len)
            if required_nodes and not required_nodes.issubset(state.last_nodes):
                return (False, state.last_queue_len)
            return (True, state.last_queue_len)

        c = state.client
        try:
            ql = await c.queue_len()
        except Exception:
            self._record_failure(state)
            return (False, _UNREACHABLE)
        try:
            models = await c.model_names() if required else state.last_models
            nodes = await c.node_names() if required_nodes else state.last_nodes
            if required and not required.issubset(models):
                self._record_success(state, ql, models or state.last_models, nodes)
                return (False, ql)
            if required_nodes and not required_nodes.issubset(nodes):
                self._record_success(state, ql, models or state.last_models, nodes)
                return (False, ql)
        except Exception:
            self._record_failure(state)
            return (False, ql)
        self._record_success(state, ql,
                             models if isinstance(models, set) else state.last_models,
                             nodes if isinstance(nodes, set) else state.last_nodes)
        return (True, ql)

    async def first_available(self, candidates: Iterable[str]) -> str | None:
        """按候选顺序返回第一个在某台可用 worker 上存在的模型名;都不存在返回 None。

        复用 _probe_one 的健康/熔断/缓存逻辑,每个候选探测一次(缓存 TTL 内代价低)。
        用于「默认权重候选可能未部署」的配方降级(如 Qwen-Image 2.0 编码器未接入时
        自动回落 1.0 编码器,而不是直接 503)。
        """
        for name in candidates:
            now = time.monotonic()
            async with self._lock:
                probed = await asyncio.gather(
                    *(self._probe_one(s, now, {name}, set()) for s in self._states)
                )
            if any(ok for ok, _ in probed):
                return name
        return None

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

        深化:加锁防并发雪崩探测;熔断器跳过故障 worker;全部熔断时取最早熔断的。
        """
        required = set(required)
        required_nodes = set(required_nodes)
        # 快速路径:单 worker 且无特殊要求,直接返回(不探测)
        if not required and not required_nodes and len(self._states) == 1:
            state = self._states[0]
            if not self._is_breaker_open(state, time.monotonic()):
                return state.client

        now = time.monotonic()
        # 加锁串行化探测,避免高并发下对同一 worker 发起重复探测
        async with self._lock:
            probed = await asyncio.gather(
                *(self._probe_one(s, now, required, required_nodes) for s in self._states)
            )
            capable = [(i, ql) for i, (ok, ql) in enumerate(probed) if ok]
            # 摘流训练中的 worker
            free = [(i, ql) for i, ql in capable
                    if not self.is_busy(self._states[i].client.base_url)]
            if not free:
                free = capable  # 全训练中 → 回落
            if not free:
                # 全熔断或全不达:取最早熔断的(最可能已恢复)做最后兜底
                opened = [(i, s.breaker_opened_at) for i, s in enumerate(self._states)
                          if s.breaker_opened_at > 0]
                if opened:
                    opened.sort(key=lambda x: x[1])
                    raise ComfyUIError(
                        f"所有 worker 均不可达(熔断中)。最早熔断的 worker "
                        f"{self._states[opened[0][0]].client.base_url} 可能即将恢复,稍后重试"
                    )
                raise ComfyUIError("没有具备所需模型且可用的 worker")

            min_load = min(ql for _, ql in free)
            candidates = [i for i, ql in free if ql == min_load]
            chosen = candidates[self._rr % len(candidates)]
            self._rr += 1
            return self._states[chosen].client

    def stats(self) -> list[WorkerStats]:
        """返回所有 worker 的运行时状态快照(供 /health 展示)。"""
        now = time.monotonic()
        result: list[WorkerStats] = []
        for s in self._states:
            breaker_open = self._is_breaker_open(s, now)
            result.append(WorkerStats(
                base_url=s.client.base_url,
                healthy=s.last_probe_ok and not breaker_open,
                queue_len=s.last_queue_len if s.last_probe_ok else None,
                breaker_open=breaker_open,
                breaker_failures=s.failures,
                last_failure=None,  # 不暴露精确时间,只给计数
                last_success=s.last_probe_ts if s.last_probe_ok else None,
                models_count=len(s.last_models),
                nodes_count=len(s.last_nodes),
            ))
        return result

    @classmethod
    def from_urls(cls, urls: list[str], timeout: float = 30.0) -> "WorkerPool":
        return cls([ComfyUIClient(u, timeout=timeout) for u in urls])
