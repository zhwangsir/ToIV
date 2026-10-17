#!/usr/bin/env bash
# 将 toiv-platform skill 安装到本机 ~/.agents/skills/（符号链接：git pull 即自动更新）
# 用法：bash skills/toiv-platform/install.sh   （在仓库任意设备 clone 后执行一次）
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST_DIR="${HOME}/.agents/skills"
DEST="${DEST_DIR}/toiv-platform"

if [ ! -f "${SRC}/SKILL.md" ]; then
  echo "ERROR: ${SRC}/SKILL.md 不存在（请在仓库根目录运行本脚本）" >&2
  exit 1
fi

mkdir -p "${DEST_DIR}"
ln -sfn "${SRC}" "${DEST}"
echo "installed: ${DEST} -> ${SRC}"
echo "验证: ls -l ${DEST}/SKILL.md"
