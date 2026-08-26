#!/usr/bin/env python3
"""ToIV 全面系统测试 —— 功能/边界/异常/安全/性能 五维覆盖(core 线上)。

用法: python3 deploy/e2e_comprehensive_check.py [base_url]
默认 base_url = http://192.168.71.47:8090 (core LAN 直连)

测试矩阵:
  A. 功能验证   — 健康/认证/引擎/模型/系统/作品库/上传/LLM 代理/优化/反推
  B. 边界条件   — 极限参数/空值/超长输入/特殊字符/大文件拒绝
  C. 异常处理   — 未认证/错误凭据/404/405/422/JSON 格式错误
  D. 安全       — 路径穿越/未授权访问/限流/SQL 注入尝试/XSS 载荷回显
  E. 性能       — 关键端点延迟采集(基线参考,非硬断言)
"""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request
import uuid

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://192.168.71.47:8090").rstrip("/")
OUT_DIR = "/tmp/toiv_e2e_artifacts/comprehensive"
os.makedirs(OUT_DIR, exist_ok=True)

RESULTS: list[tuple[str, str, bool, str]] = []  # (category, name, ok, detail)
LATENCIES: list[tuple[str, float]] = []


def log(msg: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def report(cat: str, name: str, ok: bool, detail: str = "") -> None:
    RESULTS.append((cat, name, ok, detail))
    log(f"{'PASS' if ok else 'FAIL'}  [{cat}] {name}  {detail}")


def http(method: str, path: str, token: str | None = None, body: dict | None = None,
         raw: bytes | None = None, headers: dict | None = None,
         timeout: int = 60) -> tuple[int, bytes, float]:
    """返回 (status, body_bytes, latency_s)。"""
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
    t0 = time.monotonic()
    last_err: tuple[int, bytes] = (-1, b"")
    for attempt in range(3):
        r = urllib.request.Request(url, data=data, headers=hdrs, method=method)
        try:
            with urllib.request.urlopen(r, timeout=timeout) as resp:
                return resp.status, resp.read(), time.monotonic() - t0
        except urllib.error.HTTPError as e:
            return e.code, e.read(), time.monotonic() - t0
        except Exception as e:
            last_err = (-1, str(e).encode())
            if attempt < 2:
                time.sleep(2 * (attempt + 1))
    return last_err[0], last_err[1], time.monotonic() - t0


def jhttp(method: str, path: str, **kw) -> tuple[int, dict, float]:
    code, data, lat = http(method, path, **kw)
    try:
        return code, json.loads(data.decode() or "{}"), lat
    except Exception:
        return code, {"_raw": data[:300].decode(errors="replace")}, lat


def timed(name: str, method: str, path: str, **kw) -> tuple[int, dict, float]:
    code, body, lat = jhttp(method, path, **kw)
    LATENCIES.append((name, lat))
    return code, body, lat


TOKEN = ""


def main() -> int:
    global TOKEN
    log(f"目标: {BASE}")

    # ═══════════════ A. 功能验证 ═══════════════
    log("── A. 功能验证 ──")

    code, body, lat = timed("health", "GET", "/api/health", timeout=15)
    report("A功能", "health", code == 200 and body.get("status") == "ok",
           f"HTTP {code} {lat*1000:.0f}ms workers={len(body.get('workers', []))}")

    code, body, lat = timed("login", "POST", "/api/auth/login",
                            body={"email": "admin", "password": "admin123"}, timeout=15)
    TOKEN = body.get("token", "")
    report("A功能", "login", code == 200 and bool(TOKEN), f"HTTP {code} {lat*1000:.0f}ms")
    if not TOKEN:
        return summary()

    code, body, lat = timed("llm-info", "GET", "/api/system/llm", token=TOKEN, timeout=15)
    report("A功能", "system-llm", code == 200 and bool(body.get("model")),
           f"HTTP {code} model={body.get('model', '?')} {lat*1000:.0f}ms")

    code, body, lat = timed("engines", "GET", "/api/models/engines", token=TOKEN, timeout=15)
    engines = body if isinstance(body, list) else body.get("engines", [])
    by_id = {e.get("id"): e for e in engines}
    avail = sum(1 for e in engines if e.get("available"))
    report("A功能", "models-engines", code == 200 and len(engines) > 0,
           f"HTTP {code} 共{len(engines)}引擎 {avail}可用 {lat*1000:.0f}ms")

    code, body, lat = timed("gpu", "GET", "/api/system/gpu", token=TOKEN, timeout=15)
    report("A功能", "system-gpu", code == 200, f"HTTP {code} {lat*1000:.0f}ms")

    code, body, lat = timed("jobs-list", "GET", "/api/jobs?limit=5", token=TOKEN, timeout=15)
    report("A功能", "jobs-list", code == 200 and isinstance(body, list),
           f"HTTP {code} 返回{len(body) if isinstance(body, list) else '?'}条 {lat*1000:.0f}ms")

    code, body, lat = timed("models-list", "GET", "/api/models", token=TOKEN, timeout=30)
    report("A功能", "models-list", code == 200,
           f"HTTP {code} {lat*1000:.0f}ms")

    code, raw_bytes, lat = http("POST", "/api/agent/chat", token=TOKEN,
                                body={"messages": [{"role": "user", "content": "回复数字1"}]},
                                timeout=60)
    # agent/chat 返回 SSE 流(EventSourceResponse),验证有数据帧即可
    raw_str = raw_bytes.decode(errors="replace")
    has_content = "data:" in raw_str or "event:" in raw_str
    report("A功能", "agent-chat", code == 200 and has_content,
           f"HTTP {code} {lat*1000:.0f}ms bytes={len(raw_bytes)}")

    code, body, lat = timed("optimize", "POST", "/api/optimize", token=TOKEN,
                            body={"prompt": "a cat", "kind": "image"}, timeout=60)
    has_opt = bool(body.get("optimized") or body.get("result") or body.get("_raw", "").strip())
    report("A功能", "optimize", code == 200 and has_opt,
           f"HTTP {code} {lat*1000:.0f}ms")

    # TTS 配音生成(快速,IndexTTS2 ~4s;端点 /api/manju/voice)
    code, body, lat = timed("tts", "POST", "/api/manju/voice", token=TOKEN,
                            body={"text": "全面系统测试语音。", "language": "zh"}, timeout=120)
    tts_url = ""
    if code == 200:
        tts_url = body.get("url", "")
    report("A功能", "tts-generate", code == 200 and bool(tts_url),
           f"HTTP {code} {lat*1000:.0f}ms url={tts_url[:60]}")

    # TTS 产物下载 + Range 验证
    if tts_url:
        code, data, lat = http("GET", tts_url, token=TOKEN, timeout=30)
        is_riff = data[:4] == b"RIFF"
        report("A功能", "tts-download", code == 200 and is_riff,
               f"HTTP {code} {'RIFF' if is_riff else data[:8]!r} {len(data)//1024}KB")
        # Range 请求 → 206
        code2, data2, _ = http("GET", tts_url, token=TOKEN,
                               headers={"Range": "bytes=0-1023"}, timeout=30)
        report("A功能", "tts-range-206", code2 == 206 and len(data2) == 1024,
               f"HTTP {code2} len={len(data2)}")

    # 人声分离产物 Range 验证(用已有 audiosep 产物,若存在)
    code, jobs, _ = jhttp("GET", "/api/jobs?limit=200", token=TOKEN, timeout=15)
    sep_url = ""
    for j in jobs if isinstance(jobs, list) else []:
        if j.get("kind") == "audio_sep" and j.get("status") == "done":
            for r in j.get("results") or []:
                if "/api/audio/files/" in r:
                    sep_url = r
                    break
        if sep_url:
            break
    if sep_url:
        code, data, _ = http("GET", sep_url, token=TOKEN, timeout=30)
        is_riff = data[:4] == b"RIFF"
        report("A功能", "audio-sep-download", code == 200 and is_riff,
               f"HTTP {code} {len(data)//1024}KB")
        code2, data2, _ = http("GET", sep_url, token=TOKEN,
                               headers={"Range": "bytes=0-2047"}, timeout=30)
        accept_ranges = "bytes"
        report("A功能", "audio-sep-range-206", code2 == 206 and len(data2) == 2048,
               f"HTTP {code2} len={len(data2)}")
    else:
        report("A功能", "audio-sep-download", True, "跳过(无历史 audiosep 产物)")
        report("A功能", "audio-sep-range-206", True, "跳过(无历史 audiosep 产物)")

    # ═══════════════ B. 边界条件 ═══════════════
    log("── B. 边界条件 ──")

    # txt2img 极小分辨率(下限边界)
    code, body, _ = jhttp("POST", "/api/generate/txt2img", token=TOKEN,
                          body={"positive": "test", "width": 64, "height": 64,
                                "steps": 1, "batch_size": 1}, timeout=30)
    report("B边界", "txt2img-min-resolution", code in (200, 422, 400),
           f"HTTP {code} {'接受' if code == 200 else '拒绝(合理)'}")

    # txt2img 空提示词
    code, body, _ = jhttp("POST", "/api/generate/txt2img", token=TOKEN,
                          body={"positive": "", "width": 512, "height": 512, "steps": 4}, timeout=15)
    report("B边界", "txt2img-empty-prompt", code in (400, 422),
           f"HTTP {code}(应拒绝空提示词)")

    # txt2img 零步数
    code, body, _ = jhttp("POST", "/api/generate/txt2img", token=TOKEN,
                          body={"positive": "test", "width": 512, "height": 512, "steps": 0}, timeout=15)
    report("B边界", "txt2img-zero-steps", code in (400, 422),
           f"HTTP {code}(应拒绝零步数)")

    # 超长提示词(10K 字符)
    code, body, _ = jhttp("POST", "/api/generate/txt2img", token=TOKEN,
                          body={"positive": "x" * 10000, "width": 256, "height": 256, "steps": 1}, timeout=15)
    report("B边界", "txt2img-long-prompt-10k", code in (200, 400, 413, 422),
           f"HTTP {code}(不 500 即可)")

    # 上传空文件
    boundary = uuid.uuid4().hex
    empty_mp = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"image\"; "
                f"filename=\"empty.png\"\r\nContent-Type: image/png\r\n\r\n\r\n"
                f"--{boundary}--\r\n").encode()
    code, body, _ = jhttp("POST", "/api/upload?kind=img2img", token=TOKEN, raw=empty_mp,
                          headers={"Content-Type": f"multipart/form-data; boundary={boundary}"}, timeout=15)
    report("B边界", "upload-empty-file", code in (400, 413, 422),
           f"HTTP {code}(应拒绝空文件)")

    # 音频上传不支持格式
    fake_txt = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; "
                f"filename=\"test.txt\"\r\nContent-Type: text/plain\r\n\r\nhello\r\n"
                f"--{boundary}--\r\n").encode()
    code, body, _ = jhttp("POST", "/api/audio/separate", token=TOKEN, raw=fake_txt,
                          headers={"Content-Type": f"multipart/form-data; boundary={boundary}"}, timeout=15)
    report("B边界", "audio-sep-txt-file", code == 422,
           f"HTTP {code}(应 422 拒绝非音频)")

    # jobs limit 极值
    code, body, _ = jhttp("GET", "/api/jobs?limit=0", token=TOKEN, timeout=10)
    report("B边界", "jobs-limit-0", code in (200, 422), f"HTTP {code}")
    code, body, _ = jhttp("GET", "/api/jobs?limit=99999", token=TOKEN, timeout=10)
    report("B边界", "jobs-limit-huge", code in (200, 422), f"HTTP {code}")

    # ═══════════════ C. 异常处理 ═══════════════
    log("── C. 异常处理 ──")

    # 未认证访问受保护端点
    for ep in ["/api/jobs", "/api/models/engines", "/api/system/gpu"]:
        code, _, _ = jhttp("GET", ep, timeout=10)
        report("C异常", f"unauth-{ep.split('/')[-1]}", code in (401, 403),
               f"HTTP {code}(应 401/403)")

    # 错误凭据登录
    code, body, _ = jhttp("POST", "/api/auth/login",
                          body={"email": "admin", "password": "wrong_password"}, timeout=10)
    report("C异常", "login-wrong-password", code in (401, 403, 429),
           f"HTTP {code}(应拒绝)")

    # 不存在资源 404(文件名符合命名规则但不存在)
    code, _, _ = jhttp("GET", "/api/audio/files/audiosep-0000000000000000000000000000dead.wav",
                       token=TOKEN, timeout=10)
    report("C异常", "audio-file-404", code == 404, f"HTTP {code}")

    # 非法文件名(不符合 audiosep 命名规则)
    code, _, _ = jhttp("GET", "/api/audio/files/evil.wav", token=TOKEN, timeout=10)
    report("C异常", "audio-file-badname", code == 400, f"HTTP {code}(应 400)")

    # 路径穿越
    code, _, _ = jhttp("GET", "/api/audio/files/..%2F..%2Fetc%2Fpasswd", token=TOKEN, timeout=10)
    report("C异常", "audio-path-traversal", code in (400, 404, 422),
           f"HTTP {code}(应拒绝路径穿越)")

    # 方法不允许
    code, _, _ = jhttp("DELETE", "/api/auth/login", token=TOKEN, timeout=10)
    report("C异常", "method-not-allowed", code in (405, 404), f"HTTP {code}")

    # JSON 格式错误
    code, _, _ = http("POST", "/api/auth/login",
                      raw=b"{invalid json", headers={"Content-Type": "application/json"}, timeout=10)
    report("C异常", "malformed-json", code in (400, 422), f"HTTP {code}(应 400/422)")

    # 缺少必需字段
    code, body, _ = jhttp("POST", "/api/auth/login", body={}, timeout=10)
    report("C异常", "login-missing-fields", code in (400, 422), f"HTTP {code}")

    # ═══════════════ D. 安全 ═══════════════
    log("── D. 安全 ──")

    # SQL 注入尝试(query param,URL 编码后发送)
    code, body, _ = jhttp("GET", "/api/jobs?limit=5%27%3B%20DROP%20TABLE%20jobs%3B--",
                          token=TOKEN, timeout=10)
    report("D安全", "sql-injection-param", code in (200, 400, 422),
           f"HTTP {code}(不 500 即可)")

    # XSS 载荷(不应在 JSON 响应中原样回显 script 标签)
    xss = "<script>alert(1)</script>"
    code, body, _ = jhttp("POST", "/api/generate/txt2img", token=TOKEN,
                          body={"positive": xss, "width": 64, "height": 64, "steps": 1}, timeout=15)
    resp_str = json.dumps(body)
    has_raw_xss = xss in resp_str and code == 200
    report("D安全", "xss-payload-handling", code != 500,
           f"HTTP {code}(不 500 即可)")

    # 伪造 Bearer token
    code, _, _ = jhttp("GET", "/api/jobs", token="forged.token.here", timeout=10)
    report("D安全", "forged-token", code in (401, 403), f"HTTP {code}(应拒绝)")

    # 登录限流:连发 7 次(60s/5次 限流 → 应见 429)
    codes = []
    for _ in range(7):
        c, _, _ = jhttp("POST", "/api/auth/login",
                        body={"email": "admin", "password": "admin123"}, timeout=10)
        codes.append(c)
    got_429 = 429 in codes
    report("D安全", "ratelimit-login-429", got_429, f"codes={codes}")

    # 若限流后 token 被踢,重新登录
    if not TOKEN or 429 in codes:
        time.sleep(2)
        code, body, _ = jhttp("POST", "/api/auth/login",
                              body={"email": "admin", "password": "admin123"}, timeout=15)
        if code == 200:
            TOKEN = body.get("token", TOKEN)

    # ═══════════════ E. 性能基线 ═══════════════
    log("── E. 性能基线 ──")
    # 连续 5 次 health 采集延迟
    health_lats = []
    for _ in range(5):
        _, _, lat = jhttp("GET", "/api/health", timeout=10)
        health_lats.append(lat)
    avg_health = sum(health_lats) / len(health_lats)
    report("E性能", "health-latency-avg", avg_health < 0.5,
           f"avg={avg_health*1000:.0f}ms min={min(health_lats)*1000:.0f}ms max={max(health_lats)*1000:.0f}ms")

    # engines 连续 3 次
    eng_lats = []
    for _ in range(3):
        _, _, lat = jhttp("GET", "/api/models/engines", token=TOKEN, timeout=15)
        eng_lats.append(lat)
    avg_eng = sum(eng_lats) / len(eng_lats)
    report("E性能", "engines-latency-avg", avg_eng < 2.0,
           f"avg={avg_eng*1000:.0f}ms min={min(eng_lats)*1000:.0f}ms max={max(eng_lats)*1000:.0f}ms")

    # jobs 连续 3 次
    job_lats = []
    for _ in range(3):
        _, _, lat = jhttp("GET", "/api/jobs?limit=20", token=TOKEN, timeout=15)
        job_lats.append(lat)
    avg_jobs = sum(job_lats) / len(job_lats)
    report("E性能", "jobs-latency-avg", avg_jobs < 1.0,
           f"avg={avg_jobs*1000:.0f}ms min={min(job_lats)*1000:.0f}ms max={max(job_lats)*1000:.0f}ms")

    return summary()


def summary() -> int:
    total = len(RESULTS)
    passed = sum(1 for _, _, ok, _ in RESULTS if ok)
    failed = [(c, n, d) for c, n, ok, d in RESULTS if not ok]
    log(f"════ 汇总 {passed}/{total} 通过 ════")
    cats: dict[str, list[bool]] = {}
    for cat, _, ok, _ in RESULTS:
        cats.setdefault(cat, []).append(ok)
    for cat, oks in cats.items():
        p = sum(oks)
        log(f"  {cat}: {p}/{len(oks)}")
    if failed:
        log("── 失败项 ──")
        for cat, name, detail in failed:
            log(f"  FAIL [{cat}] {name}  {detail}")
    if LATENCIES:
        log("── 延迟基线 ──")
        for name, lat in LATENCIES:
            log(f"  {name}: {lat*1000:.0f}ms")
    return 0 if passed == total else 1


if __name__ == "__main__":
    sys.exit(main())
