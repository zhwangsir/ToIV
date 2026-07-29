#!/usr/bin/env bash
#
# ToIV 真机部署安装脚本
# 目标:core / workstation 等 Ubuntu 真机(Docker 已禁用场景)
# 用法:ssh 到目标机后执行 sudo bash /home/merlin/toiv/deploy/bare-metal/install.sh
#
set -euo pipefail

INSTALL_USER="${INSTALL_USER:-merlin}"
INSTALL_DIR="/home/${INSTALL_USER}/toiv"
SERVICE_DIR="${INSTALL_DIR}/deploy/bare-metal"

if [ "$EUID" -ne 0 ]; then
  echo "请用 sudo 运行"
  exit 1
fi

echo "▶ 安装 ToIV systemd 服务 (用户: ${INSTALL_USER}, 目录: ${INSTALL_DIR})"

# 1. 确保后端依赖
if [ ! -d "${INSTALL_DIR}/api/.venv" ]; then
  echo "▶ 创建 Python 虚拟环境 ..."
  su - "${INSTALL_USER}" -c "cd ${INSTALL_DIR}/api && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt"
else
  echo "▶ 更新后端依赖 ..."
  su - "${INSTALL_USER}" -c "cd ${INSTALL_DIR}/api && .venv/bin/pip install -r requirements.txt"
fi

# 2. 构建前端(core 的 npm 通过 corepack shims 提供,不在默认 PATH)
NPM=/usr/share/nodejs/corepack/shims/npm
echo "▶ 构建前端 (npm: ${NPM}) ..."
# NEXT_PUBLIC_API_BASE 必须为空字符串,使前端走相对路径 /api,经 Next.js rewrite 打到同机 API。
# 若留空构建,lib/api.ts 会回退到 http://localhost:8090,导致线上 CORS/跨端口失败。
su - "${INSTALL_USER}" -c "cd ${INSTALL_DIR}/web && rm -f .env.local && export NEXT_PUBLIC_API_BASE='' && export INTERNAL_API_BASE='http://localhost:8090' && ${NPM} install && ${NPM} run build"

# 3. 安装 systemd 服务
cp "${SERVICE_DIR}/toiv-api.service" /etc/systemd/system/
cp "${SERVICE_DIR}/toiv-web.service" /etc/systemd/system/

# 4. 创建 /data 目录(与 Docker 卷兼容)
mkdir -p /data
chown "${INSTALL_USER}:${INSTALL_USER}" /data

# 5. 重载并启动
systemctl daemon-reload
systemctl enable toiv-api.service toiv-web.service
systemctl restart toiv-api.service toiv-web.service

echo "▶ 验证 ..."
sleep 2
systemctl status toiv-api.service --no-pager -l || true
systemctl status toiv-web.service --no-pager -l || true
printf "api :8090 -> "; curl -s -o /dev/null -w "%{http_code}\n" --max-time 10 localhost:8090/openapi.json || echo FAIL
printf "web :3100 -> "; curl -s -o /dev/null -w "%{http_code}\n" --max-time 10 localhost:3100 || echo FAIL

echo "✅ 安装完成"
