"""诊断 s1_1 提交错误,打印 ComfyUI 返回详情。"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import requests

from config import SHOTS, shot_prompt_with_chars
from comfy_client import build_ltx_t2v_graph

SHOT = next(s for s in SHOTS if s["id"] == "s1_1")
SEED = 42 + int(SHOT["id"].replace("s", "").replace("_", ""))
prompt = shot_prompt_with_chars(SHOT)
graph = build_ltx_t2v_graph(prompt, SHOT["negative"], seed=SEED)

payload = {"prompt": graph, "client_id": "diagnose"}
url = "http://192.168.71.127:8189/prompt"
print("POST", url)
r = requests.post(url, json=payload, timeout=60)
print("status:", r.status_code)
print("headers:", dict(r.headers))
try:
    print("body:", json.dumps(r.json(), indent=2, ensure_ascii=False))
except Exception:
    print("body:", r.text[:2000])
