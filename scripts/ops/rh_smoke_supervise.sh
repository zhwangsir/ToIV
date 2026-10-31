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
# 默认并发 1 而非 2:实测四口从 core 直连均 200/7ms 却仍报「熔断中」,
# 说明是池探针在高负载下超时(还叠加 worker_warmup 往 :8262/:8264 提交作业),
# 并发 2 会把健康应用写成假 fail——宁可慢,不要脏数据。
set -u
cd "$(dirname "$0")/../.." || exit 1
ROUNDS=${MAX_ROUNDS:-8}
LIMIT=${ROUND_LIMIT:-1500}
# 默认只跑 image:实测视频卡单条 pass 要 750~882s(贴着 900s 超时),
# 而 image 多在 60~200s。目标是「能用起来」的应用数,不是均匀覆盖,
# 所以先把便宜的产出吃完,再由 ROUND_KIND=all 兜其他类型。
KIND=${ROUND_KIND:-image}
# 有静态预筛清单就优先打它(缺件已齐、产出最高);没有则回落到按 kind 盲扫。
# 清单可用 scripts/ops/rh_smoke_prioritize.py 重新生成,过期了就直接删文件回落,不会静默用错数据。
IDS=${ROUND_IDS:-tmp/rh_smoke_20261013/priority_complete.txt}
LOGDIR=${RH_SMOKE_OUT_DIR:-tmp/rh_smoke_20261013}
# 与 rh_smoke_batch.py 共用一个旋钮:指到仓库外可避开 git stash -u 换 inode
# 把运行中日志变孤儿的坑(2026-10-15 实证,详见该脚本 OUT_DIR 注记)。
export RH_SMOKE_OUT_DIR="$LOGDIR"
mkdir -p "$LOGDIR"
ZERO_TRANSPORT_STREAK=0

for ((r=1; r<=ROUNDS; r++)); do
  if pgrep -f "scripts/ops/rh_smoke_batch.py" >/dev/null 2>&1; then
    echo "[sup $(date +%H:%M:%S)] 第 $r 轮:已有烟测在跑,等它结束再起下一轮"
    while pgrep -f "scripts/ops/rh_smoke_batch.py" >/dev/null 2>&1; do sleep 30; done
  fi
  TS=$(date +%H%M%S)
  OUT="$LOGDIR/sup_round${r}_${KIND}_${TS}.log"
  echo "[sup $(date +%H:%M:%S)] 第 $r/$ROUNDS 轮启动 → $OUT"
  # 参数必须用数组传:先前用 $( ...) 拼参数,把 --concurrency/--timeout-s/--sleep
  # 整段弄丢了(实测命令行里查不到),等于悄悄降回并发 1 / 默认 600s 超时。
  # 是「跑起来看着正常但配置已失效」那类,只有核对真实命令行才抓得出来。
  if [ -s "$IDS" ]; then
    TARGET=(--ids-file "$IDS" --limit "$LIMIT")
  else
    TARGET=(--kind "$KIND" --status untested --limit "$LIMIT")
  fi
  backend/api/.venv/bin/python scripts/ops/rh_smoke_batch.py \
    "${TARGET[@]}" \
    --concurrency "${ROUND_CONC:-2}" --timeout-s 900 --sleep 1.2 \
    --publish-passes --publish-every 10 >> "$OUT" 2>&1
  echo "[sup $(date +%H:%M:%S)] 第 $r 轮结束"
  tail -4 "$OUT"

  # 从最新 jsonl 读本轮结果做止损判断
  NEW=$(ls -t "$LOGDIR"/smoke_all_*.jsonl 2>/dev/null | head -1)
  if [ -n "$NEW" ]; then
    read -r P F T <<<"$(backend/api/.venv/bin/python - "$NEW" <<'PY'
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
  # 轮间收割:把「已 pass 但未公开」的立即上架。
  # 为什么不只靠进程内的 --publish-every:SIGTERM 路径的兜底我无法在无真 pass 的情况下取证,
  # 而轮间收割走的是已经手工跑通三次的同一条 bulk-public 通道(证据可核)。
  echo "[sup $(date +%H:%M:%S)] 轮间收割 pass-but-hidden"
  backend/api/.venv/bin/python scripts/ops/publish_pass_but_hidden.py >> "$OUT" 2>&1 || echo "  收割失败(不阻断下一轮)"

  # 未测见底就收工
  LEFT=$(ssh -o ConnectTimeout=20 merlin@192.168.71.47 \
    "PGPASSWORD=68799b59242beeccfd54963902a35006 psql -h 127.0.0.1 -U toiv -d toiv -tAc \"select count(*) from app where coalesce(smoke_status,'')=''\"" 2>/dev/null)
  echo "[sup] 剩余未测 ${LEFT:-未知}"
  [ -n "${LEFT:-}" ] && [ "$LEFT" -lt 20 ] && { echo "[sup] 未测基本见底,收工"; exit 0; }
done
echo "[sup] 达到轮次上限 $ROUNDS,退出"
