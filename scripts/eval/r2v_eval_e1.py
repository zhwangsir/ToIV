#!/usr/bin/env python3
"""ref2va E1 遗留项:参考音频音色。

- 参考音频:e1_ref_voice.wav(macOS say「Grandma 中文(中国大陆)」生成的 5-10s 中文台词,
  音色接近五十岁女性;先 scp 到 EVAL_DIR 再上传)
- 参考图:a4_portrait_ref.png(同一角色卡)
- 设计:角色卡 + 参考音频,prompt 带与参考不同内容的台词,语气/音色参考 <Audio 1>
- 判断:产出音轨是否存在 / 台词是否清晰 / 音色与参考的相似度(时长/响度/频谱质心对比;
  主观听审不可行,客观分析之外的部分记为不可定论)
- 轻量档:56 帧 × 6 steps,串行单任务
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
LOG = EVAL_DIR / "r2v_eval_e1_result.log"
REF_IMAGE = EVAL_DIR / "a4_portrait_ref.png"
REF_AUDIO = EVAL_DIR / "e1_ref_voice.wav"

for d in (NAS_OUT, LOCAL_OUT):
    d.mkdir(parents=True, exist_ok=True)

E1_PROMPT = (
    "场景切换到与参考图背景完全不同的新场景。<Picture 1> 中的女人(同样的短发、"
    "同样的藏青色棉布衬衫、同样的面容),白天在明亮的自家厨房里,一边用抹布擦流理台"
    "一边侧过头说话,说话的声音、音色和语气参考 <Audio 1>。\n\n"
    "对白:女人温和地说:\"今天菜场的小青菜特别新鲜,晚上给你下面吃。\"\n\n"
    "音频:抹布擦拭声、水流声、远处街道声。"
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


def build_prompt(img_name: str, audio_name: str, seed: int = 42) -> dict:
    base = json.load(open(EVAL_DIR / "i2v_prompt.json"))["prompt"]
    base["6"]["inputs"]["unet_name"] = "minimax_h3_ref2va_pruned_int8_convrot.safetensors"
    base.pop("100", None)
    base["100"] = {"class_type": "LoadImage", "inputs": {"image": img_name, "upload": True}}
    base["107"] = {"class_type": "LoadAudio", "inputs": {"audio": audio_name, "upload": True}}
    base["104"] = {
        "class_type": "MiniMaxH3ReferenceToVideo",
        "inputs": {
            "clip": ["13", 0], "vae": ["11", 0], "audio_vae": ["24", 0],
            "prompt": E1_PROMPT, "width": 1344, "height": 768, "length": 56,
            "ref_image_size": "match",
            "ref_images.ref_image_0": ["100", 0],
            "ref_audios.ref_audio_0": ["107", 0],
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
    if not REF_AUDIO.exists():
        log(f"ERROR: 参考音频 {REF_AUDIO} 不存在,先 scp e1_ref_voice.wav 到工作站")
        sys.exit(1)
    img_name = upload_file(REF_IMAGE, "e1_ref_char.png")
    audio_name = upload_file(REF_AUDIO, "e1_ref_voice.wav")
    run_case("e1_voice_clone_kitchen", build_prompt(img_name, audio_name))
    log("=== E1 完成 ===")


if __name__ == "__main__":
    sys.exit(main())
