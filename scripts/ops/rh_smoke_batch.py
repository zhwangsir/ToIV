"""W8 批 C-2:对新导入的应用逐条真跑 smoke,pass 的才有资格上架。

为什么逐条:`POST /api/admin/apps/smoke/batch` 的 `_pick_batch` 过滤 `is_public==True`,
打不到隐藏卡(新导入的一律 is_public=False)→ 必须走 `POST /api/admin/apps/{id}/smoke`。
默认串行:批量 smoke 会顶高队列深度,撞封面 autorefire 深度闸(12)。生产已
`TOIV_COVER_AUTOREFIRE=false`,故 --concurrency>1 可用;但**别超过实例数**(池里真正独立的
ComfyUI 实例只有 :8196/:8264/:8197/:8199 四台,:8188 是 :8196 的 LB 前端),超过只是排队,
还会把重作业挤到同一张卡上互相超时、制造假 timeout。
纪律:H-4「DB 标 error ≠ 生成失败」——失败的先查 ComfyUI /history/{pid} 再决定重提,禁止盲目重跑。

用法:
  python3 scripts/ops/rh_smoke_batch.py --kind image --limit 50     # 先导批
  python3 scripts/ops/rh_smoke_batch.py --status untested --limit 200
"""
from __future__ import annotations

import argparse
import json
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT_DIR = ROOT / "tmp" / "rh_smoke_20261013"
BASE = "http://192.168.71.47:8090"


def req(method: str, path: str, body=None, tok=None, timeout=900.0):
    data = json.dumps(body).encode() if body is not None else None
    # path 必须已 ASCII 安全:app id 可能是中文(如 Flux-文生图-96c82d),
    # 直接拼进 URL 会 UnicodeEncodeError。调用方用 _q() 编码路径段。
    r = urllib.request.Request(BASE + path, data=data, method=method)
    r.add_header("Content-Type", "application/json")
    if tok:
        r.add_header("Authorization", f"Bearer {tok}")
        r.add_header("X-NSFW", "1")
    try:
        with urllib.request.urlopen(r, timeout=timeout) as x:
            raw = x.read().decode()
            return x.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as e:
        return e.code, {"_error": e.read().decode(errors="replace")[:300]}
    except (urllib.error.URLError, TimeoutError) as e:
        return 0, {"_error": f"{type(e).__name__}: {e}"[:200]}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--kind", default="", help="只跑某类 output_kind(image/video/audio)")
    ap.add_argument("--limit", type=int, default=50)
    ap.add_argument("--status", default="untested",
                    help="untested=只跑 smoke_status 空的;all=不看状态;fail=只重跑失败")
    ap.add_argument("--timeout-s", type=int, default=600)
    ap.add_argument("--sleep", type=float, default=1.0)
    ap.add_argument("--ids-file", default="", help="备选:从文件读 app id(一行一个)")
    ap.add_argument("--concurrency", type=int, default=1,
                    help="并发烟测数(默认 1=串行)。别超过 4:池里独立实例只有四台")
    ap.add_argument("--publish-passes", action="store_true",
                    help="把本轮 pass 的应用批量上架(≤200/次,走 /api/admin/apps/bulk-public,逐条留审计)。"
                         "判据是「该应用自己 smoke pass」,与先导批的 60%% 群体判据是两回事")
    ap.add_argument("--publish-every", type=int, default=25,
                    help="每攒够 N 条 pass 就上架一批,不等整轮跑完(默认 25)")
    args = ap.parse_args()
    if args.publish_every < 1:
        args.publish_every = 1
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    log_path = OUT_DIR / f"smoke_{args.kind or 'all'}_{time.strftime('%H%M%S')}.jsonl"

    st, body = req("POST", "/api/auth/login", {"email": "admin", "password": "admin123"}, timeout=60)
    tok = (body or {}).get("token")
    if st != 200 or not tok:
        print(f"登录失败 {st}: {str(body)[:200]}")
        return 2

    if args.ids_file:
        ids = [l.strip() for l in Path(args.ids_file).read_text().splitlines() if l.strip()]
    else:
        ids = []
        offset = 0
        while True:
            s, page = req("GET", f"/api/apps?limit=1000&offset={offset}", tok=tok, timeout=120)
            if s != 200 or not isinstance(page, list) or not page:
                break
            for a in page:
                if args.kind and a.get("output_kind") != args.kind:
                    continue
                sm = a.get("smoke_status") or ""
                if args.status == "untested" and sm:
                    continue
                if args.status == "fail" and sm != "fail":
                    continue
                ids.append(a["id"])
            if len(page) < 1000:
                break
            offset += 1000
    ids = ids[: args.limit]
    print(f"待跑 {len(ids)} 条(kind={args.kind or '不限'} status={args.status}) → {log_path.name}")
    if not ids:
        return 0

    tally: dict[str, int] = {}
    cls: dict[str, int] = {}
    passed: list[str] = []
    pending_pub: list[str] = []
    t0 = time.time()
    lock = threading.Lock()
    done_n = 0

    def flush_publish(batch: list[str], tag: str) -> None:
        """上架一批已 individually-pass 的应用。

        增量而非收尾才发:一条 600 项的战役要跑数小时,攒到最后等于让已验证可用的应用
        在库里闲着——按目标「拉进来要用」这是纯损失。逐条留审计走 bulk-public。
        """
        if not batch:
            return
        for i in range(0, len(batch), 200):
            st, r = req("POST", "/api/admin/apps/bulk-public",
                        {"ids": batch[i:i + 200], "is_public": True}, tok=tok, timeout=300)
            print(f"  上架[{tag}] 批 {i // 200 + 1}: http={st} done={(r or {}).get('done')} "
                  f"missing={(r or {}).get('missing')}", flush=True)

    def one(aid: str) -> None:
        nonlocal done_n
        ts = time.time()
        st, r = req("POST", f"/api/admin/apps/{urllib.parse.quote(aid, safe='')}/smoke",
                    {"timeout_s": args.timeout_s}, tok=tok, timeout=args.timeout_s + 120)
        status = (r or {}).get("status") if isinstance(r, dict) else None
        c = (r or {}).get("cls") if isinstance(r, dict) else None
        status = status or f"http_{st}"
        rec = {
            "ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "id": aid, "http": st,
            "status": status, "cls": c,
            "detail": str((r or {}).get("detail"))[:220] if isinstance(r, dict) else str(r)[:220],
            "sec": round(time.time() - ts, 1),
        }
        with lock:
            tally[status] = tally.get(status, 0) + 1
            if status != "pass" and c:
                cls[c] = cls.get(c, 0) + 1
            batch: list[str] = []
            if status == "pass":
                passed.append(aid)
                if args.publish_passes:
                    pending_pub.append(aid)
                    if len(pending_pub) >= args.publish_every:
                        batch = pending_pub.copy()
                        pending_pub.clear()
            log.write(json.dumps(rec, ensure_ascii=False) + "\n")
            log.flush()
            done_n += 1
            if done_n % 10 == 0 or done_n == len(ids):
                el = time.time() - t0
                rate = done_n / el * 3600 if el else 0
                print(f"  {done_n}/{len(ids)} pass={tally.get('pass', 0)} {tally} "
                      f"| {el / 60:.1f}min | {rate:.0f}/h | 归因 {cls}", flush=True)
        if batch:
            flush_publish(batch, "增量")

    with log_path.open("a", encoding="utf-8") as log:
        if args.concurrency <= 1:
            for aid in ids:
                one(aid)
                time.sleep(args.sleep)
        else:
            with ThreadPoolExecutor(max_workers=args.concurrency) as ex:
                list(ex.map(one, ids))

    if args.publish_passes and pending_pub:
        flush_publish(pending_pub, "收尾")
        pending_pub.clear()

    total = sum(tally.values())
    p = tally.get("pass", 0)
    print(f"\n完成 {total} 条 / {(time.time() - t0) / 60:.1f}min | pass {p} ({p / max(total, 1):.0%})")
    print(f"状态:{json.dumps(tally, ensure_ascii=False)}")
    print(f"失败归因:{json.dumps(cls, ensure_ascii=False)}")
    if total and p / total < 0.6:
        print("⚠️ pass 率 <60%(先导批判据):先归因再放量,不要继续批量烧 GPU")
    return 0


if __name__ == "__main__":
    sys.exit(main())
