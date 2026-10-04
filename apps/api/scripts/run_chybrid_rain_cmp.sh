#!/usr/bin/env bash
# Background-run the c_hybrid rain-sample comparison (only after user sign-off). Check :8195 is idle with enough free VRAM first.
set -euo pipefail
WT=${WT:-/home/merlin/toiv_wt_chybrid}
OUT=${OUT:-/home/merlin/toiv/tmp/chybrid_rain_cmp}
PY=/home/merlin/toiv/api/.venv/bin/python
mkdir -p "$OUT"
curl -fsS --max-time 5 http://100.68.100.90:8195/queue | head -c 300; echo
cd "$WT/apps/api"
CODE_ROOT="$WT/apps/api" nohup "$PY" scripts/chybrid_rain_cmp_driver.py --out "$OUT" "$@" \
  > "$OUT/driver.log" 2>&1 &
echo "pid=$! log=$OUT/driver.log progress=$OUT/progress.json"
