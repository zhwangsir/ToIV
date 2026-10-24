> ⚠️ **历史快照 · 非现行事实**（DOC_TRUTH_SWEEP 2026-10-23 Asia/Shanghai）。
> 现行集群真源 → [`docs/ops/CLUSTER_TRUTH.md`](../../ops/CLUSTER_TRUTH.md)。命名铁律：一个权重一个 id；served 不得伪装异家族。

# ToIV 本地 AI 能力地图（基于本机 tip 实况）

> 日期：2026-10-22（Asia/Shanghai）  
> 分支：`work/p0-fusion-20261016` tip `e5307c63`  
> 纪律：事实优先；文档与 tip 冲突以 tip 代码 + AGENTS.md(2026-10-15) 现网口径为准；9 月 `SERVICE_INVENTORY` 仅作历史参考，不盲抄端口。  
> 范围：对齐「本地 AI 底层驱动的短剧台」10 维缺口；禁止业务编码 / commit / push。

---

## 0. 工程与集群速览（接棒必读）

### 0.1 四应用

| 应用 | 路径 | 角色 |
|------|------|------|
| api | `apps/api` FastAPI :8090 | 业务网关：Studio/Drama/Jobs/Agent/市场/舰队 |
| web | `apps/web` Next.js :3100 | 登录后 `/studio` 创作壳（含短剧工作流 UI） |
| admin | `apps/admin` :3200 | 作业队列、模型资产、收尾矩阵 |
| canvas | `apps/canvas` Go+Vite | 融合主 UI / R18 门控目标（D-U1=B） |

融合源：`third_party/{dramaclaw,toonflow,hypit,video-use}`（许可表必守；hypit 单租户；dramaclaw Elastic）。

### 0.2 集群角色（AGENTS.md 2026-10-15）

- **算力全在 workstation**（192.168.71.127）：4× RTX PRO 6000 96GB + ~183G RAM。  
- **core** = 业务网关（api/web/admin + PG18 + Redis），不是算力。  
- **NAS** `toiv/comfyui-models` ≈5.2T；core `/mnt/toiv-nas`，WS `/home/merlin/nas_mount`。  
- **Spark** DSv4 LLM :8000（spark02）；**openclaw** Whisper/JoyCaption；MateBook 仅操作终端。

### 0.3 现网关键端口（勿用 9 月旧表覆盖）

| 服务 | 端口 | 卡/备注 |
|------|------|---------|
| ComfyUI-LB | :8188 | 池=:8196+:8263+:8265（10-15 扩） |
| gpu0-alt 出图 | :8196 | GPU0 |
| LongCat/Wan 等 | :8197 | GPU0 |
| **H3 生产** | **:8264** | GPU1；`:8195` 已 stop+disable |
| 通用 worker#3 | :8265 | GPU2 |
| 超分 | :8262/:8263 | :8263 在 LB 池 |
| **IndexTTS 2.5** | **:9200** | GPU0，配音主路，勿停 |
| 音频分离 | :9220 | |
| VLM Qwen3-VL | :9311 | GPU3 |
| Embedding | :9302 | GPU1 |
| Spark LLM | :8000 | spark02 |

### 0.4 产品主线（`docs/AI短剧产品方案.md` 2026-10-08）

一句话 → 分镜 → 角色设定卡定妆 → 视频（逐镜 Ref2VA）→ 配音 → pad 对口型 → 成片。  
用户拍板默认=逐镜独立短视频 + 首尾帧拼接；`c`/`c_hybrid` 为显式可选。

**文档 vs tip 校正（关键）：**  
产品方案 §8 #1（2026-10-08）仍写「`render_shot` 默认仍是 `c`，Ref2VA 切换尚未做」。  
**tip 代码已切**：`apps/api/app/services/studio/pipelines.py` → `DEFAULT_VIDEO_PIPELINE = "ref2va"`；`orchestrator.py` / `renderers/video.py` 消费该默认；`tests/test_ref2va_indep_pipeline.py` 断言无 body 默认 ref2va、显式 `c` 才续写。  
→ **这是文档滞后，不是 tip 代码债**。仍须：生产部署是否已含该 tip、UI 是否暴露管线选择、真机一镜验收。  
另：`seam_to_next=continue` 时未显式指定管线会自动改走 `c`（W2.5 机位树 lite）。

### 0.5 Studio 状态机（代码）

`draft → queued → rendering → rendered → voiced → (lipsynced) → done`  
（`orchestrator.py` 头注释；失败可标 `error`，有入选媒体时重试保留）。

---

## 1. 本地算力与模型生命周期

### 文档已有
- `AGENTS.md` §三–§四：舰队端口、GPU UUID 锁卡、NAS 双树、H3=:8264。  
- `docs/NAS_MODEL_PICKER.md` + `NAS_MODEL_PICKER.json`：按用途挂 :8196/:8197/:8264/:8199。  
- `docs/MODEL_SOURCES.md/.json`：下载清单（运维向）。  
- `docs/SERVICE_INVENTORY.md`（2026-09-13）：全量迁移清单——**端口有漂移，交叉时以 AGENTS 为准**。

### 代码证据
- `apps/api/app/services/resource_budget.py`：提交前 RAM/VRAM 预检。  
- `apps/api/app/services/hold_queue.py`：预算不足 → `held` 排队 → 自动放行 / 超时 error。  
- `apps/api/app/services/fleet.py` + `fleet_registry.py`：舰队快照（含 IndexTTS:9200）。  
- `apps/api/app/comfy/pool.py`：queue_len 健康探测、选工人。  
- `apps/api/app/routes/nas_models.py`：管理员任意 URL/HF → NAS 落模。  
- `apps/api/app/nas.py`：SFTP 模型库。  
- 测试：`test_comfy_queue_singleflight.py`、`test_engine_plugins.py`。

### 现网服务
Workstation 常驻 Comfy 多实例 + IndexTTS + VLM + Demucs；模型读 NAS；core 不跑 GPU。

### UX 方案缺口
既有 COMPETITIVE 方案把「本地·H3/Wan」从添加菜单拿掉是对的，但**未规格化**：  
装模/换模用户面、VRAM 预估可见、忙闲与 hold 等待文案、休眠/断电后续跑、离线可用性。  
Admin 有模型资产域（U9），创作台用户几乎看不见舰队水位。

### 竞品可抄
- LocalMiniDrama：素材本地、算力/API 可选云，边界写清。  
- LumenX Studio vs Playground：重算力能力不进默认壳。  
- RunningHub Copilot：缺模在对话里引导下载（ToIV 仅有运维 `nas_models`）。

### 现状→缺口（摘要）
**有**完整本地舰队 + 预算 hold + NAS 选模配置；**缺**面向创作者的模型生命周期 UX 与离线契约。学习站「推荐组合（小显存/大显存）」未产品化。

---

## 2. AI 导演 / Agent 编排契约

### 文档已有
- `docs/AGENT_PEER_RESEARCH_20260923.md`：对话=智能体；对标 LibTV/MiniMax/Copilot/Krea。  
- `docs/ops/DRAMA_UI_PLAN.md`：短剧阶段轨为人走；Agent 为辅。  
- runner 原则 20：虚拟剧组六角色（导演/编剧/分镜师/画师/剪辑配乐/质检）。

### 代码证据
- `apps/api/app/agent/runner.py`：系统原则 + 工具循环；禁止默认 `navigate_view`。  
- `apps/api/app/agent/tools_drama.py` / `tools_studio.py` / `tools_gen.py`：分镜、成片、run_app。  
- `apps/api/app/services/agent_team_graph.py`：LangGraph StateGraph；`assembly_gate` **interrupt 人闸**；Postgres checkpoint 断点续跑。  
- `apps/api/app/services/agent_team_exec.py`：任务执行（含 `synth_for_shot`）。  
- `apps/api/app/services/drama_pipeline.py`：七阶段状态由 DB+产物重算，`next_step` 断点续跑。

### 现网服务
LLM 走 Spark DSv4（无审查别名）；Agent 作业落 PG；长任务 SSE/轮询已有（UX 路线图 U1–U4 多项已勾）。

### UX 方案缺口
推荐包 D1-A 偏「人跟着阶段轨」；P4 才提 Agent 一键成片。  
**代码侧 Agent Team + 六角色已存在**，但默认产品入口仍非「AI 导演驱动」——契约未写清：谁推进阶段、人闸放哪几步（定妆选角 / 镜过门禁 / 合成确认）。

### 竞品可抄
- Jellyfish：人确认闸。  
- 融光 / wind / ArcReel：多 Agent 流水线。  
- LibTV：会话即生产线，用户侧只传话+轮询。  
- MiniMax Design：关键节点人工审核。

### 现状→缺口
**有**工具齐全的对话 Agent + 可断点 Agent Team + 合成人闸；**缺**产品级「导演契约」与阶段轨的默认咬合（何时自动推进 vs 必须人点）。

---

## 3. 声画一体（TTS / 配音 / 口型 / BGM）

### 文档已有
- 产品方案 §4：voice → lipsync（pad 防截断）；雨夜可叠环境声床。  
- INTENT 计划积压「c 配音 TTS」（偏门户意图芯片/体验，非「无 TTS 服务」）。  
- AGENTS：IndexTTS :9200 配音主路勿停；大量 legacy ASR/TTS/lipsync unit 已 disable。

### 代码证据
- `studio/voice.py`：IndexTTS2 + 角色 `voice_ref_url` 克隆；默认 `tts_url=http://192.168.71.127:9200`。  
- `studio/lipsync.py`：pad 到视频时长 → LatentSync（`lipsync_url` agent :9103 **或** Comfy 构图）；状态 `voiced→lipsynced`。  
- `studio/assemble.py`：规格不一致时重编码归一再 concat（防哑音活雷）。  
- `board_film.py`：voices 阶段 Semaphore=1（IndexTTS 单卡串行）。  
- `routes/dub_voice.py` / `drama_studio.py` generate-voice。  
- 配置：`lipsync_url` **默认空串**——未配则走 Comfy LatentSync 路径；现网 agent 是否常驻须真机复核（勿盲信 9 月「lipsync unit disable」=产品无对口型）。

### 现网服务
IndexTTS :9200 LIVE；音频分离 :9220；Whisper 在 openclaw。BGM/声床偏样片脚本级，非一等产品步。

### UX 方案缺口
P1–P3 几乎只谈壳与图/视频节点；**声画步未进改造路径**。阶段轨若只到「生成→合成」会漏配音/口型。

### 竞品可抄
火宝/printfilm/ai_story 等成片路径含对白轨；BigBanana 衣橱+声线绑定可参考「角色音色=资产」。

### 现状→缺口
**有** IndexTTS 主路 + pad lipsync + 稳健 assemble；**缺** UI 阶段显式声画步、BGM/环境声产品化、lipsync 现网路径稳定性说明、INTENT c 体验收口。

---

## 4. 一致性与可控生成

### 文档已有
- 产品方案：定妆 front/side/full；Ref2VA 4 张参考；`reference_images_by_style` 分桶；人脸门禁 `face_mean≥0.45`。  
- `CHARACTER_ASSET_GUIDE.md`：L1 面板 / L2 JSON 锚点 / L3 参考；identity_anchors；coverage-plan；M3 LoRA 后置。

### 代码证据
- `studio/character_sheet/*`、`character_asset.py`：设定卡 + 资产 API。  
- `studio/shot_refs.py`：按风格收集参考、场景锚点（P4 dramaclaw）。  
- `studio/candidate_pick.py`：insightface / CLIP；禁止静默回落首候选。  
- `studio/qa_gate.py`：VLM 四问（人物/服装/场景/健康）；失败不自动删片。  
- `studio/scene_gate.py`、`outfit_state.py`、`keyframe_chain.py`。  
- 默认管线 ref2va 强制要参考，无定妆参考报错不静默。

### 现网服务
H3 Ref2VA @ :8264；出图 :8196；VLM :9311 供 QA。

### UX 方案缺口
方案仅 P4「关键帧」点到；未把「定妆选角 → 锁参考 → 跨镜门禁」写成默认闭环原则。

### 竞品可抄
BigBanana 定妆/衣橱/三重一致性；LocalMiniDrama 同源投影保上下文；Jellyfish 人审闸。

### 现状→缺口
**有**业界少见的厚一致性栈（设定卡+资产锚点+人脸门+VLM QA+Ref2VA）；**缺**默认 UX 强制走完定妆选角、失败时「改提示禁止原样重抽」的产品化提示。

---

## 5. 质量闭环与失败语义

### 文档已有
- 产品方案 §2/§6：选优失败标红；未配音对口型 422。  
- HARDBLOCKED / 公开应用烟测：运维向失败归因极厚。  
- UX 路线图 U1：失败自愈用户可见卡（已勾）。

### 代码证据
- `candidate_pick.CandidatePickError`、`qa_gate`、`sheet` gates、`selfheal_*`。  
- `jobs_persist` / `comfy/tracker.py`：断线回写、孤儿检测。  
- `hold_queue`：资源类失败变等待而非硬 503。  
- `quality/*`：slideshow_risk、transition_chain、variation_checker 等。  
- `routes` 侧 `sheet_gate_failure_ux`（命名线索，失败文案层）。

### 现网服务
video scorer 开关 `TOIV_VIDEO_SCORER_ENABLED`；VLM QA 可选 skip。

### UX 方案缺口
有「失败码意向」，缺：废片库、同参 vs 改参重试策略外显、质检闸在阶段轨的位置、本地 GPU 空转防护文案。

### 竞品可抄
Copilot Debug 环；Jellyfish 审核节点；火宝级「标红可重跑」。

### 现状→缺口
**有**强门禁与运维自愈；**缺**创作者可读的统一失败语义表 + 阶段轨上的质检/重试 UX。

---

## 6. 本地资产与作业系统

### 文档已有
- `drama_output_root` / NAS 产物；CHARACTER 资产落盘路径。  
- DRAMA_UI_PLAN：`POST /api/studio/sample-projects/rain-night` 幂等种子。

### 代码证据
- `storage.drama_output_root()`；studio 文件 `/api/studio/files/`。  
- `drama_pipeline.compute_*`：产物存在性 + Job 归属 → next_step（断点=从首个缺失阶段继续）。  
- `hold_queue` + `job_phase` + Admin JobsQueue。  
- `assemble` / `render_reconcile`：入选片保留、重试不覆盖 voiced。

### 现网服务
产物优先 NAS；PG 作业真相；战役 running>0 禁重启 api（P-18b）。

### UX 方案缺口
任务中心「只追踪+回跳」已在 UX P1；缺磁盘水位、取消/恢复、作业跑在哪台 worker 的用户可见性。

### 竞品可抄
LMD 本地工程目录透明；Openframe 导出包即资产边界。

### 现状→缺口
**有**幂等管线重算 + hold + 样本项目种子；**缺**学习站级「作业/存储说明书」与用户面取消恢复。

---

## 7. 本地优先混合云边界

### 文档已有
- AGENTS：算力本地；域名双入口仅是入口。  
- 市场大量 RH 导入应用 → 实际跑本地 Comfy（shim/归一）。  
- 无「纯离线模式」产品说明。

### 代码证据
- 生成默认打本地 worker pool；LLM 指局域网 Spark。  
- `web_search` 依赖 Mac 代理（半在线）。  
- HF 下载主路 hf-mirror（运维）。  
- 画布协议 `toiv-comfy-*` / `toiv-h3` 均本地端口。

### 现网服务
无云 GPU 计费层；密钥在 core `deploy/.env`。外网断 ≠ 局域网创作断（N-5），但 Spark/NAS/WS 任一挂则降级路径未产品化。

### UX 方案缺口
方案未写：哪些步骤必须 WS 在线、无 IndexTTS 时能否只出无声片、无 H3 时是否禁用短剧视频步。

### 竞品可抄
LocalMiniDrama「素材本地 / API 可云」开关文案；开源短剧台常把云 API Key 放设置页并默认本地。

### 现状→缺口
**有**事实本地优先架构；**缺**用户可读的混合云/降级边界与设置页成本/密钥可见性（学习站需要）。

---

## 8. 叙事 / 编剧 AI + R18 衔接

### 文档已有
- 产品方案：台词不进画面提示；负向禁烧录字幕。  
- `r18_policy.py`：D-U1=B，canvas 唯一主 UI + `X-NSFW`；未成年硬阻断；fail-closed。  
- hypit SVML 并码（单租户许可）；DramaScene / import-svml。

### 代码证据
- Agent：`breakdown_script`、剧组编剧角色、`tools_drama`。  
- Studio storyboard / prompt_c；board_storyboard。  
- NSFW：`nsfw_ctx`、canvas R18SettingsPane（STATE fu1）。  
- Spark 无审查模型别名服务剧本/助手。

### 现网服务
DSv4 LIVE；web 独立 `/nsfw` 退役中（F12 残债）。

### UX 方案缺口
阶段「剧本」有，缺改写强度/分集节奏/尺度策略与 R18 引擎台如何接到短剧主链（避免两套世界观）。

### 竞品可抄
hypit/SVML 词锚分镜；drama-skills / shuohao-skills 提示词包；风控产品化（非仅请求头）。

### 现状→缺口
**有**强 LLM + SVML/分镜工具 + R18 政策代码；**缺**短剧主路径上的编剧参数面与 R18 资产隔离说明。

---

## 9. 学习站脚手架

### 文档已有
- 雨夜样片结项（产品方案 §7）；`sample-projects/rain-night`。  
- `DOGFOOD_CI_SLICE_20261019.md`：CI mock 全链；真机 H3/TTS/ffmpeg 不进 CI。  
- MODEL_SOURCES / NAS_PICKER：运维向，非学员向。  
- DEVELOPMENT / AGENTS：开发者上手，非创作者教程。

### 代码证据
- `seed_rain_night_sample`；dogfood_ci 测试。  
- e2e `authed-drama-workbench` 等。  
- 推荐模型组合 UI：未见一等入口（默认写在 NAS_PICKER / gate template）。

### 现网服务
生产可种雨夜样本；真机 nightly dogfood 仍依赖运维窗口。

### UX 方案缺口
竞品矩阵厚、**教学脚手架薄**：示例短剧、小/大显存推荐组合、「做对一次」对照剧本、真机 nightly 状态对学员不可见。

### 竞品可抄
各开源短剧 README 的「5 分钟出片」；LumenX 文档分层 Studio/Playground。

### 现状→缺口
**有**雨夜种子 + dogfood_ci；**缺**学习站包装（推荐组合、对照剧本、进度成就/KPI 可见）。

---

## 10. 成功度量 / KPI

### 文档已有
- UX 方案：人天与验收信号，**无产品 KPI**。  
- `drama_analytics` 路由注释：session/summary metrics、completion_rate。  
- STATE / 战役：吞吐 67/h、烟测 PASS 等——运维 KPI。  
- PLATFORM_V5 曾提 convergence_rounds 等（规划向）。

### 代码证据
- `apps/api/app/routes/drama_analytics.py`：`completion_rate` 等。  
- `apps/web/hooks/useDramaAnalytics.ts`。  
- 公开应用 smoke 矩阵 —— 非短剧成片率。

### 现网服务
观测偏舰队/烟测；短剧「首集成片率」「不进自由画布完成率」「一致性返工次数」未产品看板。

### UX 方案缺口
§9/§10 未定义改壳后如何证明「AI 驱动变好」。

### 竞品可抄
内部 dogfood 仪表；学习站可用「首次成片时长 / 失败重试次数」。

### 现状→缺口
**有** analytics API 雏形 + 厚运维度量；**缺**产品 KPI 定义与创作台可见仪表。

---

## 11. 与此前 UX-only 方案的矛盾 / 补充

| 点 | UX 方案原倾向 | 本轮实况补充 |
|----|---------------|--------------|
| Ref2VA 默认 | 未深入代码债 | tip **已默认 ref2va**；产品 md §8 滞后 |
| 本地模型菜单噪音 | 正确：勿挂添加菜单 | 但需另建「舰队/模型」说明层，否则本地优势不可见 |
| Agent 一键成片放 P4 | 偏晚 | Agent Team + 六角色**已在代码**；缺的是默认契约与入口，不是从零研发 |
| 声画 | P1–P3 几乎未写 | IndexTTS+lipsync+assemble **主链已有**；缺 UI 阶段 |
| 一致性 | P4 关键帧 | 设定卡+资产+门禁+VLM **已厚**；缺默认强制路径 |
| 画布默认 | 勿进门即画布 | 与 DRAMA_UI_PLAN / 产品方案一致；canvas 是 R18/融合主 UI 目标，短剧仍应阶段轨 |
| SERVICE_INVENTORY | 易误抄 :8195 H3 | 现网 H3=:8264；:8195 已 disable |

---

## 12. 材料索引

- 产品：`docs/AI短剧产品方案.md`  
- 集群：`AGENTS.md`（2026-10-15）  
- 角色资产：`docs/CHARACTER_ASSET_GUIDE.md`  
- Agent 对标：`docs/AGENT_PEER_RESEARCH_20260923.md`  
- UI 目标：`docs/ops/DRAMA_UI_PLAN.md`  
- UX 竞品方案：`docs/ux/COMPETITIVE_RESEARCH_AND_UX_PLAN_20261022.md`  
- 代码主链：`apps/api/app/services/studio/*`、`agent/*`、`agent_team_graph.py`、`drama_pipeline.py`  
- 竞品浅克隆：`/workspace/refs/peers/*`、`/workspace/refs/competitive-deep/*`

