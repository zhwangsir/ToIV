#!/usr/bin/env bash
#
# ToIV 部署脚本 —— 真机部署(Docker 已禁用)
#
# 用法:
#   deploy/deploy.sh                 # 默认:rsync 源码 → core,依次重启 toiv-api/toiv-web 并做健康等待
#   deploy/deploy.sh --install       # 首次部署:rsync 后执行远端 install.sh(需 sudo)
#   deploy/deploy.sh workstation     # 部署到 workstation(默认 core)
#   deploy/deploy.sh --skip-web      # 本地无 .next 构建产物时仍部署(前端保留远端旧构建)
#   deploy/deploy.sh --rollback      # 回滚:恢复部署前快照(api/app + web/.next),重启并健康检查
#
# -E:ERR trap 在函数内失败时也生效(用于部署失败时打印回滚提示)
set -eEuo pipefail

# 默认部署到 core(2026-07-28 设备说明:core 为真机业务服务器)
REMOTE="core"
REMOTE_DIR="/home/merlin/toiv"
INSTALL=false
SKIP_WEB=false
ROLLBACK=false

for arg in "$@"; do
  case "$arg" in
    --install)  INSTALL=true ;;
    --skip-web) SKIP_WEB=true ;;
    --rollback) ROLLBACK=true ;;
    *)          REMOTE="$arg" ;;
  esac
done

# ssh 选项:数组,务必用 "${SSH_OPTS[@]}" 展开
SSH_OPTS=(-o ConnectTimeout=40 -o ServerAliveInterval=10 -o ServerAliveCountMax=6)
RSYNC_EXCLUDES=(--exclude=node_modules --exclude=.next --exclude=.venv \
  --exclude=__pycache__ --exclude='*.db' --exclude='.env*' --exclude=.git)

# 项目根(本脚本在 deploy/ 下)
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# 远端健康等待:每 2s 轮询一次,最多 60s,HTTP 200 即就绪;超时返回非零
remote_wait_health() {
  local name="$1" url="$2"
  echo "▶ 等待 ${name} 就绪(${url},最长 60s)…"
  ssh "${SSH_OPTS[@]}" "${REMOTE}" bash -s -- "${name}" "${url}" <<'REMOTE_EOF'
set -u
name="$1"; url="$2"
for i in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$url" || echo 000)
  if [ "$code" = "200" ]; then
    echo "  ${name} 已就绪(第 ${i} 次探测)"
    exit 0
  fi
  sleep 2
done
echo "ERROR: ${name} 60s 内未就绪(${url})" >&2
exit 1
REMOTE_EOF
}

remote_restart() {
  local unit="$1"
  echo "▶ 远端重启 ${unit} …"
  ssh "${SSH_OPTS[@]}" "${REMOTE}" "sudo systemctl restart ${unit}"
}

# 回滚:恢复部署前 cp -al 快照,依次重启并做健康等待
do_rollback() {
  echo "▶ 回滚目标: ${REMOTE}:${REMOTE_DIR}"
  ssh "${SSH_OPTS[@]}" "${REMOTE}" bash -s -- "${REMOTE_DIR}" <<'REMOTE_EOF'
set -eu
cd "$1"
if [ ! -d .rollback-previous ]; then
  echo "ERROR: 无 .rollback-previous 快照,无法回滚(快照在每次部署 rsync 前生成)" >&2
  exit 1
fi
if [ -d .rollback-previous/api-app ]; then
  rm -rf api/app
  cp -al .rollback-previous/api-app api/app
  echo "  已恢复 api/app"
fi
if [ -d .rollback-previous/web-next ]; then
  rm -rf web/.next
  cp -al .rollback-previous/web-next web/.next
  echo "  已恢复 web/.next"
fi
REMOTE_EOF
  echo "▶ 远端重载配置 …"
  ssh "${SSH_OPTS[@]}" "${REMOTE}" "sudo systemctl daemon-reload"
  remote_restart toiv-api
  remote_wait_health "toiv-api" "http://localhost:8090/api/health"
  remote_restart toiv-web
  remote_wait_health "toiv-web" "http://localhost:3100"
  echo "✅ 回滚完成"
}

if [ "$ROLLBACK" = true ]; then
  do_rollback
  exit 0
fi

# 本地构建产物前置检查:toiv-web 是 next start 跑预构建产物,没有 .next 部署上去
# 就是「没有前端的 web 服务」,直接失败而不是仅警告(可用 --skip-web 显式跳过)
HAS_WEB_BUILD=false
if [ -f apps/web/.next/BUILD_ID ]; then
  HAS_WEB_BUILD=true
elif [ "$SKIP_WEB" = true ]; then
  echo "⚠ --skip-web:本地无 apps/web/.next 构建产物,前端保留远端旧构建"
else
  echo "✖ 本地无 apps/web/.next 构建产物,拒绝部署(避免上线没有前端的服务)" >&2
  echo "  请先 cd apps/web && npm run build;确认要沿用远端旧前端时加 --skip-web" >&2
  exit 1
fi

echo "▶ 部署目标: ${REMOTE}:${REMOTE_DIR}"

# rsync 前在远端保存回滚快照:cp -al 硬链接副本,零拷贝开销;
# rsync 默认先写临时文件再 rename,不会改动快照指向的 inode,快照安全
echo "▶ 远端保存回滚快照(.rollback-previous)…"
ssh "${SSH_OPTS[@]}" "${REMOTE}" bash -s -- "${REMOTE_DIR}" <<'REMOTE_EOF'
set -eu
cd "$1"
rm -rf .rollback-previous
mkdir -p .rollback-previous
if [ -d api/app ]; then cp -al api/app .rollback-previous/api-app; fi
if [ -d web/.next ]; then cp -al web/.next .rollback-previous/web-next; fi
echo "  快照完成"
REMOTE_EOF

# 快照已就位,此后任一步失败都提示回滚路径
trap 'echo "✖ 部署失败。可执行 deploy/deploy.sh --rollback ${REMOTE} 回滚到部署前状态" >&2' ERR

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

if [ "$HAS_WEB_BUILD" = true ]; then
  # 防呆:部署构建必须是不带 INTERNAL_API_BASE 的(默认烘焙 localhost:8090)。
  # 本地验证用的 8200 构建若误部署,core 上 /api 代理全 500(2026-08-07 批3 事故)。
  # 两种写法都要拦:localhost:8200 与 127.0.0.1:8200(2026-08-10 .env.local 用后者,漏检过一次)
  if grep -qE "(localhost|127\.0\.0\.1):8200" apps/web/.next/routes-manifest.json 2>/dev/null; then
    echo "✖ .next 是本地验证构建(API 代理烘焙为 8200)。请先执行:cd apps/web && npm run build" >&2
    exit 1
  fi
  echo "▶ rsync 前端构建产物(.next) → ${REMOTE} …"
  rsync -az --delete -e "ssh ${SSH_OPTS[*]}" --exclude=cache \
    apps/web/.next/ "${REMOTE}:${REMOTE_DIR}/web/.next/"
  echo "  .next 完成"
fi

if [ "$INSTALL" = true ]; then
  echo "▶ 远端执行真机安装脚本(需要 sudo) ..."
  ssh "${SSH_OPTS[@]}" "${REMOTE}" \
    "sudo bash ${REMOTE_DIR}/deploy/bare-metal/install.sh"
  # install.sh 内部负责 enable/start,这里只负责等待两服务就绪
  # 健康探测用 /api/health(openapi.json 已按 TOIV_EXPOSE_API_DOCS 门控,默认关)
  remote_wait_health "toiv-api" "http://localhost:8090/api/health"
  remote_wait_health "toiv-web" "http://localhost:3100"
else
  echo "▶ 远端重载配置 …"
  ssh "${SSH_OPTS[@]}" "${REMOTE}" "sudo systemctl daemon-reload"
  # 依次重启:先 api 后 web,各自重启后立即做该服务健康等待,
  # 缩短整体停机窗口,且 api 起不来时不会白白重启 web
  remote_restart toiv-api
  # 健康探测用 /api/health 而非 /openapi.json:后者自 QA-FULL-2026-08-11 起
  # 按 TOIV_EXPOSE_API_DOCS 门控(默认关闭),探测它会误判服务未就绪
  remote_wait_health "toiv-api" "http://localhost:8090/api/health"
  remote_restart toiv-web
  remote_wait_health "toiv-web" "http://localhost:3100"
fi

trap - ERR
echo "✅ 部署完成"
