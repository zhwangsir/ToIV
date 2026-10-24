> ⚠️ **历史快照 · 非现行事实**（DOC_TRUTH_SWEEP 2026-10-23 Asia/Shanghai）。
> 现行集群真源 → [`docs/ops/CLUSTER_TRUTH.md`](../../ops/CLUSTER_TRUTH.md)。命名铁律：一个权重一个 id；served 不得伪装异家族。

# AUDIT A — 本地算力舰队 / 模型生命周期 / 作业 hold / 混合云边界

> 日期：2026-10-22（Asia/Shanghai）  
> 执行者：全栈审计 A 路  
> tip：`work/p0-fusion-20261016` @ `e5307c63`  
> 纪律：只读调研；禁止业务编码 / commit / push / 部署 / 真机重启服务。  
> 真源优先级：AGENTS.md（2026-10-15 现网）＞ tip 代码 ＞ `docs/SERVICE_INVENTORY.md`（2026-09-13 历史，端口勿盲抄）。

---

## 1. 范围与方法

### 1.1 本路范围

| 主题 | 覆盖 |
|------|------|
| 本地算力舰队 | `fleet.py` / `fleet_registry.py` / `routes/fleet.py` / Admin Observability |
| 模型生命周期 | `nas_models.py` / `nas.py` / `MODEL_SOURCES*` / `NAS_MODEL_PICKER*` |
| 作业排队 hold | `hold_queue.py` / `resource_budget.py` |
| Comfy 池 | `comfy/pool.py` / `comfy/client.py` / LB `:8188` |
| IndexTTS / VLM / Spark / openclaw ASR | config 默认 + AGENTS 现网 + studio/voice |
| 混合云边界 | 本地优先事实；RunningHub=市场工作流来源≠算力回落 |
| 端口漂移 | registry / config 默认 / `.env.example` / tests vs AGENTS |

### 1.2 方法

1. 通读 AGENTS.md §〇–§五、能力地图 `TOIV_LOCAL_AI_CAPABILITY_MAP_20261022.md` §0–§1。  
2. 对照 tip 代码：`apps/api/app/services/{fleet,fleet_registry,hold_queue,resource_budget,h3,service_orchestrator}.py`、`comfy/pool.py`、`routes/{fleet,nas_models}.py`、`nas.py`、`config.py`。  
3. 对照文档：`SERVICE_INVENTORY.md`（历史）、`NAS_MODEL_PICKER.md`、`MODEL_SOURCES.md` 头、`.env.example`、`tests/test_fleet.py`。  
4. 判定：KEEP / OPTIMIZE / REPLACE（REPLACE 必须给替代方向）。  
5. **本路未 SSH 真机 nvidia-smi**（任务禁止重启服务；端口以 AGENTS 2026-10-15 活口径为准，并在报告中标「文档/代码漂移」）。

### 1.3 现网要点（交叉验证输入，非本轮新测）

| 项 | 口径 |
|----|------|
| 算力 | 全在 workstation（192.168.71.127）；core 非算力 |
| H3 生产 | **:8264**（GPU1）；**:8195 stop+disable**（10-15） |
| IndexTTS | **:9200** GPU0，配音主路，勿停 |
| ComfyUI-LB | :8188；池=:8196+:8263+:8265（10-15 扩） |
| VLM | workstation :9311（Qwen3-VL） |
| Spark LLM | spark02 :8000 DSv4 |
| openclaw ASR | :9310×4 故障转移；02–04/cloud tailscaled 开口项 |

---

## 2. 组件清单表

| 组件 | 现状证据路径 | 判定 | 理由 | 风险 | 建议下一步 |
|------|-------------|------|------|------|-----------|
| **架构原则：算力在 WS / core 网关** | AGENTS.md §〇.1；fleet_registry core role | **KEEP** | 学习站本地优先正确；排查路径清晰 | 文档/默认端口漂移会让助手误判「引擎离线」 | 继续强制「先查 WS」；新服务只改 registry+AGENTS |
| **fleet 探测引擎** | `services/fleet.py`（15s 缓存、comfy VRAM/queue、vllm models、环形时序） | **KEEP** | 探测语义成熟；离线降级不炸 | Admin 可见、创作者不可见水位 | 产品面做 L1「忙闲」只读摘要（不暴露裸端口） |
| **fleet_registry 静态表** | `services/fleet_registry.py` L53–79 仍列 H3:**8195**、CosyVoice×3、OpenTalking:4403、超分:8261 等 | **OPTIMIZE（强）** | 与 AGENTS 10-15 冲突；Admin 舰队卡片会「假 down / 假服务」污染分母 | 运维误判；测试锁死旧端口 | 按 AGENTS 重写 workstation.services：H3→8264；加 8265/9311；摘已退役；同步改 `tests/test_fleet.py` L61–63 |
| **fleet 单测锁死旧口** | `tests/test_fleet.py` `test_registry_workstation_services_match_fleet` 断言含 8195、9201–9203、4403，**不含 8264/8265/9311** | **OPTIMIZE** | 单测把漂移固化为「绿」 | 以后改 registry 必先改测，否则「修注册表」被 CI 打回 | 与 registry 同批改断言；补「禁 8195 生产口」负向断言可选 |
| **routes/fleet + Admin Observability** | `routes/fleet.py` admin-only；`apps/admin/.../ObservabilityView.tsx`；web 有 `fetchFleet` API 封装 | **KEEP** 运维面；创作者面 **OPTIMIZE** | 运维深潜够用；学习站创作者无「排队/hold」人话 | 用户遇 503/held 不知何时放行 | 对齐 COMPETITIVE L1/L5：创作台只读忙闲+hold 文案，藏端口 |
| **resource_budget** | `services/resource_budget.py` RAM/VRAM 预检、空闲才 /free、失败降级放行 | **KEEP** | 直接回应 2026-08-21 OOM 事故；与 hold 衔接正确 | 读 stats 失败→放行可能再次 OOM | 保持；阈值调参走 env，勿产品化裸 GiB 给学员 |
| **hold_queue** | `services/hold_queue.py` held 入库、FIFO、单轮上限、超时 error、软删暂停 | **KEEP** 机制；**OPTIMIZE** 创作者 UX | 二期设计完整；Admin Jobs 有「等待资源」 | web 创作路径对 held/hold_reason 曝光不足 | P1/P2：状态中文化 + 预计等待/取消路径（已有 DELETE 软删） |
| **Comfy WorkerPool** | `comfy/pool.py` 熔断(5/30s)、Redis 健康共享、LB registry 60s 跟随、缺模明细 | **KEEP** | 生产级；曾修「繁忙假熔断」 | AGENTS P-25：api 池=core env 直连**可不经 LB**；排水 backends.json 对 api 无效 | 文档写清：池成员来源=TOIV_COMFY_WORKERS±registry；运维排水要改 env 或等 TTL |
| **config.comfy_workers 默认 :8189** | `config.py` L15 `http://192.168.71.127:8189`；AGENTS H-7 :8189 已退役 | **OPTIMIZE** | 默认值历史遗留；生产依赖 .env 覆盖 | 新环境/缺 env 直打退役口 | `.env.example`+默认改为 :8188 或 :8196 池口径；注释写清「禁止默认 8189」 |
| **H3 专用实例路径** | `services/h3.py`；config `h3_base_url` 默认 **:8195**；白名单含 TS :8195 与 **:8264**；`.env.example`/`deploy/.env.example` 仍写 8195 | **OPTIMIZE（强）→ 近 REPLACE 默认值** | 机制 KEEP（独立于池、VRAM/RAM 预检、hold）；**默认与文档指向已 disable 口** | 未覆盖 env 的部署/本地 dogfood 打到死人；与 AGENTS「H3=:8264」矛盾 | **替代方向**：默认与 example 一律 `TOIV_H3_BASE_URL=...:8264`；注释删「生产=8195」；保留 8195 仅作历史 note；确认生产 .env 已是 8264（只读核对，本轮不 SSH 改） |
| **engine_registry / 文案中的 :8195** | `engine_registry.py` 多处 description「专用实例 :8195」；`nas.py` 注释 h3 worker :8195 | **OPTIMIZE** | 不影响路由若 env 正确，但误导助手与学员 | 文档传染 | 批量改文案→8264；盘点脚本可选 |
| **worker_warmup 允许口** | `worker_warmup.py` `_ALLOWED={8195,8262,8264}` 禁 8196 | **KEEP** 策略；**OPTIMIZE** 注释 | 已含 8264；仍允许 8195 作空闲预热目标 | 若 8195 disable，探活失败属预期 | 注释标明 8195=legacy 可空；预热优先 8264 |
| **IndexTTS :9200** | config `tts_url` 默认正确；`studio/voice.py` POST `/tts`；fleet 已注册；AGENTS「勿再停」 | **KEEP** | 配音主路齐全 | GPU0 与出图争卡；并发默认 2 | 产品阶段轨给「配音」位（L3）；运维禁停；可选忙闲进 L1 |
| **Demucs audio-sep :9220** | config `audio_sep_url` 默认空；fleet 有 demucs；AGENTS 常驻 | **OPTIMIZE** | 能力在 WS；默认空=跳过分离 | 克隆音色脏参考 | 生产 env 核对是否已填；空态产品说明 |
| **VLM 默认漂移** | AGENTS VLM=:9311；config `vlm_server_url` 默认 `:8000`（注释写须 .env）；`reverse_vlm_base_url` 默认 `:9303` | **OPTIMIZE** | 生产靠 .env；仓库默认危险 | 新部署/测试误打 Spark 当 VLM | 默认改为 `http://192.168.71.127:9311`（或空+强制 env）；文档对齐 |
| **Spark LLM :8000** | config llm_* → spark02；别名四名；fleet spark02 vLLM probe | **KEEP** | 本地 LLM 主路清晰；别名换模零改 core | spark restart=no；冷启动长 | 产品降级态：LLM 不可达禁用「剧本/Agent」CTA（L5） |
| **openclaw whisper :9310×4** | fleet_registry openclaw01–04；config `whisper_url` 多址故障转移；AGENTS 开口：02–04 tailscaled | **KEEP** 设计；**OPTIMIZE** 运维开口 | 集群化正确；探针走 LAN（N-5） | TS 僵死≠服务掉（已文档）；现场恢复开口 | 不换架构；现场恢复 tailscaled；SenseVoice 接 nas picker 仍开口 |
| **NAS 模型库双树** | AGENTS §四：主库 `toiv/comfyui-models`≈5.2T；旧树 Windows/...≈1.5T | **KEEP** 拓扑 | 主路正确 | `config.nas_model_root` 默认仍指向**旧树** Windows 路径 | **OPTIMIZE**：默认/注释标明主下载进 toiv/；旧树只读兼容；NAS_MODEL_PICKER 已按用途挂口 |
| **nas.py SFTP + nas_models 管理下载** | `nas.py`；`routes/nas_models.py` admin 任意 URL/HF→SFTP；MODEL_SOURCES 账本 | **KEEP** 运维能力；创作者 **OPTIMIZE** | 绕过 Manager 白名单必要 | 仅管理员；学员无「缺模引导下载」 | 对标 RunningHub Copilot：对话/空态引导，不把装模塞进添加菜单 |
| **NAS_MODEL_PICKER** | `docs/NAS_MODEL_PICKER.md` 已写 H3→**:8264**、禁默认 8195 | **KEEP** | 与 AGENTS 一致的选模配置页 | canvas-only 部署缺 env 则列表空 | 部署检查清单已有；保持 |
| **MODEL_SOURCES 账本** | `docs/MODEL_SOURCES.md` ok487/blocked337；AGENTS 持续追加开口 | **KEEP** | 运维溯源强 | 体积大、非产品面 | 继续运维批；不进短剧默认壳 |
| **ComfyUI-LB backends.json** | AGENTS：只改 WS `/opt/comfyui-lb/backends.json`；池 8196+8263+8265 | **KEEP** | 热重载正确 | 与 api 直连池双轨易混淆 | 运维 runbook 一句「LB≠api 池」 |
| **service_orchestrator 冷层** | `service_orchestrator.py` 默认 i2l/trainer/lipsync/hy3dtex；safe_idle 默认 false | **KEEP** | 热层（H3/LLM/VLM/TTS）常驻不动，符合短剧主路 | lipsync 在冷层：短剧口型若依赖需唤醒 | 确认短剧 lipsync 走 pad 路径还是 :9103；产品空态写清 |
| **混合云边界** | 生成链路本地 WS/Spark/openclaw；RunningHub=应用市场图/shim 来源（`routes/apps.py` 等），非云算力回落 | **KEEP** 本地优先；**OPTIMIZE** 产品边界文案 | 「本地平台」名副其实 | 用户可能误以为市场卡会调 RH 云推理 | L5：设置页写「算力=本集群；市场图=本地 Comfy 执行」；不做默认云回落除非另拍板 |
| **qwen_edit / infinitetalk / pc02 默认** | config 仍有 pc02 :8194、infinitetalk :8201 等 | **OPTIMIZE** | 退役机/下架服务残留默认 | 探测失败噪声 | 默认空或标注 retired；opentalking 已 false |
| **SERVICE_INVENTORY.md** | 2026-09-13；H3=:8195、LB 2 后端等 | **OPTIMIZE（文档）** | 迁移历史有价值 | **盲抄端口是本路最大外部风险** | 文首加大「过期/以 AGENTS 为准」横幅；或迁 `.archive/` 并留指针 |
| **sysmetrics :9403** | fleet SYSMETRICS_URL；headline VRAM/RAM/NAS | **KEEP** | 舰队 headline 依赖 | 不可达则 sys=null | 保持；创作者摘要可复用聚合字段不暴露 URL |

---

## 3. 明确 REPLACE 候选

### 3.1 本路「强 REPLACE」（范式/默认错误，须换指向）

| 项 | 为何算 REPLACE 候选 | 替代方向（勿空喊） |
|----|---------------------|-------------------|
| **H3 默认基址 :8195（config + .env.example + 部分文案）** | 生产口已迁 :8264 且 :8195 disable；默认值指向死人服务 | 仓库默认与 example **整体替换为 :8264**；保留白名单可含 legacy 仅管理员覆盖；单测夹具可继续用假 :8195 URL，但生产示例禁止 |
| **fleet_registry workstation 服务清单（作为「现网真相」）** | 仍把已退役/已迁服务当现网；与 AGENTS 对立 | **替换注册表内容**为 AGENTS §三 常驻表（不是换掉探测引擎）；测试断言同步替换 |

> 说明：Comfy 池 / hold / IndexTTS / Spark **不建议 REPLACE**——机制正确，问题在契约与默认值漂移。

### 3.2 本路无强替换

- WorkerPool 熔断+LB 跟随  
- hold_queue FIFO  
- IndexTTS 主路  
- Spark 别名机制  
- NAS 双树物理拓扑  
- openclaw 多址 ASR  

---

## 4. 与竞品可对照的 3–5 点

（对照既有 `COMPETITIVE_RESEARCH_AND_UX_PLAN_20261022.md` §12 / 能力地图 §1）

1. **LocalMiniDrama**：素材本地、算力/API 边界写清 → ToIV 算力已本地，缺的是**产品面三态降级（WS/TTS/H3）**，不是再接一套云 GPU。  
2. **LumenX Studio vs Playground**：重算力不进默认壳 → ToIV Admin 舰队深潜 KEEP；勿把 :8264/:9200 挂进短剧「添加菜单」。  
3. **RunningHub Copilot**：缺模在对话引导下载 → ToIV 仅有 admin `nas_models`；学习站应做「缺模→运维/Agent 引导」，非学员裸 SFTP。  
4. **高完成率短剧台（火宝/Jellyfish 等）**：首页压阶段/就绪，不压集群拓扑 → 舰队 KEEP 在 Admin；创作台只要 hold/排队人话。  
5. **自建 Comfy 农场常见坑**：注册表与真实 systemd 漂移 → ToIV 已中招（registry/tests/:8195）；应用「单一现网真源=AGENTS + 定期 registry 对账脚本」（只读对账即可）。

---

## 5. 给父会话的 10 行摘要

1. **A 路结论**：本地舰队/hold/池/TTS/Spark **机制厚且应 KEEP**；主要债是 **端口与默认值漂移**，不是缺算力栈。  
2. **最危险漂移**：H3 仓库默认/`.env.example`/fleet_registry/engine 文案仍大量 **:8195**，现网生产是 **:8264**（:8195 已 disable）。  
3. **fleet_registry + test_fleet** 锁死旧服务集（含 CosyVoice/OpenTalking/8261），Admin 在线率分母失真 → **OPTIMIZE/内容 REPLACE**。  
4. **hold_queue + resource_budget** KEEP；缺创作者「资源排队中」闭环 UX（Admin 已有）。  
5. **WorkerPool** KEEP；注意 api 池可不经 LB（P-25），排水策略勿只改 backends.json。  
6. **IndexTTS:9200** KEEP，勿停；声画进阶段轨是产品事非基建替换。  
7. **VLM/comfy 默认**（:8000/:8189/:9303）靠 .env 续命 → 仓库默认应 OPTIMIZE 对齐 AGENTS。  
8. **混合云**：无云算力回落产品路径；RH=市场图来源；保持本地优先，补边界文案即可。  
9. **NAS**：物理双树 KEEP；`nas_model_root` 默认旧树路径 → OPTIMIZE 指向/注释主库 toiv/。  
10. **建议拍板顺序（仍不编码）**：①核对生产 env H3/VLM/COMFY；②改 registry+测试+example 默认；③L1/L5 创作者只读忙闲；④SERVICE_INVENTORY 过期横幅。

---

## 附录 A — 端口漂移速查（代码/文档 vs AGENTS）

| 服务 | AGENTS 现网 | tip 默认/注册表常见值 | 备注 |
|------|------------|----------------------|------|
| H3 | **8264** | 8195（config/example/registry/engine 文案） | 白名单已含 8264 |
| H3 legacy | 8195 disable | 仍大量出现 | stop≠应作默认 |
| Comfy 通用 | 8196（LB 池成员） | comfy_workers 默认 8189 | 8189 退役 |
| LB | 8188 | registry 可选跟随 | 池扩含 8263/8265 |
| 通用 worker#3 | 8265 | registry **缺失** | 应补 |
| VLM | 9311 | vlm 默认 8000；reverse 9303 | 须 .env |
| IndexTTS | 9200 | 9200 ✓ | KEEP |
| Embedding | 9302 | registry ✓ | |
| Spark LLM | spark02:8000 | config ✓ | |
| whisper | openclaw:9310 | registry ✓；config 默认空 | 生产填多址 |
| OpenTalking | 下架 | registry 仍 4403 | 应摘 |

## 附录 B — KEEP / OPTIMIZE / REPLACE 计数

| 判定 | 约计数（上表行） | 说明 |
|------|------------------|------|
| KEEP | **14** | 架构、探测引擎、budget、hold 机制、池、TTS、Spark、ASR 设计、NAS 拓扑、LB、orch、混合云本地优先、warmup 策略、sysmetrics、MODEL_SOURCES |
| OPTIMIZE | **16** | registry、单测、创作者 UX、comfy/H3/VLM 默认、文案、NAS 默认根、audio_sep、冷层口型澄清、RH 边界文案、inventory 横幅等 |
| REPLACE（默认/注册表内容） | **2** | H3 默认基址指向；fleet_registry workstation 清单作为现网真源 |

*计数按上表语义归并，非严格一行一票；父会话以「2 个强替换候选 + 其余优化」理解即可。*

## 附录 C — 修订记录

| 时间 (Asia/Shanghai) | 说明 |
|----------------------|------|
| 2026-10-22 00:46 | A 路初版：基于 tip e5307c63 + AGENTS 10-15；未真机重启/未改业务码 |
