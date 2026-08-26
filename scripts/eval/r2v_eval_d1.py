#!/usr/bin/env python3
"""ref2va D1 遗留项:参考视频运镜迁移。

- 参考视频:复用 A4 产物 output/r2v/a4_portrait_kitchen.mp4(厨房门口缓慢推近的运镜)
- 参考图:a4_portrait_ref.png(同一角色卡)
- 设计:角色卡 + 参考视频,prompt 显式「运镜方式参考 <Video 1>,场景切换到菜市场」
- 判断:推近运镜是否迁移 / 角色是否一致 / 场景是否切换
- 轻量档:56 帧 × 6 steps(评测性质,快为先),串行单任务
"""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
import time
import urllib.request
import uuid
from pathlib import Path

H3 = "http://127.0.0.1:8195"
EVAL_DIR = Path("/home/merlin/ComfyUI-h3-eval")
NAS_OUT = Path("/home/merlin/nas_mount/toiv/outputs/videos/h3-eval/r2v")
LOCAL_OUT = EVAL_DIR / "output" / "r2v"
LOG = EVAL_DIR / "r2v_eval_d1_result.log"
REF_VIDEO_SRC = LOCAL_OUT / "a4_portrait_kitchen.mp4"
REF_IMAGE = EVAL_DIR / "a4_portrait_ref.png"

for d in (NAS_OUT, LOCAL_OUT):
    d.mkdir(parents=True, exist_ok=True)

D1_PROMPT = (
    "运镜方式参考 <Video 1>:镜头从门口/外侧缓慢推近到人物半身。场景切换到与参考画面"
    "完全不同的新场景。<Picture 1> 中的女人(同样的短发、同样的藏青色棉布衬衫、同样的面容),"
    "傍晚在热闹的露天菜市场,俯身挑拣摊位上的青菜,然后抬头与摊主讲价。"
    "镜头从菜摊外侧缓慢推近到她的半身,推近轨迹与 <Video 1> 一致。\n\n"
    "对白:女人说:\"这青菜怎么卖?\"\n\n"
    "音频:菜市场嘈杂的人声、塑料袋摩擦声、远处自行车铃声。"
)


def log(msg: str) -> None:
    line = f"[{time.strftime('%H:%M:%S')}] {msg}"
    print(line, flush=True)
    with LOG.open("a") as f:
        f.write(line + "\n")


def req(method: str, path: str, data: bytes | None = None,
        headers: dict | None = None, timeout: int = 60):
    r = urllib.request.Request(H3 + path, data=data, headers=headers or {}, method=method)
    with urllib.request.urlopen(r, timeout=timeout) as resp:
        return resp.status, resp.read()


def gpu_used_mib() -> list[int]:
    out = subprocess.check_output(
        ["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"]
    ).decode().split()
    return [int(x) for x in out]


def upload_file(path: Path, dst_name: str) -> str:
    boundary = uuid.uuid4().hex
    body = (f"--{boundary}\r\n".encode()
            + f'Content-Disposition: form-data; name="image"; filename="{dst_name}"\r\n'.encode()
            + b"Content-Type: application/octet-stream\r\n\r\n"
            + path.read_bytes() + b"\r\n"
            + f"--{boundary}--\r\n".encode())
    code, raw = req("POST", "/upload/image", body,
                    {"Content-Type": f"multipart/form-data; boundary={boundary}"}, 300)
    name = json.loads(raw)["name"]
    log(f"上传 {path.name} → {name} (HTTP {code})")
    return name


def build_prompt(img_name: str, vid_name: str, seed: int = 42) -> dict:
    base = json.load(open(EVAL_DIR / "i2v_prompt.json"))["prompt"]
    base["6"]["inputs"]["unet_name"] = "minimax_h3_ref2va_pruned_int8_convrot.safetensors"
    base.pop("100", None)
    base["100"] = {"class_type": "LoadImage", "inputs": {"image": img_name, "upload": True}}
    base["105"] = {"class_type": "LoadVideo", "inputs": {"file": vid_name, "upload": True}}
    base["106"] = {"class_type": "GetVideoComponents", "inputs": {"video": ["105", 0]}}
    base["104"] = {
        "class_type": "MiniMaxH3ReferenceToVideo",
        "inputs": {
            "clip": ["13", 0], "vae": ["11", 0], "audio_vae": ["24", 0],
            "prompt": D1_PROMPT, "width": 1344, "height": 768, "length": 56,
            "ref_image_size": "match",
            "ref_images.ref_image_0": ["100", 0],
            "ref_videos.ref_video_0": ["106", 0],
            "ref_video_audios.ref_video_audio_0": ["106", 1],
        },
    }
    base["9"]["inputs"]["scheduler"] = "beta"
    base["9"]["inputs"]["steps"] = 6
    base["15"]["inputs"]["noise_seed"] = seed
    return base


def run_case(case: str, prompt: dict) -> None:
    log(f"=== {case} ===")
    peak = gpu_used_mib()
    t0 = time.time()
    payload = json.dumps({"prompt": prompt}).encode()
    code, raw = req("POST", "/prompt", payload, {"Content-Type": "application/json"}, 60)
    pid = json.loads(raw)["prompt_id"]
    log(f"{case}: prompt_id={pid} (HTTP {code})")
    while True:
        time.sleep(10)
        cur = gpu_used_mib()
        peak = [max(a, b) for a, b in zip(peak, cur)]
        _, hraw = req("GET", f"/history/{pid}", timeout=30)
        hist = json.loads(hraw)
        if pid in hist:
            status = hist[pid].get("status", {})
            if status.get("completed") or status.get("status_str") == "error":
                break
    dt = time.time() - t0
    entry = hist[pid]
    ok = entry.get("status", {}).get("completed", False)
    log(f"{case}: {'done' if ok else 'ERROR'} 耗时 {dt:.0f}s 显存峰值 {peak} MiB")
    if not ok:
        log(f"{case}: 失败详情 {json.dumps(entry.get('status', {}), ensure_ascii=False)[:800]}")
        return
    for out in entry.get("outputs", {}).values():
        for key in ("videos", "images", "gifs"):
            for v in out.get(key, []) or []:
                fn, sub, typ = v["filename"], v.get("subfolder", ""), v.get("type", "output")
                _, vraw = req("GET", f"/view?filename={fn}&subfolder={sub}&type={typ}", timeout=120)
                dst = LOCAL_OUT / f"{case}.mp4"
                dst.write_bytes(vraw)
                shutil.copy(dst, NAS_OUT / f"{case}.mp4")
                log(f"{case}: 产物 {fn} → {dst} ({len(vraw)//1024}KB) + NAS 副本")


def main() -> None:
    img_name = upload_file(REF_IMAGE, "d1_ref_char.png")
    vid_name = upload_file(REF_VIDEO_SRC, "d1_ref_video.mp4")
    run_case("d1_cameramove_market", build_prompt(img_name, vid_name))
    log("=== D1 完成 ===")


if __name__ == "__main__":
    sys.exit(main())
