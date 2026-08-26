#!/usr/bin/env python3
"""H3 数据飞轮编排 —— eval winner 数据集 → trainer agent 训练 → LoRA 落 NAS。

闭环链路(E_data_flywheel):
  1. scripts/h3/h3_lora_dataset.py 从 core EvalScore winner 拉「媒体+caption」数据集
     (纯 HTTP API;⚠️ 依赖 evalbatch/evalscore 有数据,2026-08-27 核实生产库为空,
     需先跑 best-of-n 评测批次累积 winner)
  2. 本脚本把数据集目录挂到 trainer DATASETS_DIR 可见路径(同机软链)
  3. POST {trainer}/train family=h3(arch=minimax_h3,17n+5 帧网格自动吸附,
     low_vram 默认 true;产物每作业独立目录防 resume 误捡)
  4. 轮询 GET {trainer}/train/{id} 至 done/error,打印 LoRA 路径
     (产物经 _find_lora_file 递归发现,落 NAS h3/loras/<name>/<name>/<name>.safetensors)

⚠️ 显存协调:H3 训练峰值 ~40G,GPU2 多租户(H3 推理实例 :8195 常驻 39G)下必须先
  POST :8195/free 驱逐推理缓存(unload_models+free_memory,39G→17G),
  训练完 H3 推理下次请求自动重载(首请求慢 1-2 分钟)。本脚本 --free-h3 自动执行。

用法(workstation 或任何能同时访问 core API 与 trainer 的机器):
  python scripts/h3/h3_flywheel.py \
      --api-base http://192.168.71.47:8090 --email admin --password admin123 \
      --trainer http://192.168.71.127:9100 --h3-worker http://192.168.71.127:8195 \
      --out /home/merlin/datasets/h3_lora_eval_winners \
      --lora-name h3_style_v1 --steps 1500 --num-frames 39 --cuda-device 2 \
      --free-h3 --min-score 6.0 --limit 50

冒烟(跳过数据集导出,复用现成数据集):
  python scripts/h3/h3_flywheel.py --skip-dataset --dataset-dir h3_lora_smoke \
      --trainer http://192.168.71.127:9100 --lora-name h3_flywheel_smoke --steps 30 \
      --cuda-device 2 --free-h3 --h3-worker http://192.168.71.127:8195
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

import requests

_POLL_INTERVAL = 15
_POLL_TIMEOUT = 4 * 3600  # 训练最长等 4h(H3 1500 步量级)


def _free_h3_worker(h3_worker: str) -> None:
    """驱逐 H3 推理实例显存缓存(训练后自动重载,首请求变慢属预期)。"""
    r = requests.post(
        f"{h3_worker}/free",
        json={"unload_models": True, "free_memory": True},
        timeout=30,
    )
    r.raise_for_status()
    time.sleep(6)  # 等异步驱逐落定(AGENTS 易错点:/free 异步,立即读显存是旧值)


def _export_dataset(args: argparse.Namespace) -> str:
    """调 h3_lora_dataset.py 导出 winner 数据集,返回数据集目录名(相对 trainer DATASETS_DIR)。"""
    out = Path(args.out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    script = Path(__file__).with_name("h3_lora_dataset.py")
    cmd = [
        sys.executable, str(script),
        "--api-base", args.api_base,
        "--email", args.email, "--password", args.password,
        "--out", str(out),
        "--limit", str(args.limit),
        "--min-score", str(args.min_score),
    ]
    print(f"[flywheel] 数据集导出: {' '.join(cmd)}", flush=True)
    subprocess.run(cmd, check=True)
    media = [p for p in out.iterdir() if p.suffix.lower() in (".mp4", ".webm", ".mov", ".png", ".jpg")]
    if not media:
        raise SystemExit(
            "[flywheel] 数据集为空:evalscore 无达标 winner。"
            "先跑 best-of-n 评测批次(/api/eval/batches)累积数据再跑飞轮。"
        )
    print(f"[flywheel] 数据集就绪: {out}({len(media)} 个样本)", flush=True)
    return out.name


def _link_into_trainer_datasets(dataset_path: str, trainer_datasets_dir: str) -> str:
    """同机部署时把数据集软链进 trainer DATASETS_DIR,返回相对目录名。"""
    src = Path(dataset_path).resolve()
    link = Path(trainer_datasets_dir) / src.name
    if not link.exists():
        link.symlink_to(src)
    return src.name


def _start_train(args: argparse.Namespace, dataset_dir: str) -> str:
    body = {
        "job_id": f"flywheel_{int(time.time())}",
        "family": "h3",
        "base_ckpt": "MiniMaxAI/MiniMax-H3",  # 仅取 tokenizer,权重走 MODELS_PATH
        "dataset_dir": dataset_dir,
        "lora_name": args.lora_name,
        "steps": args.steps,
        "num_frames": args.num_frames,
        "resolution": args.resolution,
        "cuda_device": args.cuda_device,
        "trigger_words": args.trigger_words,
        "network_dim": args.rank,
        "network_alpha": args.rank,
        "lr": args.lr,
    }
    r = requests.post(f"{args.trainer}/train", json=body, timeout=60)
    if r.status_code != 200:
        raise SystemExit(f"[flywheel] 训练启动失败 {r.status_code}: {r.text[:300]}")
    data = r.json()
    if data.get("warning"):
        print(f"[flywheel] ⚠️ {data['warning']}", flush=True)
    return data["trainer_job_id"]


def _poll_train(args: argparse.Namespace, trainer_job_id: str) -> dict:
    deadline = time.time() + _POLL_TIMEOUT
    while time.time() < deadline:
        r = requests.get(f"{args.trainer}/train/{trainer_job_id}", timeout=30)
        if r.status_code == 200:
            job = r.json()
            status = job.get("status")
            prog = job.get("progress") or {}
            print(f"[flywheel] {status} step={prog.get('step')}/{prog.get('total')} loss={prog.get('loss')}", flush=True)
            if status == "done":
                return job
            if status == "error":
                raise SystemExit(f"[flywheel] 训练失败: {job.get('error')}")
        time.sleep(_POLL_INTERVAL)
    raise SystemExit("[flywheel] 训练轮询超时")


def main() -> int:
    ap = argparse.ArgumentParser(description="H3 数据飞轮编排(eval winner→dataset→train→LoRA)")
    ap.add_argument("--api-base", default="http://192.168.71.47:8090")
    ap.add_argument("--email", default="admin")
    ap.add_argument("--password", default="admin123")
    ap.add_argument("--trainer", default="http://192.168.71.127:9100")
    ap.add_argument("--h3-worker", default="http://192.168.71.127:8195")
    ap.add_argument("--out", default="/home/merlin/datasets/h3_lora_eval_winners")
    ap.add_argument("--trainer-datasets-dir", default="/home/merlin/toiv-trainer/datasets",
                    help="trainer agent DATASETS_DIR(同机软链目标)")
    ap.add_argument("--lora-name", required=True)
    ap.add_argument("--steps", type=int, default=1500)
    ap.add_argument("--num-frames", type=int, default=39, help="17n+5 网格,非法值 agent 自动吸附")
    ap.add_argument("--resolution", type=int, default=512)
    ap.add_argument("--cuda-device", type=int, default=2)
    ap.add_argument("--rank", type=int, default=16)
    ap.add_argument("--lr", type=float, default=1e-4)
    ap.add_argument("--trigger-words", default="toiv_h3_style")
    ap.add_argument("--limit", type=int, default=50)
    ap.add_argument("--min-score", type=float, default=6.0)
    ap.add_argument("--free-h3", action="store_true", help="训练前驱逐 H3 推理实例显存缓存")
    ap.add_argument("--skip-dataset", action="store_true", help="跳过导出,复用现成数据集")
    ap.add_argument("--dataset-dir", default="", help="--skip-dataset 时 trainer 侧现成数据集目录名")
    args = ap.parse_args()

    if args.skip_dataset:
        if not args.dataset_dir:
            raise SystemExit("--skip-dataset 需配 --dataset-dir")
        dataset_dir = args.dataset_dir
    else:
        out_name = _export_dataset(args)
        dataset_dir = _link_into_trainer_datasets(args.out, args.trainer_datasets_dir)
        print(f"[flywheel] 数据集已挂入 trainer: {dataset_dir}(源 {out_name})", flush=True)

    if args.free_h3:
        print("[flywheel] 驱逐 H3 推理实例显存缓存…", flush=True)
        _free_h3_worker(args.h3_worker)

    trainer_job_id = _start_train(args, dataset_dir)
    print(f"[flywheel] 训练启动: {trainer_job_id}", flush=True)
    job = _poll_train(args, trainer_job_id)
    print(json.dumps({
        "ok": True,
        "lora_name": f"{args.lora_name}.safetensors",
        "lora_path": job.get("lora_path", ""),
        "note": "LoRA 在 NAS h3/loras 下,ComfyUI H3 实例 LoraLoader 自动发现",
    }, ensure_ascii=False, indent=2), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
