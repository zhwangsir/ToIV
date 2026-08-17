"""单镜头 LTX t2v 验证:只生成 s1_1。"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from config import SHOTS, shot_prompt_with_chars
from comfy_client import ComfyClient, build_ltx_t2v_graph

ROOT = Path(__file__).parent.parent
SHOTS_DIR = ROOT / "output" / "shots"
SHOTS_DIR.mkdir(parents=True, exist_ok=True)

SHOT = next(s for s in SHOTS if s["id"] == "s1_1")
SEED = 42 + int(SHOT["id"].replace("s", "").replace("_", ""))

client = ComfyClient()
print(f"endpoint: {client.base_url}")
print(f"shot: {SHOT['id']}, duration: {SHOT['duration']}s, seed: {SEED}")

prompt = shot_prompt_with_chars(SHOT)
print(f"prompt: {prompt[:120]}...")

graph = build_ltx_t2v_graph(prompt, SHOT["negative"], seed=SEED)
pid = client.submit(graph)
print(f"prompt_id: {pid}")

history = client.wait(pid, max_wait=900)
outputs = client.get_outputs(history)
if not outputs:
    raise RuntimeError("no output from ComfyUI")
out = outputs[0]
print(f"output: {out}")

raw_path = SHOTS_DIR / SHOT["id"] / "raw.mp4"
client.download(out["filename"], out["subfolder"], raw_path)
print(f"downloaded: {raw_path} ({raw_path.stat().st_size / 1024:.1f} KB)")

clip_path = SHOTS_DIR / SHOT["id"] / "clip.mp4"
cmd = [
    "ffmpeg", "-y", "-i", str(raw_path), "-t", str(SHOT["duration"]),
    "-c:v", "libx264", "-preset", "fast", "-crf", "23",
    "-pix_fmt", "yuv420p", "-an", str(clip_path),
]
subprocess.run(cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
print(f"trimmed clip: {clip_path}")
