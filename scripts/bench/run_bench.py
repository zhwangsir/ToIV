#!/usr/bin/env python3
"""ToIV 视频引擎基线基准 runner(P0.2/0.3,Phase 2 加速改造对照分母)。

用法:
  python3 run_bench.py prepare-images            # 生成并上传 i2v 源图(3 场景)
  python3 run_bench.py run [--engine h3-t2v ...] [--scenario closeup_static ...]
                           [--tag baseline-20260827] [--no-warmup] [--timeout 1800]
  python3 run_bench.py summarize [--tag ...]     # 仅按 JSONL 重整合并结果

纪律:lane 制(longcat / h3 双泳道串行 → 同时最多 2 个在跑;H3 实例天然串行)。
结果:scripts/bench/results/bench-<tag>.jsonl(逐作业追加,断点安全)
      scripts/bench/results/<tag>.json(合并全量 + 摘要)
"""
from __future__ import annotations

import argparse
import base64
import json
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

BASE_DEFAULT = "http://192.168.71.47:8090"
ROOT = Path(__file__).resolve().parent
RESULTS = ROOT / "results"
PROMPTS_FILE = ROOT / "prompts.json"
SOURCES_FILE = ROOT / "i2v_sources.json"
TOKEN_CACHE = RESULTS / ".token_cache.json"

POLL_INTERVAL = 5.0
DEFAULT_TIMEOUT = 1800  # 单任务 30min 上限
IMAGE_W, IMAGE_H = 1344, 768  # i2v 源图规格(对齐 H3 原生上限,LongCat 侧下采样)

# 热身提示词:刻意与全部场景 prompt 不同——同 prompt+同 seed 的重复提交会命中
# ComfyUI 执行缓存秒回(2026-08-27 首轮实证:h3-t2v 场景一正测 5.4s 缓存命中),
# 热身只负责预热模型加载,不得污染正测的 seed=42 真实生成。
WARMUP_PROMPT = "静态画面:一个红苹果放在白色桌面上,柔和自然光,固定机位"

_print_lock = threading.Lock()
_write_lock = threading.Lock()


def log(msg: str) -> None:
    with _print_lock:
        print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


class ApiError(Exception):
    def __init__(self, status: int, body: str):
        super().__init__(f"HTTP {status}: {body[:300]}")
        self.status = status
        self.body = body


def api(method: str, path: str, *, body=None, token: str | None = None,
        base: str, timeout: float = 60.0, raw: bool = False):
    url = base + path
    data = None
    headers = {"Accept": "application/json"}
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            payload = resp.read()
            return payload if raw else json.loads(payload.decode())
    except urllib.error.HTTPError as e:
        raise ApiError(e.code, e.read().decode(errors="replace")) from e
    except urllib.error.URLError as e:
        raise ApiError(0, str(e)) from e


def _jwt_exp(token: str) -> int:
    try:
        payload = token.split(".")[1]
        payload += "=" * (-len(payload) % 4)
        return int(json.loads(base64.urlsafe_b64decode(payload))["exp"])
    except Exception:
        return 0


def get_token(base: str, account: str, password: str) -> str:
    """登录一次缓存复用(login 限流 60s/5);缓存未过期直接用。"""
    if TOKEN_CACHE.exists():
        try:
            cached = json.loads(TOKEN_CACHE.read_text())
            if cached.get("base") == base and _jwt_exp(cached.get("token", "")) > time.time() + 300:
                return cached["token"]
        except Exception:
            pass
    res = api("POST", "/api/auth/login", body={"email": account, "password": password}, base=base)
    token = res["token"]
    RESULTS.mkdir(parents=True, exist_ok=True)
    TOKEN_CACHE.write_text(json.dumps({"base": base, "token": token}))
    log(f"已登录 {account},token 缓存至 {TOKEN_CACHE.name}")
    return token


# ──────────────────────────────────────────────────────────────
# 轮询与产物
# ──────────────────────────────────────────────────────────────

def find_job(base: str, token: str, prompt_id: str, ctx: dict | None = None) -> dict | None:
    jobs = api("GET", "/api/jobs?limit=100", token=token, base=base)
    for j in jobs:
        if j.get("prompt_id") == prompt_id:
            return j
    # held 放行换名:占位 prompt_id(hold-*)被换成 worker 真实 prompt_id,直接匹配落空;
    # 按 (kind, prompt, created_at 窗口) 找回同一作业(2026-08-27 首轮实证丢失)。
    if ctx and prompt_id.startswith("hold-"):
        t0 = ctx.get("t0", 0)
        best = None
        for j in jobs:
            if j.get("kind") != ctx.get("kind") or j.get("prompt") != ctx.get("prompt"):
                continue
            try:
                created = datetime.fromisoformat(j["created_at"]).replace(tzinfo=timezone.utc)
            except Exception:
                continue
            if t0 - 15 <= created.timestamp() <= t0 + 600:
                if best is None or j["created_at"] > best["created_at"]:
                    best = j
        return best
    return None


def poll_job(base: str, token: str, prompt_id: str, timeout: float,
             ctx: dict | None = None) -> tuple[dict | None, dict]:
    """5s 间隔轮询至终态。返回 (终态 job 或 None, 状态时间线)。"""
    deadline = time.time() + timeout
    timeline: dict[str, float] = {}
    last_status = None
    while time.time() < deadline:
        try:
            job = find_job(base, token, prompt_id, ctx)
        except ApiError as e:
            log(f"  轮询异常(继续): {e}")
            time.sleep(POLL_INTERVAL)
            continue
        if job:
            st = job.get("status", "")
            if st != last_status:
                timeline.setdefault(st, time.time())
                if st != last_status:
                    log(f"  [{prompt_id[:8]}] 状态 → {st}"
                        + (f" ({job.get('hold_reason')[:80]})" if st == "held" and job.get("hold_reason") else ""))
                last_status = st
            if st in ("done", "error"):
                return job, timeline
        time.sleep(POLL_INTERVAL)
    return None, timeline


def probe_artifact(base: str, token: str, url: str) -> dict:
    """下载签名产物 URL,返回 {url, bytes, duration_sec, width, height, fps, codec}。"""
    out: dict = {"url": url}
    try:
        try:
            blob = api("GET", url, token=token, base=base, raw=True, timeout=300)
        except ApiError as e:
            if e.status in (401, 403):  # 回退 ?token= 查询参数认证(P-1)
                sep = "&" if "?" in url else "?"
                blob = api("GET", f"{url}{sep}token={urllib.parse.quote(token)}",
                           base=base, raw=True, timeout=300)
            else:
                raise
        out["bytes"] = len(blob)
        suffix = ".mp4" if "filename=" not in url else "." + urllib.parse.parse_qs(
            urllib.parse.urlparse(url).query).get("filename", ["x.mp4"])[0].rsplit(".", 1)[-1]
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as f:
            f.write(blob)
            tmp = f.name
        try:
            info = json.loads(subprocess.run(
                ["ffprobe", "-v", "error", "-show_entries",
                 "format=duration:stream=codec_name,width,height,avg_frame_rate",
                 "-of", "json", tmp],
                capture_output=True, text=True, timeout=60).stdout)
            if info.get("format", {}).get("duration"):
                out["duration_sec"] = round(float(info["format"]["duration"]), 3)
            for s in info.get("streams", []):
                if s.get("width"):
                    out["width"], out["height"] = s["width"], s.get("height")
                    out["codec"] = s.get("codec_name")
                    fr = s.get("avg_frame_rate", "0/1")
                    n, _, d = fr.partition("/")
                    if float(d or 1) > 0:
                        out["fps"] = round(float(n) / float(d), 3)
                    break
        finally:
            Path(tmp).unlink(missing_ok=True)
    except Exception as e:  # 产物探测失败不污染作业结果
        out["probe_error"] = str(e)[:200]
    return out


# ──────────────────────────────────────────────────────────────
# 提交
# ──────────────────────────────────────────────────────────────

def submit_txt2img(base: str, token: str, prompt: str, seed: int) -> str:
    res = api("POST", "/api/generate/txt2img", token=token, base=base, timeout=120,
              body={"positive": prompt, "width": IMAGE_W, "height": IMAGE_H, "seed": seed})
    return res["prompt_id"]


def upload_image(base: str, token: str, blob: bytes, filename: str) -> dict:
    boundary = f"----bench{int(time.time() * 1000)}"
    parts = []
    parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"kind\"\r\n\r\nimg2img\r\n".encode())
    parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"image\"; filename=\"{filename}\"\r\n"
                 f"Content-Type: image/png\r\n\r\n".encode() + blob + b"\r\n")
    parts.append(f"--{boundary}--\r\n".encode())
    req = urllib.request.Request(
        base + "/api/upload", data=b"".join(parts),
        headers={"Authorization": f"Bearer {token}",
                 "Content-Type": f"multipart/form-data; boundary={boundary}"},
        method="POST")
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        raise ApiError(e.code, e.read().decode(errors="replace")) from e


def submit_engine(base: str, token: str, engine: dict, scenario: dict,
                  seed: int, sources: dict) -> str:
    body: dict = {"positive": scenario["prompt"], "seed": seed, **engine.get("params", {})}
    if engine["mode"] == "i2v":
        src = sources[scenario["id"]]
        body["image"] = src["filename"]
        body["worker"] = src["worker"]
    res = api("POST", engine["endpoint"], token=token, base=base, timeout=180, body=body)
    return res["prompt_id"]


# ──────────────────────────────────────────────────────────────
# i2v 源图准备
# ──────────────────────────────────────────────────────────────

def prepare_images(base: str, token: str, scenarios: list[dict], seed: int,
                   timeout: float) -> dict:
    sources: dict = {}
    if SOURCES_FILE.exists():
        sources = json.loads(SOURCES_FILE.read_text())
    for sc in scenarios:
        if sc["id"] in sources and sources[sc["id"]].get("filename"):
            log(f"源图已存在: {sc['id']} → {sources[sc['id']]['filename']}")
            continue
        log(f"生成源图 [{sc['id']}] txt2img {IMAGE_W}x{IMAGE_H} seed={seed} …")
        pid = submit_txt2img(base, token, sc["image_prompt"], seed)
        t0 = time.time()
        job, _ = poll_job(base, token, pid, timeout)
        if not job or job.get("status") != "done" or not job.get("results"):
            raise RuntimeError(f"源图生成失败 [{sc['id']}] status={job and job.get('status')}")
        log(f"  txt2img done ({time.time() - t0:.0f}s),下载并上传 pool worker …")
        blob = api("GET", job["results"][0], token=token, base=base, raw=True, timeout=300)
        up = upload_image(base, token, blob, f"bench_{sc['id']}.png")
        sources[sc["id"]] = {
            "filename": up["filename"], "worker": up["worker"],
            "txt2img_prompt_id": pid, "image_url": job["results"][0],
            "prepared_at": datetime.now(timezone.utc).isoformat(),
        }
        SOURCES_FILE.write_text(json.dumps(sources, ensure_ascii=False, indent=2))
        log(f"  上传完成: {up['filename']} @ {up['worker']}")
    return sources


# ──────────────────────────────────────────────────────────────
# 基准执行(lane 制)
# ──────────────────────────────────────────────────────────────

def run_one(base: str, token: str, engine: dict, scenario: dict, seed: int,
            warmup: bool, sources: dict, timeout: float, jsonl: Path, tag: str) -> dict:
    label = f"{engine['id']} × {scenario['id']}" + (" [热身]" if warmup else "")
    rec: dict = {
        "tag": tag, "engine": engine["id"], "lane": engine["lane"], "mode": engine["mode"],
        "scenario": scenario["id"], "scenario_name": scenario["name"],
        "prompt": scenario["prompt"], "seed": seed, "warmup": warmup,
        "submit_ts": None, "done_ts": None, "wall_seconds": None,
        "status": "submit_error", "prompt_id": None, "error": None,
    }
    t0 = time.time()
    rec["submit_ts"] = t0
    try:
        pid = submit_engine(base, token, engine, scenario, seed, sources)
    except ApiError as e:
        rec["error"] = f"submit: {e}"
        log(f"✗ {label} 提交失败: {e}")
        with _write_lock:
            with jsonl.open("a") as f:
                f.write(json.dumps(rec, ensure_ascii=False) + "\n")
        return rec
    rec["prompt_id"] = pid
    log(f"→ {label} 已提交 {pid[:8]}")
    ctx = {"kind": engine["kind"], "prompt": scenario["prompt"], "t0": t0}
    job, timeline = poll_job(base, token, pid, timeout, ctx)
    rec["done_ts"] = time.time()
    rec["wall_seconds"] = round(rec["done_ts"] - t0, 1)
    rec["status_timeline"] = {k: round(v - t0, 1) for k, v in timeline.items()}
    if timeline.get("running") is not None:
        rec["queue_seconds"] = round(timeline["running"] - t0, 1)
    if job is None:
        rec["status"] = "timeout"
        rec["error"] = f"超过 {timeout}s 未终态"
        log(f"⏱ {label} 超时({timeout}s)")
    else:
        rec["status"] = job.get("status")
        rec["job_id"] = job.get("id")
        rec["hold_reason"] = job.get("hold_reason") or ""
        if job.get("status") == "done":
            rec["artifacts"] = [probe_artifact(base, token, u) for u in job.get("results", [])]
            sizes = ", ".join(f"{a.get('bytes', 0) / 1e6:.1f}MB/{a.get('duration_sec', '?')}s"
                              for a in rec["artifacts"])
            log(f"✓ {label} done,墙钟 {rec['wall_seconds']}s,产物 {sizes}")
        else:
            rec["error"] = f"job status={job.get('status')}"
            log(f"✗ {label} error,墙钟 {rec['wall_seconds']}s")
    with _write_lock:
        with jsonl.open("a") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    return rec


def lane_worker(lane: str, tasks: list[dict], base: str, token: str, seed: int,
                sources: dict, timeout: float, jsonl: Path, tag: str,
                out: list[dict]) -> None:
    for t in tasks:
        out.append(run_one(base, token, t["engine"], t["scenario"], seed,
                           t["warmup"], sources, timeout, jsonl, tag))


def consolidate(tag: str) -> dict:
    jsonl = RESULTS / f"bench-{tag}.jsonl"
    runs = []
    if jsonl.exists():
        for line in jsonl.read_text().splitlines():
            if line.strip():
                runs.append(json.loads(line))
    # 摘要:非热身记录按 engine × scenario 取墙钟
    summary: dict = {}
    for r in runs:
        if r.get("warmup"):
            continue
        eng = summary.setdefault(r["engine"], {})
        eng[r["scenario"]] = {
            "status": r["status"],
            "wall_seconds": r.get("wall_seconds"),
            "queue_seconds": r.get("queue_seconds"),
        }
    for eng, rows in summary.items():
        walls = [v["wall_seconds"] for v in rows.values()
                 if v["status"] == "done" and v["wall_seconds"] is not None]
        rows["_mean_wall_done"] = round(sum(walls) / len(walls), 1) if walls else None
    doc = {
        "tag": tag,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "base": BASE_DEFAULT,
        "runs": runs,
        "summary": summary,
    }
    (RESULTS / f"{tag}.json").write_text(json.dumps(doc, ensure_ascii=False, indent=2))
    log(f"合并结果 → results/{tag}.json({len(runs)} 条)")
    return doc


def cmd_run(args: argparse.Namespace) -> None:
    matrix = json.loads(PROMPTS_FILE.read_text())
    seed = matrix["meta"]["seed"]
    scenarios = [s for s in matrix["scenarios"]
                 if not args.scenario or s["id"] in args.scenario]
    engines = [e for e in matrix["engines"] if not args.engine or e["id"] in args.engine]
    if not scenarios or not engines:
        raise SystemExit("过滤后矩阵为空,检查 --engine/--scenario")
    token = get_token(args.base, args.account, args.password)

    sources: dict = {}
    if any(e["mode"] == "i2v" for e in engines):
        sources = prepare_images(args.base, token, scenarios, seed, args.timeout)

    # lane 任务序列:[t2v 热身, t2v ×N, i2v 热身, i2v ×N],lane 内严格串行。
    # 热身用独立 prompt(与全部场景不同)防执行缓存命中;i2v 热身沿用场景一 id 以取源图。
    lanes: dict[str, list[dict]] = {}
    warmup_sc = {**scenarios[0], "name": "热身", "prompt": WARMUP_PROMPT}
    for mode in ("t2v", "i2v"):
        for eng in [e for e in engines if e["mode"] == mode]:
            if not args.no_warmup:
                lanes.setdefault(eng["lane"], []).append(
                    {"engine": eng, "scenario": warmup_sc, "warmup": True})
            for sc in scenarios:
                lanes.setdefault(eng["lane"], []).append(
                    {"engine": eng, "scenario": sc, "warmup": False})

    RESULTS.mkdir(parents=True, exist_ok=True)
    jsonl = RESULTS / f"bench-{args.tag}.jsonl"
    total = sum(len(v) for v in lanes.values())
    log(f"基准启动 tag={args.tag} 泳道={ {k: len(v) for k, v in lanes.items()} } 共 {total} 作业"
        f"(并发≤{len(lanes)},H3 串行)")

    out: list[dict] = []
    threads = [
        threading.Thread(target=lane_worker,
                         args=(lane, tasks, args.base, token, seed, sources,
                               args.timeout, jsonl, args.tag, out),
                         name=f"lane-{lane}", daemon=True)
        for lane, tasks in lanes.items()
    ]
    for t in threads:
        t.start()
    try:
        for t in threads:
            t.join()
    except KeyboardInterrupt:
        log("中断:已提交作业继续在服务端跑,JSONL 已落盘部分结果")
        raise
    doc = consolidate(args.tag)
    done = sum(1 for r in doc["runs"] if r["status"] == "done" and not r.get("warmup"))
    fail = sum(1 for r in doc["runs"] if r["status"] != "done" and not r.get("warmup"))
    log(f"基准结束:正测 done={done} fail={fail}")


def main() -> None:
    ap = argparse.ArgumentParser(description="ToIV 视频引擎基线基准")
    ap.add_argument("--base", default=BASE_DEFAULT)
    ap.add_argument("--account", default="admin")
    ap.add_argument("--password", default="admin123")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p_img = sub.add_parser("prepare-images", help="生成并上传 i2v 源图")
    p_img.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT)

    p_run = sub.add_parser("run", help="执行基准矩阵")
    p_run.add_argument("--engine", action="append", default=[],
                       help="longcat-t2v/longcat-i2v/h3-t2v/h3-i2v,可多次")
    p_run.add_argument("--scenario", action="append", default=[],
                       help="closeup_static/mid_cafe/high_motion,可多次")
    p_run.add_argument("--tag", default="baseline-20260827")
    p_run.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT)
    p_run.add_argument("--no-warmup", action="store_true")

    p_sum = sub.add_parser("summarize", help="按 JSONL 重整合并结果")
    p_sum.add_argument("--tag", default="baseline-20260827")

    args = ap.parse_args()
    if args.cmd == "prepare-images":
        matrix = json.loads(PROMPTS_FILE.read_text())
        token = get_token(args.base, args.account, args.password)
        prepare_images(args.base, token, matrix["scenarios"], matrix["meta"]["seed"], args.timeout)
    elif args.cmd == "run":
        cmd_run(args)
    elif args.cmd == "summarize":
        consolidate(args.tag)


if __name__ == "__main__":
    main()
