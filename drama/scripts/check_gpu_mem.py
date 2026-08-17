"""检查各 ComfyUI 实例对应 GPU 显存。"""
from __future__ import annotations

import requests

for port in [8189, 8190, 8191, 8192]:
    url = f"http://192.168.71.127:{port}/system_stats"
    try:
        r = requests.get(url, timeout=10)
        data = r.json()
        for dev in data.get("devices", []):
            name = dev.get("name", "unknown")
            mem_total = dev.get("vram_total", 0) / (1024**3)
            mem_free = dev.get("vram_free", 0) / (1024**3)
            print(f"port {port}: {name}, vram_total={mem_total:.2f} GB, vram_free={mem_free:.2f} GB")
    except Exception as e:
        print(f"port {port}: {e}")
