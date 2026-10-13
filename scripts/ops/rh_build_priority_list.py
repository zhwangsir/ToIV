"""生成烟测战役的**高优先目标清单**:按 per-worker 证据判定「现在就能本地部署」且还没测过的应用。

为什么不用「全舰队并集」筛(我一开始用的就是这个):并集会高估——
节点在 A 机有、权重只在 B 机有,并集说 OK,实际任何一台都跑不了。
分类产物里的 `ok_workers` 是**逐台**算出来的,可信得多;
实测:per-worker 筛出的批次 pass 率约 67%,盲扫约 30%、并集筛介于两者之间。

数据缝:app.description 里的 `RH:<webapp_id>` 关联回分类记录 →
  · status=ok(ok_workers 非空)  或
  · 在 classified_recovered.jsonl 里(blocked 桶按当天舰队现状重评后已齐)
再排掉已测过(smoke_status 非空)的,ok 桶排前面。

清单会随导入推进而变化,所以每次都重新生成,别把上一轮的产物当事实。
"""
from __future__ import annotations

import argparse
import json
import pathlib
import subprocess

ROOT = pathlib.Path(__file__).resolve().parents[2]
CLS = ROOT / "tmp" / "rh_classify_20261013" / "classified.jsonl"
RECOV = ROOT / "tmp" / "rh_classify_20261013" / "classified_recovered.jsonl"
OUT = ROOT / "tmp" / "rh_smoke_20261013" / "priority_perworker.txt"
PGPW = "68799b59242beeccfd54963902a35006"


def psql_cols(sql: str, sep: str = "@@") -> list[list[str]]:
    r = subprocess.run(
        ["ssh", "-o", "ConnectTimeout=40", "merlin@192.168.71.47",
         f"PGPASSWORD={PGPW} psql -h 127.0.0.1 -U toiv -d toiv -tA -F'{sep}' -c {json.dumps(sql)}"],
        capture_output=True, text=True, timeout=900)
    if r.returncode != 0:
        # P-11:查询失败绝不能被当成「库里没有」,否则清单会静默缩水
        raise RuntimeError(f"psql 失败: {r.stderr[:300]}")
    return [l.split(sep) for l in r.stdout.splitlines() if l.strip()]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--show", type=int, default=8)
    args = ap.parse_args()

    for f in (CLS, RECOV):
        if not f.exists():
            raise SystemExit(f"缺少输入 {f} —— 先跑批B 分类与重评,不要拿旧清单凑数")

    ok: set[str] = set()
    for l in CLS.open(encoding="utf-8"):
        try:
            r = json.loads(l)
        except Exception:
            continue
        if r.get("ok_workers"):
            ok.add(str(r.get("webapp_id")))
    recov = set()
    for l in RECOV.open(encoding="utf-8"):
        try:
            recov.add(str(json.loads(l)["webapp_id"]))
        except Exception:
            continue

    rows = psql_cols("select id, coalesce(smoke_status,''), substring(description from 'RH:([0-9]+)'), "
                     "coalesce(nullif(output_kind,''),'(空)') from app where description like '%RH:%'")
    prio = []
    for parts in rows:
        if len(parts) < 4:
            continue
        aid, st, wid, kind = (parts[i].strip() for i in range(4))
        if not wid:
            continue
        if wid in ok:
            tier = 0
        elif wid in recov:
            tier = 1
        else:
            continue
        if st:          # 已测过的不重复占机时
            continue
        # 同价类内再按产物类型分层:image 单条 60~280s,video 170~880s。
        # 同一张 GPU0 上,把便宜的产出排前面能显著提高「单位机时上架数」;
        # 预期收益,不预先记为已达成收益(需实测 pass 率与条/小时确认)。
        prio.append((tier, {"image": 0, "audio": 1, "3d": 2, "video": 4}.get(kind, 5), aid))
    prio.sort()
    ids = [a for *_, a in prio]
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text("\n".join(ids) + ("\n" if ids else ""))
    print(f"per-worker 可服务 {len(ok)} | 重评解锁 {len(recov)} | 未测且在名单内 {len(ids)}")
    print(f"→ {OUT.relative_to(ROOT)}")
    for a in ids[: args.show]:
        print("   ·", a)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
