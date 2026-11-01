# AGENTS.md — 会话必读（短规则 + 集群真源）

> **本文件是 ToIV 集群现行真源**（主机 / 端口 / 权重 / SSH）。探针 as-of：**2026-10-24 09:50 Asia/Shanghai**（NAMING_N3）；LLM 现网口径以 **2026-10-25 Mia :8888** 为准。  
> **权威顺序**：① 真机探针（LAN curl / docker inspect）→ ② 仓库代码默认 → ③ 本文件 → ④ 其它文档。冲突以真机为准并回写本文件。  
> **命名铁律**：一个磁盘权重一个 weight id；served 不得伪装异家族。知识图谱页 canvas `b21e123b-da5f-43d9-90af-a3842894cfcc`。  
> **最后更新**：2026-11-01 Asia/Shanghai · workstation 重启清 GPU0 卡死（四卡恢复；VLM+IndexTTS 落 GPU0、embedding GPU1、H3+SenseVoice GPU2、Comfy 族 GPU3）+ ERP/coturn/frpc/upscale-8262 退役 + BMC 带外接入（`192.168.71.108`，见 §六）；探针 as-of **2026-11-01 02:40**。  
> **历史长文**：`ALLProject/.archive/toiv-docs-20261026/`；机读 `STATE.json`（只读）。

---

## 〇、硬性规则

1. **全部 AI/算力后端在 workstation**（`192.168.71.127` / TS `100.68.100.90`）。core 只跑 web/api/admin + PG/Redis。排查「引擎不可达」→ SSH workstation 查 systemd/端口，禁止臆断。
2. **文档仅供参考，必须真机验证**。GPU/端口/挂载以 SSH + `curl` 为准；与文档冲突先改本文件。
3. **冒测战役 PG running>0 时禁止重启 toiv-api**（留孤儿；P-18b）。
4. **禁止把密码/Token 写入 AGENTS、skills、commit**。密钥只在对应机 `deploy/.env` / `secrets/*` 读。
5. **LLM ≠ VLM**：LLM = spark02 **`:8888`**（Mia / DeepSeek-V4.1-Flash-1017）；VLM = workstation `:9311` `toiv-vlm`。spark01 **不是** API 入口（TP headless）。

## 〇b、本地开发与验证

**应用**：`backend/api`(:8090) · `frontend/app`（Prime 创作壳，远端 `apps/prime/web`）· `frontend/admin`(:3200) · `vendor/legacy-web`(:3100 `/studio`，切流前线上默认前端) · `vendor/canvas`（画布冻结件，必读 `vendor/canvas/AGENTS.md`）；移动端 `vendor/mobile/`。  
目录重排（2026-10-31）：本地 `backend/api` → 远端 `api`，`frontend/app` → 远端 `apps/prime/web`，`vendor/legacy-web` → 远端 `web`，`vendor/canvas` → 远端 `apps/canvas`；**远端路径契约不变**（systemd/回滚按远端寻址）。  
Drama∥Studio：新功能只加 Studio；Drama bugfix only。长文 `DEVELOPMENT.md`。暂存 `tmp/`（gitignore）。

```bash
cd backend/api && uv sync --extra dev && uv run pytest tests/test_foo.py::test_bar -q
cd frontend/app && bun run test:unit && bun run test:browser && bun run lint && bun run build
cd vendor/legacy-web && npm test && npm run typecheck    # node:test，不是 vitest
cd frontend/admin && npm test && npm run typecheck
cd vendor/canvas/backend && go vet ./... && go test ./...
cd vendor/canvas/web && bun run lint && bun run typecheck && bun run build
```

- `frontend/app` 浏览器套件**必须逐文件独立进程**（`test:browser` 已封装，单文件超时 180s）；Bun 1.2.17 单进程加载多个 Playwright harness 会挂起或漏报，整套 `bun test test/` 的绿灯不可信。Playwright 1.64.1 在 Bun 下销毁 context 时会偶发 `Unhandled error between tests`（协议对象已释放）；runner 仅在「0 fail 且错误全部命中三条 dispatcher 签名」时判过并打印 `warn`，其它未处理错误仍硬失败。
- Prime 内容策略唯一来源是 `@content-lock`（`vite.config.ts` + `tsconfig.app.json` 同一优先级：共享 `content-lock.ts` → 共享 `content-policy.ts` → 本地 `src/toiv/policy/noop-content-lock.ts`）。新增门控/隐藏/徽标不得自造判断；删除锁文件后构建、类型检查与页面须照常（`test/prime-content-lock.browser.test.ts` 覆盖此演练）。

- `vendor/legacy-web`/`frontend/admin` 仅 **npm**；`vendor/canvas/web` 仅 **bun**。新增 `lib/api` 导出必补 `tests/mocks/studioApi.ts`。
- 部署：`deploy/deploy.sh`；外出大流量用 `core-jump`。web/admin **在 core 本机构建**，勿从 Mac 盲推过期 `.next`。渲染在飞时脚本拒重启 api（`FORCE_API_RESTART=1` 强制）。

---

## 一、主机

| host id | 主机名 | LAN | Tailscale | SSH 用户 | 职责 |
|---|---|---|---|---|---|
| host.ops-matebook | MateBook | **192.168.71.118**（en0；勿再写 .9） | 100.74.15.34 | 本机 | 运维 / Cursor |
| host.core | core | 192.168.71.47 | 100.77.80.100 | merlin | 网关：web:3100 · api:8090 · admin:3200 · PG/Redis（127.0.0.1） |
| host.ws | workstation | 192.168.71.127 | 100.68.100.90 | merlin | **全部 GPU/AI 后端** |
| host.ws-bmc | workstation BMC（ASUS iKVM/MegaRAC） | **192.168.71.108** | — | admin | 带外电源/串口；Redfish `https://192.168.71.108/redfish/v1`；口令落点见 §六，勿写值 |
| host.spark-a | spark01 | 192.168.71.82 | 100.81.235.124 | dgmt-spark | LLM **TP2 rank1 headless**（本机 **无对外 API**） |
| host.spark-b | spark02 | 192.168.71.84 | 100.86.42.89 | dgmt-spark | LLM **唯一对外 API** `:8888`（Mia） |
| host.oc-01..04 | openclaw01–04 | .86 / .75 / .81 / .85 | 见现场 | dgmt-openclaw0N | Whisper `:9310` ×4；JoyCaption `:9305` |
| host.nas | DXP8800 | 192.168.71.7 | 100.80.237.96 | dgmt-nas | SMB 模型库 |
| （网关） | beijing / cloud | 8.140.222.24 / 43.119.32.180 | 见现场 | root | `toiv.wineryz.top` / `toiv.dgmt.top` |

已退役勿再当活设备：studio01–04、EXO、pc02。pc01（.116）可选/常 offline，**不进热路径默认**。

**SSH 偏好（家里 LAN）**：`core` / `workstation-lan` / `sk01-l` / `sk02-l` / `openclaw0*-lan`。外出大流量：`core-jump`（经 WS → core LAN）。默认 Host 若走 IPv6/公网易超时。

浏览器优先 LAN `http://192.168.71.47:3100`；公网 `https://toiv.wineryz.top` / `https://toiv.dgmt.top`。「TS 离线 ≠ 服务挂了」——先 LAN ping/端口。

---

## 二、存活端点（摘要）

| ep id | 地址 | 要点 |
|---|---|---|
| ep.gateway.api | core:8090 | `/api/health` → ok |
| ep.gateway.web | core:3100 | 200 |
| ep.gateway.admin | core:3200 | 200 |
| ep.llm.primary | spark02:**8888** | Mia TensorFold TP2；served `DeepSeek-V4.1-Flash-1017`；客户端兼容别名 `deepseek-v4-flash-dspark`（proxy 改写）；旧 `:8000`/dsv4_60 已停（同卡互斥） |
| （无） | spark01:8000 | TP worker only；无对外监听 |
| ep.vlm.primary | ws:9311 | served `toiv-vlm` ← Qwen3-VL-8B-Instruct（**GPU0**，0.35 配额；`PCI_BUS_ID`+CVD=0） |
| ep.lb.comfy-primary | ws:8188 | backends=`8196`（2026-10-31 收敛为单后端） |
| ep.comfy.image-gate | ws:8196 | **唯一通用实例**（GPU3 UUID 钉卡，cuda:0 95GiB）：通用出图 / qwen_edit / LB / LongCat 视频 |
| ep.comfy.video-longcat | ws:8197 | 端口桥 → 8196（`comfyui-longcat-bridge`，LongCat API 兼容，非独立实例） |
| ep.comfy.video-animate2 | ws:8199 | Wan-Animate-2 |
| ep.h3.prod | ws:**8264** | H3 生产（ref2va/fl2va，GPU2）；`:8195` 已停 |
| ep.comfy.upscale | ws:8263 | 超分（up-only，GPU3）；`:8262` 已退役（2026-11-01） |
| ep.tts.primary | ws:9200 | IndexTTS2（GPU0 UUID 钉卡） |
| ep.demucs.primary | ws:9220 | demucs-htdemucs（GPU3 UUID 钉卡，按需加载） |
| ep.embed.primary | ws:9302 | qwen3-embedding-4b（GPU1 UUID 钉卡） |
| ep.asr.sensevoice | ws:9211 | SenseVoiceSmall 音频反查（systemd `toiv-sensevoice`，GPU2 UUID 钉卡） |
| ep.asr.whisper-cluster | oc*:9310 | whisper-mlx |

**DOWN（勿配默认）**：`:8189` `:8195` `:8261` `:8262` `:8265` `:8200` `:8300` `:9004` `:9201` `:9202` `:9203` `:9210` `:9304` `:9400`–`:9404`（WS）；spark01 `:8000`。

### 代码默认应对齐

| 键 | 应指向 |
|---|---|
| `TOIV_LLM_BASE_URL` | `http://192.168.71.84:8888/v1` |
| `TOIV_LLM_MODEL` | `DeepSeek-V4.1-Flash-1017`（proxy 可改写旧别名） |
| `TOIV_VLM_SERVER_URL` / model | `http://192.168.71.127:9311` / `toiv-vlm` |
| `TOIV_H3_BASE_URL` | `http://192.168.71.127:8264` |
| `TOIV_LONGCAT_BASE_URL` | `…:8197` |
| `TOIV_WAN_ANIMATE2_BASE_URL` | `…:8199` |
| Comfy workers / LB | `http://192.168.71.127:8188` |
| TTS / Embed / Demucs | `:9200` / `:9302` / `:9220` |
| Whisper | openclaw 四址 `:9310`（path=`/health`） |

锁卡用 **GPU UUID**（H-6）。新专用 Comfy 实例必须补 `deps.resolve_worker()`（E-1）。

复核口令（家里）：

```bash
curl -sS http://192.168.71.47:8090/api/health
curl -sS http://192.168.71.84:8888/v1/models | head
curl -sS http://192.168.71.127:9311/v1/models | head
curl -sS -o /dev/null -w '%{http_code}\n' http://192.168.71.127:8264/system_stats
curl -sS http://192.168.71.127:9200/health
```

---

## 三、凭据（无值）

| 需要 | 落点 |
|---|---|
| admin 登录 | core `deploy/.env` → `TOIV_ADMIN_EMAIL` / `TOIV_ADMIN_PASSWORD` |
| PG | 同上 `TOIV_DATABASE_URL`；或 `toiv-api` 进程 environ |
| JWT / 渠道 | 仅 `deploy/.env`（gitignore） |
| workstation BMC | Mac `~/toiv-ops-logs/bmc-cred-20261101.txt`（600，BMC 内用户 `admin`） |

轮换流程历史稿在归档：`ALLProject/.archive/toiv-docs-20261026/docs/ops/CREDENTIAL_HYGIENE_ROTATE_20261020.md`。

---

## 四、易错点（压缩）

- **H**：禁臆造硬件；显存是快照；`:8189` 退役。  
- **N**：服务听 `0.0.0.0` 才经 TS；「TS 离线≠服务掉」先 LAN。  
- **E-3**：探测通 ≠ 链路可跑，须真机 e2e。**E-9**：专用实例分支须先验模型再 return。**E-4**：vLLM/Mia served 别名≠换了权重家族。  
- **P-2**：前端变更查 BUILD_ID。**P-18**：手跑 app.* 必须带 `TOIV_DATABASE_URL`。**P-18b**：孤儿看 `smoke_started_at`。**P-25**：舰队重启串行。

---

## 五、文档地图（五件套）

| 要找 | 去哪 |
|---|---|
| 现行主机/端口/权重 | **本文件** |
| 开发长文 / 现行设置摘要 | `DEVELOPMENT.md` |
| 测试近窗 | `TEST_LOG.md` |
| 状态快照 | `STATE.json` |
| 入口 | `README.md` |
| docs 索引 + 归档找回 | `docs/README.md` |
| 历史方案/wave/CLUSTER 旧稿 | `ALLProject/.archive/toiv-docs-20261026/` |

---

## 六、未关闭运维开口（摘要）

- Acc-8Step / Security Dly / git push / DOWN 口上线：**冻结未做**。  
- 隔离目录永久 rm：需用户明示。  
- cloud/openclaw 部分 tailscaled 现场恢复；pc01 非紧急。
- **2026-11-01 已清**：workstation 经 BMC `ForceRestart` 重启（原 `systemctl reboot` 卡在关机：sshd 与全部业务端口停止、内核与网络仍存活约 30 分钟）；GPU0 `c219…` 驱动卡死与 54.6GB 孤儿随重启消失，四卡全部可见；8262 僵尸/监听/高负载一并清除。当前落卡（均 UUID 钉卡，**勿按数字 0 臆断物理卡**）：GPU0 = VLM `:9311` + IndexTTS `:9200`；GPU1 = embedding `:9302`；GPU2 = H3 `:8264` + SenseVoice `:9211`；GPU3 = ComfyUI `:8196`（LB `:8188` / LongCat 桥 `:8197`）+ animate2 `:8199` + upscale `:8263` + demucs `:9220`。
- **单元名≠实际卡**：`comfyui-gpu0-alt` 实钉 GPU3；`toiv-comfyui-h3-gpu1` 实钉 GPU2——以 `systemctl show -p Environment` 的 `CUDA_VISIBLE_DEVICES` 为准。
- **BMC 带外**：`192.168.71.108`（Redfish，用户 `admin`；口令只在 Mac `~/toiv-ops-logs/bmc-cred-20261101.txt`，600）。主机无响应（ping 通但 SSH/业务全无）时：`POST /redfish/v1/Systems/Self/Actions/ComputerSystem.Reset {"ResetType":"ForceRestart"}`；先取 `X-Auth-Token`。
- **FlashVSR v1.1 挂载未生效**：`home-merlin-nas_mount-…-FlashVSR-v1.1.mount` 因单元名含 `.` 与 `Where=` 不匹配（开机报 "Where= setting doesn't match unit name"）；基线 `FlashVSR.mount` 正常。修法：挂载点改名去点（同步 ComfyUI 路径）或按 `systemd-escape` 规则重建单元名（`\x2e`）。
- **已退役（2026-11-01）**：ERP `drt-*` 13 容器/卷/镜像（备份 `/home/merlin/backups/drt-final-20261101/`）、frpc（指向已失联的 toiv.dgmt.top）、coturn、`comfyui-upscale-gpu2`。
