"""API 格式 ComfyUI 工作流图静态校验(A2 画布编排,2026-09-21)。

agent 画布提案(propose_canvas_graph)的提交前闸门:与 object_info 对照做
确定性检查,错误返给 LLM 重写,warning 随提案透出给用户。
纯函数,worker 并集 object_info 由调用方供给(app_smoke._union_objinfo)。
"""
from __future__ import annotations

from typing import Any

# ComfyUI 内置非 object_info 类(与前端 canvasFlow 特殊类清单对齐)
_SPECIAL_CLASSES = {"Reroute", "PrimitiveNode", "Note", "MarkdownNote"}
# widget 标量类型(spec[0] 为字符串但属 widget,缺失用节点默认;其余字符串=引用连线型)
_WIDGET_SCALARS = {"INT", "FLOAT", "STRING", "BOOLEAN", "COMBO", "NUMBER"}
# 连线端类型(非 COMBO/widget 的引用槽):值必须是 [node_id, slot] 形态才按连线查
_MAX_NODES = 200


def _combo_opts(raw: Any) -> list[str]:
    """object_info 槽位的 options 提取(兼容 0.34 双形态;与 app_smoke._combo_opts 同语义)。"""
    if isinstance(raw, list) and raw and isinstance(raw[0], list):
        return [str(v) for v in raw[0]]
    if (
        isinstance(raw, list)
        and len(raw) > 1
        and isinstance(raw[1], dict)
        and isinstance(raw[1].get("options"), list)
    ):
        return [str(v) for v in raw[1]["options"]]
    return []


def _spec_has_default(spec: Any) -> bool:
    return isinstance(spec, list) and len(spec) > 1 and isinstance(spec[1], dict) and "default" in spec[1]


def validate_api_graph(graph: dict, objinfo: dict) -> dict[str, Any]:
    """静态校验 API 格式图。返回 {errors, warnings, node_count, combo_fixes}。

    errors(阻断提案):未知 class_type / 连线端点不存在或槽位超界 / 缺 required 输入且无默认值;
    warnings(透出):COMBO 值不在 options(给最接近变体建议)/ 节点数接近上限。
    combo_fixes: [{node, input, value, suggestion}] 供 LLM/前端参考。
    """
    errors: list[str] = []
    warnings: list[str] = []
    combo_fixes: list[dict] = []
    if not isinstance(graph, dict) or not graph:
        return {"errors": ["图不是非空对象(API 格式 {node_id: {class_type, inputs}})"],
                "warnings": [], "node_count": 0, "combo_fixes": []}
    if len(graph) > _MAX_NODES:
        errors.append(f"节点数 {len(graph)} 超过上限 {_MAX_NODES}")

    for nid, node in graph.items():
        if not isinstance(node, dict):
            errors.append(f"节点 {nid}: 不是对象")
            continue
        cls = str(node.get("class_type") or "")
        if not cls:
            errors.append(f"节点 {nid}: 缺 class_type")
            continue
        inputs = node.get("inputs") or {}
        if cls in _SPECIAL_CLASSES:
            continue
        spec_cls = objinfo.get(cls)
        if spec_cls is None:
            errors.append(f"节点 {nid}({cls}): fleet 不存在该类")
            continue
        required = ((spec_cls.get("input") or {}).get("required") or {})
        optional = ((spec_cls.get("input") or {}).get("optional") or {})
        all_specs = {**optional, **required}
        outputs = spec_cls.get("output") or []
        # 连线端点检查:spec 声明引用类型 → 按连线查;无 spec 时按 [str,int] 形态兜底
        # (widget 2-list 值(如 [name, 强度])不再误判为连线,2026-09-21 实证)
        for name, value in inputs.items():
            spec = all_specs.get(name)
            spec_type = spec[0] if isinstance(spec, list) and spec else None
            is_link = (
                isinstance(value, list)
                and len(value) == 2
                and isinstance(value[0], str)
                and (
                    (isinstance(spec_type, str) and spec_type not in _WIDGET_SCALARS)
                    or (spec is None and isinstance(value[1], int))
                )
            )
            if is_link:
                src_id, slot = value
                src = graph.get(src_id)
                if src is None:
                    errors.append(f"节点 {nid}.{name}: 连线源节点 {src_id} 不存在")
                    continue
                src_cls = str(src.get("class_type") or "")
                src_spec = objinfo.get(src_cls) or {}
                src_outputs = src_spec.get("output") or []
                if src_cls not in _SPECIAL_CLASSES and isinstance(slot, int) and slot >= len(src_outputs):
                    errors.append(
                        f"节点 {nid}.{name}: 源 {src_id}({src_cls}) 输出槽 {slot} 超界(共 {len(src_outputs)} 个)"
                    )
            opts = _combo_opts(spec)
            if opts and isinstance(value, str) and value not in opts:
                suggestion = min(opts, key=lambda o: _lev(o, value))
                combo_fixes.append({"node": nid, "input": name, "value": value, "suggestion": suggestion})
                warnings.append(f"节点 {nid}({cls}).{name}: 值 {value!r} 不在选项内(建议 {suggestion!r})")
        # required 输入检查:与 ComfyUI 自身语义对齐——
        # 连线型(引用类型)缺失 → error(上游也拒);widget 型缺失 → 仅 warning
        # (节点定义有默认值,object_info 不保证广告,2026-09-21 LLM 图误杀实证)
        for name, spec in required.items():
            if name in inputs:
                continue
            if _spec_has_default(spec):
                continue
            spec_type = spec[0] if isinstance(spec, list) and spec else None
            if isinstance(spec_type, str) and spec_type not in _WIDGET_SCALARS:
                errors.append(f"节点 {nid}({cls}): 缺 required 连线输入 {name}({spec_type})")
            else:
                warnings.append(f"节点 {nid}({cls}).{name}: required widget 未给值,将用节点默认")
    return {"errors": errors, "warnings": warnings,
            "node_count": len(graph), "combo_fixes": combo_fixes}


def _lev(a: str, b: str) -> int:
    """小写 Levenshtein(短选项集够用,避免引依赖)。"""
    a, b = a.lower(), b.lower()
    if a == b:
        return 0
    la, lb = len(a), len(b)
    dp = list(range(lb + 1))
    for i in range(1, la + 1):
        prev, dp[0] = dp[0], i
        for j in range(1, lb + 1):
            cur = dp[j]
            dp[j] = min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] != b[j - 1]))
            prev = cur
    return dp[lb]
