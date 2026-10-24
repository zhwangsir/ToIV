# AGENTS.md — 会话必读（短规则）

> **现行集群真源**：[`docs/ops/CLUSTER_TRUTH.md`](docs/ops/CLUSTER_TRUTH.md)（探针 as-of 见该文件；冲突以真机为准）。  
> **命名铁律**：一个磁盘权重一个 weight id；served 不得伪装异家族。知识图谱页 canvas `b21e123b-da5f-43d9-90af-a3842894cfcc`。  
> **最后更新**：2026-10-23 Asia/Shanghai · DOC_TRUTH_SWEEP（设备表迁 CLUSTER_TRUTH；删错误 spark/VLM/死端口叙述）。  
> **历史长文**：`.archive/AGENTS-full-20261014.md` 等；机读 `STATE.json`（只读）。

---

## 〇、硬性规则

1. **全部 AI/算力后端在 workstation**（`192.168.71.127` / TS `100.68.100.90`）。core 只跑 web/api/admin + PG/Redis。排查「引擎不可达」→ SSH workstation 查 systemd/端口，禁止臆断。
2. **文档仅供参考，必须真机验证**。GPU/端口/挂载以 SSH + `curl` 为准；与文档冲突先改文档（或改 CLUSTER_TRUTH）。
3. **冒测战役 PG running>0 时禁止重启 toiv-api**（留孤儿；P-18b）。
4. **禁止把密码/Token 写入 AGENTS、skills、commit**。密钥只在对应机 `deploy/.env` / `secrets/*` 读。
5. **LLM ≠ VLM**：LLM = spark02 `:8000`（DSv4）；VLM = workstation `:9311` `toiv-vlm`。spark01 **不是** API 入口（TP headless）。

## 〇b、本地开发与验证

**应用**：`apps/api`(:8090) · `apps/web`(:3100 `/studio`) · `apps/admin`(:3200) · `apps/canvas`（必读 `apps/canvas/AGENTS.md`）；移动端 `MiniProgram/`。  
Drama∥Studio：新功能只加 Studio；Drama bugfix only → `docs/ops/DRAMA_STUDIO_CONVERGENCE_GATE_20261022.md`。长文 `DEVELOPMENT.md`。暂存 `tmp/`（gitignore）。

```bash
cd apps/api && uv sync --extra dev && uv run pytest tests/test_foo.py::test_bar -q
cd apps/web && npm test && npm run typecheck    # node:test，不是 vitest
cd apps/admin && npm test && npm run typecheck
cd apps/canvas/backend && go vet ./... && go test ./...
cd apps/canvas/web && bun run lint && bun run typecheck && bun run build
```

- `apps/web`/`admin` 仅 **npm**；`apps/canvas/web` 仅 **bun**。新增 `lib/api` 导出必补 `tests/mocks/studioApi.ts`。
- 部署：`deploy/deploy.sh`；外出大流量用 `core-jump`。web/admin **在 core 本机构建**，勿从 Mac 盲推过期 `.next`。渲染在飞时脚本拒重启 api（`FORCE_API_RESTART=1` 强制）。

## 一、集群（摘要）

完整表、端口、权重、DOWN 口、SSH 偏好 → **`docs/ops/CLUSTER_TRUTH.md`**。

| 角色 | 主机 | 要点 |
|---|---|---|
| 运维本机 | MateBook | LAN **`.118`**（勿写 `.9`）；TS `100.74.15.34` |
| 网关 | core `.47` | web:3100 · api:8090 · admin:3200 |
| GPU | workstation `.127` | Comfy LB `:8188`→8196/8263/8265；H3 `:8264`；VLM `:9311`；TTS `:9200`；embed `:9302` |
| LLM | spark02 `.84:8000` | weight `dsv4-flash-dspark-abliterated`；canonical `deepseek-v4-flash-dspark`；**仍挂废弃别名** qwen*/glm*（待清） |
| LLM worker | spark01 `.82` | TP2 rank1；**:8000 无监听** |
| ASR | openclaw×4 `:9310` | whisper-mlx；JoyCaption `:9305` |
| 存储 | NAS `.7` | `toiv/comfyui-models` |

浏览器优先 LAN `http://192.168.71.47:3100`；公网 `https://toiv.wineryz.top` / `https://toiv.dgmt.top`。「TS 离线 ≠ 服务挂了」——先 LAN ping/端口。

## 二、凭据（无值）

| 需要 | 落点 |
|---|---|
| admin 登录 | core `deploy/.env` → `TOIV_ADMIN_EMAIL` / `TOIV_ADMIN_PASSWORD` |
| PG | 同上 `TOIV_DATABASE_URL`；或 `toiv-api` 进程 environ |
| JWT / 渠道 | 仅 `deploy/.env`（gitignore） |

轮换：`docs/ops/CREDENTIAL_HYGIENE_ROTATE_20261020.md`。

## 三、Workstation 服务（活口）

| 服务 | 端口 | 备注 |
|---|---|---|
| ComfyUI-LB | :8188 | backends **仅** 8196/8263/8265；只改 `/opt/comfyui-lb/backends.json` |
| 出图 / LongCat / Animate2 | :8196 / :8197 / :8199 | |
| **H3 生产** | **:8264** | `:8195` 已停；勿当默认 |
| VLM / Embed / TTS / Demucs | :9311 / :9302 / :9200 / :9220 | |
| 超分 / 扩容 | :8262 / :8263 / :8265 | `:8261` 已撤 |

**DOWN（勿配默认）**：`:8189` `:8195` `:8261` CosyVoice/Qwen3-TTS/ASR 旧口 `:9201–9211` 等——见 CLUSTER_TRUTH。

锁卡用 **GPU UUID**（H-6）。新专用 Comfy 实例必须补 `deps.resolve_worker()`（E-1）。

## 四、易错点（压缩；叙事见 .archive）

- **H**：禁臆造硬件；显存是快照；`:8189` 退役。  
- **N**：服务听 `0.0.0.0` 才经 TS；「TS 离线≠服务掉」先 LAN。  
- **E-3**：探测通 ≠ 链路可跑，须真机 e2e。**E-9**：专用实例分支须先验模型再 return。**E-4**：vLLM served 别名≠换了权重家族。  
- **P-2**：前端变更查 BUILD_ID。**P-18**：手跑 app.* 必须带 `TOIV_DATABASE_URL`。**P-18b**：孤儿看 `smoke_started_at`。**P-25**：舰队重启串行。

## 五、文档地图

| 要找 | 去哪 |
|---|---|
| 现行主机/端口/权重 | `docs/ops/CLUSTER_TRUTH.md` |
| 开发长文 | `DEVELOPMENT.md` |
| 测试记录 | `TEST_LOG.md` |
| 09-13 迁移考古 | `docs/SERVICE_INVENTORY.md`（已标过期） |
| 10-22 模型盘点快照 | `docs/ops/DEVICE_MODELS_IN_USE_20261022.md`（已标非现行） |
| 历史 wave/audit | `docs/ux/research/*`、`docs/_archive/`（横幅「历史快照」） |

## 六、未关闭运维开口（摘要）

- 生产 core `.env` LLM model/display 可能仍为旧别名（仓库 N1 已改默认，**未改生产**）。  
- spark `dsv4_60` 仍 serve qwen*/glm* 伪装别名（**清别名需重启，未做**）。  
- cloud/openclaw 部分 tailscaled 现场恢复；pc01 非紧急。
