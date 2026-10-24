> ⚠️ **历史快照 · 非现行事实**（DOC_TRUTH_SWEEP 2026-10-23 Asia/Shanghai）。
> 现行集群真源 → [`docs/ops/CLUSTER_TRUTH.md`](../../ops/CLUSTER_TRUTH.md)。命名铁律：一个权重一个 id；served 不得伪装异家族。

# AUDIT MASTER — KEEP / OPTIMIZE / REPLACE 通读总表

> 日期：2026-10-22（Asia/Shanghai）  
> tip：`e5307c63` · 分支 `work/p0-fusion-20261016`  
> 合成源：AUDIT_A / B / C / D（全栈四路只读审计）  
> 对齐：`COMPETITIVE_RESEARCH_AND_UX_PLAN_20261022.md` §0 · §12（D1–D8）  
> 纪律：**禁止**业务编码 / commit / push / 部署；本文件为决策通读稿。

---

## 0. 一页结论（通读优先）

**整体不是「换栈」，而是「默认入口 / 契约 / 文档对齐」。**

四路审计共同指向同一判断：

| 层 | 实况 | 正确动作 |
|----|------|----------|
| 本地算力 | 舰队 / hold / 池 / IndexTTS / Spark **机制厚** | **KEEP**；修默认端口与 registry 漂移 |
| 短剧管线 | tip 默认 **ref2va**；配音→口型→成片主链在 | **KEEP**；修无台词 next_step + 文档滞后 |
| 前端壳 | 主壳已在 **canvas**；`/toiv/ws` 六段是阶段轨底子 | **KEEP** 实现；**REPLACE 语义**（首页 CTA / 添加菜单） |
| 架构/文档 | BUILD 门禁 / IDOR / 凭据脱敏 / third_party 策略在 | **KEEP** 门禁；**修 md**；换密/alembic/DRT **可延后** |

**与推荐拍板包如何咬合：**

```
UX 包（§0）          本地 AI（§12）           本 MASTER
D1-A 阶段轨默认  ←→  L2 导演开关 / D5-A   ←→  C 首页 CTA + 侧栏；禁 Toonflow 化
D2-A 双视图投影  ←→  L4 refs 同源         ←→  C P3 新增投影（非推倒 ws）
D3-A 工具台拆权  ←→  L1 舰队藏端口        ←→  C 工具箱 KEEP；徽章去端口
D4-C 站内合成    ←→  L3 声画 + assemble   ←→  B 配音必须进 P2
D6-A 声画进 P2   ←→  IndexTTS KEEP        ←→  B next_step 无台词修复
D7-A 文档对齐    ←→  tip=ref2va 已落地    ←→  A/B/D 近窗必修 md + 默认 8264
D8-A 雨夜 CTA    ←→  L6 学习脚手架        ←→  C P1 首页旁路
```

**一句话给拍板人：** 近窗做「默认指向正确世界」——H3=:8264、registry 对齐 AGENTS、首页进短剧、添加菜单创作语义、产品 md 承认 ref2va、无台词不卡配音、新功能只写 Studio；**不要**整仓 Toonflow 化、不要关 IndexTTS、不要把已落地的 Ref2VA 再立项成「切换默认」。

---

## 1. 计数汇总（A / B / C / D）

| 路 | 主题 | KEEP | OPTIMIZE | REPLACE | 备注 |
|----|------|------|----------|---------|------|
| **A** | 算力舰队 / 模型 / hold / 混合云 | **14** | **16** | **2** | REPLACE=默认基址指向 + registry 内容（非换探测引擎） |
| **B** | 短剧管线 / 设定卡 / 声画 / Agent | **19** | **8** | **1** | + DOC-DEBT **2**（并入近窗文档债）；REPLACE=Drama∥Studio 收敛 |
| **C** | web / admin / canvas / MP | **~27** | **~16** | **~5** | REPLACE=产品语义/一级交互（非删仓）；按模块表归并 |
| **D** | API / 安全 / 文档 / third_party | **11** | **14** | **5** | REPLACE 中 **4 可延后**；近窗主要是文档债 |
| **合计（约）** | — | **~71** | **~54** | **~13** | 语义归并，非严格一行一票 |

**解读：** KEEP 远多于 REPLACE → 栈正确；债集中在 **默认值 / 入口语义 / 文档真源**，不是缺能力。

---

## 2. 近窗必做 REPLACE / 语义替换（不可延后）

> 「REPLACE」在此含：**默认指向替换**、**一级产品语义替换**、**文档断言替换**、**收敛计划启动**。  
> 仍 **不编码本窗**；下列为确认拍板后的首批工程卡候选。

| # | 项 | 来源 | 现状 → 目标 | 验收信号 | 咬合 |
|---|-----|------|-------------|----------|------|
| N1 | **H3 默认基址** | A | config / `.env.example` / 文案大量 **:8195** → 一律 **:8264**（白名单可留 legacy） | 新环境无 env 也不会打死人口；example 禁写「生产=8195」 | D7 / L5 |
| N2 | **fleet_registry + test_fleet** | A | 仍锁 8195、CosyVoice、OpenTalking:4403… → 按 AGENTS §三重写；补 8265/9311；摘退役 | Admin 在线率分母与现网一致；单测断言同步 | L1 |
| N3 | **首页主 CTA 语义** | C | 「新建画布创作」→ **「新建短剧」** + 最近短剧项目；画布降二级 | 学习站进门不落自由画布 | D1-A / P1 |
| N4 | **侧栏「新建项目」语义** | C | `/canvas?mode=new` → 主新建进 **短剧**；画布进专家/高级 | 与 N3 一词一义 | D1-A / P1 |
| N5 | **添加菜单一级语义** | C | `LOCAL_CREATE_PRESETS` 挂「本地·H3/Wan…」→ **文本/图像/视频/音频/合成/分组**；模型进节点设置 | 产品面无引擎名作节点类型 | D3 / G6 / P3 |
| N6 | **产品方案 Ref2VA 文档** | B+D | §8 仍写「默认仍是 c、尚未做」→ 改为 **tip 已切 ref2va**；余下=生产核对+UI 管线+真机一镜 | 代理/同学不再按「切默认」开工 | D7-A |
| N7 | **Studio next_step 无台词卡死** | B | 无 dialogue 镜永久卡在 voice → 对齐 Drama：越过 voice/lipsync | 纯画面项目进度条可到 assemble | D6-A / P2 |
| N8 | **Drama∥Studio 收敛计划** | B | 双域并存 → **新功能只加 Studio**；Drama API 只读兼容至收束 | 评估文档已定宿主；工程卡禁 Drama 写入 | 架构债近窗「启动」 |
| N9 | **SERVICE_INVENTORY 过期横幅** | A+D | 09-13 表仍像现网 → 文首 **过期警告** + 10-15 勘误（8264 / TTS9200 / VLM9311） | 禁盲抄端口 | §12.6 |
| N10 | **任务中心 Create 迁出 + LocalBadges 去端口** | C | tasks 嵌「新建智能体」；工具箱露 `:8264` → Create→agent；徽章撤端口 | Jellyfish 式只读任务中心；G10 清 | P1 / D3 |

**近窗必做条数：10**（N1–N10）。

---

## 3. OPTIMIZE 优先队列（按波次）

每条一行：`项 | 来源 | 动作 | 验收`

### 3.1 P1（信息架构 / 文案 / 空态）｜与方案 §9 P1 对齐

| 项 | 来源 | 动作 | 验收 |
|----|------|------|------|
| 首页能力瓷砖 / 意图条收权 | C | 只留 1 主 CTA + 最近项目；能力归侧栏 | G1 三重镜像消失 |
| 侧栏稳态序 | C | 短剧默认 → 任务只读 → 工具台 → 自由画布(可折) → 设置 | 对标 §8.4 草图 |
| `/toiv/tasks` 深链 | C | 文档/网关统一 `/studio/toiv/tasks` | G4 404 清 |
| 状态中文化（drama 键） | C | `STATUS_TONE` 展示层字典 | G2 无裸英文 |
| L1 忙闲只读摘要 | A | 创作台 hold/排队人话；藏端口 | 用户知「何时放行」 |
| L5 依赖三态空态 | A | WS / TTS / H3 不可达禁用对应 CTA | 降级可解释 |
| L6 雨夜示例 CTA | C+§12 | 首页旁路一键种子 | D8-A |
| INTENT c「配音 TTS」文案 | B | 清「从零做 TTS」叙事 | 不重复立项 |
| canvas developing 死钮 | C | 智能剪辑等藏实验室 | G9 主路径无「正在开发」 |
| COMMIT_BATCH 09-13 废弃横幅 | D | 指向 `ops/COMMIT_BATCH_PLAN_20261021` | 批次真源唯一 |
| HARDBLOCKED 标历史 | D | 活口径改指 STATE/admin | 禁当现网阻塞表 |

### 3.2 P2（阶段轨 / 声画 / 门禁 UX）｜§9 P2 + L3/L4

| 项 | 来源 | 动作 | 验收 |
|----|------|------|------|
| drama-workspace Phase 叙事 | C | prepared≠generating；配音→口型显式 | D6-A；最小闭环不进画布 |
| 任务回跳至 ws section | C | Jellyfish 式回跳镜/段 | 任务中心可闭环 |
| 站内合成预览强化 | C | 成片/时间线 CTA 可看片 | D4-C |
| 定妆门禁 UX（L4） | B | 无定妆禁批量视频 | 一致性返工下降 |
| 选优/QA 失败人话 | B | 复用 sheet humanize | 失败非哑巴 |
| canvas makeup c-chains 默认 | B | 脱钩主 CTA 或改 ref2va | 短剧主路径≠c_hybrid |
| UI 管线选择器 | B | 默认 ref2va；c/c_hybrid 专家 | D7-A UI 项 |
| seam=continue 标注 | B | UI 标明「续写=管线 C」 | 用户不误判仍是 ref2va |
| Director Gate 文案 | B | 防误入并行编排 | D5-A |
| `drama_studio.py` 按资源切分 | D | 纯搬迁+测绿 | CR 可读；不挡感知 |
| OpenClaw 网关 vs ASR 分写 | D | INVENTORY/AGENTS 分角色 | 勿停 Whisper |

### 3.3 P3（节点感 / 检视器 / 双视图）｜§9 P3

| 项 | 来源 | 动作 | 验收 |
|----|------|------|------|
| 列表↔竖排流水线投影 | C | 同源投影；非 xyflow 重写 ws | D2-A |
| 参数右侧检视器 | C | 取代大面积 fixed Popover | G5 叠盖缓解 |
| 市场精选创作语义标签 | C | 能力保留；非引擎目录 | D3-A |
| character_sheet `_impl` 续切 | D | compose/gen/inpaint… | 降 CR；不挡短剧 |
| 角色资产变体 UI 下单 | B | L2 指南已写、UI 缺 | 变体可下单 |
| toonflow 三视图 MIT 按需并 | D | 仅服务阶段轨 | 许可合规 |

### 3.4 文档债专队（可与 P1 并行，0 业务码）

| 项 | 来源 | 动作 | 验收 |
|----|------|------|------|
| `AI短剧产品方案.md` §8 | B+D | 见 N6 | P0 文档 |
| `SERVICE_INVENTORY.md` 勘误 | A+D | 见 N9 | P0 文档 |
| alembic cutover 升格出 tmp | D | → `docs/ops/ALEMBIC_…` | 防丢 |
| AGENTS H3 token 待办核销 | D | 只读确认后改监控项 | 待办不假开 |
| MIGRATION_PLAYBOOK DRT 旁注 | D | 「可选/待拍板」 | 启动序不解耦误导 |
| VLM/comfy 仓库默认对齐 | A | :9311 / 禁默认 :8189 | 新环境不踩坑 |
| NAS 默认根注释主库 toiv/ | A | 旧树只读兼容 | 下载进主库 |
| timeout 假阳性离线重标 | D | 文档徽章「未验证(慢链)」 | #13 不改码 |

---

## 4. KEEP 清单（别动的核心能力）

> 近窗改造 **不得** 以「清理」名义关掉或重写下列项。

### 4.1 本地算力与作业（A）

- 算力在 workstation / core 只做网关  
- `fleet.py` 探测引擎（15s 缓存、VRAM/queue）  
- `resource_budget` + `hold_queue` **机制**  
- Comfy `WorkerPool` 熔断 + LB 跟随  
- **IndexTTS :9200** 配音主路（勿停）  
- Spark LLM 别名机制  
- openclaw **ASR** 多址设计（与网关 LLM 分角色）  
- NAS 双树物理拓扑 + MODEL_SOURCES 账本 + NAS_MODEL_PICKER  
- ComfyUI-LB backends 热重载策略  
- service_orchestrator 热层常驻 / 冷层唤醒模型  
- 混合云：**本地优先**（RH=市场图来源≠云算力回落）  
- sysmetrics headline  

### 4.2 短剧管线与质量（B）

- `DEFAULT_VIDEO_PIPELINE=ref2va` + `render_shot` 拒错误续写  
- Motion Context `c` / `c_hybrid` **作为可选**（勿删代码/门禁）  
- 选优 face_mean≥0.45；场景/硬切/衣物门禁  
- 角色设定卡 + L2 资产锚点 + `select_indep_shot_refs`  
- IndexTTS `voice.synth_for_shot`；pad lipsync；assemble 规格归一  
- Drama 七阶段重算（voice applicable=有台词）  
- Agent 对话六角色（触发式）+ Agent Team `assembly_gate` interrupt  
- 失败保留入选片 / render_reconcile 异步候选  

### 4.3 前端壳（C）

- **canvas 为创作主壳**；web=登录门 + `/studio` 托管  
- `/toiv/ws/:id` 六段工作区 **实现与路由**  
- 短剧列表 / 经典详情 / 图生短剧辅入口  
- 工具箱页壳 + R18 门控 + 单工具页归属工具台  
- 画布节点原语 / 添加菜单 **组件结构**  
- settings `local-compute`（端口在**设置**合理）  
- `/toiv/agent`、媒体库、admin 全作业/舰队/模型面  
- MiniProgram web-view→studio（P1–P3 不重做原生阶段轨）  
- Beef `/tasks` → `/` 重定向（防双中心）  

### 4.4 架构 / 安全 / 工程（D）

- routes 按域拆分 + 统一 `/api` 挂载  
- character_sheet **包级**拆分与公开 re-export 测  
- Alembic 脚手架 + **生产切流前双轨**  
- Jobs 属主过滤 + 既有 IDOR 测试资产  
- **BUILD_ID / deploy gate / CI release-gate**  
- 凭据文档脱敏 + `test_cred_hygiene`  
- third_party：源树 ignore + licenses；MIT 已并码；ChatCut/OpenMontage 红线  
- #13 **暂不改码**（与批准 commit 边界一致）  
- api CI + dogfood_ci；canvas Go/web build 闸  

---

## 5. 可延后 REPLACE（明确不抢感知窗）

| # | 项 | 来源 | 为何延后 | 触发条件 |
|---|-----|------|----------|----------|
| Dly1 | 生产 admin/JWT/PG **换密** + api 重启 | D | 用户暂缓安全换密/上线 | 独立批准窗 + drain |
| Dly2 | 历史 git 秘密净化 / filter-repo | D | 需 push 脱敏批准 | 外泄评估后 |
| Dly3 | alembic 生产 `stamp`/`upgrade`、Drama 删表 | D | COMMIT 方案明文不纳入 | 切流专窗 |
| Dly4 | DRT 12+LiveKit **整栈关停** | D | 去留未拍板 | 负责人书面 |
| Dly5 | api **微服务拆分** | D | 单机网关边界已正确 | 规模证明需要后 |
| Dly6 | hypit/dramaclaw 在 **多租户 SaaS** 下换实现 | D | 现单租户学习站 | 产品转 SaaS 决策 |
| Dly7 | #13 假 timeout **归因改码** | D | 不挡 P1–P3；先离线重标 | 分析完成后再议 |
| Dly8 | 全库自动化 IDOR fuzzer | D | 单租户收益/成本偏低 | 多租户前 |
| Dly9 | OpenClaw **网关 LLM** 角色替换 | D | ASR 仍要用；勿连带砍 Whisper | 网关替代就绪 |
| Dly10 | H3 原生音画一体换默认 | B | A/B 实验位；现 TTS+对轴正确 | V5 W7 证据压倒默认 |
| Dly11 | canvas Playwright 搬回 CI / web 全量 unit | D | 感知窗优先文档+壳 | 壳稳定后 |
| Dly12 | WS legacy unit 文件物理清理 | D | 防与现行 indextts 命名混淆即可 | 文档消歧后可选 |

**可延后条数：12**（Dly1–Dly12）。

---

## 6. 明确不做（本审计窗 + 推荐包默认）

| 反模式 | 理由 |
|--------|------|
| **整仓 Toonflow / TapCanvas / waoowaoo 化**（进门即画布） | §0 行业证据：学习站高完成率=阶段默认 |
| **关 IndexTTS :9200** / 把 legacy disable 当「无配音」 | 配音主路；INTENT c≠能力缺失 |
| **重做「切 Ref2VA 默认」立项** | tip 已是 ref2va+单测；只做 D7 对齐 |
| **把默认管线改回 `c`** | 与产品拍板及 tip 对立 |
| **删 Motion Context / chybrid 代码** | 可选续写与门禁资产仍要 |
| **在 apps/web 复活 SideRail 第二壳** | F9/F12 已切 studio |
| **P1 大改 MiniProgram 原生短剧 UI** | web-view 已接；桌面 IA 先稳 |
| **为「干净」删 admin / local-compute 端口** | 运维真源；只从创作者默认面撤 |
| **把添加菜单继续当引擎目录** | G6；与 D3/N5 对立 |
| **近窗执行换密 / alembic 切流 / DRT 关停 / 微服务** | §5 可延后 |
| **盲抄 SERVICE_INVENTORY 09-13 端口** | H3≠8195 |
| **宣称为「本地 AI 驱动已完成」仅因改了 Tabs** | §12.6 |

---

## 7. 分册链接

| 分册 | 本机路径 | Box 路径 |
|------|----------|----------|
| A 算力舰队 | `docs/ux/research/AUDIT_A_FLEET_MODELS_20261022.md` | `/workspace/refs/competitive-deep/AUDIT_A_FLEET_MODELS_20261022.md` |
| B 短剧管线 | `docs/ux/research/AUDIT_B_DRAMA_PIPELINE_20261022.md` | `/workspace/refs/competitive-deep/AUDIT_B_DRAMA_PIPELINE_20261022.md` |
| C 前端壳层 | `docs/ux/research/AUDIT_C_FRONTEND_SHELL_20261022.md` | `/workspace/refs/competitive-deep/AUDIT_C_FRONTEND_SHELL_20261022.md` |
| D 架构文档 | `docs/ux/research/AUDIT_D_ARCH_DOCS_20261022.md` | `/workspace/refs/competitive-deep/AUDIT_D_ARCH_DOCS_20261022.md` |
| 能力地图 | `docs/ux/research/TOIV_LOCAL_AI_CAPABILITY_MAP_20261022.md` | （若已同步）同 research/ |
| UX+§12 总方案 | `docs/ux/COMPETITIVE_RESEARCH_AND_UX_PLAN_20261022.md` | `/workspace/refs/competitive-deep/COMPETITIVE_RESEARCH_AND_UX_PLAN_20261022.md` |
| **本 MASTER** | `docs/ux/research/AUDIT_MASTER_KEEP_OPTIMIZE_REPLACE_20261022.md` | `/workspace/refs/competitive-deep/AUDIT_MASTER_KEEP_OPTIMIZE_REPLACE_20261022.md` |

---

## 附录 — 修订记录

| 时间 (Asia/Shanghai) | 说明 |
|----------------------|------|
| 2026-10-22 | 初版：合成 A/B/C/D；近窗 N1–N10；可延后 Dly1–Dly12；对齐 D1–D8；未编码未 commit |
