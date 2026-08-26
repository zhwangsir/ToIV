#!/usr/bin/env python3
"""H3 真机 E2E 验证(经 core 生产链路)。

链路:core API 登录 → POST /api/h3/t2v(最小参数:22 帧 17k+5、4 步、512×288)
→ 轮询 GET /api/jobs 直到 done → 拉取产物 URL 验证 200 + 视频字节。

用途:验证 core 的 TOIV_H3_BASE_URL(workstation :8195 专用实例)+ Redis 链路
端到端可用。用法:python3 scripts/h3_core_e2e.py [base_url](默认 http://192.168.71.47:8090)
"""
import json
import sys
import time
import urllib.request

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://192.168.71.47:8090"
TIMEOUT_S = 600  # 生成最长等待(22 帧 4 步热态约 1-2 分钟,留足冷启动余量)


def req(path, payload=None, token=None, timeout=30):
    r = urllib.request.Request(
        BASE + path,
        data=json.dumps(payload).encode() if payload is not None else None,
        headers={
            "Content-Type": "application/json",
            **({"Authorization": f"Bearer {token}"} if token else {}),
        },
        method="POST" if payload is not None else "GET",
    )
    with urllib.request.urlopen(r, timeout=timeout) as resp:
        return resp.status, json.loads(resp.read().decode())


def main():
    # 1. 登录
    _, login = req("/api/auth/login", {"email": "admin", "password": "admin123"})
    token = login["token"]
    print("[1/4] 登录 OK")

    # 2. 提交最小 H3 t2v
    payload = {
        "positive": "一只橘猫在窗台晒太阳,微风吹动窗帘,电影感",
        "negative": "low quality, blurry, deformed",
        "width": 512,
        "height": 288,
        "length": 22,  # 17k+5 最小帧数,约 0.9s
        "steps": 4,
    }
    _, submit = req("/api/h3/t2v", payload, token, timeout=60)
    prompt_id = submit.get("prompt_id") or submit.get("id")
    print(f"[2/4] 提交 OK prompt_id={prompt_id} 响应键={sorted(submit.keys())}")

    # 3. 轮询任务状态
    deadline = time.time() + TIMEOUT_S
    job = None
    while time.time() < deadline:
        _, data = req("/api/jobs?limit=50", token=token, timeout=30)
        jobs = data if isinstance(data, list) else data.get("jobs", [])
        job = next((j for j in jobs if j.get("prompt_id") == prompt_id), None)
        st = (job or {}).get("status")
        print(f"  … status={st} ({int(deadline - time.time())}s 剩余)", flush=True)
        if st in ("done", "failed", "error"):
            break
        time.sleep(10)
    if not job or job.get("status") != "done":
        print(f"[3/4] ✖ 任务未成功: {json.dumps(job, ensure_ascii=False)[:400]}")
        sys.exit(1)
    print(f"[3/4] 任务 done,任务字段={sorted(job.keys())}")

    # 4. 验证产物
    urls = job.get("results") or job.get("images") or job.get("result_urls") or job.get("outputs") or []
    if isinstance(urls, str):
        urls = [urls]
    if not urls:
        print(f"✖ done 但无产物 URL: {json.dumps(job, ensure_ascii=False)[:400]}")
        sys.exit(1)
    ok = 0
    for u in urls:
        full = u if u.startswith("http") else BASE + u
        r = urllib.request.Request(full, headers={"Authorization": f"Bearer {token}"})
        with urllib.request.urlopen(r, timeout=60) as resp:
            head = resp.read(64)
            size = int(resp.headers.get("Content-Length") or 0)
            ctype = resp.headers.get("Content-Type", "")
        is_video = "video" in ctype or head[4:8] == b"ftyp"
        print(f"  产物 {u} → {resp.status} {ctype} {size}B video={is_video}")
        ok += 1 if (resp.status == 200 and (size > 1024 or is_video)) else 0
    if ok == len(urls):
        print(f"[4/4] ✅ H3 真机 E2E 通过({ok}/{len(urls)} 产物有效)")
    else:
        print(f"[4/4] ✖ 产物验证失败({ok}/{len(urls)})")
        sys.exit(1)


if __name__ == "__main__":
    main()
