# API 文档与运维配方

> 鉴权口径与 curl 例多为 2026-10-14 生产实测；服务表摘自 AGENTS.md §三/§五（10-13 核）。

## 一、服务端口全景

### workstation（192.168.71.127，全部 systemd 常驻）

| 服务 | 端口 | systemd 单元 | 说明 |
|---|---|---|---|
| ComfyUI-LB | :8188 | `comfyui-lb` | 池后端只编辑 `/opt/comfyui-lb/backends.json`（5s 热重载）；当前池≈仅 :8196（pc01 掉线） |
| gpu0-alt | :8196 | `comfyui-gpu0-alt` | GPU0，cache-lru 8 |
| LongCat | :8197 | `comfyui-longcat` | GPU0，TI2V/Avatar |
| MiniMax H3（试验口） | :8195 | `toiv-comfyui-h3` | GPU2 |
| **MiniMax H3（生产口）** | :8264 | `toiv-comfyui-h3-gpu1` | GPU1，UUID 钉卡 |
| Wan-Animate-2 | :8199 | `comfyui-wan-animate-2` | GPU3 |
| ToIV VLM（Qwen3-VL-8B） | :9311 | `toiv-vlm` | GPU3，from-image/图片解析 |
| 超分 fleet | :8262/:8263 | `comfyui-upscale-gpu2/3` | 4x-UltraSharp |
| IndexTTS 2.5 | :9200 | `toiv-indextts` | 配音主路，勿停 |
| Qwen3-Embedding-4B | :9302 | `qwen3-embedding` | OpenAI 兼容 `/v1` |
| 音频分离 / comfy-mcp | :9220 / :9100 | `toiv-audio-sep` / `toiv-comfy-mcp` | — |
| whisper ASR 集群 | openclaw×4 :9310 | — | `192.168.71.86/.75/.81/.85:9310`，OpenAI 兼容，多址故障转移（5xx 换节点、4xx 不转移） |
| LLM/VLM API（DSv4 无审查） | spark02 :8000 | vLLM TP2 | `http://192.168.71.84:8000/v1`；served `deepseek-v4-flash-dspark` + 别名 `qwen3.8-27b`/`qwen3.6-uncensored`/`glm-5.3-flash`；1M ctx ≈70 tok/s；**当前直连免鉴权**；重启 `ssh dgmt-spark@192.168.71.84 '~/dsv4-serve.sh 0'` |

### core（192.168.71.47）

| 服务 | 端口 | 说明 |
|---|---|---|
| toiv-web | :3100 | `/studio` 同源挂 canvas SPA；`/studio/api/*` 经 Next beforeFiles rewrite → `127.0.0.1:8290`（**Host 被改写为回环**，见 P-23） |
| toiv-api | :8090 | FastAPI；health=`GET /api/health`；LLM 代理 `/api/llm/v1` |
| toiv-admin | :3200 | 管理台（admin/admin123） |
| canvas-api-pg | :8290（仅 127.0.0.1） | `systemctl --user`（SSH 需 XDG_RUNTIME_DIR）；二进制 `/home/merlin/beeftv-prod/canvas-api-pg` |
| PG 18 / Redis | :5432 / :6379 | 仅 bind 127.0.0.1 |

## 二、ToIV API（:8090）

```bash
# 健康
curl -s http://192.168.71.47:8090/api/health

# 登录（字段名是 email；响应扁平 {token,user}，token=7天 JWT）
TOKEN=$(curl -s -X POST http://192.168.71.47:8090/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin","password":"admin123"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')

# LLM 代理（白名单模型 + 需 JWT）
curl -s -H "Authorization: Bearer $TOKEN" http://192.168.71.47:8090/api/llm/v1/models
```

注意：`/api/apps` 对 `limit>1000` 与未知 query 返回 **422**；分页用 `limit=1000&offset=`，任何一页失败必须报错不能当空集。产物/媒体 URL 需 sig 或 `?token=`。

## 三、Canvas API（经 web 入口 `/studio/api/*`，2026-10-14 实测链路）

鉴权三层：**ToIV Bearer + 可信 Origin（POST 类）+ UI 会话头（助手接口）**。浏览器同源访问自动满足；curl 模拟：

```bash
BASE="http://192.168.71.47:3100/studio/api"; ORIGIN="http://192.168.71.47:3100"

# ① 助手第一步：签发 UI 会话（来源校验要求 Origin 在 CANVAS_OPS_TRUSTED_ORIGINS 里）
UITOK=$(curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Origin: $ORIGIN" \
  $BASE/assistant/ui-session | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"]["token"])')

# ② 读对话/会话（GET 无 Origin 也可过；需要 UI 会话头）
curl -s -H "Authorization: Bearer $TOKEN" -H "X-Beeftv-Ui-Session: $UITOK" \
  "$BASE/assistant/history?canvasId=<id>"
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/assistant/status"   # 只读状态，无需 UI 会话

# ③ 文档 Ops（统一操作层；只读 op 不带 opId）
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Origin: $ORIGIN" -H "Content-Type: application/json" \
  -d '{"params":{"query":"关键词"}}' $BASE/ops/canvas.search
# 常用 op：canvas.get / canvas.search / canvas.node.update / canvas.nodes.create /
#          canvas.edge.create / canvas.document.commit / asset.list / task.get（完整表见 operations/ops.go）

# ④ 画布 REST（保存走 PUT，CAS revision）
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/canvas-projects"          # 列表 {data:{projects:[...]}}
curl -s -X PUT -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  --data @doc.json "$BASE/canvas-projects/<id>"

# ⑤ 模型渠道配置（密钥返回脱敏标记 __BEEFTV_REDACTED__，PUT 原样带回即保留）
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/workspace/model-config"   # {data:{config,revision}}
# PUT: {"config":<原config改字段>, "expectedRevision":<当前revision>}
```

关键事实：Next rewrite 会把 Host 改写成 `127.0.0.1:8290`（后端看到回环 Host），真正校验的是 **Origin** 是否同源或在 `CANVAS_OPS_TRUSTED_ORIGINS`（core env 已配 LAN/TS/wineryz 三个入口）；拒绝时后端日志打 `ops_source_denied`（journalctl --user -u canvas-api-pg）。助手宿主子进程（`/usr/bin/node /home/merlin/beeftv/agent-host/server.mjs`）由 canvas-api-pg 拉起，经回环调 ops，不经前端代理。

## 四、ComfyUI 探测坑（实证经验）

- **`GET /object_info/<未知类名>` 返回 HTTP 200 + 空 `{}`**——存在性判据只能取 body 键集合（`name in json.loads(raw)`）或全量 `/object_info` 键数，状态码一律作废。
- 「DB 标 error」≠「生成失败」：批量失败先查 `/history/{prompt_id}`，产物在就回写，禁止盲目重提。
- 引擎探测通过≠链路可跑；新引擎必须真机 e2e。
- GPU 显存/温度先 `nvidia-smi`（快照不是真理）；锁卡一律 GPU UUID。

## 五、运维配方

```bash
# ── 生产 PG 直查（只能 SSH core 后） ──
ssh merlin@192.168.71.47
export PGPASSWORD=68799b59242beeccfd54963902a35006
psql -h 127.0.0.1 -U toiv -d toiv -c "select count(*) from apps where is_public;"
# canvas 域加 search_path：... -c "set search_path=canvas; select ..."

# ── 部署（全部 core 本机构建，禁止外地传 .next） ──
# api：  deploy/deploy.sh --skip-web core-jump
# web：  ssh core 'cd /home/merlin/toiv/web && rm -rf .next && pnpm build && sudo systemctl restart toiv-web'
# admin：core 全量 npm install 后构建（deploy-admin.sh）
# canvas 后端+SPA 全量：deploy/deploy.sh --canvas-only（rsync 源码→core 构建→停服换装 canvas-api-pg→起服）

# ── canvas 后端单二进制快速换装（改 Go 代码时，10-14 实测口径） ──
rsync -az apps/canvas/backend/... merlin@192.168.71.47:~/toiv/apps/canvas/backend/
ssh merlin@192.168.71.47 'export PATH=$HOME/sdk/go1.25.0/bin:$PATH XDG_RUNTIME_DIR=/run/user/$(id -u); \
  cd ~/toiv/apps/canvas/backend && CGO_ENABLED=1 go build -trimpath -o /tmp/canvas-api-pg.new ./cmd/server && \
  systemctl --user stop canvas-api-pg && mv /tmp/canvas-api-pg.new ~/beeftv-prod/canvas-api-pg && \
  systemctl --user start canvas-api-pg'

# ── workstation 侧 ──
ssh merlin@192.168.71.127 'nvidia-smi; free -h; systemctl status comfyui-lb toiv-vlm toiv-indextts'
# ComfyUI 池成员变更：只编辑 /opt/comfyui-lb/backends.json（5s 热重载，零重启）
```

**部署后必验**：服务 active + `curl :8090/api/health` + web BUILD_ID 与 git HEAD 一致（P-2：前端变更必须生产干净重建，不能只看 API）。
