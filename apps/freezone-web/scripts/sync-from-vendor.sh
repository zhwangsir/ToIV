#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENDOR="$(cd "$ROOT/../../vendor/dramaclaw/frontend" && pwd)"
rsync -a --delete --exclude node_modules --exclude dist "$VENDOR/src/" "$ROOT/src/"
rsync -a --delete "$VENDOR/public/" "$ROOT/public/"
echo "Synced src+public from $VENDOR"
