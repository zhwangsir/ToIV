#!/usr/bin/env python3
"""ToIV 生产端到端验证 —— 云端入口(https://toiv.dgmt.top)。

覆盖:健康 / 登录 / 引擎注册表(含 H3) / 文生图 / 上传+图生图 /
LTX2 文生视频 / H3 文生视频 / H3 图生视频 / 登录限流 429。
生成类用例全部轮询至完成并下载产物校验魔数与大小,确保"真实可用有产物"。

用法: python3 e2e_prod_check.py [base_url]   默认 https://toiv.dgmt.top
产物落盘: /tmp/toiv_e2e_artifacts/
"""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request
import uuid

BASE = (sys.argv[1] if len(sys.argv) > 1 else "https://toiv.dgmt.top").rstrip("/")
OUT_DIR = "/tmp/toiv_e2e_artifacts"
os.makedirs(OUT_DIR, exist_ok=True)

RESULTS: list[tuple[str, bool, str]] = []


def log(msg: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def report(name: str, ok: bool, detail: str = "") -> None:
    RESULTS.append((name, ok, detail))
    log(f"{'PASS' if ok else 'FAIL'}  {name}  {detail}")


def http(method: str, path: str, token: str | None = None, body: dict | None = None,
         raw: bytes | None = None, headers: dict | None = None,
         timeout: int = 60) -> tuple[int, bytes]:
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
    # 云端跨境隧道(20% 丢包)偶发 SSL EOF/读超时:网络层错误重试 5 次,指数退避
    last_err: tuple[int, bytes] = (-1, b"")
    for attempt in range(5):
        r = urllib.request.Request(url, data=data, headers=hdrs, method=method)
        try:
            with urllib.request.urlopen(r, timeout=timeout) as resp:
                return resp.status, resp.read()
        except urllib.error.HTTPError as e:
            return e.code, e.read()
        except Exception as e:  # 网络层错误
            last_err = (-1, str(e).encode())
            if attempt < 4:
                time.sleep(3 * (attempt + 1))
    return last_err


def jhttp(method: str, path: str, **kw) -> tuple[int, dict]:
    code, data = http(method, path, **kw)
    try:
        return code, json.loads(data.decode() or "{}")
    except Exception:
        return code, {"_raw": data[:200].decode(errors="replace")}


def magic_ok(data: bytes) -> str:
    """返回识别到的类型;无法识别返回空串。"""
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "png"
    if data[:3] == b"\xff\xd8\xff":
        return "jpeg"
    if data[4:8] == b"ftyp":
        return "mp4"
    if data[:4] == b"\x1a\x45\xdf\xa3":
        return "webm"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    return ""


def download_artifact(url: str, token: str, tag: str, min_bytes: int) -> tuple[bool, str]:
    full = url if url.startswith("http") else f"{BASE}{url}"
    # url 可能已带 token 查询参数;统一再加 Authorization 头(服务端两种都接受其一即可)
    code, data = http("GET", full, token=token, timeout=300)
    if code != 200:
        return False, f"下载失败 HTTP {code}"
    kind = magic_ok(data)
    if not kind:
        return False, f"魔数无法识别({len(data)}B, head={data[:12]!r})"
    if len(data) < min_bytes:
        return False, f"产物过小 {len(data)}B < {min_bytes}B"
    path = os.path.join(OUT_DIR, f"{tag}.{kind}")
    with open(path, "wb") as f:
        f.write(data)
    return True, f"{kind} {len(data)/1024:.0f}KB → {path}"


def poll_job(prompt_id: str, token: str, timeout_s: int, label: str) -> tuple[bool, list[str]]:
    """轮询 /api/jobs 找到 prompt_id 直至 done/error。返回 (ok, 产物url列表)。"""
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


def submit_and_verify(label: str, path: str, payload: dict, token: str,
                      timeout_s: int, min_bytes: int) -> bool:
    code, body = jhttp("POST", path, token=token, body=payload, timeout=120)
    if code != 200 or "prompt_id" not in body:
        report(label, False, f"提交失败 HTTP {code}: {str(body)[:200]}")
        return False
    pid = body["prompt_id"]
    log(f"  {label}: prompt_id={pid} worker={body.get('worker','')}")
    ok, urls = poll_job(pid, token, timeout_s, label)
    if not ok or not urls:
        report(label, False, "作业未完成或无产物")
        return False
    ok, detail = download_artifact(urls[0], token, label.replace("/", "_"), min_bytes)
    report(label, ok, detail)
    return ok


def multipart_upload(file_bytes: bytes, filename: str, token: str,
                     ctype: str = "image/png") -> tuple[int, dict]:
    boundary = uuid.uuid4().hex
    parts = []
    parts.append(f"--{boundary}\r\n".encode())
    parts.append(
        f'Content-Disposition: form-data; name="image"; filename="{filename}"\r\n'
        f"Content-Type: {ctype}\r\n\r\n".encode()
    )
    parts.append(file_bytes)
    parts.append(f"\r\n--{boundary}--\r\n".encode())
    raw = b"".join(parts)
    return jhttp(
        "POST", "/api/upload?kind=img2img", token=token, raw=raw,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        timeout=120,
    )


def main() -> int:
    log(f"目标: {BASE}")

    # 1. 健康
    code, body = jhttp("GET", "/api/health", timeout=30)
    report("health", code == 200, f"HTTP {code} {str(body)[:120]}")

    # 2. 登录
    code, body = jhttp("POST", "/api/auth/login",
                       body={"email": "admin", "password": "admin123"}, timeout=30)
    token = body.get("token", "")
    report("login", code == 200 and bool(token), f"HTTP {code}")
    if not token:
        return summary()

    # 3. 引擎注册表(含 H3 双引擎)
    code, body = jhttp("GET", "/api/models/engines", token=token, timeout=30)
    engines = body if isinstance(body, list) else body.get("engines", [])
    by_id = {e.get("id"): e for e in engines}
    h3t = by_id.get("h3-t2v", {})
    h3i = by_id.get("h3-i2v", {})
    ok = code == 200 and h3t.get("available") is True and h3i.get("available") is True
    report("engines-h3", ok,
           f"HTTP {code} h3-t2v={h3t.get('available')} h3-i2v={h3i.get('available')} 共{len(engines)}引擎")

    # 4. 文生图(最小快测)
    t2i_payload = {
        "positive": "a serene mountain lake at dawn, mist, photorealistic",
        "negative": "low quality, blurry",
        "width": 512, "height": 512, "steps": 8, "batch_size": 1,
    }
    t2i_ok = submit_and_verify("txt2img", "/api/generate/txt2img", t2i_payload,
                               token, timeout_s=600, min_bytes=10_000)

    # 5. 上传 + 图生图 / H3 图生视频(共用一张参考图)
    ref_name, ref_worker = "", ""
    if t2i_ok:
        # 取 txt2img 产物字节作为参考图
        code, jobs = jhttp("GET", "/api/jobs?limit=10", token=token, timeout=30)
        ref_url = ""
        for j in jobs if isinstance(jobs, list) else []:
            if j.get("kind") == "txt2img" and j.get("status") == "done" and j.get("results"):
                ref_url = j["results"][0]
                break
        if ref_url:
            full = ref_url if ref_url.startswith("http") else f"{BASE}{ref_url}"
            c, img_bytes = http("GET", full, token=token, timeout=120)
            if c == 200 and magic_ok(img_bytes):
                # 跨境隧道丢包高:1.2MB 原图上传极易 SSL EOF,先缩到 320px JPEG(~25KB)
                try:
                    import io
                    from PIL import Image
                    im = Image.open(io.BytesIO(img_bytes)).convert("RGB")
                    im.thumbnail((320, 320))
                    buf = io.BytesIO()
                    im.save(buf, "JPEG", quality=80)
                    up_bytes, up_name, up_ctype = buf.getvalue(), "e2e_ref.jpg", "image/jpeg"
                    log(f"  参考图压缩 {len(img_bytes)//1024}KB → {len(up_bytes)//1024}KB")
                except Exception:
                    up_bytes, up_name, up_ctype = img_bytes, "e2e_ref.png", "image/png"
                uc, ub = multipart_upload(up_bytes, up_name, token, ctype=up_ctype)
                if uc == 200:
                    ref_name, ref_worker = ub.get("filename", ""), ub.get("worker", "")
                    report("upload", True, f"{ref_name} @ {ref_worker}")
                else:
                    report("upload", False, f"HTTP {uc}: {str(ub)[:160]}")
            else:
                report("upload", False, f"参考图下载失败 HTTP {c}")
        else:
            report("upload", False, "未找到 txt2img 产物")
    else:
        report("upload", False, "跳过(txt2img 未过)")

    if ref_name:
        i2i_payload = {
            "positive": "same lake, sunset light, warmer tones",
            "image": ref_name, "worker": ref_worker,
            "denoise": 0.5, "steps": 8,
        }
        submit_and_verify("img2img", "/api/generate/img2img", i2i_payload,
                          token, timeout_s=600, min_bytes=10_000)

    # 6. LTX2 文生视频(最小帧数/步数,验证链路)
    ltx_payload = {
        "positive": "gentle waves on a quiet beach, cinematic",
        "width": 256, "height": 256, "length": 9, "steps": 4, "fps": 8,
    }
    # 256x256@9帧极简规格高压缩下成品仅 ~15KB,魔数校验为主,阈值不宜过高
    submit_and_verify("ltx2_t2v", "/api/ltx2/t2v", ltx_payload,
                      token, timeout_s=1500, min_bytes=10_000)

    # 7. H3 文生视频(最小规格:256x256 / 22帧 / 4步)
    h3_payload = {
        "positive": "a small boat drifting on calm water, soft light",
        "width": 256, "height": 256, "length": 22, "steps": 4,
    }
    submit_and_verify("h3_t2v", "/api/h3/t2v", h3_payload,
                      token, timeout_s=2400, min_bytes=30_000)

    # 8. H3 图生视频
    if ref_name:
        h3i_payload = {
            "positive": "the scene gently ripples, camera slowly pushes in",
            "image": ref_name, "worker": ref_worker,
            "width": 256, "height": 256, "length": 22, "steps": 4,
        }
        submit_and_verify("h3_i2v", "/api/h3/i2v", h3i_payload,
                          token, timeout_s=2400, min_bytes=30_000)

    # 9. 登录限流:60s 5 次 → 连发 7 次应见 429
    codes = []
    for _ in range(7):
        c, _ = jhttp("POST", "/api/auth/login",
                     body={"email": "admin", "password": "admin123"}, timeout=15)
        codes.append(c)
    got_429 = 429 in codes
    report("ratelimit-login-429", got_429, f"codes={codes}")

    return summary()


def summary() -> int:
    total = len(RESULTS)
    passed = sum(1 for _, ok, _ in RESULTS if ok)
    log(f"==== 汇总 {passed}/{total} 通过;产物目录 {OUT_DIR} ====")
    for name, ok, detail in RESULTS:
        print(f"  {'PASS' if ok else 'FAIL'}  {name}  {detail}", flush=True)
    return 0 if passed == total else 1


if __name__ == "__main__":
    sys.exit(main())
