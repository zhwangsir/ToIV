#!/usr/bin/env bash
#
# fleet_activate_missing_nodes.sh — 方案 C 波「放量」缺件节点激活脚本(待命,本轮只暂存不激活)
#
# 用途:Wave C 暂存的缺件节点包/类键别名随实例重启生效(P-15:装了文件≠生效,逐实例重启+object_info 核验)。
# 运行位置:workstation 本机执行(先 scp 过去,严禁并行多开会话跑):
#   scp scripts/ops/fleet_activate_missing_nodes.sh merlin@192.168.71.127:/var/tmp/
#   ssh merlin@192.168.71.127 'bash /var/tmp/fleet_activate_missing_nodes.sh'
#
# 纪律:
#   - 串行逐实例(P-25:并行重启互写共享 user 配置会整包注册失败、节点数下降)
#   - 每实例重启前查 /queue:有在飞作业(running/pending 非空)则跳过该实例
#   - P-15 计数互核:重启前后 object_info 节点总数,下降即中止并按 ROLLBACK 段回退
#   - 8 键断言:PG smoke_error 重析 8 类逐键核验(显示键→现网图真实类键映射见下)
#   - 🔴 只在空窗执行:B 波渲染/冒测战役在飞时禁止跑(P-25/AGENTS §〇)
#
# 8 键映射(2026-10-17 现网重析定案,显示键来自 smoke_error 文本,真实类键来自存量 workflow_json):
#   1 'FL Image Batch To Grid'      -> FL_ImageBatchToGrid + 别名键 "FL Image Batch To Grid"(toiv_classkey_aliases)
#   2 'Runninghub Captioner'        -> RH_Captioner(toiv_rh_shims shim → ToIV VLM :9311)
#   3 'Flux Resolution Calc'        -> FluxResolutionNode(ControlAltAI-Nodes)
#   4 '☯️无极清理器'                -> WujiCleaner(ComfyUI-WujiToolbox;暂存受阻见 wave-c-report,EXPECTED_MISSING)
#   5 'Qwen Multiangle Camera'      -> QwenMultiangleCameraNode(ComfyUI-qwenmultiangle)
#   6 'Wan2.2提示词选取器 昊纯制作' -> Wan22PromptSelector(wan22_prompt_selector)
#   7 'Render NLF Poses'            -> RenderNLFPoses + 别名键 "Render NLF Poses"
#   8 'Inspyrenet Rembg'            -> InspyrenetRembg(两树皆无,豁免留档,EXPECTED_MISSING)
#
# 作用范围:共享 custom_nodes 树(/opt/ComfyUI/custom_nodes)的 4 实例。
# :8197(ComfyUI-longcat)/:8264(ComfyUI-h3-eval)是独立 curated 树,不适用本脚本(缺键面不同,另行处理)。
#
# ROLLBACK(节点数下降/注册失败时):
#   1) 本轮新暂存目录移出共享树:`sudo mv /opt/ComfyUI/custom_nodes/<新包> /var/tmp/toiv_rollback_<ts>/`
#      (增量见 wave-c-report「已暂存包清单」;已有包本体严禁动)
#   2) `sudo systemctl restart <unit>` 恢复原注册面,再跑本脚本核验计数回升
#   3) journalctl -u <unit> 留证后回报,禁止在未查明前反复重启(P-5)

set -euo pipefail

SUDO="${SUDO:-sudo}"
HOST=127.0.0.1
READY_TIMEOUT=600          # object_info 就绪最长等待(实例冷启动+5000 类注册)
READY_POLL=10
COOLDOWN=5                 # 实例间串行冷却
LOG=/var/tmp/toiv_activate_missing_nodes_$(date +%Y%m%d_%H%M%S).log

# 共享树实例(unit:port),串行处理顺序即数组顺序
INSTANCES=(
  "comfyui-gpu0-alt:8196"
  "comfyui-upscale-gpu2:8262"
  "comfyui-upscale-gpu3:8263"
  "comfyui-gpu2-gen:8265"
)

# 8 键断言:每条 = "smoke_error 显示键|必过注册键(逗号分隔)|豁免/待装注册键(逗号分隔)"
# - 必过键缺失 → FAIL 该实例
# - 豁免键缺失 → 记 EXPECTED_MISSING(不判失败);豁免键出现 → 记 INFO(好事,自动转正)
ASSERTS=(
  "FL Image Batch To Grid|FL_ImageBatchToGrid,FLImageBatchToGridAliasKey|"
  "Runninghub Captioner|RH_Captioner|Runninghub Captioner"
  "Flux Resolution Calc|FluxResolutionNode|Flux Resolution Calc"
  "☯️无极清理器||WujiCleaner"
  "Qwen Multiangle Camera|QwenMultiangleCameraNode|Qwen Multiangle Camera"
  "Wan2.2提示词选取器 昊纯制作|Wan22PromptSelector|Wan2.2提示词选取器 昊纯制作"
  "Render NLF Poses|RenderNLFPoses,RenderNLFPosesAliasKey|"
  "Inspyrenet Rembg||InspyrenetRembg"
)

log() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$LOG"; }

node_count() { # $1=port → 打印节点类总数(-1=取不到);curl 失败不传染 set -e
  { curl -sf --max-time 120 "http://$HOST:$1/object_info" || true; } \
    | python3 -c 'import json,sys
try:
    print(len(json.load(sys.stdin)))
except Exception:
    print(-1)'
}

queue_busy() { # $1=port → 0=有在飞作业 1=空闲 2=查不到
  local out
  if ! out=$(curl -sf --max-time 20 "http://$HOST:$1/queue"); then return 2; fi
  python3 -c 'import json,sys
d=json.loads(sys.argv[1])
busy=bool(d.get("queue_running")) or bool(d.get("queue_pending"))
sys.exit(0 if busy else 1)' "$out"
}

wait_ready() { # $1=port → 等 object_info 可取且非空
  local deadline=$(( $(date +%s) + READY_TIMEOUT ))
  while (( $(date +%s) < deadline )); do
    local n
    n=$(node_count "$1")
    if (( n > 0 )); then return 0; fi
    sleep "$READY_POLL"
  done
  return 1
}

assert_keys() { # $1=port → 打印逐键结果,有必过键缺失则返回 1
  # 别名键只在共享树 toiv_classkey_aliases 生效后存在;用哨兵名在 python 侧替换成真实键名,
  # 避免 bash 数组里塞带空格/emoji 的键名。
  python3 - "$1" "${ASSERTS[@]}" <<'PY' | tee -a "$LOG"
import json, sys, urllib.request

port = sys.argv[1]
ALIAS = {"FLImageBatchToGridAliasKey": "FL Image Batch To Grid",
         "RenderNLFPosesAliasKey": "Render NLF Poses"}
with urllib.request.urlopen(f"http://127.0.0.1:{port}/object_info", timeout=120) as r:
    reg = set(json.load(r).keys())

failed = False
for entry in sys.argv[2:]:
    label, required, pending = entry.split("|")
    for k in filter(None, (x.strip() for x in required.split(","))):
        k = ALIAS.get(k, k)
        ok = k in reg  # P-16:存在性只看 body 键集合,不看 HTTP 码
        print(f"  [{'PASS' if ok else 'FAIL'}] {label} -> {k}")
        failed |= not ok
    for k in filter(None, (x.strip() for x in pending.split(","))):
        k = ALIAS.get(k, k)
        if k in reg:
            print(f"  [INFO] {label} -> {k} 已注册(豁免/待装键转正)")
        else:
            print(f"  [EXPECTED_MISSING] {label} -> {k}(留档/待人工暂存,不判失败)")
sys.exit(1 if failed else 0)
PY
}

# ---- 预检:暂存面(不满足只告警,不阻断——EXPECTED_MISSING 键本就允许缺席) ----
log "日志:$LOG"
for f in toiv_classkey_aliases/__init__.py toiv_rh_shims/__init__.py \
         toiv_FL_ImageBatchToGrid/FL_ImageBatchToGrid.py ComfyUI-SCAIL-Pose/nodes.py \
         ControlAltAI-Nodes/flux_resolution_cal_node.py ComfyUI-qwenmultiangle/nodes.py \
         wan22_prompt_selector/wan22_prompt_selector.py; do
  [ -e "/opt/ComfyUI/custom_nodes/$f" ] || log "WARN 预检缺文件:$f"
done
[ -d /opt/ComfyUI/custom_nodes/ComfyUI-WujiToolbox ] \
  || log "WARN ComfyUI-WujiToolbox 未暂存(4 号键 ☯️无极清理器 本轮仍 EXPECTED_MISSING,人工下载步骤见 wave-c-report)"

# ---- 串行激活 ----
overall=0
for item in "${INSTANCES[@]}"; do
  unit=${item%%:*}; port=${item##*:}
  log "===== $unit(:$port) ====="

  before=$(node_count "$port")
  if (( before <= 0 )); then log "SKIP object_info 取不到(before=$before),实例不可达,不重启"; overall=1; continue; fi
  log "重启前节点类总数:$before"

  set +e
  queue_busy "$port"
  qb=$?
  set -e
  case $qb in
    0) log "SKIP 有在飞作业(running/pending 非空),跳过 $unit(P-25)"; continue ;;
    2) log "SKIP /queue 查不到,跳过 $unit"; overall=1; continue ;;
  esac

  log "restart $unit …"
  "$SUDO" systemctl restart "$unit"
  if ! wait_ready "$port"; then
    log "FAIL $unit ${READY_TIMEOUT}s 内 object_info 未就绪 → 按 ROLLBACK 段处置"
    exit 1
  fi

  after=$(node_count "$port")
  log "重启后节点类总数:$after"
  if (( after < before )); then
    log "FAIL P-15 节点数下降($before → $after)→ 中止全跑,按 ROLLBACK 段回退"
    exit 1
  fi

  if ! assert_keys "$port"; then
    log "FAIL $unit 8 键断言未全过(明细见上)"
    overall=1
  else
    log "OK $unit 8 键断言全过"
  fi
  sleep "$COOLDOWN"
done

if (( overall != 0 )); then
  log "收尾:存在 SKIP/FAIL 项,逐条处置后再补跑(脚本幂等,可重入)"
  exit 1
fi
log "全部实例激活并核验通过"
