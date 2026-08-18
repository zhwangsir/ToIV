#!/usr/bin/env python3
"""上下文预算压缩本地验证脚本(Harness M1 配套,2026-08-19)。

构造一份「长对话 + 多工具调用」Mock 历史(system + 首任务锚点 + 10 轮迭代
[用户指令 → assistant 工具调用 → 大体积工具结果 → 阶段总结] + 尾部新一轮),
在多档预算下跑 app/agent/context.compress_history,验证:
  ① 首锚点(任务起点)与尾部(最近上下文)永远保留;
  ② tool_calls 与 tool 结果配对完整(无孤儿 tool 消息,OpenAI 协议合法);
  ③ 中间超预算单元被折叠,system 出现折叠注;
  ④ 预算越大保留越多,0 = 关闭压缩(原样)。

用法:
  python3 scripts/verify_context_budget.py                 # 默认档 [0, 6k, 12k, 24k]
  python3 scripts/verify_context_budget.py --budget 8000   # 单档验证
"""
from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "apps" / "api"))

from app.agent.context import _group_units, _msg_len, compress_history  # noqa: E402


def build_mock_history() -> list[dict]:
    """长对话 Mock:1 system + 首任务 + 10 轮工具迭代 + 尾部新一轮。"""
    msgs: list[dict] = [{"role": "system", "content": "SYS:你是 ToIV 创作助手(工具清单略)"}]
    msgs.append({"role": "user", "content": "帮我做一张「深海发光水母」主题海报,风格要梦幻"})  # 首锚点
    for i in range(1, 11):
        msgs.append({"role": "user", "content": f"第{i}轮:调整一下构图和光影,再生成一版"})
        tool = "generate_image" if i % 2 else "edit_image"
        msgs.append({
            "role": "assistant", "content": "",
            "tool_calls": [{"id": f"call_{i}", "type": "function",
                            "function": {"name": tool, "arguments": json.dumps(
                                {"prompt": f"jellyfish poster v{i}", "seed": 1000 + i})}}],
        })
        # 大体积工具结果:模拟 ComfyUI 作业回执(节点清单+产物路径+耗时)
        payload = json.dumps({
            "job_id": f"job_{i:04d}", "worker": "http://192.168.71.127:8189",
            "prompt_id": f"p{i}", "nodes": [f"KSampler#{n}" for n in range(12)],
            "outputs": [{"filename": f"ComfyUI_{i:05d}_.png", "subfolder": "", "type": "output"}],
            "metrics": {"steps": 28, "took_s": 12.4 + i},
            "log_tail": ["model load ok", "sampling done", "save image ok"] + [f"pad_{i}_{k}" * 8 for k in range(14)],
        }, ensure_ascii=False)
        msgs.append({"role": "tool", "tool_call_id": f"call_{i}", "content": payload})
        msgs.append({"role": "assistant", "content": f"第{i}版完成:构图{i}号方案,光影偏冷色,已展示。"})
    msgs.append({"role": "user", "content": "最终版不错,再帮我配一段海洋氛围的背景音乐"})  # 尾部(最近上下文)
    return msgs


def validate_invariants(out: list[dict], origin: list[dict], budget: int) -> list[str]:
    """返回违规列表(空 = 全部通过)。"""
    errs: list[str] = []
    # ① 首锚点与尾部保留(预算>0 时)
    if budget > 0:
        anchor = next(m for m in origin if m["role"] == "user")
        if anchor["content"] not in [m.get("content") for m in out]:
            errs.append("首锚点丢失")
        if origin[-1]["content"] not in [m.get("content") for m in out]:
            errs.append("尾部丢失")
    # ② tool 配对不变量:tool 消息前一条必须是带 tool_calls 的 assistant
    for i, m in enumerate(out):
        if m.get("role") == "tool":
            prev = out[i - 1] if i else {}
            if not (prev.get("role") == "assistant" and prev.get("tool_calls")):
                errs.append(f"孤儿 tool 消息 @idx{i}")
                break
    # ③ 折叠发生时 system 有折叠注
    if len(out) < len(origin):
        if "折叠省略" not in (out[0].get("content") if out and out[0].get("role") == "system" else ""):
            errs.append("折叠注缺失")
    # ④ system 只在开头(runner 约定)
    if any(m.get("role") == "system" for m in out[1:]):
        errs.append("system 不在开头")
    return errs


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--budget", type=int, default=None, help="单档预算(字符);缺省跑多档")
    args = ap.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    hist = build_mock_history()
    units = _group_units(hist)
    total = sum(_msg_len(m) for m in hist if m.get("role") != "system")
    print(f"\n=== Mock 历史 ===")
    print(f"消息数 {len(hist)} | 原子单元 {len(units)} | 非 system 字符总量 {total}")
    print(f"形态:system + 首锚点 + 10 轮[指令→tool_calls→大结果(~1.6KB)→总结] + 尾部新一轮\n")

    budgets = [args.budget] if args.budget is not None else [0, 6000, 12000, 24000]
    print(f"{'预算':>8} | {'压缩后消息':>10} | {'保留字符':>10} | {'折叠单元':>8} | 不变量校验")
    print("-" * 78)
    ok_all = True
    for b in budgets:
        out = compress_history(hist, b)
        label = f"{b}" if b > 0 else "∞(关闭)"
        kept = sum(_msg_len(m) for m in out if m.get("role") != "system")
        n_units = len(_group_units(out))
        folded = len(units) - n_units if b > 0 else 0
        errs = validate_invariants(out, hist, b)
        ok_all &= not errs
        verdict = "✅ 通过" if not errs else "❌ " + ";".join(errs)
        print(f"{label:>8} | {len(out):>10} | {kept:>10} | {folded:>8} | {verdict}")
    print("-" * 78)
    print("结论:" + ("所有预算档不变量全部通过(首尾锚定/配对完整/折叠注/协议合法)" if ok_all
                     else "存在违规,见上表 ❌ 行"))
    # 展示一档折叠明细
    demo_b = next((b for b in budgets if b and b < total), None)
    if demo_b:
        out = compress_history(hist, demo_b)
        print(f"\n--- 折叠明细(budget={demo_b})---")
        print("保留的消息角色序列:")
        print("  " + " ".join(f"{m['role'][:4]}:{'tool_calls' if m.get('tool_calls') else (m.get('content') or '')[:12]!r}"
                             for m in out[:14]) + (" ..." if len(out) > 14 else ""))
        print(f"system 折叠注: {'✅ 已追加' if '折叠省略' in out[0]['content'] else '—(未触发)'}")
    sys.exit(0 if ok_all else 1)


if __name__ == "__main__":
    main()
