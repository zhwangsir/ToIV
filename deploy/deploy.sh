#!/usr/bin/env bash
#
# ToIV 部署脚本 —— 真机部署(Docker 已禁用)
#
# 用法:
#   deploy/deploy.sh                 # 默认:rsync 源码 → core,并重启 systemd 服务
#   deploy/deploy.sh --install       # 首次部署:rsync 后执行远端 install.sh(需 sudo)
#   deploy/deploy.sh workstation     # 部署到 workstation(默认 core)
#
set -euo pipefail

# 默认部署到 core(2026-07-28 设备说明:core 为真机业务服务器)
REMOTE="${1:-core}"
REMOTE_DIR="/home/merlin/toiv"
INSTALL=false

if [ "${1:-}" = "--install" ]; then
  REMOTE="core"
  INSTALL=true
  shift
elif [ "${2:-}" = "--install" ]; then
  INSTALL=true
fi

# ssh 选项:数组,务必用 "${SSH_OPTS[@]}" 展开
SSH_OPTS=(-o ConnectTimeout=40 -o ServerAliveInterval=10 -o ServerAliveCountMax=6)
RSYNC_EXCLUDES=(--exclude=node_modules --exclude=.next --exclude=.venv \
  --exclude=__pycache__ --exclude='*.db' --exclude='.env*' --exclude=.git)

# 项目根(本脚本在 deploy/ 下)
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "▶ 部署目标: ${REMOTE}:${REMOTE_DIR}"
echo "▶ rsync 源码 → ${REMOTE} …"
# 远端 core 仍用旧目录结构 /home/merlin/toiv/{api,web,deploy}
# --delete:删除远端旧组件残留
# 注意:deploy/.env 是 core 上的生产配置(含 secret),不在 rsync 范围内,
# 如需修改生产配置请直接编辑 /home/merlin/toiv/deploy/.env 并重启 toiv-api。
rsync -az --delete -e "ssh ${SSH_OPTS[*]}" "${RSYNC_EXCLUDES[@]}" \
  apps/api/ "${REMOTE}:${REMOTE_DIR}/api/"
rsync -az --delete -e "ssh ${SSH_OPTS[*]}" "${RSYNC_EXCLUDES[@]}" \
  apps/web/ "${REMOTE}:${REMOTE_DIR}/web/"
rsync -az --delete -e "ssh ${SSH_OPTS[*]}" "${RSYNC_EXCLUDES[@]}" \
  deploy/ "${REMOTE}:${REMOTE_DIR}/deploy/"
echo "  rsync 完成"

if [ "$INSTALL" = true ]; then
  echo "▶ 远端执行真机安装脚本(需要 sudo) ..."
  ssh "${SSH_OPTS[@]}" "${REMOTE}" \
    "sudo bash ${REMOTE_DIR}/deploy/bare-metal/install.sh"
else
  echo "▶ 远端重载配置并重启服务 ..."
  ssh "${SSH_OPTS[@]}" "${REMOTE}" "
    cd ${REMOTE_DIR} && \
    sudo systemctl daemon-reload && \
    sudo systemctl restart toiv-api toiv-web
  "
fi

echo "▶ 验证 …"
ssh "${SSH_OPTS[@]}" "${REMOTE}" '
  printf "api :8090 -> "; curl -s -o /dev/null -w "%{http_code}\n" --max-time 15 localhost:8090/openapi.json || echo FAIL
  printf "web :3100 -> "; curl -s -o /dev/null -w "%{http_code}\n" --max-time 15 localhost:3100 || echo FAIL
'
echo "✅ 部署完成"
