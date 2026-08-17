"""从 ComfyUI history 获取最近一次成功 LTX t2v 工作流。"""
from __future__ import annotations

import json

import requests

url = "http://192.168.71.127:8189/history"
r = requests.get(url, timeout=60)
r.raise_for_status()
data = r.json()

# 找最近的 success 且输出包含 mp4 的条目
for pid, h in sorted(data.items(), key=lambda x: x[1].get("prompt", [{}])[2].get("client_id", ""), reverse=True):
    status = h.get("status", {})
    if status.get("status_str") != "success":
        continue
    outputs = h.get("outputs", {})
    has_video = any("videos" in v or "gifs" in v for v in outputs.values())
    if not has_video:
        continue
    print(f"prompt_id: {pid}")
    print("status:", status)
    prompt = h.get("prompt", [None, {}])[1]
    print(json.dumps(prompt, indent=2, ensure_ascii=False))
    break
else:
    print("no successful video workflow found")
