#!/usr/bin/env python3
"""MiniMax H3 视频 E2E 单独验证(云端 toiv.dgmt.top):t2v + i2v。

用法: python3 scripts/e2e/e2e_h3_check.py [base_url]   默认 https://toiv.dgmt.top
产物落盘: /tmp/toiv_e2e_artifacts/h3/
"""
from __future__ import annotations

import io
import json
import os
import sys
import time
import urllib.error
import urllib.request
import uuid

BASE = (sys.argv[1] if len(sys.argv) > 1 else "https://toiv.dgmt.top").rstrip("/")
OUT = "/tmp/toiv_e2e_artifacts/h3"
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


def poll_job(prompt_id: str, token: str, timeout_s: int, label: str):
    deadline = time.time() + timeout_s
    seen = ""
    while time.time() < deadline:
        code, body = jhttp("GET", "/api/jobs?limit=100", token=token, timeout=30)
        if code == 200:
            for job in body if isinstance(body, list) else []:
                if job.get("prompt_id") == prompt_id:
                    st = job.get("status", "")
                    if st != seen:
                        seen = st
                        log(f"  {label}: status={st}")
                    if st == "done":
                        return True, job.get("results") or []
                    if st == "error":
                        return False, []
        time.sleep(10)
    return False, []


def download_artifact(url: str, token: str, tag: str, min_bytes: int):
    full = url if url.startswith("http") else f"{BASE}{url}"
    code, data = http("GET", full, token=token, timeout=300)
    if code != 200:
        return False, f"下载失败 HTTP {code}"
    kind = "mp4" if data[4:8] == b"ftyp" else ""
    if not kind:
        return False, f"魔数无法识别({len(data)}B, head={data[:12]!r})"
    if len(data) < min_bytes:
        return False, f"产物过小 {len(data)}B < {min_bytes}B"
    return True, f"{kind} {len(data)/1024:.0f}KB -> {save(tag, kind, data)}"


def multipart_upload(file_bytes: bytes, filename: str, token: str, ctype: str = "image/png"):
    boundary = uuid.uuid4().hex
    parts = [
        f"--{boundary}\r\n".encode(),
        f'Content-Disposition: form-data; name="image"; filename="{filename}"\r\n'
        f"Content-Type: {ctype}\r\n\r\n".encode(),
        file_bytes,
        f"\r\n--{boundary}--\r\n".encode(),
    ]
    raw = b"".join(parts)
    return jhttp(
        "POST", "/api/upload?kind=img2img", token=token, raw=raw,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        timeout=120,
    )


def main() -> int:
    log(f"目标: {BASE}")
    code, body = jhttp("POST", "/api/auth/login",
                       body={"email": "admin", "password": "admin123"}, timeout=30)
    token = body.get("token", "")
    report("login", code == 200 and bool(token), f"HTTP {code}")
    if not token:
        return summary()

    # 先上传一张参考图(用简单纯色图,避免再次文生图)
    # 生成 320x320 红色 JPEG
    try:
        from PIL import Image
        im = Image.new("RGB", (320, 320), color=(180, 80, 80))
        buf = io.BytesIO()
        im.save(buf, "JPEG", quality=80)
        up_bytes, up_name, up_ctype = buf.getvalue(), "h3_ref.jpg", "image/jpeg"
    except Exception as e:
        report("prepare_ref", False, str(e))
        return summary()
    uc, ub = multipart_upload(up_bytes, up_name, token, ctype=up_ctype)
    ref_name, ref_worker = ub.get("filename", ""), ub.get("worker", "")
    report("upload", uc == 200, f"{ref_name} @ {ref_worker}")
    if uc != 200:
        return summary()

    # H3 t2v
    t2v_payload = {
        "positive": "a small paper boat floating on calm water, soft cinematic light",
        "width": 256, "height": 256, "length": 22, "steps": 4,
    }
    code, body = jhttp("POST", "/api/h3/t2v", token=token, body=t2v_payload, timeout=120)
    if code != 200 or "prompt_id" not in body:
        report("h3_t2v", False, f"提交失败 HTTP {code}: {str(body)[:200]}")
    else:
        pid = body["prompt_id"]
        log(f"  h3_t2v: prompt_id={pid}")
        ok, urls = poll_job(pid, token, 2400, "h3_t2v")
        if ok and urls:
            ok2, detail = download_artifact(urls[0], token, "h3_t2v", 20_000)
            report("h3_t2v", ok2, detail)
        else:
            report("h3_t2v", False, "未完成或无产物")

    # H3 i2v
    i2v_payload = {
        "positive": "the boat gently drifts forward, water ripples subtly",
        "image": ref_name, "worker": ref_worker,
        "width": 256, "height": 256, "length": 22, "steps": 4,
    }
    code, body = jhttp("POST", "/api/h3/i2v", token=token, body=i2v_payload, timeout=120)
    if code != 200 or "prompt_id" not in body:
        report("h3_i2v", False, f"提交失败 HTTP {code}: {str(body)[:200]}")
    else:
        pid = body["prompt_id"]
        log(f"  h3_i2v: prompt_id={pid}")
        ok, urls = poll_job(pid, token, 2400, "h3_i2v")
        if ok and urls:
            ok2, detail = download_artifact(urls[0], token, "h3_i2v", 20_000)
            report("h3_i2v", ok2, detail)
        else:
            report("h3_i2v", False, "未完成或无产物")

    return summary()


def summary() -> int:
    total = len(RESULTS)
    passed = sum(1 for _, ok, _ in RESULTS if ok)
    log(f"==== H3 板块 {passed}/{total} 通过;产物 {OUT} ====")
    for name, ok, detail in RESULTS:
        print(f"  {'PASS' if ok else 'FAIL'}  {name}  {detail}", flush=True)
    return 0 if passed == total else 1


if __name__ == "__main__":
    sys.exit(main())
