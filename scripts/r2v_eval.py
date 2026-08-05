#!/usr/bin/env python3
"""MiniMax H3 ref2va 评测(第二轮遗留项):角色一致性矩阵 A1/A2/B1。

- 参考图:第一轮 t2v 成片抽帧(同一中年女人角色,不同时刻角度)
- A1: 1 张参考 + ref_image_size=match
- A2: 1 张参考 + ref_image_size=max(保真档,慢数倍)
- B1: 3 张参考 + match
- 串行执行(GPU 纪律),逐 run 记录耗时/显存峰值,产物落 NAS toiv/outputs/videos/h3-eval/r2v/
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
SRC_VIDEO = "/home/merlin/nas_mount/toiv/outputs/videos/h3-eval/t2v_768p_5s_00001_.mp4"
NAS_OUT = Path("/home/merlin/nas_mount/toiv/outputs/videos/h3-eval/r2v")
LOCAL_OUT = EVAL_DIR / "output" / "r2v"
LOG = EVAL_DIR / "r2v_eval_result.log"

for d in (NAS_OUT, LOCAL_OUT):
    d.mkdir(parents=True, exist_ok=True)

PROMPT_A1 = (
    "<Picture 1> 中的中年女人,白天在明亮的自家厨房里,把菜篮里的青菜放到流理台上,"
    "挽起袖子拧开水龙头洗菜,窗外阳光洒在她侧脸上。镜头从厨房门口缓慢推近到她的半身。\n\n"
    "对白:女人轻声哼着一段越剧,自言自语说:\"今天晚上给孩子做他最爱吃的青菜面。\"\n\n"
    "音频:水流声、青菜叶摩擦声、远处街道的车流声、女人轻柔的哼唱。"
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


class GpuSampler:
    def __init__(self) -> None:
        self.peak = gpu_used_mib()
        self.running = True

    def sample(self) -> None:
        cur = gpu_used_mib()
        self.peak = [max(a, b) for a, b in zip(self.peak, cur)]


def extract_frames() -> list[Path]:
    frames = []
    for i, t in enumerate(("0.5", "2.5", "4.5")):
        p = EVAL_DIR / f"r2v_ref_char_{i}.png"
        subprocess.run(
            ["ffmpeg", "-y", "-ss", t, "-i", SRC_VIDEO, "-frames:v", "1", str(p)],
            check=True, capture_output=True,
        )
        frames.append(p)
    log(f"抽帧完成: {[f.name for f in frames]}")
    return frames


def upload_image(path: Path) -> str:
    boundary = uuid.uuid4().hex
    body = b""
    body += f"--{boundary}\r\n".encode()
    body += f'Content-Disposition: form-data; name="image"; filename="{path.name}"\r\n'.encode()
    body += b"Content-Type: image/png\r\n\r\n"
    body += path.read_bytes() + b"\r\n"
    body += f"--{boundary}--\r\n".encode()
    code, raw = req("POST", "/upload/image", body,
                    {"Content-Type": f"multipart/form-data; boundary={boundary}"}, 120)
    name = json.loads(raw)["name"]
    log(f"上传 {path.name} → {name} (HTTP {code})")
    return name


def build_prompt(ref_names: list[str], ref_size: str, seed: int = 42) -> dict:
    base = json.load(open(EVAL_DIR / "i2v_prompt.json"))["prompt"]
    # UNET 换 ref2va 权重
    base["6"]["inputs"]["unet_name"] = "minimax_h3_ref2va_pruned_int8_convrot.safetensors"
    # 104: ImageToVideo → ReferenceToVideo
    inputs = {
        "clip": ["13", 0],
        "vae": ["11", 0],
        "audio_vae": ["24", 0],
        "prompt": PROMPT_A1,
        "width": 1344,
        "height": 768,
        "length": 124,
        "ref_image_size": ref_size,
    }
    # 参考图 LoadImage 节点:复用 100,新增 101/102
    load_nodes = {}
    for i, name in enumerate(ref_names):
        nid = str(100 + i)
        load_nodes[nid] = {"class_type": "LoadImage", "inputs": {"image": name, "upload": True}}
        inputs[f"ref_images.ref_image_{i}"] = [nid, 0]
    base.pop("100", None)
    base.update(load_nodes)
    base["104"] = {"class_type": "MiniMaxH3ReferenceToVideo", "inputs": inputs}
    # 调度器:参考密集时 beta 优于 simple(模板建议)
    base["9"]["inputs"]["scheduler"] = "beta"
    base["15"]["inputs"]["noise_seed"] = seed
    return {"prompt": base}


def run_case(case: str, ref_names: list[str], ref_size: str) -> None:
    log(f"=== {case}: refs={len(ref_names)} size={ref_size} ===")
    sampler = GpuSampler()
    t0 = time.time()
    payload = json.dumps(build_prompt(ref_names, ref_size)).encode()
    code, raw = req("POST", "/prompt", payload, {"Content-Type": "application/json"}, 60)
    pid = json.loads(raw)["prompt_id"]
    log(f"{case}: prompt_id={pid} (HTTP {code})")
    while True:
        time.sleep(10)
        sampler.sample()
        _, hraw = req("GET", f"/history/{pid}", timeout=30)
        hist = json.loads(hraw)
        if pid in hist:
            status = hist[pid].get("status", {})
            if status.get("completed") or status.get("status_str") == "error":
                break
    dt = time.time() - t0
    entry = hist[pid]
    ok = entry.get("status", {}).get("completed", False)
    log(f"{case}: {'done' if ok else 'ERROR'} 耗时 {dt:.0f}s 显存峰值 {sampler.peak} MiB")
    if not ok:
        log(f"{case}: 失败详情 {json.dumps(entry.get('status', {}), ensure_ascii=False)[:500]}")
        return
    # 找产物
    for out in entry.get("outputs", {}).values():
        for v in out.get("videos", []) or out.get("gifs", []) or []:
            fn, sub, typ = v["filename"], v.get("subfolder", ""), v.get("type", "output")
            _, vraw = req("GET", f"/view?filename={fn}&subfolder={sub}&type={typ}", timeout=120)
            dst = LOCAL_OUT / f"{case}.mp4"
            dst.write_bytes(vraw)
            shutil.copy(dst, NAS_OUT / f"{case}.mp4")
            log(f"{case}: 产物 {fn} → {dst} ({len(vraw)//1024}KB) + NAS 副本")


def main() -> None:
    frames = extract_frames()
    names = [upload_image(f) for f in frames]
    run_case("a1_1ref_match", names[:1], "match")
    run_case("a2_1ref_max", names[:1], "max")
    run_case("b1_3ref_match", names, "match")
    log("=== 全部完成 ===")


if __name__ == "__main__":
    sys.exit(main())
