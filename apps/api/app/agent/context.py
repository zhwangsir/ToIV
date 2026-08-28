"""Agent 上下文预算管理(Harness 化 M1,2026-08-19;参照 DeepSeek Harness 压缩思想)。

原则(压缩而非截断):
- system 消息全保留(runner 约定 system 只在开头,此处按角色泛化防御);
- 「配对不变量」:带 tool_calls 的 assistant 消息与其后的 tool 结果消息是一个
  原子单元,要么整组保留要么整组折叠——孤儿 tool 消息会被 vLLM/OpenAI 协议拒收;
- 锚定策略:首单元(任务起点)与尽量多的尾部单元(最近上下文)永远优先保留,
  超预算时从中间最老的完整单元开始折叠;
- 工作副本截断:每条 role=tool 正文先帽到 TOOL_CONTENT_CAP;若首尾单元仍超预算,
  再压缩这些单元内的 tool/assistant 正文,而不是把 32k+ token 原样送出;
- 纯函数:返回新列表,不修改入参。
"""
from __future__ import annotations

import json
import logging

logger = logging.getLogger(__name__)

_FOLD_NOTE = "\n\n(系统注:更早的部分对话已因上下文预算折叠省略,关键任务起点与最近上下文已保留)"

# 工作副本中单条 tool 结果帽(字符)。MCP get_system_stats 等仍可能返回数千字,
# 全量进 vLLM 会先把 32k 上下文打满。标记追加在帽之后,总长略超 cap。
TOOL_CONTENT_CAP = 1800
_TRUNC_SUFFIX = "\n...(截断)"

# runner 在 LLM 报上下文溢出且重试仍失败时展示给用户(不要回传 vLLM JSON)
CONTEXT_OVERFLOW_USER_MSG = (
    "对话太长，模型上下文已满。请新开一个会话，或删掉本轮过长的附件后再试。"
)


def is_context_overflow_error(err: BaseException) -> bool:
    """识别 vLLM/OpenAI 的上下文长度 400(maximum context length / input tokens)。"""
    s = str(err).lower()
    return "maximum context length" in s or "input tokens" in s


def tighter_context_budget(budget: int) -> int:
    """溢出重试预算:原预算一半,且不低于 4000。"""
    return max(int(budget) // 2, 4000)


def chat_tool_schemas(schemas: list[dict] | None) -> list[dict]:
    """送给 chat() 的 tools 载荷:去掉 mcp__* (schema 巨大),执行器仍可按名调用。"""
    if not schemas:
        return []
    out: list[dict] = []
    for s in schemas:
        fn = s.get("function") if isinstance(s, dict) else None
        name = ""
        if isinstance(fn, dict):
            name = str(fn.get("name") or "")
        elif isinstance(s, dict):
            name = str(s.get("name") or "")
        if name.startswith("mcp__"):
            continue
        out.append(s)
    return out


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


def _cap_tool_contents(msgs: list[dict], cap: int = TOOL_CONTENT_CAP) -> int:
    """就地帽每条 tool 正文;返回被截断条数。"""
    n = 0
    for m in msgs:
        if m.get("role") != "tool":
            continue
        c = m.get("content") or ""
        if len(c) > cap:
            m["content"] = c[:cap] + _TRUNC_SUFFIX
            n += 1
    return n


def _fit_content(text: str, cap: int) -> str:
    """把正文压进 cap 字符(含截断标记);cap<=0 为空串。"""
    if cap <= 0:
        return ""
    if len(text) <= cap:
        return text
    mark = _TRUNC_SUFFIX
    if cap <= len(mark):
        return text[:cap]
    return text[: cap - len(mark)] + mark


def _non_sys_len(msgs: list[dict]) -> int:
    return sum(_msg_len(m) for m in msgs if m.get("role") != "system")


def _shrink_to_budget(msgs: list[dict], budget: int) -> None:
    """就地压缩已保留单元内的 tool/assistant 正文,直到非 system 总长 <= budget。

    不删消息、不动 tool_calls,以保住 assistant.tool_calls + tool 配对。
    先砍 tool 正文,再砍 assistant 正文。
    """
    if budget <= 0:
        return
    for role in ("tool", "assistant"):
        guard = 0
        while _non_sys_len(msgs) > budget and guard < 64:
            guard += 1
            candidates = [
                m for m in msgs
                if m.get("role") == role and len(m.get("content") or "") > 0
            ]
            if not candidates:
                break
            longest = max(candidates, key=lambda m: len(m.get("content") or ""))
            c = longest.get("content") or ""
            overflow = _non_sys_len(msgs) - budget
            new_cap = max(0, len(c) - overflow)
            fitted = _fit_content(c, new_cap)
            if fitted == c:
                # 再砍一半,避免 suffix 导致无法收敛
                fitted = _fit_content(c, max(0, len(c) // 2))
            if fitted == c:
                break
            longest["content"] = fitted


def compress_history(msgs: list[dict], budget: int) -> list[dict]:
    """按预算压缩历史(新列表)。

    - 预算作用于非 system 消息的总字符数;
    - 工作副本先帽每条 tool 正文(不改入参);
    - 保留:全部 system + 首单元 + 尽量多的尾部单元(逆序贪心装填);
    - 发生折叠时在第一条 system 尾部追加折叠说明(模型可感知历史不完整);
    - 首尾两单元已超预算:仍保首尾,并截断其内 tool/assistant 正文,不产生空历史。
    """
    out: list[dict] = [dict(m) for m in msgs]
    if budget <= 0:
        return out

    capped = _cap_tool_contents(out)
    if capped:
        logger.info("context.cap_tools: n=%d cap=%d", capped, TOOL_CONTENT_CAP)

    non_idx = [i for i, m in enumerate(out) if m.get("role") != "system"]
    if not non_idx:
        return out
    total = sum(_msg_len(out[i]) for i in non_idx)
    if total <= budget:
        return out

    units = _group_units(out)
    keep: set[int] = set()
    acc = 0
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

    # 埋点:压缩决策可观测(只记数量/长度/单元序号,不落消息内容)
    folded = [u for u in units if not set(u) & keep]
    logger.info(
        "context.compress: budget=%d total_chars=%d units=%d kept=%d folded=%d "
        "folded_unit_pos=%s kept_chars=%d",
        budget, total, len(units), len(units) - len(folded), len(folded),
        [units.index(u) + 1 for u in folded], acc,
    )

    dropped_any = len(keep) < len(non_idx)
    compressed = [m for i, m in enumerate(out) if m.get("role") == "system" or i in keep]
    leftover = _non_sys_len(compressed)
    if leftover > budget:
        logger.info(
            "context.shrink_kept: before=%d budget=%d", leftover, budget,
        )
        _shrink_to_budget(compressed, budget)

    if dropped_any:
        for m in compressed:
            if m.get("role") == "system":
                m["content"] = (m.get("content") or "") + _FOLD_NOTE
                break
        else:
            # 防御:无 system 时补一条(调用方约定 system 在首,正常不会走到)
            compressed.insert(0, {"role": "system", "content": _FOLD_NOTE.strip()})
    return compressed
