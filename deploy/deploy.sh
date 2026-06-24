#!/usr/bin/env bash
#
# ToIV 部署脚本 —— spark02 的 ~/ToIV 不是 git 仓库,部署 = 本地 rsync 源码 → 远端 docker compose 重建。
#
# 用法:
#   deploy/deploy.sh            # 默认部署 web + api
#   deploy/deploy.sh web        # 只部署 web
#   deploy/deploy.sh api        # 只部署 api
#
# 设计要点(踩过的坑,别再犯):
#   1. ssh 选项用 **数组** 展开 "${SSH_OPTS[@]}",绝不写 `$VAR host cmd`
#      —— zsh 不对未引用变量分词,会把整串当成一个命令名("command not found")。
#   2. 远端命令 **不经 `| tail`** —— 管道会用最后一段(tail)的退出码,吞掉 ssh 的真实失败。
#      这里靠 `set -euo pipefail` + 直接调用,任一步失败立即非零退出。
#   3. keepalive 选项扛 Tailscale DERP 中继的高延迟瞬断。
#
set -euo pipefail

REMOTE="spark02"
REMOTE_DIR="/home/dgmt-spark/ToIV"

# ssh 选项:数组,务必用 "${SSH_OPTS[@]}" 展开
SSH_OPTS=(-o ConnectTimeout=40 -o ServerAliveInterval=10 -o ServerAliveCountMax=6)
RSYNC_EXCLUDES=(--exclude=node_modules --exclude=.next --exclude=.venv \
  --exclude=__pycache__ --exclude='*.db' --exclude='.env*' --exclude=.git)

# 要部署的服务(默认 web api)
SERVICES=("$@")
if [ ${#SERVICES[@]} -eq 0 ]; then SERVICES=(web api); fi

# 项目根(本脚本在 deploy/ 下)
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "▶ 部署服务: ${SERVICES[*]}"

echo "▶ rsync 源码 → ${REMOTE} …"
rsync -az -e "ssh ${SSH_OPTS[*]}" "${RSYNC_EXCLUDES[@]}" \
  apps/web apps/api "${REMOTE}:${REMOTE_DIR}/apps/"
echo "  rsync 完成"

echo "▶ 远端 docker compose 重建 (${SERVICES[*]}) …"
ssh "${SSH_OPTS[@]}" "${REMOTE}" \
  "cd ${REMOTE_DIR}/deploy && docker compose up -d --build ${SERVICES[*]}"

echo "▶ 验证 …"
ssh "${SSH_OPTS[@]}" "${REMOTE}" '
  docker ps --filter name=toiv --format "{{.Names}}  {{.Status}}"
  printf "web :3100 -> "; curl -s -o /dev/null -w "%{http_code}\n" --max-time 15 localhost:3100 || echo FAIL
  printf "api :8090 -> "; curl -s -o /dev/null -w "%{http_code}\n" --max-time 15 localhost:8090/openapi.json || echo FAIL
'
echo "✅ 部署完成"
