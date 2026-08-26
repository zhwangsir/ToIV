"""ToIV chat_layered 真实端到端 thinking 抑制验证（2026-07-27）。

用 ToIV 实际调用链(chat_layered L3)调真实 EXO,对比:
  [1] baseline: _call_with_retry 不传 enable_thinking(开 thinking)
  [2] ToIV 路径: chat_layered layer="L3"(关 thinking,生产代码路径)

证明 ToIV 代码改动后,实际发出的请求关闭了 thinking,reasoning_tokens=0,延迟大降。

用法:cd apps/api && python ../../scripts/thinking_e2e_toiv.py
"""
from __future__ import annotations

import asyncio
import time

# 确保从 apps/api 目录运行,能 import app.*
from app.agent import llm
from app.config import get_settings


async def main() -> None:
    settings = get_settings()
    print(f"L3 model: {settings.llm_l3_model}")
    print(f"L3 url:   {settings.llm_l3_base_url}")
    print(f"L3 timeout: {settings.llm_l3_timeout}s")

    messages = [{"role": "user", "content": "用一句话描写雨夜中的孤独,画面感强、情感克制。"}]

    # [1] baseline: 开 thinking(不传 enable_thinking)
    print("\n[1] baseline 开 thinking(直接 _call_with_retry,不传 enable_thinking)...")
    t0 = time.monotonic()
    try:
        msg_base = await llm._call_with_retry(
            settings.llm_l3_base_url.rstrip("/"), settings.llm_l3_model,
            settings.llm_api_key, messages, None, 800, 0.6,
            label="baseline-open-thinking",
            read_timeout=settings.llm_l3_timeout,
        )
        t_base = time.monotonic() - t0
        rt_base = msg_base.get("_reasoning_tokens", 0)
        c_base = (msg_base.get("content") or "")[:120]
        print(f"  耗时: {t_base:.1f}s | reasoning_tokens: {rt_base} | content: {c_base!r}")
    except Exception as e:
        print(f"  FAILED: {e}")
        t_base, rt_base, c_base = -1, -1, str(e)

    # [2] ToIV 生产路径: chat_layered L3(关 thinking)
    print("\n[2] ToIV 生产路径 chat_layered L3(关 thinking)...")
    t0 = time.monotonic()
    try:
        msg_off = await llm.chat_layered(messages, layer="L3", max_tokens=800, temperature=0.6)
        t_off = time.monotonic() - t0
        rt_off = msg_off.get("_reasoning_tokens", 0)
        c_off = (msg_off.get("content") or "")[:120]
        print(f"  耗时: {t_off:.1f}s | reasoning_tokens: {rt_off} | content: {c_off!r}")
    except Exception as e:
        print(f"  FAILED: {e}")
        t_off, rt_off, c_off = -1, -1, str(e)

    # 对比
    print("\n=== 对比 ===")
    print(f"  [1] 开 thinking: {t_base:.1f}s  reasoning={rt_base}")
    print(f"  [2] 关 thinking: {t_off:.1f}s  reasoning={rt_off}")
    if t_base > 0 and t_off > 0:
        speedup = t_base / t_off if t_off > 0 else 0
        print(f"  加速比: {speedup:.1f}x")
        print(f"  reasoning 降幅: {rt_base} → {rt_off}")
    print("\n结论: [2] 路径是 ToIV 生产代码路径,reasoning=0 即 thinking 抑制生效。")


if __name__ == "__main__":
    asyncio.run(main())
