#!/usr/bin/env bash
# 部署独立管理系统(apps/admin → core :3200,systemd toiv-admin)。
# 用法: bash deploy/deploy-admin.sh [REMOTE]
#
# 现行口径(2026-09-22 固化,D7):一律 core 本机构建——
#   ① rsync 源码(不含 node_modules/.next/.git/env)
#   ② core 全量 npm install(勿 --omit=dev:缺 typescript 会报 @/components 假线索)
#   ③ core npm run build
#   ④ 刷新 systemd unit + restart + 健康等待
# 历史教训:Mac 外地 Tailscale ~37KB/s,.next 构建产物不可传输;
#   旧版 Mac 构建+rsync .next 口径已退役(且 admin 构建前 core 必须全量 install)。
set -eEuo pipefail

SSH_OPTS=(-o ConnectTimeout=40 -o ServerAliveInterval=10 -o ServerAliveCountMax=6)
REMOTE="${1:-core-ts}"  # Tailscale(外地可部署);LAN 在家时也可传 core
REMOTE_DIR="/home/merlin/toiv"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "▶ rsync 管理系统源码 → ${REMOTE}:${REMOTE_DIR}/admin/ …"
rsync -az --delete -e "ssh ${SSH_OPTS[*]}" \
  --exclude=node_modules --exclude=.next --exclude=.git --exclude='*.env*' \
  apps/admin/ "${REMOTE}:${REMOTE_DIR}/admin/"

echo "▶ core 全量依赖安装(依赖未变时秒回)…"
ssh "${SSH_OPTS[@]}" "${REMOTE}" "cd ${REMOTE_DIR}/admin && PATH=/usr/share/nodejs/corepack/shims:\$PATH npm install --no-audit --no-fund 2>&1 | tail -1"

echo "▶ core 本机构建(.next 不出机)…"
ssh "${SSH_OPTS[@]}" "${REMOTE}" "cd ${REMOTE_DIR}/admin && PATH=/usr/share/nodejs/corepack/shims:\$PATH npm run build 2>&1 | tail -12"

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
    echo "✅ 管理系统部署完成: http://192.168.71.47:3200(core 本机构建)"
    exit 0
  fi
  sleep 2
done
echo "ERROR: toiv-admin 60s 内未就绪" >&2
exit 1
