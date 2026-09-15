"""应用功能指纹(2026-09-15)——同指纹 = 同功能的工作流变体。

设计:
- canonical 化:忽略节点 id(重编号不改语义)、连线目标(结构由类+标量字段近似表达)、
  易变字段(seed/prompt/text 类)与超长文本;
- 同指纹的应用在市场折叠为一张「功能卡」:代表 = 烟测 pass 优先 + usage 最高;
  其余为变体(参数/LoRA 差异),展开可见;
- 指纹在导入/更新时计算落 App.fingerprint;历史数据由 scripts/ops 回填。
"""
from __future__ import annotations

import hashlib
import json
import re

_VOLATILE_RE = re.compile(r"seed|prompt|text", re.IGNORECASE)


def fingerprint(workflow_json: dict | None) -> str:
    """canonical 图指纹(16 hex);空图返回空串。"""
    if not isinstance(workflow_json, dict) or not workflow_json:
        return ""
    items: list[tuple] = []
    for node in workflow_json.values():
        if not isinstance(node, dict):
            continue
        ct = node.get("class_type")
        if not isinstance(ct, str):
            continue
        ins = node.get("inputs") or {}
        kv: list[tuple] = []
        for k in sorted(ins):
            if _VOLATILE_RE.search(k):
                continue
            v = ins[k]
            if isinstance(v, list):
                continue  # 连线目标:重编号即变,忽略
            if isinstance(v, str) and len(v) > 80:
                v = v[:80]
            if isinstance(v, (dict, list)):
                v = json.dumps(v, ensure_ascii=False, sort_keys=True)[:120]
            kv.append((k, v))
        items.append((ct, json.dumps(kv, ensure_ascii=False, sort_keys=True, default=str)))
    items.sort()  # 对序列化串排序,避免跨类型比较(str vs float)
    payload = json.dumps(items, ensure_ascii=False, sort_keys=True, default=str)
    return hashlib.sha256(payload.encode()).hexdigest()[:16]
