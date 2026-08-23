#!/usr/bin/env python3
"""LongCat 接力提交:轮询 H3 两作业终态,H3 全完成后提交 LongCat×2(GPU2 错峰防 OOM)。
在 core 上 nohup 后台跑;写 /tmp/longcat_relay.log。
"""
import json
import sys
import time
import urllib.request

sys.path.insert(0, "/home/merlin/toiv/api")
from app.db import engine
from sqlmodel import Session, select

from app.models import Job, User
from app.security import create_token

H3_PIDS = [
    "0b045e20-f3f8-4575-b6d9-17ef6a04b77e",  # cyberpunk
    "a9fb4564-8fad-467a-91c5-a2089fc58933",  # jellyfish
]
LONGCAT_TASKS = [
    ("longcat_ghibli_field", {
        "positive": "吉卜力动画风格,夏日广阔原野,白云在蓝天缓缓飘动,风吹过金色草浪形成波纹,远处小屋炊烟袅袅上升,镜头缓慢平稳向前推进,手绘水彩质感,清新明亮色彩,治愈系氛围,单个连续长镜头",
        "width": 832, "height": 480, "duration_sec": 60, "fps": 16, "steps": 10, "resolution_target": "1080p"}),
    ("longcat_mountain_sunrise", {
        "positive": "电影感风光摄影,雪山日出延时,云海在山间翻涌流动,太阳缓缓升起将雪峰染成金色,光线随时间自然过渡变化,固定机位,超高清细节,史诗感构图,单个连续镜头",
        "width": 1280, "height": 720, "duration_sec": 60, "fps": 16, "steps": 10, "resolution_target": "1080p"}),
]


def h3_status() -> list[tuple[str, str]]:
    out = []
    with Session(engine) as s:
        for pid in H3_PIDS:
            j = s.exec(select(Job).where(Job.prompt_id == pid)).first()
            out.append((pid[:8], j.status if j else "missing"))
    return out


def main() -> None:
    with Session(engine) as s:
        token = create_token(str(s.exec(select(User).limit(1)).first().id))

    # 轮询 H3 终态(最多 3.5h)
    deadline = time.time() + 3.5 * 3600
    while time.time() < deadline:
        sts = h3_status()
        print(time.strftime("%H:%M:%S"), sts, flush=True)
        if all(st in ("done", "error") for _, st in sts):
            break
        time.sleep(300)

    sts = h3_status()
    if any(st == "error" for _, st in sts):
        print("H3 有 error,仍继续提交 LongCat(独立实例)", flush=True)

    jobs = json.load(open("/tmp/five_video_jobs.json"))
    for name, payload in LONGCAT_TASKS:
        req = urllib.request.Request(
            "http://localhost:8090/api/longcat/t2v",
            data=json.dumps(payload).encode(),
            headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=180) as rsp:
                body = json.loads(rsp.read())
                pid = body.get("prompt_id") or ""
                print("[" + name + "] 200 " + pid, flush=True)
                jobs[name] = pid
        except urllib.error.HTTPError as e:
            print("[" + name + "] " + str(e.code) + ": " + e.read().decode()[:150], flush=True)
        time.sleep(15)
    json.dump(jobs, open("/tmp/five_video_jobs.json", "w"))
    print("RELAY DONE", flush=True)


if __name__ == "__main__":
    main()
