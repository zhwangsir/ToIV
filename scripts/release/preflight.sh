#!/usr/bin/env bash
# 发版预检(P-2):工作区干净 + 若存在 web BUILD_ID 则必须无 -dirty 且 sha==HEAD。
# 不打 tag、不推远程、不部署。通过后按 docs/ops/RELEASE_AUTOMATION_P2_20261020.md 手工发版。
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
GATE=(python3 "$ROOT/scripts/release/build_id_gate.py")

echo "▶ P-2 发版预检"
"${GATE[@]}" --assert-clean-tree --repo "$ROOT"

if [ -f vendor/legacy-web/.next/BUILD_ID ]; then
  echo "▶ 校验 vendor/legacy-web/.next/BUILD_ID"
  "${GATE[@]}" --file vendor/legacy-web/.next/BUILD_ID --require-head --repo "$ROOT"
else
  echo "⚠ 尚无 vendor/legacy-web/.next/BUILD_ID — 发 web 前请: cd vendor/legacy-web && rm -rf .next && npm run build"
fi

echo "▶ canvas VERSION=$(tr -d '\n' < vendor/canvas/VERSION 2>/dev/null || echo '?')"
echo "OK: 预检通过。下一步见 docs/ops/RELEASE_AUTOMATION_P2_20261020.md"
echo "   (本脚本不执行 tag/push/deploy)"
