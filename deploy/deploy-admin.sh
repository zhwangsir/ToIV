#!/usr/bin/env bash
# 部署独立管理系统(apps/admin → core :3200,systemd toiv-admin)。
# 用法: bash deploy/deploy-admin.sh
# 前置: cd apps/admin && npm run build(本脚本校验 .next/BUILD_ID 存在)
set -eu

SSH_OPTS=(-o ConnectTimeout=8)
REMOTE="${1:-merlin@100.77.80.100}"  # Tailscale(外出可部署)
REMOTE_DIR="/home/merlin/toiv"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ ! -f apps/admin/.next/BUILD_ID ]; then
  echo "✖ 本地无 apps/admin/.next 构建产物。请先: cd apps/admin && npm run build" >&2
  exit 1
fi

echo "▶ rsync 管理系统源码 → ${REMOTE}:${REMOTE_DIR}/admin/ …"
rsync -az --delete -e "ssh ${SSH_OPTS[*]}" \
  --exclude=node_modules --exclude=.next --exclude=.git --exclude='*.env*' \
  apps/admin/ "${REMOTE}:${REMOTE_DIR}/admin/"
echo "▶ rsync 构建产物 .next …"
rsync -az --delete -e "ssh ${SSH_OPTS[*]}" --exclude=cache \
  apps/admin/.next/ "${REMOTE}:${REMOTE_DIR}/admin/.next/"

echo "▶ 远端依赖安装(仅首次/依赖变更时实际耗时)…"
ssh "${SSH_OPTS[@]}" "${REMOTE}" "cd ${REMOTE_DIR}/admin && PATH=/usr/share/nodejs/corepack/shims:\$PATH npm install --omit=dev --no-audit --no-fund 2>&1 | tail -1"

echo "▶ 安装/刷新 systemd unit(toiv-admin, :3200)…"
ssh "${SSH_OPTS[@]}" "${REMOTE}" "sudo tee /etc/systemd/system/toiv-admin.service > /dev/null" <<'UNIT'
[Unit]
Description=ToIV Admin Console (Next.js, standalone)
After=network.target toiv-api.service
Wants=network.target

[Service]
Type=simple
User=merlin
Group=merlin
WorkingDirectory=/home/merlin/toiv/admin
Environment=PATH=/usr/share/nodejs/corepack/shims:/usr/bin:/bin
Environment=NODE_ENV=production
ExecStart=/usr/share/nodejs/corepack/shims/npm run start
Restart=on-failure
RestartSec=5
StartLimitInterval=60s
StartLimitBurst=3

[Install]
WantedBy=multi-user.target
UNIT
ssh "${SSH_OPTS[@]}" "${REMOTE}" "sudo systemctl daemon-reload && sudo systemctl enable toiv-admin >/dev/null 2>&1 || true && sudo systemctl restart toiv-admin"

echo "▶ 等待 toiv-admin 就绪(http://localhost:3200,最长 60s)…"
for i in $(seq 1 30); do
  code=$(ssh "${SSH_OPTS[@]}" "${REMOTE}" "curl -s -o /dev/null -w '%{http_code}' http://localhost:3200/ || true")
  if [ "$code" = "200" ]; then
    echo "  toiv-admin 已就绪(第 ${i} 次探测)"
    echo "✅ 管理系统部署完成: http://192.168.71.47:3200"
    exit 0
  fi
  sleep 2
done
echo "ERROR: toiv-admin 60s 内未就绪" >&2
exit 1
