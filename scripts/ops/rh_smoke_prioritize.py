"""W8 批C-2:未测应用**静态预筛**,把 GPU 时间花在「缺件已齐」的应用上。

为什么要它:未测群体里 pass 率只有约 30%,而失败的主因是缺模型/缺节点——
这些**不烧 GPU 就能判**。随机扫等于花 70% 的机时去确认「早就知道会失败」的事。

口径(全是硬比对,不做概率猜测):
  · 图里每个 class_type 必须在四口 /object_info 键并集里(按 body 键名,不看状态码——
    /object_info/<未知类> 返回 200 + 空对象,见 AGENTS P-16);
  · 图里每个字符串输入只要形如权重文件名(.safetensors/.pt/.gguf…),必须在四口
    combo 选项并集里(这已包含目录前缀,如 bbox/face_yolov8m.pt);
  · complete = 两条都过;另出「只差一个模型」的近完整清单(装/下 1 个文件即可解锁)。

已知盲区(所以只排序、不判死):
  · 并集是**全舰队**口径,某台才有该文件的应用会被判 complete 却在路由后失败;
  · 不含尺寸/显存/节点签名兼容(P-13/E-9 型问题仍要靠真烟测);
  · combo 里存在 ≠ 文件非空可读。

用法:
  apps/api/.venv/bin/python scripts/ops/rh_smoke_prioritize.py          # 出清单
  apps/api/.venv/bin/python scripts/ops/rh_smoke_prioritize.py --apply  # 顺带写战役命令
"""
from __future__ import annotations

import argparse
import collections
import json
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
OUT = ROOT / "tmp" / "rh_smoke_20261013"
PG = "192.168.71.47"
SSH_USER = "merlin"
WS = "192.168.71.127"
MODEL_EXT = r"\.(safetensors|ckpt|pth|pt|bin|gguf|sft|onnx)$"
# 舰队四口:通用池 :8196/:8197 + H3 :8264/:8195
PORTS = ("8196", "8197", "8264", "8195")


def run(sql: str) -> str:
    """经 core 本机 psql 取数。**任何失败必须抛**——分页/查询被吞成空集就是 P-11 的坑。"""
    r = subprocess.run(
        ["ssh", "-o", "ConnectTimeout=40", f"{SSH_USER}@{PG}",
         f"PGPASSWORD=68799b59242beeccfd54963902a35006 psql -h 127.0.0.1 -U toiv -d toiv "
         f"-tA -F'@@' -c {json.dumps(sql)}"],
        capture_output=True, text=True, timeout=1800)
    if r.returncode != 0:
        raise RuntimeError(f"psql 失败: {r.stderr[:300]}")
    return r.stdout


def fleet_unions() -> tuple[set[str], set[str]]:
    """四口 /object_info 的类名并集 + combo 选项(模型名)并集。"""
    code = (
        "import json,urllib.request\n"
        "cls=set();mod=set()\n"
        f"for p in {list(PORTS)!r}:\n"
        "    try:\n"
        "        d=json.loads(urllib.request.urlopen(f'http://127.0.0.1:{p}/object_info',timeout=300).read())\n"
        "    except Exception as e:\n"
        "        print('skip',p,type(e).__name__);continue\n"
        "    cls|=set(d)\n"
        "    for i in d.values():\n"
        "        for g in ('required','optional'):\n"
        "            for spec in ((i.get('input') or {}).get(g) or {}).values():\n"
        "                if isinstance(spec,list) and spec and isinstance(spec[0],list):\n"
        "                    mod.update(str(o) for o in spec[0])\n"
        "open('/tmp/fleet_classes.txt','w').write('\\n'.join(sorted(cls))+'\\n')\n"
        "open('/tmp/fleet_models.txt','w').write('\\n'.join(sorted(mod))+'\\n')\n"
        "print('classes',len(cls),'models',len(mod))\n"
    )
    r = subprocess.run(["ssh", "-o", "ConnectTimeout=40", f"{SSH_USER}@{WS}",
                        "/opt/ComfyUI/venv/bin/python"],
                       input=code, capture_output=True, text=True, timeout=900)
    if r.returncode != 0:
        raise RuntimeError(f"舰队并集取数失败: {r.stderr[:300]}")
    print("  ", r.stdout.strip().splitlines()[-1])
    fc = {l.strip() for l in open("/tmp/fleet_classes.txt") if l.strip()}
    fm = {l.strip() for l in open("/tmp/fleet_models.txt") if l.strip()}
    return fc, fm


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="打印可直接执行的战役命令")
    args = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)

    print("1) 舰队并集(object_info 键名 + combo 选项)…")
    fc, fm = fleet_unions()

    print("2) 未测应用的 class_type / 权重名…")
    q_cls = ("select a.id, string_agg(distinct n.value->>'class_type', chr(1)) "
             "from app a, jsonb_each(a.workflow_json::jsonb) n "
             "where coalesce(a.smoke_status,'')='' and coalesce(n.value->>'class_type','')<>'' "
             "group by a.id")
    # 注意:SQL 里有 #>>'{}' 与 ~* 正则,不能放进 f-string(花括号会被当占位符)
    q_mod = ("select a.id, string_agg(distinct iv.value #>> '{}', chr(1)) "
             "from app a, jsonb_each(a.workflow_json::jsonb) n, jsonb_each(n.value->'inputs') iv "
             "where coalesce(a.smoke_status,'')='' and jsonb_typeof(iv.value)='string' "
             "and iv.value #>> '{}' ~* '" + MODEL_EXT + "' group by a.id")
    cls, mods = {}, {}
    for aid, rest in (l.rstrip("\n").split("@@", 1) for l in run(q_cls).splitlines() if "@@" in l):
        cls[aid] = [c for c in rest.split("\x01") if c]
    for aid, rest in (l.rstrip("\n").split("@@", 1) for l in run(q_mod).splitlines() if "@@" in l):
        mods[aid] = [m for m in rest.split("\x01") if m]
    print(f"   未测有图 {len(cls)} 条,其中带权重引用 {len(mods)} 条")

    stats: collections.Counter = collections.Counter()
    complete, near = [], []
    for aid, cs in cls.items():
        miss_c = {c for c in cs if c not in fc}
        miss_m = {m for m in mods.get(aid, []) if m not in fm}
        if not miss_c and not miss_m:
            complete.append(aid); stats["complete"] += 1
        elif not miss_c and len(miss_m) == 1:
            near.append(aid); stats["只差一个模型"] += 1
        elif miss_c and not miss_m:
            stats["缺节点"] += 1
        elif miss_c and miss_m:
            stats["节点与模型都缺"] += 1
        else:
            stats["其他"] += 1
    tot = len(cls) or 1
    print("\n静态预筛结果:")
    for k, v in stats.most_common():
        print(f"   {v:>6}  {k}  ({v / tot:.1%})")
    (OUT / "priority_complete.txt").write_text("\n".join(complete) + "\n")
    (OUT / "priority_one_model_short.txt").write_text("\n".join(near) + "\n")
    print(f"\n已写 {OUT}/priority_complete.txt({len(complete)} 条)与 "
          f"priority_one_model_short.txt({len(near)} 条)")
    if args.apply:
        print("\n建议战役命令(先停现有战役与监管,避免抢卡与熔断污染):")
        print(f"  apps/api/.venv/bin/python scripts/ops/rh_smoke_batch.py \\")
        print(f"    --ids-file {OUT}/priority_complete.txt --limit {len(complete)} \\")
        print("    --concurrency 2 --timeout-s 900 --publish-passes --publish-every 10")
    return 0


if __name__ == "__main__":
    sys.exit(main())
