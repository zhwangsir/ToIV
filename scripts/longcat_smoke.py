#!/usr/bin/env python3
"""LongCat-Video GPU2 实例(:8197)冒烟测试:最小 t2v 工作流 + VRAM 采样。

用法: python3 scripts/longcat_smoke.py [--frames 49] [--width 480 --height 832]
"""
import argparse, json, time, urllib.request, subprocess, sys

BASE = "http://192.168.71.127:8197"


def post(path: str, payload: dict) -> dict:
    req = urllib.request.Request(
        BASE + path, data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())


def get(path: str) -> dict:
    with urllib.request.urlopen(BASE + path, timeout=30) as r:
        return json.loads(r.read())


def build_graph(width: int, height: int, frames: int, steps: int) -> dict:
    return {
        "1": {"class_type": "WanVideoLoraSelect", "inputs": {
            "lora": "LongCat_distill_lora_alpha64_bf16.safetensors",
            "strength": 1.0, "low_mem_load": False, "merge_loras": False}},
        "2": {"class_type": "WanVideoBlockSwap", "inputs": {
            "blocks_to_swap": 10, "offload_img_emb": True, "offload_txt_emb": True}},
        "3": {"class_type": "WanVideoModelLoader", "inputs": {
            "model": "LongCat/LongCat_TI2V_comfy_fp8_e4m3fn_scaled_KJ.safetensors",
            "base_precision": "bf16", "quantization": "disabled",
            "load_device": "offload_device", "attention_mode": "sdpa",
            "lora": ["1", 0], "block_swap_args": ["2", 0]}},
        "4": {"class_type": "LoadWanVideoT5TextEncoder", "inputs": {
            "model_name": "umt5-xxl-enc-fp8_e4m3fn.safetensors",
            "precision": "bf16", "load_device": "offload_device"}},
        "5": {"class_type": "WanVideoTextEncode", "inputs": {
            "positive_prompt": "雪山脚下的湖泊,清晨金色阳光洒在湖面,薄雾缓缓流动,倒映着山峰,cinematic, photorealistic",
            "negative_prompt": "low quality, blurry, watermark, distorted",
            "t5": ["4", 0]}},
        "6": {"class_type": "WanVideoEmptyEmbeds", "inputs": {
            "width": width, "height": height, "num_frames": frames}},
        "7": {"class_type": "WanVideoSampler", "inputs": {
            "model": ["3", 0], "image_embeds": ["6", 0], "text_embeds": ["5", 0],
            "steps": steps, "cfg": 1.0, "shift": 12.0, "seed": 42,
            "force_offload": True, "scheduler": "longcat_distill_euler",
            "riflex_freq_index": 0, "rope_function": "comfy"}},
        "8": {"class_type": "WanVideoVAELoader", "inputs": {
            "model_name": "Wan2_1_VAE_bf16.safetensors", "precision": "bf16"}},
        "9": {"class_type": "WanVideoDecode", "inputs": {
            "vae": ["8", 0], "samples": ["7", 0], "enable_vae_tiling": False,
            "tile_x": 272, "tile_y": 272, "tile_stride_x": 144, "tile_stride_y": 128}},
        "10": {"class_type": "VHS_VideoCombine", "inputs": {
            "images": ["9", 0], "frame_rate": 16, "loop_count": 0,
            "filename_prefix": "LongCatSmoke", "format": "video/h264-mp4",
            "pix_fmt": "yuv420p", "crf": 19, "save_metadata": True,
            "trim_to_audio": False, "pingpong": False, "save_output": True}},
    }


def gpu_mem() -> str:
    try:
        out = subprocess.run(
            ["ssh", "-o", "ConnectTimeout=10", "merlin@192.168.71.127",
             "nvidia-smi --query-gpu=index,memory.used,utilization.gpu --format=csv,noheader -i 2"],
            capture_output=True, text=True, timeout=15)
        return out.stdout.strip()
    except Exception:
        return ""


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--width", type=int, default=480)
    ap.add_argument("--height", type=int, default=832)
    ap.add_argument("--frames", type=int, default=49)
    ap.add_argument("--steps", type=int, default=10)
    args = ap.parse_args()

    print(f"提交 LongCat t2v: {args.width}x{args.height} {args.frames}帧 steps={args.steps}")
    t0 = time.time()
    resp = post("/prompt", {"prompt": build_graph(args.width, args.height, args.frames, args.steps)})
    pid = resp.get("prompt_id")
    print(f"prompt_id={pid} 轮询…(GPU2 基线: {gpu_mem()})")

    peak = ""
    while True:
        time.sleep(10)
        mem = gpu_mem()
        if mem:
            peak = mem
        hist = get(f"/history/{pid}")
        if hist:
            break
        print(f"  {int(time.time()-t0)}s GPU2: {mem}", flush=True)
        if time.time() - t0 > 1800:
            print("超时 30 分钟"); sys.exit(1)

    elapsed = time.time() - t0
    outputs = hist[pid].get("outputs", {})
    print(f"完成 {elapsed:.0f}s;GPU2 最后采样: {peak}")
    for nid, out in outputs.items():
        for v in out.get("gifs", []) + out.get("videos", []):
            print("产物:", v)
            url = f"{BASE}/view?filename={v['filename']}&subfolder={v.get('subfolder','')}&type={v.get('type','output')}"
            dest = f"test-results/longcat_smoke_{args.width}x{args.height}_{args.frames}f.mp4"
            urllib.request.urlretrieve(url, dest)
            print("已下载:", dest)
        status = hist[pid].get("status", {})
        if status.get("status_str") == "error":
            print("ERROR:", json.dumps(status, ensure_ascii=False)[:500]); sys.exit(1)


if __name__ == "__main__":
    main()
