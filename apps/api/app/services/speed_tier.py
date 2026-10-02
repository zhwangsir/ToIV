"""速度分档(INTENT e):快速 / 精细。

用户可见两档(少字):
  - quality(精细,默认):原生参数,不加速
  - fast(快速):H3 家族映射 acceleration=balanced;非 H3 有采样步数时折半(下限 4)

字段写入 Job.params.speed_tier;执行路径必须真正改图,禁止空装饰。
显式 acceleration!=off 时优先进阶加速档(兼容旧 H3AccelSelect)。
"""
from __future__ import annotations

import copy
from typing import Any

SPEED_TIERS: tuple[str, ...] = ("fast", "quality")
DEFAULT_SPEED_TIER = "quality"

# 快速档折半步数下限(过低易糊/崩图)
_FAST_STEPS_FLOOR = 4

# 采样步数字段常见落点(与 h3_accel 对齐)
_STEP_NODE_TYPES = ("BasicScheduler", "KSampler", "KSamplerAdvanced", "SamplerCustom")


def validate_speed_tier(v: object) -> str:
    """归一 speed_tier;非法值抛 ValueError(供 pydantic field_validator)。"""
    if v is None or v == "":
        return DEFAULT_SPEED_TIER
    if not isinstance(v, str):
        raise ValueError("speed_tier 须为 fast / quality")
    tier = v.strip().lower()
    if tier not in SPEED_TIERS:
        raise ValueError(f"speed_tier 须为 {' / '.join(SPEED_TIERS)} 之一")
    return tier


def resolve_h3_acceleration(speed_tier: str, explicit_accel: str = "off") -> str:
    """H3 家族:显式 acceleration 优先;否则 quality→off / fast→balanced。"""
    accel = (explicit_accel or "off").strip().lower() or "off"
    if accel != "off":
        return accel
    tier = validate_speed_tier(speed_tier)
    return "balanced" if tier == "fast" else "off"


def apply_fast_steps(graph: dict[str, Any], speed_tier: str) -> tuple[dict[str, Any], bool, dict[str, Any]]:
    """非 H3:fast 时把采样 steps 折半(≥4);quality 原样。

    返回 (新图, 是否改写, 元数据{patched_nodes, before→after})。
    """
    tier = validate_speed_tier(speed_tier)
    meta: dict[str, Any] = {"patched": [], "tier": tier}
    if tier != "fast":
        return graph, False, meta
    if not isinstance(graph, dict) or not graph:
        return graph, False, meta

    out = copy.deepcopy(graph)
    patched = False
    for nid, node in out.items():
        if not isinstance(node, dict):
            continue
        ctype = node.get("class_type")
        if ctype not in _STEP_NODE_TYPES:
            continue
        inputs = node.get("inputs")
        if not isinstance(inputs, dict) or "steps" not in inputs:
            continue
        raw = inputs["steps"]
        # 连线(list)不改;只改数值叶子
        if isinstance(raw, list):
            continue
        try:
            steps = int(raw)
        except (TypeError, ValueError):
            continue
        if steps <= _FAST_STEPS_FLOOR:
            continue
        new_steps = max(_FAST_STEPS_FLOOR, steps // 2)
        if new_steps == steps:
            continue
        inputs["steps"] = new_steps
        patched = True
        meta["patched"].append(
            {"node": str(nid), "class_type": ctype, "steps_before": steps, "steps_after": new_steps}
        )
    return out, patched, meta


def describe_tier(speed_tier: str) -> str:
    """中文短标签(前端/日志)。"""
    return "快速" if validate_speed_tier(speed_tier) == "fast" else "精细"
