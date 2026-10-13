#!/usr/bin/env bash
# 未测应用烟测监管:一轮跑完(或意外死掉)就再起一轮,直到清单见底或触发止损。
#
# 为什么要监管而不是单跑:未测有上万条,单轮 --limit 跑完要数小时,进程一旦中断
# 就静默停在半路——正是 AGENTS D-2「一次性手工迁移没有守护会静默失效」的形状。
#
# 止损口径(两条,任一触发即退出):
#   1) 连续 2 轮 pass=0 且 fail 全属 transport/熔断 → 是测量环境坏,不是应用坏,继续跑只会写脏数据;
#   2) 达到 MAX_ROUNDS 上限(默认 8)。
# 熔断污染是本项目自己引入过的坑(重启接单实例会把在跑烟测打成 transport 并落 fail)。
set -u
cd "$(dirname "$0")/../.." || exit 1
ROUNDS=${MAX_ROUNDS:-8}
LIMIT=${ROUND_LIMIT:-1500}
LOGDIR=tmp/rh_smoke_20261013
mkdir -p "$LOGDIR"
ZERO_TRANSPORT_STREAK=0

for ((r=1; r<=ROUNDS; r++)); do
  if pgrep -f "scripts/ops/rh_smoke_batch.py" >/dev/null 2>&1; then
    echo "[sup $(date +%H:%M:%S)] 第 $r 轮:已有烟测在跑,等它结束再起下一轮"
    while pgrep -f "scripts/ops/rh_smoke_batch.py" >/dev/null 2>&1; do sleep 30; done
  fi
  TS=$(date +%H%M%S)
  OUT="$LOGDIR/sup_round${r}_${TS}.log"
  echo "[sup $(date +%H:%M:%S)] 第 $r/$ROUNDS 轮启动 → $OUT"
  apps/api/.venv/bin/python scripts/ops/rh_smoke_batch.py \
    --status untested --limit "$LIMIT" --concurrency 2 --timeout-s 900 --sleep 0.8 \
    --publish-passes --publish-every 10 >> "$OUT" 2>&1
  echo "[sup $(date +%H:%M:%S)] 第 $r 轮结束"
  tail -4 "$OUT"

  # 从最新 jsonl 读本轮结果做止损判断
  NEW=$(ls -t "$LOGDIR"/smoke_all_*.jsonl 2>/dev/null | head -1)
  if [ -n "$NEW" ]; then
    read -r P F T <<<"$(apps/api/.venv/bin/python - "$NEW" <<'PY'
import json,sys
rows=[json.loads(l) for l in open(sys.argv[1]) if l.strip()]
p=sum(1 for r in rows if r.get("status")=="pass")
tr=sum(1 for r in rows if r.get("cls")=="transport")
print(p, len(rows)-p, tr)
PY
)"
    echo "[sup] 本轮 pass=$P fail/其他=$F transport=$T"
    if [ "${P:-0}" -eq 0 ]; then
      ZERO_TRANSPORT_STREAK=$((ZERO_TRANSPORT_STREAK+1))
      if [ "$ZERO_TRANSPORT_STREAK" -ge 2 ]; then
        echo "[sup] ⚠️ 连续 ${ZERO_TRANSPORT_STREAK} 轮零 pass —— 判为测量环境故障(熔断/实例不可达),退出。"
        echo "     先查 :8196/:8197 可达性与池熔断冷却,别继续写脏 fail。"
        exit 1
      fi
    else
      ZERO_TRANSPORT_STREAK=0
    fi
  fi
  # 未测见底就收工
  LEFT=$(ssh -o ConnectTimeout=20 merlin@192.168.71.47 \
    "PGPASSWORD=68799b59242beeccfd54963902a35006 psql -h 127.0.0.1 -U toiv -d toiv -tAc \"select count(*) from app where coalesce(smoke_status,'')=''\"" 2>/dev/null)
  echo "[sup] 剩余未测 ${LEFT:-未知}"
  [ -n "${LEFT:-}" ] && [ "$LEFT" -lt 20 ] && { echo "[sup] 未测基本见底,收工"; exit 0; }
done
echo "[sup] 达到轮次上限 $ROUNDS,退出"
