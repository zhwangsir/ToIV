"""收割「已 smoke pass 但未公开」的应用——让验证过的东西真的能被用起来。

为什么不只在烟测进程里做:那条通道要等攒够 --publish-every 才发,而进程常被运维动作 kill,
攒着的 pass 就随进程丢了。本脚本走**同一条 bulk-public**,但可独立重复执行,
每次战役轮次之间兜一次,不依赖信号处理是否生效(SIGTERM 兜底我无法在无真 pass 时取证,
所以不把它当唯一保障)。

两道自证(都是本轮踩过坑后加回来的):
  1. 跳过启动期不变量卡:MERGE_HIDE_IDS ∪ SIMILAR_MERGE_HIDE_IDS 里的 id 上架会被
     seed_builtin_apps 每次启动改回 false(AGENTS P-17),上架它们是假收益;
  2. 发完必须回 PG 用 count 复核,不看接口返回的 done 数——done=9 只证明"这次写成功",
     不证明"下次启动后还公开着"。
"""
from __future__ import annotations

import argparse
import json
import pathlib
import subprocess
import sys
import urllib.error
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[2]
BASE = "http://192.168.71.47:8090"
PGPW = "68799b59242beeccfd54963902a35006"


def psql(sql: str) -> str:
    r = subprocess.run(
        ["ssh", "-o", "ConnectTimeout=30", "merlin@192.168.71.47",
         f"PGPASSWORD={PGPW} psql -h 127.0.0.1 -U toiv -d toiv -tA -c {json.dumps(sql)}"],
        capture_output=True, text=True, timeout=300)
    if r.returncode != 0:
        # P-11:取数失败绝不能被当成"没有待收割的",否则去重/清单会静默失效
        raise RuntimeError(f"psql 失败: {r.stderr[:300]}")
    return r.stdout


def req(method: str, path: str, body=None, tok=None, timeout=120.0):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(BASE + path, data=data, method=method)
    r.add_header("Content-Type", "application/json")
    if tok:
        r.add_header("Authorization", f"Bearer {tok}")
        r.add_header("X-NSFW", "1")  # 缺这个头时 R18 卡在普通视图不可见(不是失败)
    try:
        with urllib.request.urlopen(r, timeout=timeout) as x:
            raw = x.read().decode()
            return x.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as e:
        return e.code, {"_error": e.read().decode(errors="replace")[:200]}


def invariant_ids() -> set[str]:
    """启动期会被强制改回非公开的 id(孪生卡 / 合并卡)。"""
    sys.path.insert(0, str(ROOT / "apps" / "api"))
    try:
        from app.services.app_content_modes import MERGE_HIDE_IDS
    except Exception as e:  # noqa: BLE001
        print(f"  ⚠️ 取不到 MERGE_HIDE_IDS({type(e).__name__})——为安全起见本轮不收割")
        raise
    ids = set(MERGE_HIDE_IDS)
    try:
        from app.services.app_seed import SIMILAR_MERGE_HIDE_IDS
        ids |= set(SIMILAR_MERGE_HIDE_IDS)
    except Exception:  # noqa: BLE001 — 老版本可能没这个常量
        pass
    return ids


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="只列不改")
    ap.add_argument("--limit", type=int, default=200)
    args = ap.parse_args()

    guard = invariant_ids()
    rows = [l.strip() for l in psql(
        "select id from app where smoke_status='pass' and not is_public").splitlines() if l.strip()]
    safe = [i for i in rows if i not in guard][: args.limit]
    print(f"pass-but-hidden 共 {len(rows)} | 不变量卡 {len(rows) - len([i for i in rows if i not in guard])} "
          f"| 可上架 {len(safe)}")
    if not safe:
        return 0
    if args.dry_run:
        for i in safe[:20]:
            print("  ·", i)
        return 0

    before = int(psql("select count(*) from app where is_public").strip() or 0)
    st, tok = req("POST", "/api/auth/login", {"email": "admin", "password": "admin123"}, timeout=60)
    token = (tok or {}).get("token")
    if st != 200 or not token:
        print(f"登录失败 {st}: {str(tok)[:120]}")
        return 2
    for i in range(0, len(safe), 200):
        s, r = req("POST", "/api/admin/apps/bulk-public",
                   {"ids": safe[i:i + 200], "is_public": True}, tok=token, timeout=300)
        print(f"  上架批 {i // 200 + 1}: http={s} done={(r or {}).get('done')} "
              f"missing={(r or {}).get('missing')}")

    # 回 PG 复核:done 数不算证据,稳定态计数才算
    after = int(psql("select count(*) from app where is_public").strip() or 0)
    left = len([l.strip() for l in psql(
        "select id from app where smoke_status='pass' and not is_public").splitlines() if l.strip()])
    print(f"PG 复核:public {before} → {after}(+{after - before});"
          f"剩余 pass-but-hidden {left}(应≈不变量卡数 {len(rows) - len(safe)})")
    if after - before == 0:
        print("⚠️ 计数没变——上架未生效,别当成功")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
