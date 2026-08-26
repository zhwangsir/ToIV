#!/usr/bin/env python3
"""短剧工作室链式 E2E(云端 toiv.dgmt.top):
项目创建 → LLM 分镜拆解 → 分镜视频(LTX) → 分镜配音(IndexTTS2) → 一键合成成片 → 下载校验。

用法: python3 scripts/e2e/e2e_drama_check.py [base_url]   默认 https://toiv.dgmt.top
产物落盘: /tmp/toiv_e2e_artifacts/drama/
"""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request

BASE = (sys.argv[1] if len(sys.argv) > 1 else "https://toiv.dgmt.top").rstrip("/")
OUT = "/tmp/toiv_e2e_artifacts/drama"
os.makedirs(OUT, exist_ok=True)
RESULTS: list[tuple[str, bool, str]] = []


def log(m: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {m}", flush=True)


def report(name: str, ok: bool, detail: str = "") -> None:
    RESULTS.append((name, ok, detail))
    log(f"{'PASS' if ok else 'FAIL'}  {name}  {detail}")


def http(method, path, token=None, body=None, raw=None, headers=None, timeout=60):
    url = path if path.startswith("http") else f"{BASE}{path}"
    hdrs = {"Accept": "application/json"}
    if token:
        hdrs["Authorization"] = f"Bearer {token}"
    data = raw
    if body is not None:
        data = json.dumps(body).encode()
        hdrs["Content-Type"] = "application/json"
    if headers:
        hdrs.update(headers)
    last_err = (-1, b"")
    for attempt in range(5):
        r = urllib.request.Request(url, data=data, headers=hdrs, method=method)
        try:
            with urllib.request.urlopen(r, timeout=timeout) as resp:
                return resp.status, resp.read()
        except urllib.error.HTTPError as e:
            return e.code, e.read()
        except Exception as e:
            last_err = (-1, str(e).encode())
            if attempt < 4:
                time.sleep(3 * (attempt + 1))
    return last_err


def jhttp(method, path, **kw):
    code, data = http(method, path, **kw)
    try:
        return code, json.loads(data.decode() or "{}")
    except Exception:
        return code, {"_raw": data[:300].decode(errors="replace")}


def save(tag: str, ext: str, data: bytes) -> str:
    p = os.path.join(OUT, f"{tag}.{ext}")
    with open(p, "wb") as f:
        f.write(data)
    return p


def wait_shot(pid, sid, token, timeout_s=1200):
    deadline = time.time() + timeout_s
    seen = ""
    while time.time() < deadline:
        c, prj = jhttp("GET", f"/api/drama/projects/{pid}", token=token, timeout=30)
        if c == 200:
            for s in prj.get("shots", []):
                if s.get("id") == sid:
                    st = s.get("video_status", "")
                    if st != seen:
                        seen = st
                        log(f"  shot {sid}: video_status={st}")
                    if st == "done":
                        return True, s.get("video_url", ""), s.get("voice_status", ""), s.get("voice_url", "")
                    if st == "error":
                        return False, "", s.get("voice_status", ""), s.get("voice_url", "")
        time.sleep(10)
    return False, "", "", ""


def main() -> int:
    # 登录
    code, body = jhttp("POST", "/api/auth/login",
                       body={"email": "admin", "password": "admin123"}, timeout=30)
    token = body.get("token", "")
    if not token:
        report("login", False, f"HTTP {code}")
        return summary()
    log("login ok")

    # 1. 创建项目
    code, body = jhttp("POST", "/api/drama/projects", token=token, body={
        "title": "E2E 短剧测试-湖边偶遇",
        "premise": "两位老朋友在湖边偶遇,寒暄几句",
        "style": "cinematic, warm afternoon light, realistic",
        "script": "张伟和李娜在湖边散步时偶遇。张伟微笑着打招呼:今天天气真好啊。李娜点点头:是啊,我们一起去湖边看夕阳吧。",
        "width": 256,
        "height": 256,
        "fps": 8,
    })
    pid = body.get("id", "")
    report("create_project", code == 200 and pid, f"HTTP {code} pid={pid}")
    if not pid:
        return summary()

    # 2. 剧本拆解
    code, body = jhttp("POST", f"/api/drama/projects/{pid}/storyboard", token=token,
                       body={"num_shots": 2, "style": "cinematic, warm afternoon light, realistic"},
                       timeout=240)
    shots = body.get("shots", [])
    report("storyboard", code == 200 and len(shots) >= 2,
           f"HTTP {code} shots={len(shots)}")
    if code != 200 or len(shots) < 2:
        return summary()
    shot_ids = [s["id"] for s in shots]
    log(f"  shot_ids={shot_ids}")

    # 3. 分镜视频生成(最小规格)
    for sid in shot_ids:
        code, body = jhttp("POST", f"/api/drama/shots/{sid}/generate-video", token=token,
                           body={"steps": 4, "cfg": 1.0}, timeout=120)
        report(f"generate_video_{sid}", code == 200 and "prompt_id" in body,
               f"HTTP {code} prompt_id={body.get('prompt_id','')}")

    # 4. 轮询每个分镜视频完成
    video_done = 0
    for sid in shot_ids:
        ok, vurl, _, _ = wait_shot(pid, sid, token, timeout_s=1500)
        report(f"video_done_{sid}", ok, f"url={vurl[:80] if vurl else ''}...")
        if ok:
            video_done += 1

    if video_done < len(shot_ids):
        report("assemble", False, "分镜视频未完成")
        return summary()

    # 5. 分镜配音
    for sid in shot_ids:
        code, body = jhttp("POST", f"/api/drama/shots/{sid}/generate-voice", token=token,
                           body={"emo_text": "平静叙述"}, timeout=240)
        report(f"generate_voice_{sid}", code == 200 and body.get("url"),
               f"HTTP {code} url={body.get('url','')}")

    # 6. 合成成片
    code, body = jhttp("POST", f"/api/drama/projects/{pid}/assemble", token=token,
                       body={"title": "E2E短剧测试", "transition": "none", "fps": 8},
                       timeout=300)
    final_url = body.get("url", "")
    report("assemble", code == 200 and final_url, f"HTTP {code} url={final_url}")
    if not final_url:
        return summary()

    # 7. 下载成片校验
    c, mp4 = http("GET", final_url, token=token, timeout=120)
    ok = c == 200 and len(mp4) > 30_000 and mp4[4:8] == b"ftyp"
    report("download_final", ok, f"HTTP {c} {len(mp4)/1024:.0f}KB -> {save('final','mp4',mp4) if ok else 'fail'}")

    return summary()


def summary() -> int:
    total = len(RESULTS)
    passed = sum(1 for _, ok, _ in RESULTS if ok)
    log(f"==== 短剧板块 {passed}/{total} 通过;产物 {OUT} ====")
    for name, ok, detail in RESULTS:
        print(f"  {'PASS' if ok else 'FAIL'}  {name}  {detail}", flush=True)
    return 0 if passed == total else 1


if __name__ == "__main__":
    sys.exit(main())
