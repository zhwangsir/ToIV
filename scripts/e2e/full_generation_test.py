#!/usr/bin/env python3
"""ToIV 全功能真机生成测试(经 core 生产链路,串行执行 + GPU 负载监控)。

覆盖:txt2img → img2img → upscale → removebg → LTX2.3 t2v/i2v → H3 t2v/i2v
     → ACE 文生音乐(120s) → IndexTTS2 配音 → faster-whisper 听写 → Demucs 人声分离

纪律:全程串行(不给 GPU 并发压力,H3 实例单任务);大文件落本机 test-results/fullgen/。
监控:每 10s 采样 core /api/system/gpu(ComfyUI 池)+ workstation nvidia-smi(4 卡真实负载)。

用法:python3 scripts/full_generation_test.py [base_url](默认 http://192.168.71.47:8090)
"""
import json
import os
import subprocess
import sys
import threading
import time
import urllib.request
from pathlib import Path

BASE = sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith("--") else "http://192.168.71.47:8090"
ONLY = None  # --only 6,7,8,12 只跑指定步骤
for a in sys.argv[1:]:
    if a.startswith("--only="):
        ONLY = set(a.split("=", 1)[1].split(","))


def want(step):
    return ONLY is None or step in ONLY
OUT = Path(__file__).resolve().parent.parent / "test-results" / "fullgen"
OUT.mkdir(parents=True, exist_ok=True)

REPORT = []  # (name, ok, detail)
GPU_SAMPLES = []  # (ts, source, text)
STOP = threading.Event()


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def req(path, payload=None, token=None, timeout=60, method=None):
    r = urllib.request.Request(
        BASE + path,
        data=json.dumps(payload).encode() if payload is not None else None,
        headers={
            "Content-Type": "application/json",
            **({"Authorization": f"Bearer {token}"} if token else {}),
        },
        method=method or ("POST" if payload is not None else "GET"),
    )
    with urllib.request.urlopen(r, timeout=timeout) as resp:
        return resp.status, json.loads(resp.read().decode())


def upload_file(path, field, token, extra="", filename=None):
    """multipart 上传(纯 urllib)。"""
    boundary = "----toivfullgen"
    data = Path(path).read_bytes() if not isinstance(path, bytes) else path
    fname = filename or (Path(path).name if not isinstance(path, bytes) else "upload.bin")
    body = (
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"{field}\"; filename=\"{fname}\"\r\n"
        f"Content-Type: application/octet-stream\r\n\r\n"
    ).encode() + data + f"\r\n--{boundary}--\r\n".encode()
    url = BASE + "/api/upload" + extra if field == "image" else BASE + extra
    r = urllib.request.Request(
        url, data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}",
                 "Authorization": f"Bearer {token}"}, method="POST")
    with urllib.request.urlopen(r, timeout=120) as resp:
        return json.loads(resp.read().decode())


def download(url, token, dest):
    full = url if url.startswith("http") else BASE + url
    r = urllib.request.Request(full, headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(r, timeout=180) as resp:
        blob = resp.read()
    Path(dest).write_bytes(blob)
    return len(blob), blob[:16]


def magic_ok(blob, kind):
    if kind == "image":
        return blob[:4] == b"\x89PNG" or blob[:2] == b"\xff\xd8"
    if kind == "video":
        return blob[4:8] == b"ftyp"
    if kind == "audio":
        return blob[:4] == b"RIFF" or blob[:3] == b"ID3" or blob[:2] == b"\xff\xfb" or blob[:4] == b"fLaC" or blob[:4] == b"OggS"
    return True


def poll_job(prompt_id, token, timeout_s=1200, interval=10):
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        try:
            _, data = req("/api/jobs?limit=50", token=token, timeout=30)
        except Exception as e:
            # toiv-api 可能中途重启(systemd Restart=always),连接错误重试而非中断
            log(f"  … 轮询瞬时失败({type(e).__name__}),10s 后重试")
            time.sleep(interval)
            continue
        jobs = data if isinstance(data, list) else data.get("jobs", [])
        job = next((j for j in jobs if j.get("prompt_id") == prompt_id), None)
        st = (job or {}).get("status")
        if st in ("done", "failed", "error"):
            return job
        time.sleep(interval)
    return None


def gpu_sampler(token):
    while not STOP.is_set():
        ts = time.strftime("%H:%M:%S")
        try:
            _, g = req("/api/system/gpu", token=token, timeout=10)
            GPUs = " ".join(f"{x['id']}:{x['load']:.0f}%/{x['vram']:.0f}%" for x in g.get("gpus", []))
            GPU_SAMPLES.append((ts, "pool", f"{GPUs} queue={g.get('queueDepth')}"))
        except Exception as e:
            GPU_SAMPLES.append((ts, "pool", f"err {e}"))
        try:
            out = subprocess.run(
                ["ssh", "-o", "ConnectTimeout=5", "-o", "StrictHostKeyChecking=no",
                 "merlin@192.168.71.127",
                 "nvidia-smi --query-gpu=index,utilization.gpu,memory.used,memory.total --format=csv,noheader"],
                capture_output=True, text=True, timeout=15)
            for line in out.stdout.strip().splitlines():
                GPU_SAMPLES.append((ts, "ws", line.strip()))
        except Exception as e:
            GPU_SAMPLES.append((ts, "ws", f"err {e}"))
        STOP.wait(10)


def run_gen(name, path, payload, token, kind, timeout_s=1200, direct=False, out_ext=None):
    """提交生成 → 轮询 → 下载产物 → 校验。"""
    log(f"▶ {name} 提交…")
    t0 = time.time()
    try:
        _, resp = req(path, payload, token, timeout=120)
    except Exception as e:
        REPORT.append((name, False, f"提交失败: {e}"))
        log(f"  ✖ 提交失败: {e}")
        return None
    urls = []
    if direct:
        urls = [resp.get("url")]
    else:
        pid = resp.get("prompt_id") or resp.get("id")
        if not pid:
            REPORT.append((name, False, f"无 prompt_id: {json.dumps(resp, ensure_ascii=False)[:200]}"))
            return None
        log(f"  prompt_id={pid} 轮询…")
        job = poll_job(pid, token, timeout_s=timeout_s)
        if not job or job.get("status") != "done":
            st = (job or {}).get("status", "timeout")
            REPORT.append((name, False, f"任务未成功 status={st}"))
            log(f"  ✖ status={st}")
            return None
        urls = job.get("results") or job.get("images") or job.get("result_urls") or []
        if isinstance(urls, str):
            urls = [urls]
    dur = time.time() - t0
    if not urls:
        REPORT.append((name, False, "done 但无产物 URL"))
        return None
    saved = []
    for i, u in enumerate(urls):
        ext = out_ext or Path(u.split("?")[0]).suffix or ".bin"
        dest = OUT / f"{name}{'_' + str(i) if i else ''}{ext}"
        try:
            size, head = download(u, token, dest)
        except Exception as e:
            REPORT.append((name, False, f"产物下载失败: {e}"))
            return None
        ok = magic_ok(head, kind) and size > 1024
        saved.append(str(dest))
        log(f"  产物 {dest.name} {size/1024:.0f}KB magic_ok={magic_ok(head, kind)}")
        if not ok:
            REPORT.append((name, False, f"产物校验失败 size={size}"))
            return None
    REPORT.append((name, True, f"{dur:.0f}s, {len(urls)} 产物, {Path(saved[0]).stat().st_size/1024:.0f}KB"))
    log(f"✔ {name} 完成({dur:.0f}s)")
    return saved[0] if saved else None


def main():
    # 登录
    _, login = req("/api/auth/login", {"email": "admin", "password": "admin123"})
    token = login["token"]
    log("登录 OK")

    # 引擎健康快照
    try:
        _, health = req("/api/models/health", token=token, timeout=30)
        bad = [m["name"] for grp in ("image_models", "text_encoders", "vaes")
               for m in health.get(grp, []) if m.get("status") != "healthy"]
        llm_bad = [e["model_id"] for e in health.get("llm_endpoints", []) if e.get("status") != "healthy"]
        log(f"引擎健康: overall={health.get('overall_status')} 异常模型={bad or '无'} 异常LLM={llm_bad or '无'}")
    except Exception as e:
        log(f"健康检查失败: {e}")

    # GPU 监控线程
    th = threading.Thread(target=gpu_sampler, args=(token,), daemon=True)
    th.start()

    # ── 1. 文生图(1024×1024 大图) ──
    img_a = None
    if want("1"):
        img_a = run_gen("1_txt2img", "/api/generate/txt2img", {        "positive": "雪山脚下的湖泊,清晨金色阳光,倒映着山峰,超高清摄影,细节丰富",
        "negative": "low quality, blurry, watermark",
        "width": 1024, "height": 1024, "steps": 28, "cfg": 7.0, "seed": 42,
        }, token, "image", timeout_s=600)
    if img_a is None:
        prev = OUT / "1_txt2img.bin"
        if prev.is_file():
            img_a = str(prev)
            log(f"复用上次源图: {prev.name}")

    # ── 2. 上传 + 图生图 ──
    if img_a and want("2"):
        up = upload_file(img_a, "image", token)
        log(f"上传 OK: {up.get('filename')} @ {up.get('worker')}")
        img_b = run_gen("2_img2img", "/api/generate/img2img", {
            "positive": "同一湖泊场景,油画风格,笔触明显,色彩浓郁",
            "image": up["filename"], "worker": up["worker"],
            "denoise": 0.55, "steps": 25, "seed": 42,
        }, token, "image", timeout_s=600)
    elif want("2"):
        REPORT.append(("2_img2img", False, "跳过(无源图)"))

    # ── 3. 高清放大(2x → 2048² 大文件) ──
    if img_a and want("3"):
        up2 = upload_file(img_a, "image", token, extra="?kind=upscale")
        run_gen("3_upscale", "/api/generate/upscale", {
            "image": up2["filename"], "worker": up2["worker"], "scale": 2.0,
        }, token, "image", timeout_s=900)
    elif want("3"):
        REPORT.append(("3_upscale", False, "跳过(无源图)"))

    # ── 4. 去背景 ──
    if img_a and want("4"):
        up3 = upload_file(img_a, "image", token, extra="?kind=removebg")
        run_gen("4_removebg", "/api/generate/removebg", {
            "image": up3["filename"], "worker": up3["worker"],
        }, token, "image", timeout_s=600)
    elif want("4"):
        REPORT.append(("4_removebg", False, "跳过(无源图)"))

    # ── 5. LTX 2.3 文生视频(121 帧 @16fps ≈ 7.6s) ──
    if want("5"):
        run_gen("5_ltx_t2v", "/api/ltx2/t2v", {
        "positive": "航拍镜头缓慢推进,雪山湖泊全景,云雾缭绕,电影质感",
        "negative": "low quality, blurry",
        "width": 768, "height": 384, "length": 121, "fps": 16, "steps": 20, "seed": 42,
        }, token, "video", timeout_s=1800)

    # ── 6. LTX 2.3 图生视频 ──
    if img_a and want("6"):
        up4 = upload_file(img_a, "image", token, extra="?kind=ltx_i2v")
        run_gen("6_ltx_i2v", "/api/ltx2/i2v", {
            "positive": "湖面微波荡漾,云雾缓慢流动,镜头轻微推进",
            "image": up4["filename"], "worker": up4["worker"],
            "width": 768, "height": 512, "length": 97, "fps": 16, "steps": 20, "seed": 42,
        }, token, "video", timeout_s=1800)
    elif want("6"):
        REPORT.append(("6_ltx_i2v", False, "跳过(无源图)"))

    # ── H3 前置:释放 ComfyUI GPU0 模型缓存(H3 校验空闲显存 ≥36GiB,与图像/LTX 缓存错峰) ──
    if want("7") or want("8"):
        log("释放 :8189 GPU0 模型缓存(为 H3 腾显存)…")
        try:
            urllib.request.urlopen(urllib.request.Request(
                "http://192.168.71.127:8189/free",
                data=json.dumps({"unload_models": True, "free_memory": True}).encode(),
                headers={"Content-Type": "application/json"}, method="POST"), timeout=30)
        except Exception as e:
            log(f"  释放失败(继续): {e}")
        time.sleep(8)

    # ── 7. H3 文生视频(960×544 56 帧,带音轨) ──
    if want("7"):
        run_gen("7_h3_t2v", "/api/h3/t2v", {
        "positive": "一位老渔夫在湖边木船上撒网,清晨薄雾,他说:今天会是个好收成。",
        "width": 960, "height": 544, "length": 56, "steps": 8, "seed": 42,
        }, token, "video", timeout_s=1800)

    # ── 8. H3 图生视频 ──
    if img_a and want("8"):
        up5 = upload_file(img_a, "image", token, extra="?kind=h3_i2v")
        run_gen("8_h3_i2v", "/api/h3/i2v", {
            "positive": "湖水开始流动,云雾飘散,鸟儿飞过山峰",
            "image": up5["filename"], "worker": up5["worker"],
            "width": 960, "height": 544, "length": 56, "steps": 8, "seed": 42,
        }, token, "video", timeout_s=1800)
    elif want("8"):
        REPORT.append(("8_h3_i2v", False, "跳过(无源图)"))

    # ── 9. ACE 文生音乐(120s 大文件) ──
    aud_g = None
    if want("9"):
        aud_g = run_gen("9_ace_music", "/api/generate/audio", {
        "tags": "epic orchestral, cinematic, mountain adventure, strings and horns",
        "seconds": 120, "steps": 50, "seed": 42,
        }, token, "audio", timeout_s=1200, out_ext=".mp3")
    if aud_g is None:
        prev = OUT / "9_ace_music.mp3"
        if prev.is_file():
            aud_g = str(prev)
            log(f"复用上次音乐: {prev.name}")

    # ── 10. IndexTTS2 配音(长文本) ──
    aud_h = None
    if want("10"):
        aud_h = run_gen("10_tts_voice", "/api/manju/voice", {
        "text": "清晨的薄雾还没散尽,老渔夫已经撑着他的木船划向湖心。他看了看远处的雪山,又看了看手里磨得发亮的渔网,轻声说道:今天,一定会是个好收成。",
        "emo_text": "平静叙述,略带期待", "language": "zh",
        }, token, "audio", timeout_s=300, direct=True, out_ext=".wav")
    if aud_h is None:
        prev = OUT / "10_tts_voice.wav"
        if prev.is_file():
            aud_h = str(prev)
            log(f"复用上次配音: {prev.name}")

    # ── 11. ASR 听写(对 TTS 产物) ──
    if aud_h and want("11"):
        try:
            up6 = upload_file(Path(aud_h).read_bytes(), "video", token, extra="/api/dub/upload", filename="tts.wav")
            name = up6.get("name") or up6.get("filename")
            log(f"dub 上传 OK: {name}")
            _, tr = req("/api/dub/transcribe", {"name": name}, token, timeout=60)
            jid = tr.get("job_id") or tr.get("id")
            t0 = time.time()
            segs = None
            while time.time() - t0 < 600:
                _, st = req(f"/api/dub/transcribe/{jid}", token=token, timeout=30)
                if st.get("status") in ("done", "error"):
                    segs = st
                    break
                time.sleep(8)
            ok = segs and segs.get("status") == "done"
            text = " ".join(s.get("text", "") for s in (segs or {}).get("segments", [])[:3])
            REPORT.append(("11_asr_transcribe", bool(ok), f"{time.time()-t0:.0f}s, 片段={len((segs or {}).get('segments', []))}, 开头: {text[:60]}"))
            log(f"✔ ASR 完成: {text[:60]}")
        except Exception as e:
            REPORT.append(("11_asr_transcribe", False, str(e)))
            log(f"✖ ASR 失败: {e}")
    elif want("11"):
        REPORT.append(("11_asr_transcribe", False, "跳过(无 TTS 产物)"))

    # ── 12. 人声分离(对 ACE 音乐;GPU1 高负载时可能 OOM,重试一次) ──
    if aud_g and want("12"):
        try:
            blob = Path(aud_g).read_bytes()
            boundary = "----toivsep"
            body = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"music.mp3\"\r\n"
                    f"Content-Type: audio/mpeg\r\n\r\n").encode() + blob + f"\r\n--{boundary}--\r\n".encode()
            r = urllib.request.Request(BASE + "/api/audio/separate", data=body,
                headers={"Content-Type": f"multipart/form-data; boundary={boundary}",
                         "Authorization": f"Bearer {token}"}, method="POST")
            t0 = time.time()
            for attempt in (1, 2):
                try:
                    with urllib.request.urlopen(r, timeout=600) as resp:
                        sep = json.loads(resp.read().decode())
                    break
                except Exception:
                    if attempt == 2:
                        raise
                    log("  分离失败(可能 GPU1 OOM),20s 后重试…")
                    time.sleep(20)
            url = sep.get("url") or sep.get("vocals_url")
            if url:
                size, head = download(url, token, OUT / "12_separate_vocals.wav")
                ok = magic_ok(head, "audio") and size > 1024
                REPORT.append(("12_vocal_separate", ok, f"{time.time()-t0:.0f}s, {size/1024:.0f}KB"))
                log(f"✔ 人声分离完成 {size/1024:.0f}KB")
            else:
                REPORT.append(("12_vocal_separate", False, f"无产物 URL: {json.dumps(sep, ensure_ascii=False)[:200]}"))
        except Exception as e:
            REPORT.append(("12_vocal_separate", False, str(e)))
            log(f"✖ 人声分离失败: {e}")
    elif want("12"):
        REPORT.append(("12_vocal_separate", False, "跳过(无音乐产物)"))

    # 停止监控,输出报告
    STOP.set()
    th.join(timeout=5)

    (OUT / "load_log.txt").write_text(
        "\n".join(f"{ts} [{src}] {txt}" for ts, src, txt in GPU_SAMPLES), encoding="utf-8")

    # 负载峰值汇总
    peaks = {}
    for _, src, txt in GPU_SAMPLES:
        if src != "ws" or "err" in txt:
            continue
        parts = [p.strip() for p in txt.split(",")]
        if len(parts) >= 4:
            idx, util, mem, total = parts[0], parts[1], parts[2], parts[3]
            k = f"GPU{idx}"
            u = float(util.replace(" %", "") or 0)
            m = float(mem.replace(" MiB", "") or 0)
            t = float(total.replace(" MiB", "") or 1)
            cur = peaks.get(k, (0, 0, t))
            peaks[k] = (max(cur[0], u), max(cur[1], m), t)

    print("\n" + "=" * 70)
    print("全功能生成测试报告")
    print("=" * 70)
    passed = sum(1 for _, ok, _ in REPORT if ok)
    for name, ok, detail in REPORT:
        print(f"  [{'✔' if ok else '✖'}] {name}: {detail}")
    print(f"\n通过 {passed}/{len(REPORT)}")
    print("\nWorkstation GPU 峰值:")
    for k in sorted(peaks):
        u, m, t = peaks[k]
        print(f"  {k}: 峰值利用率 {u:.0f}%,峰值显存 {m/1024:.1f}/{t/1024:.0f} GiB ({m/t*100:.0f}%)")
    print(f"\n产物目录: {OUT}")
    print(f"负载时间线: {OUT/'load_log.txt'}")
    sys.exit(0 if passed == len(REPORT) else 1)


if __name__ == "__main__":
    main()
