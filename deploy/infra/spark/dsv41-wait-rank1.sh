#!/usr/bin/env bash
# Wait until spark01 rank1 container is Up (for split rank0 ExecStartPre).
set -euo pipefail
WORKER="${WORKER:-dgmt-spark@192.168.200.13}"
NAME="${CONTAINER_NAME:-dsv41-1017-exl3-tf}"
TIMEOUT_SEC="${WAIT_RANK1_TIMEOUT_SEC:-3600}"
deadline=$((SECONDS + TIMEOUT_SEC))
while (( SECONDS < deadline )); do
  if ssh -o BatchMode=yes -o ConnectTimeout=10 "$WORKER" \
      "docker inspect -f '{{.State.Running}}' '$NAME' 2>/dev/null" | grep -qx true; then
    echo "rank1 $NAME running on $WORKER"
    exit 0
  fi
  sleep 5
done
echo "timeout waiting for rank1 $NAME on $WORKER" >&2
exit 1
