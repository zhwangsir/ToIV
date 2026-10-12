"""W8 批 C-2:对新导入的应用逐条真跑 smoke,pass 的才有资格上架。

为什么逐条:`POST /api/admin/apps/smoke/batch` 的 `_pick_batch` 过滤 `is_public==True`,
打不到隐藏卡(新导入的一律 is_public=False)→ 必须走 `POST /api/admin/apps/{id}/smoke`。
为什么串行:批量 smoke 自己会顶高队列深度,撞封面 autorefire 深度闸(12);串行 + 间隔最稳。
纪律:H-4「DB 标 error ≠ 生成失败」——失败的先查 ComfyUI /history/{pid} 再决定重提,禁止盲目重跑。

用法:
  python3 scripts/ops/rh_smoke_batch.py --kind image --limit 50     # 先导批
  python3 scripts/ops/rh_smoke_batch.py --status untested --limit 200
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
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
    args = ap.parse_args()
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
    t0 = time.time()
    with log_path.open("a", encoding="utf-8") as log:
        for i, aid in enumerate(ids, 1):
            ts = time.time()
            st, r = req("POST", f"/api/admin/apps/{urllib.parse.quote(aid, safe='')}/smoke",
                        {"timeout_s": args.timeout_s}, tok=tok, timeout=args.timeout_s + 120)
            status = (r or {}).get("status") if isinstance(r, dict) else None
            c = (r or {}).get("cls") if isinstance(r, dict) else None
            status = status or f"http_{st}"
            tally[status] = tally.get(status, 0) + 1
            if status != "pass" and c:
                cls[c] = cls.get(c, 0) + 1
            log.write(json.dumps({
                "ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "id": aid, "http": st,
                "status": status, "cls": c,
                "detail": str((r or {}).get("detail"))[:220] if isinstance(r, dict) else str(r)[:220],
                "sec": round(time.time() - ts, 1),
            }, ensure_ascii=False) + "\n")
            log.flush()
            if i % 5 == 0 or i == len(ids):
                el = time.time() - t0
                print(f"  {i}/{len(ids)} pass={tally.get('pass', 0)} {tally} "
                      f"| {el / 60:.1f}min | 归因 {cls}", flush=True)
            time.sleep(args.sleep)

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
