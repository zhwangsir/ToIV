"""EXO thinking 抑制参数探测脚本（2026-07-27）。

目的:验证 EXO(192.168.71.109:52415)是否接受 chat_template_kwargs.enable_thinking=false,
以及该参数能否真正降低 reasoning token / 延迟。

测试对象:
  1. Kimi-K2.7-Code-4bit(L2,~6.6s/次,快速验证参数接受度)
  2. GLM-5.2-fp8(L3,~115s/次,reasoning 80%+,关键对比)

每组测 3 种 payload:
  - baseline:默认(不加任何 thinking 参数)
  - ctk:chat_template_kwargs.enable_thinking=false(Qwen3/vLLM 风格)
  - top:顶层 enable_thinking=false(部分 OpenAI 兼容实现支持)

输出:耗时 / completion_tokens / reasoning_tokens / content 长度 / 是否含 <think> 标签。

用法:python3 scripts/thinking_probe.py [model_id]
  不传 model_id 则依次跑 Kimi + GLM 两个模型。
"""
from __future__ import annotations

import json
import sys
import time
import urllib.request

URL = "http://192.168.71.109:52415/v1/chat/completions"
PROMPT = "用一句话描写雨夜中的孤独,要求画面感强、情感克制。"

# 三种 payload 构造器
VARIANTS = [
    ("baseline", lambda: {}),
    ("ctk_false", lambda: {"chat_template_kwargs": {"enable_thinking": False}}),
    ("top_false", lambda: {"enable_thinking": False}),
]


def call(model: str, extra: dict, label: str) -> dict:
    payload: dict = {
        "model": model,
        "messages": [{"role": "user", "content": PROMPT}],
        "max_tokens": 800,
        "temperature": 0.6,
    }
    payload.update(extra)
    data = json.dumps(payload).encode()
    req = urllib.request.Request(
        URL, data=data, headers={"Content-Type": "application/json"}
    )
    t0 = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=400) as r:
            body = json.loads(r.read())
    except urllib.error.HTTPError as e:
        err_body = e.read().decode(errors="replace")[:500]
        print(f"  [{label}] HTTP {e.code}: {err_body}")
        return {"ok": False, "label": label, "error": f"HTTP {e.code}"}
    except Exception as e:
        print(f"  [{label}] ERROR: {e}")
        return {"ok": False, "label": label, "error": str(e)}

    elapsed = time.monotonic() - t0
    msg = (body.get("choices") or [{}])[0].get("message", {}) or {}
    content = msg.get("content") or ""
    reasoning = msg.get("reasoning_content") or msg.get("reasoning") or ""
    usage = body.get("usage") or {}
    details = usage.get("completion_tokens_details") or {}
    rtokens = details.get("reasoning_tokens") or 0
    ctokens = usage.get("completion_tokens") or 0
    has_tag = "<think>" in content or "<think>" in reasoning
    print(
        f"  [{label}] {elapsed:6.1f}s | comp={ctokens:5d} reason={rtokens:5d} "
        f"| content={len(content):4d}c reasoning={len(reasoning):4d}c "
        f"| think_tag={has_tag}"
    )
    print(f"           content[:120]={content[:120]!r}")
    return {
        "ok": True,
        "label": label,
        "elapsed": round(elapsed, 1),
        "completion_tokens": ctokens,
        "reasoning_tokens": rtokens,
        "content_len": len(content),
        "reasoning_len": len(reasoning),
        "has_think_tag": has_tag,
    }


def probe_model(model: str) -> list[dict]:
    print(f"\n=== {model} ===")
    results = []
    for label, extra_fn in VARIANTS:
        r = call(model, extra_fn(), label)
        results.append(r)
    # 小结
    ok = [r for r in results if r.get("ok")]
    if len(ok) >= 2:
        base = next((r for r in ok if r["label"] == "baseline"), ok[0])
        print(f"  --- 对比(相对 baseline) ---")
        for r in ok:
            if r["label"] == "baseline":
                continue
            d_tok = r["completion_tokens"] - base["completion_tokens"]
            d_time = r["elapsed"] - base["elapsed"]
            print(
                f"  {r['label']:10s}: Δtokens={d_tok:+d}  Δtime={d_time:+.1f}s  "
                f"reasoning={r['reasoning_tokens']}"
            )
    return results


def main() -> None:
    if len(sys.argv) > 1:
        probe_model(sys.argv[1])
        return
    # 默认:先 Kimi(快),再 GLM(慢)
    summary: dict[str, list[dict]] = {}
    for m in [
        "mlx-community/Kimi-K2.7-Code-4bit",
        "mlx-community/GLM-5.2-fp8",
    ]:
        summary[m] = probe_model(m)

    print("\n=== 总结 ===")
    for m, rs in summary.items():
        print(f"\n{m}")
        for r in rs:
            if r.get("ok"):
                print(
                    f"  {r['label']:10s}: {r['elapsed']:6.1f}s  "
                    f"comp={r['completion_tokens']:5d}  reason={r['reasoning_tokens']:5d}  "
                    f"think_tag={r['has_think_tag']}"
                )
            else:
                print(f"  {r['label']:10s}: FAILED ({r.get('error')})")


if __name__ == "__main__":
    main()
