#!/usr/bin/env python3
"""Small, fixed-input Wan I2V A/B for the verified NSFW-22 HIGH/LOW pair."""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "apps" / "api"))

from app.workflows.wan_i2v import WanI2VParams, build_wan_i2v_graph

HIGH = "NSFW-22-H-e8.safetensors"
LOW = "NSFW-22-L-e8.safetensors"


def request(method: str, url: str, data: bytes | None = None, headers: dict | None = None, timeout: int = 120) -> bytes:
    req = urllib.request.Request(url, data=data, headers=headers or {}, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            return response.read()
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")[:2000]
        raise RuntimeError(f"{method} {url} -> HTTP {error.code}: {detail}") from error


def upload(worker: str, image: Path) -> str:
    boundary = uuid.uuid4().hex
    body = (
        f"--{boundary}\r\n".encode()
        + f'Content-Disposition: form-data; name="image"; filename="{image.name}"\r\n'.encode()
        + b"Content-Type: image/png\r\n\r\n"
        + image.read_bytes()
        + f"\r\n--{boundary}--\r\n".encode()
    )
    data = json.loads(request("POST", f"{worker}/upload/image", body, {"Content-Type": f"multipart/form-data; boundary={boundary}"}))
    if not data.get("name"):
        raise RuntimeError(f"upload failed: {data}")
    return data["name"]


def wait(worker: str, prompt_id: str, timeout: int) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        history = json.loads(request("GET", f"{worker}/history/{prompt_id}"))
        if prompt_id in history:
            return history[prompt_id]
        time.sleep(5)
    raise TimeoutError(f"{prompt_id} did not finish within {timeout}s")


def download_outputs(worker: str, entry: dict, out_dir: Path, tag: str) -> list[Path]:
    paths = []
    for node in entry.get("outputs", {}).values():
        for item in node.get("gifs", []):
            query = urllib.parse.urlencode({"filename": item["filename"], "subfolder": item.get("subfolder", ""), "type": item.get("type", "output")})
            path = out_dir / f"{tag}.mp4"
            path.write_bytes(request("GET", f"{worker}/view?{query}", timeout=600))
            paths.append(path)
    if not paths:
        raise RuntimeError(f"no video output in {json.dumps(entry)[:1000]}")
    return paths


def run_arm(worker: str, tag: str, image_name: str, prompt: str, seed: int, out_dir: Path, timeout: int, with_pair: bool) -> dict:
    params = WanI2VParams(
        positive=prompt,
        image=image_name,
        seed=seed,
        length=49,
        steps=8,
        accel="off",
        filename_prefix=f"ToIV_eval_nsfw22_{tag}",
        high_loras=((HIGH, 0.8),) if with_pair else (),
        low_loras=((LOW, 0.8),) if with_pair else (),
    )
    graph = build_wan_i2v_graph(params)
    started = time.time()
    payload = json.dumps({"prompt": graph, "client_id": f"nsfw22-{tag}-{seed}"}).encode()
    response = json.loads(request("POST", f"{worker}/prompt", payload, {"Content-Type": "application/json"}))
    prompt_id = response.get("prompt_id")
    if not prompt_id:
        raise RuntimeError(json.dumps(response)[:1000])
    print(json.dumps({"tag": tag, "prompt_id": prompt_id}, ensure_ascii=False), flush=True)
    entry = wait(worker, prompt_id, timeout)
    videos = download_outputs(worker, entry, out_dir, tag)
    elapsed = round(time.time() - started, 1)
    frame = out_dir / f"{tag}_frame.png"
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-ss", "1.5", "-i", str(videos[0]), "-frames:v", "1", str(frame)], check=True)
    probe = json.loads(subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "format=duration:stream=width,height,nb_frames", "-of", "json", str(videos[0])]))
    return {"tag": tag, "with_nsfw22_pair": with_pair, "prompt_id": prompt_id, "elapsed_sec": elapsed, "video": str(videos[0]), "frame": str(frame), "bytes": videos[0].stat().st_size, "probe": probe}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--worker", default="http://192.168.71.127:8197")
    parser.add_argument("--image", type=Path, required=True)
    parser.add_argument("--out-dir", type=Path, required=True)
    parser.add_argument("--seed", type=int, default=20261027)
    parser.add_argument("--timeout", type=int, default=1800)
    parser.add_argument("--prompt", default="nsfwsks, the same adult woman slowly puts down her cup and lowers her cardigan to reveal natural bare shoulders, sensual but composed, realistic skin texture, gentle body movement, cinematic soft window light, anatomically coherent, no minors")
    args = parser.parse_args()
    queue = json.loads(request("GET", f"{args.worker}/queue"))
    if queue.get("queue_running") or queue.get("queue_pending"):
        raise RuntimeError("worker is busy; refusing to contend with existing work")
    args.out_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy2(args.image, args.out_dir / "input.png")
    image_name = upload(args.worker, args.image)
    arms = [
        run_arm(args.worker, "a_base", image_name, args.prompt, args.seed, args.out_dir, args.timeout, False),
        run_arm(args.worker, "b_nsfw22_pair", image_name, args.prompt, args.seed, args.out_dir, args.timeout, True),
    ]
    report = {
        "scope": "single-reference 3s smoke A/B, not a fleet-wide quality certification",
        "worker": args.worker,
        "seed": args.seed,
        "prompt": args.prompt,
        "sampling": {"width": 832, "height": 480, "length": 49, "fps": 16, "steps": 8, "accel": "off", "high_cfg": 3.5, "low_cfg": 3.0},
        "weights": {HIGH: "34e2144d3cd65360f97d09ccbe03e1c39a096df6c9234af5fe3899d1b63cda39", LOW: "d6b783742f4d5fd63a0223ae1d5bf64fc995a6b408480ac2a00528ae0d4146db"},
        "arms": arms,
    }
    (args.out_dir / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
