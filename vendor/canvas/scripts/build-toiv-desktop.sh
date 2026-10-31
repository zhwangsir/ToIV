#!/usr/bin/env bash
# ToIV desktop build (macOS; Windows via .github/workflows/toiv-desktop.yml).
# Produces backend/cmd/desktop/build/bin/ToIV.app: the BeefTV desktop shell renamed to ToIV,
# with the ToIV login (backend/cmd/desktop/toiv_gate.go), the bundled toiv-h3 plugin and the
# ToIV app icon. Optional: BEEFTV_NODE_RUNTIME (Node 24.15.0) to bundle the assistant agent-host.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DESK="$ROOT/backend/cmd/desktop"
ARCH="$(uname -m)"; [[ "$ARCH" == "x86_64" ]] && ARCH=amd64
PLATFORM="${TOIV_WAILS_PLATFORM:-darwin/$ARCH}"
VERSION_VALUE="$(tr -d '[:space:]' < "$ROOT/VERSION")"
COMMIT_VALUE="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
BUILD_TIME_VALUE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
export GOTOOLCHAIN="${GOTOOLCHAIN:-local}" CANVAS_BUILD_VERSION="$VERSION_VALUE"
LDFLAGS="-X infinite-canvas/backend/internal/buildinfo.Version=$VERSION_VALUE -X infinite-canvas/backend/internal/buildinfo.Commit=$COMMIT_VALUE -X infinite-canvas/backend/internal/buildinfo.BuildTime=$BUILD_TIME_VALUE"

echo "== ToIV desktop $VERSION_VALUE ($COMMIT_VALUE) for $PLATFORM"

echo "== web (desktop build)"
( cd "$ROOT/web" && bun install --frozen-lockfile && bun run build:desktop )
rm -rf "$DESK/frontend/dist" && mkdir -p "$DESK/frontend/dist"
cp -R "$ROOT/web/dist/." "$DESK/frontend/dist/" && touch "$DESK/frontend/dist/.gitkeep"

echo "== plugin packages"
PLUGIN_OUT="$(mktemp -d)"
for m in "$ROOT"/plugin-packages/*/manifest.json; do
  d="${m%/manifest.json}"; id="${d##*/}"
  ( cd "$d" && { find manifest.json README.md docs assets web backend LICENSE -type f 2>/dev/null || true; } | LC_ALL=C sort | zip -X -q "$PLUGIN_OUT/$id.beeftv-plugin" -@ )
done
[[ -f "$PLUGIN_OUT/toiv-h3.beeftv-plugin" ]] || { echo "toiv-h3 plugin missing" >&2; exit 1; }

echo "== wails build"
mkdir -p "$DESK/build"
cp "$ROOT/assets/toiv-app-icon.png" "$DESK/build/appicon.png"
( cd "$DESK" && go run github.com/wailsapp/wails/v2/cmd/wails@v2.16.0 build -s -clean -trimpath -platform "$PLATFORM" -ldflags "$LDFLAGS" )

APP="$DESK/build/bin/ToIV.app"
mkdir -p "$APP/Contents/Resources/plugin-packages"
cp "$PLUGIN_OUT/"*.beeftv-plugin "$APP/Contents/Resources/plugin-packages/"
rm -rf "$PLUGIN_OUT"

if [[ -n "${BEEFTV_NODE_RUNTIME:-}" ]]; then
  bun "$ROOT/scripts/package-agent-host.mjs" "$PLATFORM" "$APP/Contents/Resources/agent-host"
else
  echo "!! BEEFTV_NODE_RUNTIME not set: assistant agent-host not bundled (canvas + H3 work without it)"
fi

PLIST="$APP/Contents/Info.plist"
plutil -replace CFBundleIdentifier -string "top.wineryz.toiv" "$PLIST"
plutil -replace CFBundleName -string "ToIV" "$PLIST"
plutil -replace CFBundleDisplayName -string "ToIV" "$PLIST" 2>/dev/null || plutil -insert CFBundleDisplayName -string "ToIV" "$PLIST"
plutil -replace CFBundleShortVersionString -string "${VERSION_VALUE#v}" "$PLIST"
plutil -replace CFBundleVersion -string "${VERSION_VALUE#v}" "$PLIST"
codesign --force --deep --sign - "$APP"
echo "== built $APP"
