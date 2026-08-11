#!/usr/bin/env python3
"""4K 视频超分测试脚本：抽帧 → ComfyUI 帧级 ESRGAN 4× 超分 → 编码为 3840×2160 MP4。

设计目标：
1. 直接调用 ComfyUI /prompt API，复用 worker 上已有的 UpscaleModelLoader / ImageUpscaleWithModel / ImageScale 节点。
2. 默认运行在 Workstation 上，可直接读写 /opt/ComfyUI/input 与 /opt/ComfyUI/output。
3. 支持断点续跑：已超分的帧会跳过。
4. 输出详细耗时、显存、ffprobe 元数据到报告文件。

用法示例（在 Workstation 上）：
    python3 scripts/video_4k_upscale.py /tmp/test_1344x768.mp4 --output /tmp/output_4k.mp4
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import time
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

DEFAULT_COMFY_BASE = "http://127.0.0.1:8189"
DEFAULT_INPUT_DIR = Path("/opt/ComfyUI/instances/gpu0/input")
DEFAULT_OUTPUT_DIR = Path("/opt/ComfyUI/instances/gpu0/output")
DEFAULT_UPSCALE_MODEL = "4x-UltraSharp.pth"
DEFAULT_TEMP_DIR = Path("/var/tmp/4k_upscale")
TARGET_W, TARGET_H = 3840, 2160


@dataclass
class UpscaleReport:
    """单次 4K 超分测试报告。"""

    source_video: Path
    output_video: Path
    source_resolution: tuple[int, int] = (0, 0)
    source_fps: float = 0.0
    source_frames: int = 0
    target_resolution: tuple[int, int] = (TARGET_W, TARGET_H)
    model: str = DEFAULT_UPSCALE_MODEL
    worker: str = DEFAULT_COMFY_BASE
    total_elapsed_sec: float = 0.0
    upscale_elapsed_sec: float = 0.0
    encode_elapsed_sec: float = 0.0
    frame_times_sec: list[float] = field(default_factory=list)
    peak_gpu_memory_mb: int = 0
    output_file_size_mb: float = 0.0
    errors: list[str] = field(default_factory=list)

    def to_markdown(self) -> str:
        avg = sum(self.frame_times_sec) / len(self.frame_times_sec) if self.frame_times_sec else 0
        lines = [
            "# 4K 视频超分测试报告",
            "",
            f"- **源视频**: `{self.source_video}`",
            f"- **源分辨率**: {self.source_resolution[0]}×{self.source_resolution[1]}",
            f"- **源帧率**: {self.source_fps:.2f} fps",
            f"- **源总帧数**: {self.source_frames}",
            f"- **目标分辨率**: {self.target_resolution[0]}×{self.target_resolution[1]}",
            f"- **超分模型**: {self.model}",
            f"- **ComfyUI worker**: {self.worker}",
            f"- **超分耗时**: {self.upscale_elapsed_sec:.1f} s",
            f"- **编码耗时**: {self.encode_elapsed_sec:.1f} s",
            f"- **总耗时**: {self.total_elapsed_sec:.1f} s",
            f"- **平均每帧超分耗时**: {avg:.2f} s",
            f"- **峰值 GPU 显存**: {self.peak_gpu_memory_mb} MB",
            f"- **输出文件大小**: {self.output_file_size_mb:.1f} MB",
            f"- **错误数**: {len(self.errors)}",
            "",
        ]
        if self.errors:
            lines.append("## 错误")
            for e in self.errors:
                lines.append(f"- {e}")
            lines.append("")
        return "\n".join(lines)


def post(base: str, path: str, payload: dict, timeout: int = 120) -> dict:
    req = urllib.request.Request(
        base + path,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def get(base: str, path: str, timeout: int = 60) -> dict:
    with urllib.request.urlopen(base + path, timeout=timeout) as r:
        return json.loads(r.read())


def gpu_memory_mb(gpu_index: int = 0) -> int:
    """查询指定 GPU 当前显存使用(MB)。"""
    try:
        out = subprocess.run(
            ["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader", "-i", str(gpu_index)],
            capture_output=True, text=True, timeout=10, check=True,
        )
        return int(out.stdout.strip().replace(" MiB", ""))
    except Exception:
        return 0


def probe_video(path: Path) -> dict:
    """ffprobe 获取视频宽度、高度、帧率。"""
    cmd = [
        "ffprobe", "-v", "error",
        "-select_streams", "v:0",
        "-show_entries", "stream=width,height,r_frame_rate",
        "-of", "json", str(path),
    ]
    out = subprocess.run(cmd, capture_output=True, text=True, check=True).stdout
    data = json.loads(out)
    stream = data["streams"][0]
    w = int(stream["width"])
    h = int(stream["height"])
    fps = eval(stream["r_frame_rate"])  # e.g. "24/1" -> 24.0
    return {"width": w, "height": h, "fps": fps}


def extract_frames(video: Path, out_dir: Path) -> list[Path]:
    """ffmpeg 抽帧为 frame_%06d.png。"""
    out_dir.mkdir(parents=True, exist_ok=True)
    pattern = out_dir / "frame_%06d.png"
    cmd = [
        "ffmpeg", "-y", "-i", str(video),
        "-pix_fmt", "rgb24",
        "-start_number", "1",
        str(pattern),
    ]
    subprocess.run(cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    frames = sorted(out_dir.glob("frame_*.png"))
    return frames


def build_upscale_graph(image_name: str, model_name: str, target_w: int, target_h: int) -> dict:
    """构建单帧超分图：4× 模型 → ImageScale 到目标 4K 分辨率。"""
    return {
        "10": {"class_type": "UpscaleModelLoader", "inputs": {"model_name": model_name}},
        "11": {"class_type": "LoadImage", "inputs": {"image": image_name}},
        "12": {
            "class_type": "ImageUpscaleWithModel",
            "inputs": {"upscale_model": ["10", 0], "image": ["11", 0]},
        },
        "13": {
            "class_type": "ImageScale",
            "inputs": {
                "image": ["12", 0],
                "width": target_w,
                "height": target_h,
                "upscale_method": "lanczos",
                "crop": "center",
            },
        },
        "9": {
            "class_type": "SaveImage",
            "inputs": {"images": ["13", 0], "filename_prefix": "4k_upscale"},
        },
    }


def find_upscaled_output(comfy_base: str, output_dir: Path, prompt_id: str) -> Optional[Path]:
    """在历史记录中查找 SaveImage 输出文件名。"""
    try:
        hist = get(comfy_base, f"/history/{prompt_id}", timeout=30)
    except Exception:
        return None
    if not hist or prompt_id not in hist:
        return None
    entry = hist[prompt_id]
    status = entry.get("status", {})
    if status.get("status_str") == "error":
        raise RuntimeError(f"ComfyUI error: {status}")
    outputs = entry.get("outputs", {})
    for node_id, node_out in outputs.items():
        for img in node_out.get("images", []):
            filename = img["filename"]
            subfolder = img.get("subfolder", "")
            if subfolder:
                return output_dir / subfolder / filename
            return output_dir / filename
    return None


def upscale_frame(
    frame_idx: int,
    frame_path: Path,
    input_dir: Path,
    output_dir: Path,
    comfy_base: str,
    model_name: str,
    target_w: int,
    target_h: int,
    timeout: int = 600,
) -> Path:
    """单帧超分。返回超分后图片在 output_dir 中的路径。"""
    src_name = f"4k_src_{frame_idx:06d}.png"
    src_path = input_dir / src_name
    shutil.copy2(frame_path, src_path)

    graph = build_upscale_graph(src_name, model_name, target_w, target_h)
    resp = post(comfy_base, "/prompt", {"prompt": graph}, timeout=60)
    prompt_id = resp["prompt_id"]

    t0 = time.time()
    while time.time() - t0 < timeout:
        out_path = find_upscaled_output(comfy_base, output_dir, prompt_id)
        if out_path and out_path.exists():
            return out_path
        time.sleep(0.5)
    raise TimeoutError(f"Frame {frame_idx} upscale timeout ({timeout}s)")


def encode_video(
    frame_dir: Path,
    output: Path,
    fps: float,
    audio_source: Optional[Path] = None,
) -> None:
    """将帧序列编码为 MP4。"""
    pattern = frame_dir / "upscaled_%06d.png"
    cmd = ["ffmpeg", "-y", "-framerate", str(fps), "-i", str(pattern)]
    if audio_source and audio_source.exists():
        cmd += [
            "-i", str(audio_source),
            "-c:a", "aac", "-b:a", "192k",
            "-shortest",
        ]
    cmd += [
        "-c:v", "libx264",
        "-preset", "medium",
        "-crf", "18",
        "-pix_fmt", "yuv420p",
        "-movflags", "+faststart",
        str(output),
    ]
    subprocess.run(cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)


def extract_audio(video: Path, audio_path: Path) -> bool:
    """提取音频轨道，返回是否成功。"""
    try:
        subprocess.run(
            ["ffmpeg", "-y", "-i", str(video), "-vn", "-c:a", "copy", str(audio_path)],
            check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        return audio_path.exists() and audio_path.stat().st_size > 0
    except Exception:
        return False


def main() -> int:
    ap = argparse.ArgumentParser(description="4K 视频帧级超分测试")
    ap.add_argument("video", type=Path, help="源视频路径")
    ap.add_argument("--output", type=Path, default=Path("output_4k.mp4"), help="输出 4K MP4 路径")
    ap.add_argument("--worker", default=DEFAULT_COMFY_BASE, help="ComfyUI worker base URL")
    ap.add_argument("--input-dir", type=Path, default=DEFAULT_INPUT_DIR, help="ComfyUI input 目录")
    ap.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT_DIR, help="ComfyUI output 目录")
    ap.add_argument("--model", default=DEFAULT_UPSCALE_MODEL, help="超分模型文件名")
    ap.add_argument("--target-w", type=int, default=TARGET_W, help="目标宽度")
    ap.add_argument("--target-h", type=int, default=TARGET_H, help="目标高度")
    ap.add_argument("--gpu-index", type=int, default=0, help="监控显存的 GPU 索引")
    ap.add_argument("--keep-frames", action="store_true", help="保留临时帧目录")
    ap.add_argument("--resume", action="store_true", help="断点续跑：跳过已存在的超分帧")
    ap.add_argument("--report", type=Path, default=Path("/tmp/4k_upscale_report.md"), help="报告输出路径")
    ap.add_argument("--temp-dir", type=Path, default=DEFAULT_TEMP_DIR, help="临时帧目录（默认 /var/tmp 避免 tmpfs 爆内存）")
    args = ap.parse_args()

    if not args.video.exists():
        print(f"错误：源视频不存在 {args.video}", file=sys.stderr)
        return 1

    report = UpscaleReport(
        source_video=args.video,
        output_video=args.output,
        target_resolution=(args.target_w, args.target_h),
        model=args.model,
        worker=args.worker,
    )

    print("=" * 60)
    print("4K 视频超分测试启动")
    print("=" * 60)

    # 1. 视频信息
    print("[1/5] 探测源视频信息...")
    meta = probe_video(args.video)
    report.source_resolution = (meta["width"], meta["height"])
    report.source_fps = meta["fps"]
    print(f"      分辨率: {meta['width']}×{meta['height']}, 帧率: {meta['fps']:.2f} fps")

    # 2. 抽帧
    print("[2/5] 抽帧...")
    tmp_dir = args.temp_dir / args.video.stem
    frames_dir = tmp_dir / "frames"
    upscaled_dir = tmp_dir / "upscaled"
    frames_dir.mkdir(parents=True, exist_ok=True)
    upscaled_dir.mkdir(parents=True, exist_ok=True)

    frames = extract_frames(args.video, frames_dir)
    report.source_frames = len(frames)
    print(f"      共 {len(frames)} 帧 -> {frames_dir}")

    # 3. 提取音频
    audio_path = tmp_dir / "audio.aac"
    has_audio = extract_audio(args.video, audio_path)
    if has_audio:
        print(f"      已提取音频 -> {audio_path}")
    else:
        print("      无音频或提取失败，输出将无音轨")

    # 4. 逐帧超分
    print("[3/5] 逐帧超分...")
    report.frame_times_sec = []
    report.peak_gpu_memory_mb = gpu_memory_mb(args.gpu_index)
    upscale_t0 = time.time()

    for i, frame in enumerate(frames, 1):
        out_frame = upscaled_dir / f"upscaled_{i:06d}.png"
        if args.resume and out_frame.exists():
            print(f"      帧 {i}/{len(frames)} 已存在，跳过")
            report.frame_times_sec.append(0.0)
            continue

        print(f"      帧 {i}/{len(frames)}: {frame.name} -> {out_frame.name}", end=" ", flush=True)
        t0 = time.time()
        src_name = f"4k_src_{i:06d}.png"
        src_path = args.input_dir / src_name
        try:
            upscaled = upscale_frame(
                i, frame, args.input_dir, args.output_dir,
                args.worker, args.model, args.target_w, args.target_h,
            )
            shutil.copy2(upscaled, out_frame)
            # 清理 ComfyUI input/output 中的临时文件，避免长视频累积数万文件拖慢目录
            try:
                if src_path.exists():
                    src_path.unlink()
                if upscaled.exists():
                    upscaled.unlink()
            except Exception:
                pass
            elapsed = time.time() - t0
            report.frame_times_sec.append(elapsed)
            mem = gpu_memory_mb(args.gpu_index)
            if mem > report.peak_gpu_memory_mb:
                report.peak_gpu_memory_mb = mem
            print(f"({elapsed:.1f}s, GPU{args.gpu_index} {mem}MB)")
        except Exception as e:
            elapsed = time.time() - t0
            report.frame_times_sec.append(elapsed)
            err = f"帧 {i} 超分失败: {e}"
            report.errors.append(err)
            print(f"\n      ❌ {err}", file=sys.stderr)
            # 失败一帧即中止，避免浪费算力
            return 1

    report.upscale_elapsed_sec = time.time() - upscale_t0

    # 5. 编码
    print("[4/5] 编码 4K 视频...")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    encode_t0 = time.time()
    encode_video(upscaled_dir, args.output, meta["fps"], audio_path if has_audio else None)
    report.encode_elapsed_sec = time.time() - encode_t0

    # 6. 验证
    print("[5/5] 验证输出...")
    out_meta = probe_video(args.output)
    print(f"      输出分辨率: {out_meta['width']}×{out_meta['height']}, 帧率: {out_meta['fps']:.2f} fps")
    if (out_meta["width"], out_meta["height"]) != (args.target_w, args.target_h):
        report.errors.append(
            f"输出分辨率 {out_meta['width']}×{out_meta['height']} 与目标 {args.target_w}×{args.target_h} 不符"
        )
        print(f"      ⚠️ 分辨率不匹配", file=sys.stderr)
        return 1

    report.total_elapsed_sec = report.upscale_elapsed_sec + report.encode_elapsed_sec
    if args.output.exists():
        report.output_file_size_mb = args.output.stat().st_size / (1024 * 1024)
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(report.to_markdown(), encoding="utf-8")

    if not args.keep_frames:
        shutil.rmtree(tmp_dir, ignore_errors=True)

    print("=" * 60)
    print(f"✅ 4K 超分完成: {args.output}")
    print(f"   平均每帧: {sum(report.frame_times_sec)/len(report.frame_times_sec):.2f}s")
    print(f"   峰值显存: {report.peak_gpu_memory_mb} MB")
    print(f"   报告: {args.report}")
    print("=" * 60)
    return 0


if __name__ == "__main__":
    sys.exit(main())
