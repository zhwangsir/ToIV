#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAGED_APP="$ROOT_DIR/backend/cmd/desktop/build/bin/ToIV.app"
INSTALLED_APP="/Applications/ToIV.app"
LEGACY_APP="/Applications/BeefTV.app"

cleanup_staged_app() {
  if [[ -d "$STAGED_APP" && ! -L "$STAGED_APP" ]]; then
    find "$STAGED_APP" -depth -delete
  fi
}
trap cleanup_staged_app EXIT

"$ROOT_DIR/scripts/build-beeftv-release.sh"

if [[ ! -x "$STAGED_APP/Contents/MacOS/ToIV" ]]; then
  echo "Built ToIV.app is incomplete: $STAGED_APP" >&2
  exit 1
fi
# External agents connect through the bundled CLI, so an install without it is
# incomplete even though the GUI would start.
if [[ ! -x "$STAGED_APP/Contents/MacOS/cli/beeftv" ]]; then
  echo "Built ToIV.app has no bundled beeftv CLI: $STAGED_APP/Contents/MacOS/cli/beeftv" >&2
  exit 1
fi
codesign --verify --deep --strict "$STAGED_APP"
if [[ -e "$INSTALLED_APP" && ( ! -d "$INSTALLED_APP" || -L "$INSTALLED_APP" ) ]]; then
  echo "Refusing to replace unexpected target: $INSTALLED_APP" >&2
  exit 1
fi

osascript -e 'tell application id "top.wineryz.toiv" to quit' 2>/dev/null || true
osascript -e 'tell application id "com.wails.beeftv" to quit' 2>/dev/null || true
for _ in 1 2 3 4 5; do
  pgrep -f '^/Applications/ToIV.app/Contents/MacOS/ToIV$' >/dev/null \
    || pgrep -f '^/Applications/BeefTV.app/Contents/MacOS/BeefTV$' >/dev/null \
    || break
  sleep 1
done
if pgrep -f '^/Applications/ToIV.app/Contents/MacOS/ToIV$' >/dev/null \
  || pgrep -f '^/Applications/BeefTV.app/Contents/MacOS/BeefTV$' >/dev/null; then
  echo "ToIV/BeefTV is still running. Save your work and quit before updating." >&2
  exit 1
fi

mkdir -p "$INSTALLED_APP"
rsync -a --delete "$STAGED_APP/" "$INSTALLED_APP/"
codesign --verify --deep --strict "$INSTALLED_APP"

# Legacy BeefTV.app: leave in place but warn; updater migrates on next auto-update.
if [[ -d "$LEGACY_APP" && ! -L "$LEGACY_APP" ]]; then
  echo "Note: legacy $LEGACY_APP still present; canonical install is now $INSTALLED_APP" >&2
fi

echo "Updated the canonical local app: $INSTALLED_APP"
