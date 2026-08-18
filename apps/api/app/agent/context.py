"""Agent 上下文预算管理(Harness 化 M1,2026-08-19;参照 DeepSeek Harness 压缩思想)。

原则(压缩而非截断):
- system 消息全保留(runner 约定 system 只在开头,此处按角色泛化防御);
- 「配对不变量」:带 tool_calls 的 assistant 消息与其后的 tool 结果消息是一个
  原子单元,要么整组保留要么整组折叠——孤儿 tool 消息会被 vLLM/OpenAI 协议拒收;
- 锚定策略:首单元(任务起点)与尽量多的尾部单元(最近上下文)永远优先保留,
  超预算时从中间最老的完整单元开始折叠;
- 纯函数:返回新列表,不修改入参。
"""
from __future__ import annotations

import json

_FOLD_NOTE = "\n\n(系统注:更早的部分对话已因上下文预算折叠省略,关键任务起点与最近上下文已保留)"


def _msg_len(m: dict) -> int:
    """粗估消息体量:正文 + tool_calls 序列化长度(字符数;中文 ≈ 1 字符/字,量级足够)。"""
    n = len(m.get("content") or "")
    if m.get("tool_calls"):
        n += len(json.dumps(m["tool_calls"], ensure_ascii=False))
    return n


def _group_units(msgs: list[dict]) -> list[list[int]]:
    """把非 system 消息按下标分组为原子单元:
    带 tool_calls 的 assistant + 紧随的全部 tool 消息为一组;其余单条一组。"""
    units: list[list[int]] = []
    i, n = 0, len(msgs)
    while i < n:
        if msgs[i].get("role") == "system":
            i += 1
            continue
        if msgs[i].get("tool_calls"):
            grp = [i]
            j = i + 1
            while j < n and msgs[j].get("role") == "tool":
                grp.append(j)
                j += 1
            units.append(grp)
            i = j
        else:
            units.append([i])
            i += 1
    return units


def compress_history(msgs: list[dict], budget: int) -> list[dict]:
    """按预算压缩历史(新列表)。

    - 预算作用于非 system 消息的总字符数;未超预算原样返回(浅拷贝);
    - 保留:全部 system + 首单元 + 尽量多的尾部单元(逆序贪心装填);
    - 发生折叠时在第一条 system 尾部追加折叠说明(模型可感知历史不完整);
    - 极端情形(首尾两单元已超预算):仍保首尾,不产生空历史。
    """
    out: list[dict] = [dict(m) for m in msgs]
    if budget <= 0:
        return out
    non_idx = [i for i, m in enumerate(out) if m.get("role") != "system"]
    if not non_idx:
        return out
    total = sum(_msg_len(out[i]) for i in non_idx)
    if total <= budget:
        return out

    units = _group_units(out)
    keep: set[int] = set()
    if units:
        keep |= set(units[0])
        if len(units) > 1:
            keep |= set(units[-1])
        acc = sum(_msg_len(out[i]) for i in keep)
        # 逆序贪心:从倒数第二单元向前尽量多保最近上下文
        for ui in range(len(units) - 2, 0, -1):
            ul = sum(_msg_len(out[i]) for i in units[ui])
            if acc + ul > budget:
                break
            keep |= set(units[ui])
            acc += ul

    dropped_any = len(keep) < len(non_idx)
    compressed = [m for i, m in enumerate(out) if m.get("role") == "system" or i in keep]
    if dropped_any:
        for m in compressed:
            if m.get("role") == "system":
                m["content"] = (m.get("content") or "") + _FOLD_NOTE
                break
        else:
            # 防御:无 system 时补一条(调用方约定 system 在首,正常不会走到)
            compressed.insert(0, {"role": "system", "content": _FOLD_NOTE.strip()})
    return compressed
