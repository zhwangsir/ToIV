"""提交时种子策略(INTENT e / 02:17·02:41 父代理)。

规则:
  - 用户显式传 seed → 全图所有 seed/noise_seed 数值叶子写同一值(可复现)
  - 用户未传 → 每次随机一个 int,写进全图 seed 类叶子(等同 control_after_generate=randomize)
  - 连线(list)叶子不改
  - 不依赖 params_schema 是否声明 seed;API 把 seed 当保留可选参数
"""
from __future__ import annotations

import secrets
from typing import Any

SEED_LEAF_NAMES: frozenset[str] = frozenset({"seed", "noise_seed"})
# Comfy INT seed 常用 32-bit 正区间;与多数 UI 一致
_SEED_MAX = 2**31 - 1


def parse_user_seed(values: dict[str, Any] | None) -> int | None:
    """从表单取用户显式 seed;空/缺省 → None。"""
    if not isinstance(values, dict):
        return None
    v = values.get("seed")
    if v is None or v == "":
        return None
    try:
        n = int(v) if not isinstance(v, bool) else None
    except (TypeError, ValueError):
        return None
    if n is None or n < 0:
        return None
    return n


def apply_seed_policy(graph: dict[str, Any], values: dict[str, Any] | None = None) -> int:
    """按策略改写图内全部 seed/noise_seed 数值叶子,返回实际使用的 seed。"""
    if not isinstance(graph, dict) or not graph:
        chosen = parse_user_seed(values)
        return chosen if chosen is not None else secrets.randbelow(_SEED_MAX + 1)

    chosen = parse_user_seed(values)
    if chosen is None:
        chosen = secrets.randbelow(_SEED_MAX + 1)

    for node in graph.values():
        if not isinstance(node, dict):
            continue
        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            continue
        for key in SEED_LEAF_NAMES:
            if key not in inputs:
                continue
            raw = inputs[key]
            if isinstance(raw, list):  # 连线
                continue
            if isinstance(raw, bool):
                continue
            if isinstance(raw, (int, float)):
                inputs[key] = int(chosen)
                continue
            if isinstance(raw, str) and raw.strip():
                try:
                    float(raw.strip())
                except ValueError:
                    continue
                inputs[key] = int(chosen)
    return int(chosen)


def collect_seed_leaves(graph: dict[str, Any]) -> list[tuple[str, str, object]]:
    """调试/测试:列出 (node_id, field, value)。"""
    out: list[tuple[str, str, object]] = []
    for nid, node in (graph or {}).items():
        if not isinstance(node, dict):
            continue
        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            continue
        for key in SEED_LEAF_NAMES:
            if key in inputs:
                out.append((str(nid), key, inputs[key]))
    return out
