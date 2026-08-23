#!/usr/bin/env python3
"""H3 LoRA 训练数据集准备 —— 从 core EvalScore winner 拉产物 + prompt 生成 caption 对。

数据飞轮闭环:best-of-n 批次(EvalBatch)→ 评分(EvalScore)→ 本脚本取各批次
winner 变体的产物(视频/图)落盘,旁边写同名 .txt caption(= 批次 prompt),
即 ai-toolkit / musubi 系训练器约定的「媒体 + caption」目录格式。

只走 HTTP API(不直连 DB):
  POST /api/auth/login           拿 token(返回字段是 token 不是 access_token)
  GET  /api/eval/batches         批次列表(新→旧)
  GET  /api/eval/batches/{id}    批次详情 + 逐变体排名(is_winner / result URLs)

产物 URL 带 sig(HMAC 签名)已在 result 里内嵌;下载时另附 Bearer 头
(<img>/<video> 场景的 ?token= 查询参数方式同样支持,脚本优先用请求头)。

用法:
  python scripts/h3_lora_dataset.py \
      --api-base http://100.77.80.100:8090 \
      --email admin --password admin123 \
      --out /home/merlin/datasets/h3_lora_eval_winners \
      --limit 50 --min-score 6.0

输出:
  <out>/<batch_id>_<job_id>.<ext>   winner 产物
  <out>/<batch_id>_<job_id>.txt     caption(批次 prompt)
  <out>/manifest.jsonl              逐样本元数据(batch/job/seed/score/scorer/url)
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import requests

MEDIA_EXTS = {".mp4", ".webm", ".mov", ".png", ".jpg", ".jpeg", ".webp"}


def login(api: str, email: str, password: str) -> str:
    r = requests.post(
        f"{api}/api/auth/login",
        json={"email": email, "password": password},
        timeout=30,
    )
    if r.status_code != 200:
        raise SystemExit(f"登录失败 {r.status_code}: {r.text[:200]}")
    return r.json()["token"]


def pick_ext(url: str) -> str:
    path = url.split("?", 1)[0]
    ext = Path(path).suffix.lower()
    return ext if ext in MEDIA_EXTS else ".mp4"


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--api-base", default="http://100.77.80.100:8090", help="core api 地址")
    ap.add_argument("--email", default="admin")
    ap.add_argument("--password", default="admin123")
    ap.add_argument("--out", required=True, help="数据集输出目录(媒体 + 同名 .txt)")
    ap.add_argument("--limit", type=int, default=50, help="扫描的批次数上限(新→旧)")
    ap.add_argument("--min-score", type=float, default=0.0, help="winner 分数下限,低于则跳过")
    ap.add_argument("--include-nsfw", action="store_true", help="带 X-NSFW:1 头(NSFW 批次才可见时)")
    ap.add_argument("--dry-run", action="store_true", help="只统计不下载")
    args = ap.parse_args()

    api = args.api_base.rstrip("/")
    token = login(api, args.email, args.password)
    headers = {"Authorization": f"Bearer {token}"}
    if args.include_nsfw:
        headers["X-NSFW"] = "1"

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    r = requests.get(f"{api}/api/eval/batches", headers=headers, params={"limit": args.limit}, timeout=30)
    r.raise_for_status()
    batches = r.json().get("batches", [])
    print(f"共 {len(batches)} 个批次(扫描上限 {args.limit})", flush=True)

    kept = skipped = 0
    manifest_path = out / "manifest.jsonl"
    with manifest_path.open("w", encoding="utf-8") as mf:
        for b in batches:
            bid = b["batch_id"]
            if b.get("status") != "done" or not b.get("winner_job_id"):
                skipped += 1
                continue
            d = requests.get(f"{api}/api/eval/batches/{bid}", headers=headers, timeout=30)
            if d.status_code != 200:
                print(f"  [skip] 批次 {bid} 详情 {d.status_code}", flush=True)
                skipped += 1
                continue
            view = d.json()
            winner = next(
                (v for v in view["variants"] if v["job_id"] == view["winner_job_id"]),
                None,
            )
            if winner is None or not winner.get("result"):
                skipped += 1
                continue
            if winner["score"] < args.min_score or winner.get("error"):
                skipped += 1
                continue

            url = winner["result"][0]
            full_url = url if url.startswith("http") else f"{api}{url}"
            ext = pick_ext(url)
            stem = f"{bid}_{winner['job_id']}"
            media_path = out / f"{stem}{ext}"
            caption_path = out / f"{stem}.txt"

            if not args.dry_run:
                dl = requests.get(full_url, headers=headers, timeout=300, stream=True)
                if dl.status_code != 200:
                    print(f"  [skip] 产物下载 {dl.status_code}: {full_url[:120]}", flush=True)
                    skipped += 1
                    continue
                with media_path.open("wb") as f:
                    for chunk in dl.iter_content(1 << 20):
                        f.write(chunk)
                caption_path.write_text(view["prompt"].strip() + "\n", encoding="utf-8")

            mf.write(json.dumps({
                "batch_id": bid,
                "job_id": winner["job_id"],
                "seed": winner["seed"],
                "score": winner["score"],
                "scorer": winner["scorer"],
                "prompt": view["prompt"],
                "file": media_path.name,
                "source_url": url,
            }, ensure_ascii=False) + "\n")
            kept += 1
            size = media_path.stat().st_size if media_path.exists() else 0
            print(f"  [ok] {stem}{ext} score={winner['score']:.2f} {size / 1e6:.1f}MB", flush=True)
            time.sleep(0.2)  # 温和打产线

    print(f"\n完成:保留 {kept} 样本,跳过 {skipped};manifest → {manifest_path}", flush=True)
    if args.dry_run:
        print("(dry-run:未下载产物)", flush=True)


if __name__ == "__main__":
    sys.exit(main())
