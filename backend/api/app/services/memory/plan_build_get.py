"""FU4 plan→build→get 会话状态机(纯函数式,无进程内状态)。

设计来源:hypit(修改版 Apache-2.0,单租户本地自用许可,详见 third_party/README.md)
的 plan→build→get 三段式:plan 只声明步骤,build 收步骤结果,get 按显式键
(产物哈希/URL)决定复用。核心纪律(hypit 实践改写):**失败的 build 保留已产出
产物**——failed_step 不清 completed 产物,失败步自己产出的部分产物也保留,
失败步之后的步骤不再执行。本模块全程纯函数:输入数据→输出数据,不持状态,
任意会话可续接由调用方序列化 dataclass 承担。
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Mapping, Sequence

MAX_PLAN_STEPS = 64


class PlanError(ValueError):
    """plan/build/get 入参或状态机约束被破坏。"""


@dataclass(frozen=True)
class Step:
    """一个可构建步骤:produces 声明它应产出的产物键,depends_on 是前置步骤 id。"""

    id: str
    produces: tuple[str, ...] = ()
    depends_on: tuple[str, ...] = ()


@dataclass(frozen=True)
class Artifact:
    """产物:key 为逻辑键,哈希/URL 为 get() 的显式复用键(至少存一)。"""

    key: str
    hash: str | None = None
    url: str | None = None


@dataclass(frozen=True)
class StepResult:
    """build 阶段收到的单步结果;ok=False 时 artifacts 仍可含已产出部分产物。"""

    ok: bool
    artifacts: tuple[Artifact, ...] = ()
    error: str | None = None


@dataclass(frozen=True)
class ReuseCandidate:
    """显式复用候选:按哈希或 URL 键匹配产物,空键不命中任何产物。"""

    hash: str | None = None
    url: str | None = None


@dataclass(frozen=True)
class Plan:
    """plan() 产物:拓扑有序的步骤序列。"""

    steps: tuple[Step, ...] = ()


@dataclass(frozen=True)
class BuildResult:
    """build() 产物:失败保留已产出,completed/failed_step/pending 三态齐全。"""

    completed: tuple[str, ...] = ()
    failed_step: str | None = None
    artifacts: tuple[Artifact, ...] = ()
    pending: tuple[str, ...] = ()
    error: str | None = None


def plan(steps: Sequence[Step], max_steps: int = MAX_PLAN_STEPS) -> Plan:
    """校验步骤声明并拓扑排序;环/重复 id/悬空依赖/超上限一律 PlanError。"""
    if not steps:
        raise PlanError("plan 至少要有一个步骤")
    if len(steps) > max_steps:
        raise PlanError(f"步骤数 {len(steps)} 超过上限 {max_steps}")
    ids: list[str] = []
    for s in steps:
        if not s.id:
            raise PlanError("步骤 id 不能为空")
        ids.append(s.id)
    if len(set(ids)) != len(ids):
        raise PlanError(f"步骤 id 重复:{ids}")
    known = set(ids)
    for s in steps:
        for dep in s.depends_on:
            if dep not in known:
                raise PlanError(f"步骤 {s.id!r} 依赖了不存在的步骤 {dep!r}")
            if dep == s.id:
                raise PlanError(f"步骤 {s.id!r} 依赖自身,构成环")

    # Kahn 拓扑排序:无环时全部出队,剩余即环上的节点
    by_id = {s.id: s for s in steps}
    indegree = {s.id: len(s.depends_on) for s in steps}
    dependents: dict[str, list[str]] = {s.id: [] for s in steps}
    for s in steps:
        for dep in s.depends_on:
            dependents[dep].append(s.id)
    queue = [s.id for s in steps if indegree[s.id] == 0]
    ordered: list[str] = []
    while queue:
        cur = queue.pop(0)
        ordered.append(cur)
        for nxt in dependents[cur]:
            indegree[nxt] -= 1
            if indegree[nxt] == 0:
                queue.append(nxt)
    if len(ordered) != len(ids):
        stuck = [i for i in ids if i not in set(ordered)]
        raise PlanError(f"步骤依赖成环:{stuck}")
    return Plan(steps=tuple(by_id[i] for i in ordered))


def build(plan_: Plan, step_results: Mapping[str, StepResult]) -> BuildResult:
    """按 plan 顺序吸收步骤结果;首个失败步即停,已产出产物全部保留。

    - step_results 含未知步骤 id → PlanError(防拼写错吞成漏跑)。
    - 缺结果的步骤视为未执行,记入 pending;失败步之后的步骤不再执行。
    - failed_step 自身的 partial 产物也保留(hypit:失败 build 仍可供应已完成输出)。
    """
    plan_ids = [s.id for s in plan_.steps]
    for rid in step_results:
        if rid not in plan_ids:
            raise PlanError(f"结果里出现 plan 之外的步骤:{rid!r}")

    completed: list[str] = []
    artifacts: list[Artifact] = []
    failed_step: str | None = None
    error: str | None = None
    pending: list[str] = []

    stopped = False
    for s in plan_.steps:
        if stopped:
            pending.append(s.id)
            continue
        res = step_results.get(s.id)
        if res is None:
            pending.append(s.id)
            continue
        artifacts.extend(res.artifacts)  # 无论成败,已产出都保留
        if res.ok:
            completed.append(s.id)
        else:
            failed_step = s.id
            error = res.error
            stopped = True
    return BuildResult(
        completed=tuple(completed),
        failed_step=failed_step,
        artifacts=tuple(artifacts),
        pending=tuple(pending),
        error=error,
    )


def get(
    result: BuildResult,
    reuse_candidates: Sequence[ReuseCandidate],
) -> tuple[Artifact, ...]:
    """显式复用:候选按哈希或 URL 键精确匹配产物;空键/未命中不复用,结果去重。"""
    by_hash = {a.hash: a for a in result.artifacts if a.hash}
    by_url = {a.url: a for a in result.artifacts if a.url}
    picked: list[Artifact] = []
    seen: set[str] = set()
    for cand in reuse_candidates:
        hit: Artifact | None = None
        if cand.hash:
            hit = by_hash.get(cand.hash)
        if hit is None and cand.url:
            hit = by_url.get(cand.url)
        if hit is not None and hit.key not in seen:
            seen.add(hit.key)
            picked.append(hit)
    return tuple(picked)
