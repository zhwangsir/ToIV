#!/usr/bin/env python3
"""五路视频任务状态查询 v2(core 侧;Job.result 是 JSON 字符串)。"""
import json
import sys

sys.path.insert(0, "/home/merlin/toiv/api")
from app.db import engine
from sqlmodel import Session, select

from app.models import Job

jobs = json.load(open("/tmp/five_video_jobs.json"))
by_prompt = {v: k for k, v in jobs.items()}


def _urls(j: Job) -> str:
    try:
        data = json.loads(j.result) if j.result else []
        if isinstance(data, list) and data:
            return str(data[0])[:70]
        if isinstance(data, dict):
            return str(data.get("video_url") or data.get("url") or "")[:70]
    except Exception:
        pass
    return ""


with Session(engine) as s:
    rows = s.exec(select(Job).where(Job.prompt_id.in_(list(jobs.values())))).all()  # type: ignore[attr-defined]
    print(f"{'任务':26s} {'kind':14s} {'status':11s} {'post':10s} url")
    print("-" * 110)
    for j in sorted(rows, key=lambda r: r.created_at):
        name = by_prompt.get(j.prompt_id, "?")
        print(f"{name:26s} {j.kind:14s} {j.status:11s} {j.post_status or '-':10s} {_urls(j)}")

    # 活跃子作业(extend/续写/超分链)全局视角
    kids = s.exec(select(Job).where(
        Job.kind.in_(["h3_extend_i2v", "video_upscale", "longcat_continue", "ltx25_t2v", "longcat_t2v", "h3_t2v"]),  # type: ignore[attr-defined]
        # 近期作业
    )).all()
    recent = [k for k in kids if str(k.created_at) > "2026-08-19 03:0"]
    active = [k for k in recent if k.status in ("generating", "queued", "running", "pending")]
    done = [k for k in recent if k.status == "done"]
    print(f"\n今日相关作业: 活跃 {len(active)} / 完成 {len(done)}")
    for k in sorted(recent, key=lambda r: r.created_at)[-14:]:
        print(f"  {k.kind:16s} {k.status:11s} {str(k.created_at)[11:19]} {_urls(k)[:48]}")
