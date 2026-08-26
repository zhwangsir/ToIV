#!/usr/bin/env python3
"""音频板块链式 E2E(云端 toiv.dgmt.top):TTS → 人声分离 → ASR 听写 + ACE 音乐。
TTS 产物作为分离/ASR 的真实输入,全链路产物校验魔数与大小。

用法: python3 scripts/e2e/e2e_audio_check.py [base_url]   默认 https://toiv.dgmt.top
产物落盘: /tmp/toiv_e2e_artifacts/audio/
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
OUT = "/tmp/toiv_e2e_artifacts/audio"
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
    # 云端跨境隧道(20% 丢包)偶发 SSL EOF/读超时:网络层错误重试 3 次,指数退避
    last_err = (-1, b"")
    for attempt in range(3):
        r = urllib.request.Request(url, data=data, headers=hdrs, method=method)
        try:
            with urllib.request.urlopen(r, timeout=timeout) as resp:
                return resp.status, resp.read()
        except urllib.error.HTTPError as e:
            return e.code, e.read()
        except Exception as e:  # 网络层错误
            last_err = (-1, str(e).encode())
            if attempt < 2:
                time.sleep(3 * (attempt + 1))
    return last_err


def jhttp(method, path, **kw):
    code, data = http(method, path, **kw)
    try:
        return code, json.loads(data.decode() or "{}")
    except Exception:
        return code, {"_raw": data[:300].decode(errors="replace")}


def upload(field: str, path: str, file_bytes: bytes, filename: str, token: str,
           ctype: str = "audio/wav", timeout: int = 300):
    boundary = uuid.uuid4().hex
    raw = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="{field}"; filename="{filename}"\r\n'
        f"Content-Type: {ctype}\r\n\r\n"
    ).encode() + file_bytes + f"\r\n--{boundary}--\r\n".encode()
    return jhttp("POST", path, token=token, raw=raw,
                 headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
                 timeout=timeout)


def save(tag: str, ext: str, data: bytes) -> str:
    p = os.path.join(OUT, f"{tag}.{ext}")
    with open(p, "wb") as f:
        f.write(data)
    return p


def main() -> int:
    # 登录
    code, body = jhttp("POST", "/api/auth/login",
                       body={"email": "admin", "password": "admin123"}, timeout=30)
    token = body.get("token", "")
    if not token:
        report("login", False, f"HTTP {code}")
        return 1
    log("login ok")

    # 1. TTS 配音(同步,IndexTTS2)
    line = "今天天气真好,我们一起去湖边散步,看夕阳西下。"
    code, body = jhttp("POST", "/api/manju/voice", token=token,
                       body={"text": line, "emo_text": "平静叙述"}, timeout=180)
    tts_url = body.get("url", "")
    ok = code == 200 and tts_url
    report("tts_voice", ok, f"HTTP {code} dur={body.get('duration_sec')}s {tts_url}")
    if not ok:
        return summary()
    c, wav = http("GET", tts_url, token=token, timeout=120)
    if c == 200 and wav[:4] == b"RIFF" and len(wav) > 10_000:
        report("tts_download", True, f"{len(wav)/1024:.0f}KB → {save('tts_voice', 'wav', wav)}")
    else:
        report("tts_download", False, f"HTTP {c} head={wav[:8]!r} {len(wav)}B")
        return summary()

    # 2. 人声分离(TTS wav 作输入)
    code, body = upload("file", "/api/audio/separate", wav, "tts_input.wav", token)
    sep_url = body.get("url", "")
    ok = code == 200 and sep_url
    report("separate", ok, f"HTTP {code} dur={body.get('duration_sec')}s {sep_url}")
    if ok:
        c, vox = http("GET", sep_url, token=token, timeout=120)
        if c == 200 and vox[:4] == b"RIFF" and len(vox) > 5_000:
            report("separate_download", True,
                   f"{len(vox)/1024:.0f}KB → {save('vocals', 'wav', vox)}")
        else:
            report("separate_download", False, f"HTTP {c} head={vox[:8]!r}")
    else:
        report("separate_download", False, "跳过")

    # 3. ASR 听写(验证 dub/upload 音频放行 + whisper 链路)
    code, body = upload("video", "/api/dub/upload", wav, "asr_input.wav", token)
    name = body.get("name", "")
    ok = code == 200 and name.endswith(".wav")
    report("asr_upload_audio", ok, f"HTTP {code} name={name}")
    if ok:
        code, body = jhttp("POST", "/api/dub/transcribe", token=token,
                           body={"name": name}, timeout=60)
        job_id = body.get("job_id", "")
        if code != 200 or not job_id:
            report("asr_transcribe", False, f"起作业失败 HTTP {code}: {str(body)[:200]}")
        else:
            deadline = time.time() + 600
            text_out, st = "", ""
            while time.time() < deadline:
                c, jb = jhttp("GET", f"/api/dub/transcribe/{job_id}", token=token, timeout=30)
                st = jb.get("status", "")
                if st == "done":
                    segs = jb.get("segments") or []
                    text_out = "".join(s.get("text", "") for s in segs)
                    break
                if st == "error":
                    break
                time.sleep(8)
            hit = ("天气" in text_out) or ("湖" in text_out) or ("夕阳" in text_out)
            report("asr_transcribe", st == "done" and hit,
                   f"status={st} 转写='{text_out[:60]}'")
            with open(os.path.join(OUT, "asr_transcript.txt"), "w") as f:
                f.write(text_out)
    else:
        report("asr_transcribe", False, "跳过(上传失败)")

    # 4. ACE 文生音乐(最小规格 15s/10步)
    code, body = jhttp("POST", "/api/generate/audio", token=token,
                       body={"tags": "calm cinematic piano, soft strings, gentle",
                             "seconds": 15, "steps": 10}, timeout=120)
    pid = body.get("prompt_id", "")
    if code != 200 or not pid:
        report("ace_music", False, f"提交失败 HTTP {code}: {str(body)[:200]}")
    else:
        log(f"  ace_music: prompt_id={pid} worker={body.get('worker','')}")
        deadline = time.time() + 1800
        urls, st = [], ""
        while time.time() < deadline:
            c, jobs = jhttp("GET", "/api/jobs?limit=100", token=token, timeout=30)
            if c == 200:
                for j in jobs if isinstance(jobs, list) else []:
                    if j.get("prompt_id") == pid:
                        st = j.get("status", "")
                        if st == "done":
                            urls = j.get("results") or []
                        break
                if st in ("done", "error"):
                    break
            time.sleep(10)
        if st == "done" and urls:
            c, mp3 = http("GET", urls[0], token=token, timeout=300)
            is_mp3 = mp3[:3] == b"ID3" or (mp3[:1] == b"\xff" and (mp3[1] & 0xE0) == 0xE0)
            if c == 200 and is_mp3 and len(mp3) > 30_000:
                report("ace_music", True, f"{len(mp3)/1024:.0f}KB → {save('ace_music', 'mp3', mp3)}")
            else:
                report("ace_music", False, f"下载校验失败 HTTP {c} head={mp3[:8]!r} {len(mp3)}B")
        else:
            report("ace_music", False, f"status={st} 无产物")

    return summary()


def summary() -> int:
    total = len(RESULTS)
    passed = sum(1 for _, ok, _ in RESULTS if ok)
    log(f"==== 音频板块 {passed}/{total} 通过;产物 {OUT} ====")
    for name, ok, detail in RESULTS:
        print(f"  {'PASS' if ok else 'FAIL'}  {name}  {detail}", flush=True)
    return 0 if passed == total else 1


if __name__ == "__main__":
    sys.exit(main())
