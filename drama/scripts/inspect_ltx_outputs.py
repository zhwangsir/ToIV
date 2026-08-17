"""检查 LTXVGemmaCLIPModelLoader 的输出类型。"""
from __future__ import annotations

import json

import requests

url = "http://192.168.71.127:8189/object_info"
r = requests.get(url, timeout=60)
r.raise_for_status()
info = r.json()

node = "LTXVGemmaCLIPModelLoader"
print(json.dumps(info[node].get("output", []), indent=2, ensure_ascii=False))
print("output_name:", info[node].get("output_name", []))
print("output_is_list:", info[node].get("output_is_list", []))
