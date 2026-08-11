#!/usr/bin/env python3
"""多 worker 并行 4K 超分（M6）：抽帧 → 分片到多个 ComfyUI worker 并行超分 → 合并编码。

与单 worker 版 scripts/video_4k_upscale.py 的区别:
- 通过 ComfyUI HTTP API（/upload/image + /prompt + /history + /view）访问 worker，
  因此 worker 可以是任意可达节点（Workstation gpu0、pc01、pc02，或临时在
  GPU1/2/3 起的新实例），无需共享文件系统。
- 帧序列按 round-robin 分片，每 worker 一个线程并行处理。

⚠️ 集群约束（AGENTS.md 硬性规则）: Workstation GPU1 跑 LiveAct(~59GB)、GPU3 跑
FlashTalk(~50GB)，新增 ComfyUI 实例前必须 SSH 真机查显存。默认推荐组合:
gpu0(:8189) + pc01(:8188) + pc02(:8193)。

用法:
    python3 scripts/video_4k_upscale_parallel.py input.mp4 --output out_4k.mp4 \
        --workers http://192.168.71.127:8189,http://192.168.71.115:8188,http://192.168.71.114:8193
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
import threading
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import video_4k_upscale as up  # 复用单 worker 版的 probe/extract/encode/report

DEFAULT_WORKERS = [
    "http://192.168.71.127:8189",  # workstation gpu0
    "http://192.168.71.115:8188",  # pc01
    "http://192.168.71.114:8193",  # pc02
]

_print_lock = threading.Lock()


def _log(msg: str) -> None:
    with _print_lock:
        print(msg, flush=True)


# ---------------------------------------------------------------------------
# ComfyUI HTTP API 访问（无共享文件系统依赖）
# ---------------------------------------------------------------------------
def _upload_image(worker: str, image_path: Path, timeout: int = 120) -> str:
    """上传图片到 worker 的 input 目录，返回 ComfyUI 侧文件名。"""
    boundary = f"----toiv4k{int(time.time() * 1000)}"
    body = b"\r\n".join([
        f"--{boundary}".encode(),
        f'Content-Disposition: form-data; name="image"; filename="{image_path.name}"'.encode(),
        b"Content-Type: image/png",
        b"",
        image_path.read_bytes(),
        f"--{boundary}--".encode(),
        b"",
    ])
    req = urllib.request.Request(
        worker + "/upload/image",
        data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())["name"]


def upscale_frame_remote(
    frame_idx: int,
    frame_path: Path,
    worker: str,
    model_name: str,
    target_w: int,
    target_h: int,
    timeout: int = 600,
) -> bytes:
    """在远端 worker 上超分单帧，返回超分后 PNG 字节。"""
    image_name = _upload_image(worker, frame_path)
    graph = up.build_upscale_graph(image_name, model_name, target_w, target_h)
    resp = up.post(worker, "/prompt", {"prompt": graph}, timeout=60)
    prompt_id = resp["prompt_id"]

    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            hist = up.get(worker, f"/history/{prompt_id}", timeout=30)
        except Exception:
            hist = None
        if hist and prompt_id in hist:
            entry = hist[prompt_id]
            status = entry.get("status", {})
            if status.get("status_str") == "error":
                raise RuntimeError(f"worker {worker} error: {status}")
            outputs = entry.get("outputs", {})
            for node_out in outputs.values():
                for img in node_out.get("images", []):
                    fname = img["filename"]
                    subfolder = img.get("subfolder", "")
                    from urllib.parse import urlencode

                    params = urlencode(
                        {"filename": fname, "subfolder": subfolder, "type": "output"}
                    )
                    with urllib.request.urlopen(
                        f"{worker}/view?{params}", timeout=180
                    ) as r:
                        return r.read()
        time.sleep(0.5)
    raise TimeoutError(f"帧 {frame_idx} 在 {worker} 超分超时({timeout}s)")


# ---------------------------------------------------------------------------
# 分片并行
# ---------------------------------------------------------------------------
def _shard(items: list, n: int) -> list[list]:
    """round-robin 分片。"""
    shards = [[] for _ in range(n)]
    for i, item in enumerate(items):
        shards[i % n].append(item)
    return [s for s in shards if s]


def _worker_loop(
    worker: str,
    shard: list[tuple[int, Path]],
    merged_dir: Path,
    model_name: str,
    target_w: int,
    target_h: int,
    resume: bool,
    stats: dict,
    stats_lock: threading.Lock,
) -> list[str]:
    """单个 worker 的分片处理循环。返回错误列表。"""
    errors: list[str] = []
    for frame_idx, frame_path in shard:
        out_frame = merged_dir / f"upscaled_{frame_idx:06d}.png"
        if resume and out_frame.exists():
            continue
        t0 = time.time()
        try:
            data = upscale_frame_remote(
                frame_idx, frame_path, worker, model_name, target_w, target_h
            )
            out_frame.write_bytes(data)
            elapsed = time.time() - t0
            with stats_lock:
                stats["frame_times"].append(elapsed)
            _log(f"      [{worker.split('//')[1]}] 帧 {frame_idx} 完成 ({elapsed:.1f}s)")
        except Exception as e:
            err = f"帧 {frame_idx} @ {worker} 失败: {e}"
            errors.append(err)
            _log(f"      ❌ {err}")
            # 单帧失败不中止整个分片，最后由缺失帧检测兜底
    return errors


def main() -> int:
    ap = argparse.ArgumentParser(description="多 worker 并行 4K 超分（M6）")
    ap.add_argument("video", type=Path, help="源视频路径")
    ap.add_argument("--output", type=Path, default=Path("output_4k.mp4"))
    ap.add_argument("--workers", default=",".join(DEFAULT_WORKERS),
                    help="逗号分隔的 ComfyUI worker base URL 列表")
    ap.add_argument("--model", default=up.DEFAULT_UPSCALE_MODEL)
    ap.add_argument("--target-w", type=int, default=up.TARGET_W)
    ap.add_argument("--target-h", type=int, default=up.TARGET_H)
    ap.add_argument("--resume", action="store_true", help="跳过已超分的帧")
    ap.add_argument("--keep-frames", action="store_true")
    ap.add_argument("--temp-dir", type=Path, default=up.DEFAULT_TEMP_DIR)
    ap.add_argument("--report", type=Path, default=Path("/tmp/4k_upscale_parallel_report.md"))
    args = ap.parse_args()

    if not args.video.exists():
        print(f"错误：源视频不存在 {args.video}", file=sys.stderr)
        return 1

    workers = [w.strip().rstrip("/") for w in args.workers.split(",") if w.strip()]
    if not workers:
        print("错误：至少需要一个 worker", file=sys.stderr)
        return 1

    report = up.UpscaleReport(
        source_video=args.video,
        output_video=args.output,
        target_resolution=(args.target_w, args.target_h),
        model=args.model,
        worker=f"parallel({len(workers)}): {args.workers}",
    )

    print("=" * 60)
    print(f"多 worker 并行 4K 超分（{len(workers)} workers）")
    print("=" * 60)

    # 1. 探测 + 抽帧 + 音频
    print("[1/4] 探测与抽帧...")
    meta = up.probe_video(args.video)
    report.source_resolution = (meta["width"], meta["height"])
    report.source_fps = meta["fps"]

    tmp_dir = args.temp_dir / f"{args.video.stem}_parallel"
    frames_dir = tmp_dir / "frames"
    merged_dir = tmp_dir / "upscaled"
    frames_dir.mkdir(parents=True, exist_ok=True)
    merged_dir.mkdir(parents=True, exist_ok=True)

    frames = up.extract_frames(args.video, frames_dir)
    report.source_frames = len(frames)
    print(f"      共 {len(frames)} 帧, 分片到 {len(workers)} 个 worker")

    audio_path = tmp_dir / "audio.aac"
    has_audio = up.extract_audio(args.video, audio_path)

    # 2. 分片并行超分
    print("[2/4] 并行超分...")
    total_t0 = time.time()
    indexed = list(enumerate(frames, 1))
    shards = _shard(indexed, len(workers))
    stats = {"frame_times": []}
    stats_lock = threading.Lock()

    all_errors: list[str] = []
    with ThreadPoolExecutor(max_workers=len(shards)) as pool:
        futures = {
            pool.submit(
                _worker_loop, worker, shard, merged_dir,
                args.model, args.target_w, args.target_h, args.resume,
                stats, stats_lock,
            ): worker
            for worker, shard in zip(workers, shards)
        }
        for fut in as_completed(futures):
            all_errors.extend(fut.result())

    # 缺失帧检测
    missing = [i for i in range(1, len(frames) + 1)
               if not (merged_dir / f"upscaled_{i:06d}.png").exists()]
    if missing:
        all_errors.append(f"缺失 {len(missing)} 帧: {missing[:10]}{'...' if len(missing) > 10 else ''}")

    report.frame_times_sec = stats["frame_times"]
    report.upscale_elapsed_sec = time.time() - total_t0
    report.errors = all_errors

    if missing:
        print(f"      ❌ {len(missing)} 帧缺失，中止编码", file=sys.stderr)
        report.total_elapsed_sec = report.upscale_elapsed_sec
        args.report.write_text(report.to_markdown(), encoding="utf-8")
        return 1

    # 3. 编码
    print("[3/4] 编码 4K 视频...")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    encode_t0 = time.time()
    up.encode_video(merged_dir, args.output, meta["fps"], audio_path if has_audio else None)
    report.encode_elapsed_sec = time.time() - encode_t0
    report.total_elapsed_sec = time.time() - total_t0

    # 4. 验证 + 报告
    print("[4/4] 验证输出...")
    out_meta = up.probe_video(args.output)
    print(f"      输出: {out_meta['width']}×{out_meta['height']} @ {out_meta['fps']:.2f}fps")
    if (out_meta["width"], out_meta["height"]) != (args.target_w, args.target_h):
        report.errors.append(
            f"输出分辨率 {out_meta['width']}×{out_meta['height']} 与目标不符"
        )
    report.output_file_size_mb = args.output.stat().st_size / 1024 / 1024

    args.report.write_text(report.to_markdown(), encoding="utf-8")
    print(f"      报告: {args.report}")

    if not args.keep_frames:
        shutil.rmtree(tmp_dir, ignore_errors=True)

    avg = (sum(report.frame_times_sec) / len(report.frame_times_sec)
           if report.frame_times_sec else 0)
    print(f"完成: {report.total_elapsed_sec:.1f}s 总耗时, "
          f"{report.upscale_elapsed_sec:.1f}s 超分(均帧 {avg:.2f}s), "
          f"错误 {len(report.errors)} 条")
    return 0 if not report.errors else 2


if __name__ == "__main__":
    sys.exit(main())
