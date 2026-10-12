"""W8 批 C:把分类结果里「静态可本地部署(status=ok)」的 RH webapp 导入 ToIV。

复用 scripts/ops/rh_import_webapps.py 的既有逻辑(rh_detail/rh_export/build_schema_bindings/seed_one),
不重写 schema/bindings 推导——那套逻辑已成功导入 5636 条,重写等于制造第二套口径。

与旧 seed 脚本的两点关键差异:
1. 输入源 = 批 B 的 classified.jsonl(已按 worker 能力静态判定),不是关键词候选清单;
2. **导入时 is_public=False**(模块级 IS_PUBLIC_DEFAULT),先 smoke 真跑验证再分批 bulk-public,
   避免未验证应用直接涌进市场。

用法:
  python3 scripts/ops/rh_import_classified.py --dry-run            # 只看会导入什么
  python3 scripts/ops/rh_import_classified.py --apply --limit 50   # 真导入前 50 条
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CLASSIFIED = Path(os.environ.get(
    "TOIV_RH_CLASSIFIED",
    str(ROOT / "tmp" / "rh_classify_20261013" / "classified.jsonl"),
))
LOG = ROOT / "tmp" / "rh_classify_20261013" / "import_log.jsonl"
BASE = os.environ.get("TOIV_CORE", "http://192.168.71.47:8090").rstrip("/")

_spec = importlib.util.spec_from_file_location("rh_import", ROOT / "scripts" / "ops" / "rh_import_webapps.py")
mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(mod)


def login(base: str) -> str:
    code, body = mod._http_json(
        f"{base}/api/auth/login", "POST", {"email": "admin", "password": "admin123"}, timeout=60,
    )
    tok = (body or {}).get("token") if isinstance(body, dict) else None
    if code != 200 or not tok:
        raise SystemExit(f"core 登录失败 code={code} body={str(body)[:200]}")
    return tok


def _as_int(v) -> int:
    """RH 的 statisticsInfo.useCount 是字符串("999"),分类产物里两种类型都可能出现。"""
    try:
        return int(str(v).strip())
    except (TypeError, ValueError):
        return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="真写库(默认 dry-run)")
    ap.add_argument("--dry-run", action="store_true", help="显式 dry-run(默认行为)")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--status", default="ok", help="classified.jsonl 里要导入的 status")
    ap.add_argument("--min-use", type=int, default=0)
    ap.add_argument("--sleep", type=float, default=0.35)
    ap.add_argument("--publish", action="store_true",
                    help="导入即公开(默认不公开;仅在已另行验证时使用,并请在日志里写明理由)")
    args = ap.parse_args()
    dry = not args.apply

    if args.publish:
        mod.IS_PUBLIC_DEFAULT = True
        print("⚠️ --publish:导入即公开(违背默认「先 smoke 再上架」纪律,请确认已另行验证)")

    api_key = mod._load_rh_key()
    token = login(BASE)
    print(f"core={BASE} 登录 ok | 分类源={CLASSIFIED.name} | 模式={'DRY-RUN' if dry else 'APPLY'}")

    rows = []
    for line in CLASSIFIED.open(encoding="utf-8"):
        try:
            r = json.loads(line)
        except json.JSONDecodeError:
            continue
        if r.get("status") != args.status:
            continue
        if _as_int(r.get("use_count")) < args.min_use:
            continue
        rows.append(r)
    rows.sort(key=lambda r: -_as_int(r.get("use_count")))
    if args.limit:
        rows = rows[: args.limit]
    print(f"候选 {len(rows)} 条(status={args.status}, min_use={args.min_use}, limit={args.limit or '无'})")
    if not rows:
        return 0

    seeded = mod._already_seeded_webapp_ids(BASE, token)
    print(f"库内已有 RH 溯源 webappId {len(seeded)} 个 → 跳过重复")

    used_names: set[str] = set()
    tally: dict[str, int] = {}
    LOG.parent.mkdir(parents=True, exist_ok=True)
    with LOG.open("a", encoding="utf-8") as log:
        for i, r in enumerate(rows, 1):
            wid = str(r["webappId"] if "webappId" in r else r["webapp_id"])
            if wid in seeded:
                tally["skip_already"] = tally.get("skip_already", 0) + 1
                continue
            row = {
                "webappId": wid,
                "name": r.get("name") or wid,
                "coverUrl": r.get("cover_url") or "",
                "useCount": _as_int(r.get("use_count")),
                "families": mod._tag_family(str(r.get("name") or "")),
            }
            try:
                res = mod.seed_one(api_key, BASE, token, row, dry, used_names)
            except Exception as e:  # noqa: BLE001
                res = {"webappId": wid, "status": "exception", "reason": f"{type(e).__name__}: {e}"[:200]}
            st = str(res.get("status"))
            tally[st] = tally.get(st, 0) + 1
            res["_ts"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
            res["_mode"] = "dry" if dry else "apply"
            log.write(json.dumps(res, ensure_ascii=False) + "\n")
            if i % 20 == 0 or i == len(rows):
                log.flush()
                print(f"  {i}/{len(rows)} {tally}")
            time.sleep(args.sleep)

    print(f"完成:{json.dumps(tally, ensure_ascii=False)}")
    print(f"日志 → {LOG}")
    if not dry:
        print("下一步:对新导入的应用逐条 POST /api/admin/apps/{id}/smoke 真跑验证,"
              "pass 的再分批 bulk-public(≤200/次);**不要**跳过 smoke 直接上架")
    return 0


if __name__ == "__main__":
    sys.exit(main())
