#!/usr/bin/env python3
"""ref2va A3 补测:干净正面肖像 → 新场景(修正 A1/A2/B1 参考图带场景导致的场景锁死)。

流程:fl2va t2v 生成正面肖像镜头 → 抽帧 → 上传 → ref2va 换成厨房场景。
修正:产物从 history outputs 的 images 键提取(A1/A2/B1 脚本漏提,已人工补捞)。
"""
from __future__ import annotations

import json
import shutil
import subprocess
import time
import urllib.request
import uuid
from pathlib import Path

H3 = "http://127.0.0.1:8195"
EVAL_DIR = Path("/home/merlin/ComfyUI-h3-eval")
NAS_OUT = Path("/home/merlin/nas_mount/toiv/outputs/videos/h3-eval/r2v")
LOCAL_OUT = EVAL_DIR / "output" / "r2v"
LOG = EVAL_DIR / "r2v_eval_a3_result.log"
for d in (NAS_OUT, LOCAL_OUT):
    d.mkdir(parents=True, exist_ok=True)

PORTRAIT_PROMPT = (
    "正面半身肖像镜头:一位五十岁上下的上海弄堂女人,齐耳短发夹杂几缕银丝,"
    "穿藏青色棉布衬衫,面容和善、眼角有皱纹,平静直视镜头。柔和的左侧窗光,"
    "背景是虚化的老式厨房。固定机位,人物保持静止只有轻微呼吸起伏。\n\n"
    "音频:安静的室内环境音,远处隐约的街道声。"
)
A3_PROMPT = (
    "场景切换到与参考图背景完全不同的新场景。<Picture 1> 中的女人(同样的短发、"
    "同样的藏青色棉布衬衫、同样的面容),白天在明亮的现代化厨房里,把青菜放到流理台上,"
    "拧开水龙头洗菜,阳光洒在她侧脸上。镜头从厨房门口缓慢推近到她的半身。\n\n"
    "对白:女人轻声说:\"今天晚上做青菜面。\"\n\n"
    "音频:水流声、青菜叶摩擦声。"
)


def log(msg: str) -> None:
    line = f"[{time.strftime('%H:%M:%S')}] {msg}"
    print(line, flush=True)
    with LOG.open("a") as f:
        f.write(line + "\n")


def req(method, path, data=None, headers=None, timeout=60):
    r = urllib.request.Request(H3 + path, data=data, headers=headers or {}, method=method)
    with urllib.request.urlopen(r, timeout=timeout) as resp:
        return resp.status, resp.read()


def gpu_used():
    out = subprocess.check_output(
        ["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"]
    ).decode().split()
    return [int(x) for x in out]


def submit(prompt: dict) -> str:
    payload = json.dumps({"prompt": prompt}).encode()
    _, raw = req("POST", "/prompt", payload, {"Content-Type": "application/json"})
    return json.loads(raw)["prompt_id"]


def wait_done(pid: str) -> tuple[dict, float, list[int]]:
    peak = gpu_used()
    t0 = time.time()
    while True:
        time.sleep(10)
        cur = gpu_used()
        peak = [max(a, b) for a, b in zip(peak, cur)]
        _, hraw = req("GET", f"/history/{pid}", timeout=30)
        hist = json.loads(hraw)
        if pid in hist:
            st = hist[pid].get("status", {})
            if st.get("completed") or st.get("status_str") == "error":
                return hist[pid], time.time() - t0, peak


def fetch_artifacts(entry: dict, case: str) -> None:
    for out in entry.get("outputs", {}).values():
        for key in ("videos", "images", "gifs"):
            for v in out.get(key, []) or []:
                fn, sub, typ = v["filename"], v.get("subfolder", ""), v.get("type", "output")
                raw = urllib.request.urlopen(
                    f"{H3}/view?filename={fn}&subfolder={sub}&type={typ}", timeout=120
                ).read()
                dst = LOCAL_OUT / f"{case}.mp4"
                dst.write_bytes(raw)
                shutil.copy(dst, NAS_OUT / f"{case}.mp4")
                log(f"{case}: 产物 {fn} {len(raw)//1024}KB → 本地+NAS")


def t2v_prompt(text: str, length: int, seed: int) -> dict:
    base = json.load(open(EVAL_DIR / "t2v_prompt.json"))["prompt"]
    for n in base.values():
        if n["class_type"] == "MiniMaxH3TextToVideo":
            n["inputs"]["prompt"] = text
            n["inputs"]["length"] = length
        if n["class_type"] == "RandomNoise":
            n["inputs"]["noise_seed"] = seed
    return base


def r2v_prompt(ref_name: str, text: str, seed: int) -> dict:
    base = json.load(open(EVAL_DIR / "i2v_prompt.json"))["prompt"]
    base["6"]["inputs"]["unet_name"] = "minimax_h3_ref2va_pruned_int8_convrot.safetensors"
    base.pop("100", None)
    base["100"] = {"class_type": "LoadImage", "inputs": {"image": ref_name, "upload": True}}
    base["104"] = {
        "class_type": "MiniMaxH3ReferenceToVideo",
        "inputs": {
            "clip": ["13", 0], "vae": ["11", 0], "audio_vae": ["24", 0],
            "prompt": text, "width": 1344, "height": 768, "length": 124,
            "ref_image_size": "match",
            "ref_images.ref_image_0": ["100", 0],
        },
    }
    base["9"]["inputs"]["scheduler"] = "beta"
    base["15"]["inputs"]["noise_seed"] = seed
    return base


def main() -> None:
    # 1) 肖像镜头(2.3s 足够抽帧)
    pid = submit(t2v_prompt(PORTRAIT_PROMPT, length=56, seed=7))
    log(f"portrait t2v: {pid}")
    entry, dt, peak = wait_done(pid)
    log(f"portrait: {'done' if entry.get('status',{}).get('completed') else 'ERROR'} {dt:.0f}s 峰值 {peak}")
    fetch_artifacts(entry, "a3_portrait_src")
    # 2) 抽中间帧
    subprocess.run(["ffmpeg", "-y", "-ss", "1.2", "-i", str(LOCAL_OUT / "a3_portrait_src.mp4"),
                    "-frames:v", "1", str(EVAL_DIR / "a3_portrait_ref.png")],
                   check=True, capture_output=True)
    # 3) 上传
    boundary = uuid.uuid4().hex
    body = (f"--{boundary}\r\n".encode()
            + b'Content-Disposition: form-data; name="image"; filename="a3_portrait_ref.png"\r\n'
            + b"Content-Type: image/png\r\n\r\n"
            + (EVAL_DIR / "a3_portrait_ref.png").read_bytes() + b"\r\n"
            + f"--{boundary}--\r\n".encode())
    _, raw = req("POST", "/upload/image", body,
                 {"Content-Type": f"multipart/form-data; boundary={boundary}"}, 120)
    ref_name = json.loads(raw)["name"]
    log(f"肖像帧上传 → {ref_name}")
    # 4) ref2va 新场景
    pid = submit(r2v_prompt(ref_name, A3_PROMPT, seed=42))
    log(f"a3 r2v: {pid}")
    entry, dt, peak = wait_done(pid)
    log(f"a3_portrait_kitchen: {'done' if entry.get('status',{}).get('completed') else 'ERROR'} {dt:.0f}s 峰值 {peak}")
    fetch_artifacts(entry, "a3_portrait_kitchen")
    log("=== A3 完成 ===")


if __name__ == "__main__":
    main()
