#!/usr/bin/env python3
"""1M 上下文真实 needle 测试: ~800K tokens"""
import json, time, random, sys, urllib.request

BASE = "http://192.168.71.82:8000/v1"
TARGET_CHARS = 2_260_000  # ~800K tokens (实测 2.83 chars/tok)

needle_code = "".join(random.choices("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", k=8))
needle = f"在本报告中,秘密验收暗号是「{needle_code}」,请勿外传。"
filler_unit = "人工智能技术的发展日新月异,深度学习模型在各个领域展现出强大的能力,从自然语言处理到计算机视觉,从科学研究到工业生产。" * 10
filler = filler_unit * (TARGET_CHARS // len(filler_unit) + 1)
pos = random.randint(len(filler) // 3, 2 * len(filler) // 3)
text = filler[:pos] + needle + filler[pos:]
print(f"payload: {len(text)} chars, needle at {pos/len(text):.0%}")

body = {"model": "qwen3.8-flash-next", "max_tokens": 256, "temperature": 0,
        "chat_template_kwargs": {"enable_thinking": False},
        "messages": [{"role": "user", "content": f"阅读以下长文并回答问题:\n\n{text}\n\n问题:文中提到的秘密验收暗号是什么?只回答暗号本身,不要其他内容。"}]}
req = urllib.request.Request(f"{BASE}/chat/completions", data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
t0 = time.time()
try:
    with urllib.request.urlopen(req, timeout=1800) as r:
        d = json.load(r)
    dt = time.time() - t0
    m = d["choices"][0]["message"]
    ans = (m.get("content") or "")
    u = d.get("usage", {})
    ok = needle_code in ans
    print(f"[{'PASS' if ok else 'FAIL'}] prompt_tokens={u.get('prompt_tokens')} answer={ans[:80]!r} time={dt:.1f}s prefill_tps={u.get('prompt_tokens',0)/dt:.0f}")
    sys.exit(0 if ok else 1)
except Exception as e:
    print(f"[FAIL] {type(e).__name__}: {e}")
    sys.exit(1)
