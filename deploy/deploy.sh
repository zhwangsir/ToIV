#!/usr/bin/env bash
#
# ToIV 部署脚本 —— 真机部署(Docker 已禁用)
#
# 用法:
#   deploy/deploy.sh                 # 默认:rsync 源码 → core,依次重启 toiv-api/toiv-web 并做健康等待
#   deploy/deploy.sh --install       # 首次部署:rsync 后执行远端 install.sh(需 sudo)
#   deploy/deploy.sh workstation     # 部署到 workstation(默认 core)
#   deploy/deploy.sh --skip-web      # 本地无 .next 构建产物时仍部署(前端保留远端旧构建)
#   ALLOW_STALE_WEB=1 deploy/deploy.sh  # 显式允许推与当前 HEAD 短 sha 不一致的旧 .next(默认拒)
#   无 ALLOW_DIRTY_WEB:BUILD_ID 含 -dirty 一律拒推(P-2;见 scripts/release/build_id_gate.py)
#   FORCE_API_RESTART=1          # 跳过 deploy drain(批跑+studio 生成窗+烟测 campaign),危险
#   DEPLOY_DRAIN_WAIT_SEC=120    # api 重启前若 busy 则最多等 N 秒排水(默认 0=立即拒绝)
#   deploy/deploy.sh --web-only      # 仅前端:rsync web+.next,只重启 toiv-web(不碰 toiv-api,保护烟测)
#   deploy/deploy.sh --rollback      # 回滚:恢复部署前快照(api/app + web/.next),重启并健康检查
#   deploy/deploy.sh --with-canvas   # 追加画布件:rsync apps/canvas → core 构建(canvas-api-pg 二进制
#                                    # + /studio SPA dist)换装重启(M4-5 后 canvas 部署合一入口)
#   deploy/deploy.sh --canvas-only   # 仅画布件(不动 toiv-api/toiv-web)
#   deploy/deploy.sh --all           # S12 单部署链路:api + web + canvas 一条命令(等价 --with-canvas 全量)
#   deploy/deploy.sh --dry           # 仅本地预检:校验源码路径存在并打印本地→远端映射,不连远端
#
# 目录约定(2026-10-31 重排):
#   本地 backend/api → 远端 ${REMOTE_DIR}/api
#   本地 frontend/app → 远端 ${REMOTE_DIR}/apps/prime/web(远端构建路径不变,systemd/回滚契约保持)
#   本地 apps/web / apps/canvas → 远端 web / apps/canvas(第 6 步归档前不动)
#
# -E:ERR trap 在函数内失败时也生效(用于部署失败时打印回滚提示)
set -eEuo pipefail

# 默认部署到 core(2026-07-28 设备说明:core 为真机业务服务器)
REMOTE="core"
REMOTE_DIR="/home/merlin/toiv"
INSTALL=false
SKIP_WEB=false
WEB_ONLY=false
ROLLBACK=false
WITH_CANVAS=false
CANVAS_ONLY=false
PRIME=false
DRY=false

for arg in "$@"; do
  case "$arg" in
    --install)     INSTALL=true ;;
    --skip-web)    SKIP_WEB=true ;;
    --web-only)    WEB_ONLY=true ;;
    --rollback)    ROLLBACK=true ;;
    --with-canvas) WITH_CANVAS=true ;;
    --canvas-only) CANVAS_ONLY=true ;;
    --prime)       PRIME=true ;;
    --dry)         DRY=true ;;
    --all)         SKIP_WEB=${SKIP_WEB:-false}; WITH_CANVAS=true ;;
    *)             REMOTE="$arg" ;;
  esac
done

# ssh 选项:数组,务必用 "${SSH_OPTS[@]}" 展开
SSH_OPTS=(-o ConnectTimeout=40 -o ServerAliveInterval=10 -o ServerAliveCountMax=6)
RSYNC_EXCLUDES=(--exclude=node_modules --exclude=.next --exclude=.venv \
  --exclude=__pycache__ --exclude='*.db' --exclude='.env*' --exclude=.git)

# 项目根(本脚本在 deploy/ 下)
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# --dry:本地预检源码路径 + 打印本地→远端映射,不连远端、不构建、不重启。
# 重排后本地源路径变化最容易漏改到这里,所以把它做成可执行门禁。
dry_run() {
  local fail=0
  echo "▶ [dry] 部署目标: ${REMOTE}:${REMOTE_DIR}"
  echo "▶ [dry] 本地→远端映射:"
  echo "    backend/api/     → ${REMOTE_DIR}/api/"
  echo "    frontend/app/    → ${REMOTE_DIR}/apps/prime/web/"
  echo "    apps/web/        → ${REMOTE_DIR}/web/"
  echo "    apps/canvas/     → ${REMOTE_DIR}/apps/canvas/"
  echo "    deploy/          → ${REMOTE_DIR}/deploy/"

  check_dir() {
    if [ -d "$1" ]; then
      echo "  ✓ $1"
    else
      echo "  ✖ 缺少本地源目录: $1" >&2
      fail=1
    fi
  }

  if [ "$WEB_ONLY" = true ]; then
    check_dir apps/web
  elif [ "$CANVAS_ONLY" = true ]; then
    check_dir apps/canvas
    [ "$PRIME" = true ] && check_dir frontend/app
  else
    check_dir backend/api
    check_dir deploy
    if [ "$SKIP_WEB" != true ]; then check_dir apps/web; fi
    if [ "$WITH_CANVAS" = true ]; then
      check_dir apps/canvas
      [ "$PRIME" = true ] && check_dir frontend/app
    fi
  fi

  if [ "$PRIME" = true ] && [ -d frontend/app ] && [ ! -f frontend/app/index.html ]; then
    echo "  ⚠ frontend/app/index.html 不存在(确认是否仍是 Vite 前端根)" >&2
  fi
  if [ "$SKIP_WEB" != true ] && [ "$WEB_ONLY" != true ] && [ "$CANVAS_ONLY" != true ]; then
    if [ -f apps/web/.next/BUILD_ID ]; then
      echo "  ✓ apps/web/.next/BUILD_ID=$(tr -d '\n\r' < apps/web/.next/BUILD_ID)"
    else
      echo "  ⚠ apps/web/.next 无构建产物:真跑部署会被拒(先 cd apps/web && npm run build,或加 --skip-web)" >&2
    fi
  fi

  if [ "$fail" -ne 0 ]; then
    echo "✖ [dry] 预检失败" >&2
    exit 1
  fi
  echo "✅ [dry] 预检通过(未连接远端)"
  exit 0
}

if [ "$DRY" = true ]; then
  dry_run
fi

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

# P-25 / AGENTS §〇:toiv-api 重启前排水。
# 覆盖:批跑驱动 pgrep + PG Job(queued/running,含 studio_* / drama_* / board_film 等)
# + App.smoke_status=running(campaign)。旧逻辑只 pgrep batch 脚本,两次误杀 studio 生成窗。
assert_api_drain() {
  if [[ "${FORCE_API_RESTART:-0}" == "1" ]]; then
    echo "⚠ FORCE_API_RESTART=1:跳过 deploy drain(生成窗/战役守卫)" >&2
    return 0
  fi
  local wait_sec="${DEPLOY_DRAIN_WAIT_SEC:-0}"
  echo "▶ deploy drain:检查 studio 生成窗 / 烟测 campaign / 批跑驱动…"
  # shellcheck disable=SC2029
  ssh "${SSH_OPTS[@]}" "${REMOTE}" bash -s -- "${REMOTE_DIR}" "${wait_sec}" <<'REMOTE_DRAIN'
set -euo pipefail
TOIV="$1"
WAIT="$2"
DRAIN="$TOIV/deploy/deploy_drain.py"
PY="$TOIV/api/.venv/bin/python"
if [ ! -f "$DRAIN" ]; then
  # 脚本尚未 rsync 到远端:回退旧 pgrep(并警告 studio 窗未覆盖)
  busy=$(pgrep -af 'tmp/batch[0-9]+_[^ ]*\.py' | grep -v pgrep || true)
  if [ -n "$busy" ]; then
    echo "✖ 有渲染驱动在跑,拒绝重启 toiv-api:" >&2
    echo "$busy" >&2
    exit 3
  fi
  echo "⚠ 远端无 deploy/deploy_drain.py — 仅旧 pgrep 守卫;请先完整部署以启用 studio drain" >&2
  exit 0
fi
if [ ! -x "$PY" ]; then
  PY=python3
fi
extra=()
if [ "${WAIT:-0}" -gt 0 ] 2>/dev/null; then
  extra+=(--wait-sec "$WAIT" --poll-interval 5)
fi
exec "$PY" "$DRAIN" --probe-local "${extra[@]}"
REMOTE_DRAIN
}

remote_restart() {
  local unit="$1"
  if [[ "${unit}" == "toiv-api" ]]; then
    assert_api_drain || exit $?
  fi
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
if [ -d .rollback-previous/canvas-plugins ]; then
  rm -rf /home/merlin/toiv-studio/plugin-packages
  cp -al .rollback-previous/canvas-plugins /home/merlin/toiv-studio/plugin-packages
  echo "  已恢复 canvas 官方插件包"
fi
if [ -f .rollback-previous/canvas-api.env ]; then
  cp -p .rollback-previous/canvas-api.env /home/merlin/toiv-studio/canvas-api/canvas-api.env
  echo "  已恢复 canvas-api.env"
fi
if [ -f .rollback-previous/canvas-bin ]; then
  systemctl --user stop canvas-api-pg || true
  cp .rollback-previous/canvas-bin /home/merlin/toiv-studio/canvas-api-pg
  systemctl --user start canvas-api-pg || true
  echo "  已恢复 canvas-api-pg 二进制"
fi
if [ -d .rollback-previous/canvas-dist ]; then
  rm -rf /home/merlin/toiv-studio/dist
  cp -al .rollback-previous/canvas-dist /home/merlin/toiv-studio/dist
  echo "  已恢复 canvas /studio dist"
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

# ---------- 画布件(canvas)部署:M4-5 部署合一 ----------
# 目标链:apps/canvas 源码 rsync → ${REMOTE_DIR}/apps/canvas → core 本机构建
#   · Go:   ~/sdk/go1.25.0 CGO 构建.canvas-api-pg.new,停服换装再启(运行中二进制 Text file busy)
#   · Web:  node_modules 兜底(已有则沿用;缺则 bun install,无 bun 则硬链旧检出)后
#           VITE_CANVAS_BACKEND_URL=/studio/api --base=/studio/ 生产口径出 dist → toiv-studio/dist
#   · 插件: core 本机 build-packages.sh → toiv-studio/plugin-packages(canvas-api.env 指向此处)
#   · 快照:.rollback-previous/canvas-{bin,dist,plugins,api.env}(与 api/web 快照同批,--rollback 一并恢复)
deploy_canvas() {
  echo "▶ [canvas] rsync apps/canvas → ${REMOTE}:${REMOTE_DIR}/apps/canvas …"
  rsync -az --delete -e "ssh ${SSH_OPTS[*]}" \
    --exclude=node_modules --exclude='.git' --exclude=dist \
    apps/canvas/ "${REMOTE}:${REMOTE_DIR}/apps/canvas/"
  if [ "$PRIME" = true ]; then
    # 本地重排后源码在 frontend/app;远端构建路径 apps/prime/web 保持不变(systemd/回滚契约)
    echo "▶ [prime] rsync frontend/app → ${REMOTE}:${REMOTE_DIR}/apps/prime/web …"
    ssh "${SSH_OPTS[@]}" "${REMOTE}" "mkdir -p '${REMOTE_DIR}/apps/prime/web'"
    rsync -az --delete -e "ssh ${SSH_OPTS[*]}" \
      --exclude=node_modules --exclude='.git' --exclude=dist \
      frontend/app/ "${REMOTE}:${REMOTE_DIR}/apps/prime/web/"
  fi
  echo "▶ [canvas] sync docs/NAS_MODEL_PICKER.json …"
  ssh "${SSH_OPTS[@]}" "${REMOTE}" "mkdir -p '${REMOTE_DIR}/docs'"
  rsync -az -e "ssh ${SSH_OPTS[*]}" docs/NAS_MODEL_PICKER.json "${REMOTE}:${REMOTE_DIR}/docs/NAS_MODEL_PICKER.json"
  echo "▶ [canvas] 远端快照 + 构建 + 换装(canvas-api-pg + /studio dist)…"
  ssh "${SSH_OPTS[@]}" "${REMOTE}" bash -s -- "${REMOTE_DIR}" "${PRIME}" <<'REMOTE_EOF'
set -euo pipefail
TOIV="$1"
PRIME="${2:-false}"
CANVAS="$TOIV/apps/canvas"
PROD="/home/merlin/toiv-studio"
GOROOT_BIN="$HOME/sdk/go1.25.0/bin"

# 快照(与主部署同批回滚)
mkdir -p "$TOIV/.rollback-previous"
[ -f "$PROD/canvas-api-pg" ] && cp -al "$PROD/canvas-api-pg" "$TOIV/.rollback-previous/canvas-bin" 2>/dev/null || true
[ -d "$PROD/dist" ] && rm -rf "$TOIV/.rollback-previous/canvas-dist" && cp -al "$PROD/dist" "$TOIV/.rollback-previous/canvas-dist" || true

# 官方插件包(toiv-h3 等):core 本机打包 → toiv-studio/plugin-packages(只放 *.beeftv-plugin),
# canvas-api 启动时按该目录 reconcile 内置插件。此前 env 指向已归档的旧 BeefTV 检出
# (/home/merlin/beeftv/plugin-packages,停在 toiv-h3 0.3.0),主仓插件改动部署不到生产。
# 首次部署把 canvas-api.env 的 CANVAS_OFFICIAL_PLUGIN_DIR 切过来(先备份,--rollback 恢复)。
PLUG="$PROD/plugin-packages"
ENVF="$PROD/canvas-api/canvas-api.env"
sh "$CANVAS/plugin-packages/build-packages.sh" >/dev/null
rm -rf "$TOIV/.rollback-previous/canvas-plugins" "$TOIV/.rollback-previous/canvas-api.env"
[ -d "$PLUG" ] && cp -al "$PLUG" "$TOIV/.rollback-previous/canvas-plugins" || true
[ -f "$ENVF" ] && cp -p "$ENVF" "$TOIV/.rollback-previous/canvas-api.env" || true
mkdir -p "$PLUG"
rsync -a --delete --include='*.beeftv-plugin' --exclude='*' "$CANVAS/plugin-packages/" "$PLUG/"
n_pk=$(ls "$PLUG"/*.beeftv-plugin | wc -l)
[ "$n_pk" -gt 0 ] || { echo "ERROR: 官方插件包为空($PLUG)" >&2; exit 1; }
if [ -f "$ENVF" ] && ! grep -qx "CANVAS_OFFICIAL_PLUGIN_DIR=$PLUG" "$ENVF"; then
  if grep -q '^CANVAS_OFFICIAL_PLUGIN_DIR=' "$ENVF"; then
    sed -i "s#^CANVAS_OFFICIAL_PLUGIN_DIR=.*#CANVAS_OFFICIAL_PLUGIN_DIR=$PLUG#" "$ENVF"
  else
    echo "CANVAS_OFFICIAL_PLUGIN_DIR=$PLUG" >> "$ENVF"
  fi
  echo "  canvas-api.env:CANVAS_OFFICIAL_PLUGIN_DIR → $PLUG"
fi
echo "  官方插件包 ${n_pk} 个 → $PLUG"

# Live gate model-config template（prod 读 toiv-studio/gate/model-config.template.json，勿只留 .example）
GATE_PROD="$PROD/gate"
mkdir -p "$GATE_PROD"
SRC_LIVE="$CANVAS/deploy/toiv-staging/gate/model-config.template.json"
SRC_EX="$CANVAS/deploy/toiv-staging/gate/model-config.template.example.json"
if [ -f "$SRC_LIVE" ]; then
  cp -f "$SRC_LIVE" "$GATE_PROD/model-config.template.json"
elif [ -f "$SRC_EX" ]; then
  cp -f "$SRC_EX" "$GATE_PROD/model-config.template.json"
else
  echo "ERROR: missing model-config.template(.example).json under deploy/toiv-staging/gate" >&2
  exit 1
fi
echo "  gate template → $GATE_PROD/model-config.template.json"

# NAS picker env（缺则 Studio NAS 列表空）
PICKER="$TOIV/docs/NAS_MODEL_PICKER.json"
NAS_ROOT="/mnt/toiv-nas/toiv/comfyui-models"
if [ -f "$PICKER" ] && [ -f "$ENVF" ]; then
  ensure_env_kv() { local key="$1" val="$2"; if grep -q "^${key}=" "$ENVF"; then sed -i "s#^${key}=.*#${key}=${val}#" "$ENVF"; else echo "${key}=${val}" >> "$ENVF"; fi; }
  ensure_env_kv TOIV_NAS_MODELS_ROOT "$NAS_ROOT"
  ensure_env_kv TOIV_NAS_PICKER_PATH "$PICKER"
  echo "  canvas-api.env: TOIV_NAS_MODELS_ROOT + TOIV_NAS_PICKER_PATH"
fi

# Go 后端
export PATH="$GOROOT_BIN:$PATH"
cd "$CANVAS/backend"
CGO_ENABLED=1 go build -trimpath -o "$PROD/canvas-api-pg.new" ./cmd/server
systemctl --user stop canvas-api-pg
mv "$PROD/canvas-api-pg.new" "$PROD/canvas-api-pg"
systemctl --user start canvas-api-pg

# Web dist(生产挂载口径)；--prime 时改构建 apps/prime/web（printfilm 基座）
if [ "$PRIME" = "true" ]; then
  cd "$TOIV/apps/prime/web"
  if [ ! -x node_modules/.bin/vite ]; then
    if command -v bun >/dev/null 2>&1; then bun install --frozen-lockfile
    else echo "ERROR: prime web 无 node_modules 且无 bun" >&2; exit 1; fi
  fi
  BEEFTV_PUBLIC_BASE=/studio/ VITE_API_BASE=/api ./node_modules/.bin/vite build --outDir /tmp/canvas-dist-new --emptyOutDir >/dev/null
else
  cd "$CANVAS/web"
  if [ ! -x node_modules/.bin/vite ]; then
    if command -v bun >/dev/null 2>&1; then bun install --frozen-lockfile
    elif [ -d /home/merlin/beeftv/web/node_modules ]; then cp -al /home/merlin/beeftv/web/node_modules ./node_modules
    else echo "ERROR: canvas web 无 node_modules 且无 bun(先装 bun 或硬链旧检出)" >&2; exit 1; fi
  fi
  VITE_CANVAS_BACKEND_URL=/studio/api ./node_modules/.bin/vite build --base=/studio/ --outDir /tmp/canvas-dist-new --emptyOutDir >/dev/null
fi
rsync -a --delete /tmp/canvas-dist-new/ "$PROD/dist/"
echo "  canvas 构建换装完成(prime=$PRIME)"
REMOTE_EOF
  remote_wait_health "canvas-api-pg" "http://127.0.0.1:8290/api/health/live"
}

if [ "$CANVAS_ONLY" = true ]; then
  echo "▶ 部署目标: ${REMOTE} (canvas-only)"
  trap 'echo "✖ canvas 部署失败。可执行 deploy/deploy.sh --rollback ${REMOTE} 回滚" >&2' ERR
  deploy_canvas
  trap - ERR
  echo "✅ canvas 部署完成"
  exit 0
fi

if [ "$WEB_ONLY" = true ] && [ "$SKIP_WEB" = true ]; then
  echo "✖ --web-only 与 --skip-web 互斥" >&2
  exit 1
fi
if [ "$WEB_ONLY" = true ] && [ "$INSTALL" = true ]; then
  echo "✖ --web-only 与 --install 互斥" >&2
  exit 1
fi


# 拒脏/旧网页:本地 .next/BUILD_ID 不得含 -dirty,且 git 短 sha 须等于当前 HEAD。
# 格式见 apps/web/next.config.mjs:YYYYMMDD-HHmmss-<git短sha>[-dirty]
# --skip-web 不走此检查(本来就不推 web)。
# ALLOW_STALE_WEB=1 仅可绕过「sha≠HEAD」的旧构建警告;绝不绕过 -dirty(P-2,无 ALLOW_DIRTY_WEB)。
assert_web_build_matches_head() {
  local build_id expected_sha build_sha gate
  build_id="$(tr -d '\n\r' < apps/web/.next/BUILD_ID)"
  expected_sha="$(git rev-parse --short HEAD)"
  gate=(python3 "$ROOT/scripts/release/build_id_gate.py")

  # P-2 硬闸:含 -dirty 一律失败(先于 stale 旁路)
  if ! "${gate[@]}" --id "$build_id"; then
    echo "  (deploy 拒推:请干净工作区后重建 web,勿带 -dirty 上线)" >&2
    return 1
  fi

  build_sha=""
  if [[ "$build_id" =~ ^[0-9]{8}-[0-9]{6}-([0-9a-fA-F]+)(-dirty)?$ ]]; then
    build_sha="${BASH_REMATCH[1]}"
  elif [[ "$build_id" =~ ^[0-9]{8}-[0-9]{6}-nogit$ ]]; then
    echo "⚠ BUILD_ID 为 nogit(非 git 检出构建),跳过 sha==HEAD 校验" >&2
    return 0
  fi
  if [ "$build_sha" = "$expected_sha" ]; then
    return 0
  fi
  if [ "${ALLOW_STALE_WEB:-}" = "1" ]; then
    echo "⚠ ALLOW_STALE_WEB=1:本地 .next 是旧构建(BUILD_ID=$build_id,期望 sha=$expected_sha),仍继续推前端" >&2
    echo "  注意:ALLOW_STALE_WEB 不能放行 -dirty(本函数已先过 dirty 闸)" >&2
    return 0
  fi
  echo "✖ 本地 .next 是旧构建,请先 cd apps/web && npm run build" >&2
  echo "  本地 BUILD_ID=$build_id" >&2
  echo "  期望 sha=$expected_sha" >&2
  return 1
}

# 本地构建产物前置检查:toiv-web 是 next start 跑预构建产物,没有 .next 部署上去
# 就是「没有前端的 web 服务」,直接失败而不是仅警告(可用 --skip-web 显式跳过)
HAS_WEB_BUILD=false
if [ "$SKIP_WEB" = true ]; then
  # --skip-web 只部署后端:不推 web 源码/.next、不重启 toiv-web。
  # 2026-10-05 事故:旧逻辑本地有 .next 就照推,把旧构建盖掉了线上官网 v3。
  echo "⚠ --skip-web:不动前端(web 源码/.next/toiv-web 均保留远端现状)"
elif [ -f apps/web/.next/BUILD_ID ]; then
  HAS_WEB_BUILD=true
else
  echo "✖ 本地无 apps/web/.next 构建产物,拒绝部署(避免上线没有前端的服务)" >&2
  echo "  请先 cd apps/web && npm run build;确认要沿用远端旧前端时加 --skip-web" >&2
  exit 1
fi

# HAS_WEB_BUILD=true 即将推前端:拒与当前 HEAD 短 sha 不一致的旧 .next
if [ "$HAS_WEB_BUILD" = true ]; then
  assert_web_build_matches_head || exit 1
fi

if [ "$WEB_ONLY" = true ]; then
  echo "▶ 部署目标: ${REMOTE}:${REMOTE_DIR} (web-only)"
else
  echo "▶ 部署目标: ${REMOTE}:${REMOTE_DIR}"
fi

# rsync 前在远端保存回滚快照:cp -al 硬链接副本,零拷贝开销;
# rsync 默认先写临时文件再 rename,不会改动快照指向的 inode,快照安全
echo "▶ 远端保存回滚快照(.rollback-previous)…"
ssh "${SSH_OPTS[@]}" "${REMOTE}" bash -s -- "${REMOTE_DIR}" "$WEB_ONLY" <<'REMOTE_EOF'
set -eu
cd "$1"
web_only="$2"
rm -rf .rollback-previous
mkdir -p .rollback-previous
if [ "$web_only" != true ] && [ -d api/app ]; then cp -al api/app .rollback-previous/api-app; fi
if [ -d web/.next ]; then cp -al web/.next .rollback-previous/web-next; fi
echo "  快照完成"
REMOTE_EOF

# 快照已就位,此后任一步失败都提示回滚路径
trap 'echo "✖ 部署失败。可执行 deploy/deploy.sh --rollback ${REMOTE} 回滚到部署前状态" >&2' ERR

if [ "$WEB_ONLY" = true ]; then
  if [ "$HAS_WEB_BUILD" != true ]; then
    echo "✖ --web-only 需要本地 apps/web/.next 构建产物" >&2
    echo "  请先 cd apps/web && npm run build" >&2
    exit 1
  fi
  if grep -qE "(localhost|127\.0\.0\.1):8200" apps/web/.next/routes-manifest.json 2>/dev/null; then
    echo "✖ .next 是本地验证构建(API 代理烘焙为 8200)。请先执行:cd apps/web && npm run build" >&2
    exit 1
  fi
  echo "▶ rsync 前端源码 → ${REMOTE}(不碰 api)…"
  rsync -az --delete -e "ssh ${SSH_OPTS[*]}" "${RSYNC_EXCLUDES[@]}" \
    apps/web/ "${REMOTE}:${REMOTE_DIR}/web/"
  echo "▶ rsync 前端构建产物(.next) → ${REMOTE} …"
  rsync -az --delete -e "ssh ${SSH_OPTS[*]}" --exclude=cache \
    apps/web/.next/ "${REMOTE}:${REMOTE_DIR}/web/.next/"
  echo "  web+.next 完成"
  echo "▶ 仅重启 toiv-web(保留 toiv-api / 烟测)…"
  remote_restart toiv-web
  remote_wait_health "toiv-web" "http://localhost:3100"
else
  echo "▶ rsync 源码 → ${REMOTE} …"
  # 远端 core 仍用旧目录结构 /home/merlin/toiv/{api,web,deploy}
  # --delete:删除远端旧组件残留
  # 注意:deploy/.env 是 core 上的生产配置(含 secret),不在 rsync 范围内,
  # 如需修改生产配置请直接编辑 /home/merlin/toiv/deploy/.env 并重启 toiv-api。
  rsync -az --delete -e "ssh ${SSH_OPTS[*]}" "${RSYNC_EXCLUDES[@]}" \
    backend/api/ "${REMOTE}:${REMOTE_DIR}/api/"
  if [ "$SKIP_WEB" != true ]; then
    rsync -az --delete -e "ssh ${SSH_OPTS[*]}" "${RSYNC_EXCLUDES[@]}" \
      apps/web/ "${REMOTE}:${REMOTE_DIR}/web/"
  fi
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
    if [ "$SKIP_WEB" != true ]; then
      remote_restart toiv-web
      remote_wait_health "toiv-web" "http://localhost:3100"
    fi
  fi
fi

# --with-canvas:主部署(api+web)完成后追加画布件
if [ "$WITH_CANVAS" = true ]; then
  deploy_canvas
fi

trap - ERR
echo "✅ 部署完成"
