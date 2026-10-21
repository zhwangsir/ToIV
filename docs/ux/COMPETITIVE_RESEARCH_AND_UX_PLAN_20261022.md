# ToIV 竞品调研与 UX 改造完整方案

> 文档日期：2026-10-22（Asia/Shanghai）  
> 状态：**仅调研与方案，未编码、未 commit、未 push、未部署**  
> 仓库落点：`docs/ux/COMPETITIVE_RESEARCH_AND_UX_PLAN_20261022.md`  
> Box 副本：`/workspace/refs/competitive-deep/COMPETITIVE_RESEARCH_AND_UX_PLAN_20261022.md`（及 `/workspace/refs/` 同名）  
> Stars/活跃度以 2026-10-21～22 GitHub API / README 实读为准，禁止虚构。  
> **修订：2026-10-22 深夜加深轮**（名单仓 9 维补档 + 硬证据表 + 差距改法 + P1–P4 人天；waoowaoo/printfilm 纠偏）。

---


---

## 0. 给决策者的一页摘要（通读优先）

**结论一句话：** ToIV 应默认走「短剧阶段轨主路径」，可选「列表↔竖排流水线画布」双视图，自由/Agent 画布只放专家层——**不要**把 Toonflow / TapCanvas / waoowaoo 式「进门即画布」当学习站默认壳。

**行业证据（本轮加深后仍成立）：**
- **阶段默认能成片**：火宝（左轨）、Jellyfish（`prepared → ready → 生成`）、BigBanana（Phase01–05）、LingGuo（Tabs）、ArcReel（可审核流水线+剪映导出）、printfilm（漫剧阶段+短视频模板）、ai_story（Pipeline 阶段回滚）、Openframe（项目→…→FCPXML/EDL）。
- **节点感≠无限自由图**：LocalMiniDrama（列表真源 + 竖排流水线投影）、AID（工作流入口 ≠ 画布入口）、wind-comic（xyflow 展示 Agent/控片就绪，非引擎目录）、剧流 Studio（统一画布但可退回经典步骤）。
- **画布优先适合专家**：Toonflow、TapCanvas、AI-Canvas-tauri、**waoowaoo（右侧 Assistant + 图像/视频画布，Elastic 2.0，非短剧阶段台）**。

**对 ToIV 已验证痛点的改法优先级：**
1. **P1（约 3–5 人天）**：收敛首页三重镜像；侧栏一词一义；任务中心只追踪+回跳；修 `/toiv/tasks` 深链；状态中文化；端口号撤出产品面。
2. **P2（约 5–8 人天）**：短剧左轨/Phase + Jellyfish 就绪态；任务中心禁塞创建；最小闭环不进自由画布。
3. **P3（约 6–10 人天）**：短剧内「流水线视图」双视图同源；自由画布添加菜单改创作语义；参数改右侧检视器。
4. **P4（按需）**：关键帧默认、失败码、NLE/剪映导出、控片就绪灯、Agent 一键成片（专家开关）。

**推荐拍板包（正文已按此写满路径）：D1-A + D2-A + D3-A + D4-C。**  
确认前：**不写业务代码、不 commit、不 push、不部署。**

**本轮加深新增/纠正：** waoowaoo 定位纠偏（画布+Assistant，非工业短剧阶段台）；printfilm 四模块拆分坐实；ArcReel 剪映草稿+AGPL；Openframe FCPXML/EDL；AI-Canvas-tauri master README（源码可用→10k★转 MIT）；阶段 vs 画布硬证据表；差距→改法对照；P1–P4 交付物/验收/人天。

---
## 1. 背景与目标

### 1.1 用户痛点（已验证）

1. **用着难受**：首页入口三重镜像（侧栏 + 瓷砖 + 快捷胶囊）、状态中英混用、任务中心错位、公网 `/toiv/tasks` 404。
2. **节点乱七八糟**：现网 admin 下未必有蜘蛛网乱线；乱在**壳层叠盖**（参数浮层盖住节点）、**添加菜单=本地引擎目录**（「本地·H3/Wan…」当节点类型）、短剧主路径仍是 Tabs 而非受控节点。
3. **想要的感觉**：参考 [LingGuo-Drama](https://github.com/LingGuoAI/LingGuo-Drama) 的**简洁阶段台**，但仍要**节点工作流感**——不是二选一，是「简洁主路径 + 受控节点」。

### 1.2 ToIV 现状（必须对照）

| 项 | 现状 |
|----|------|
| 分支 | `work/p0-fusion-20261016` |
| 线上 tip | 已对齐 `e5307c63`（BUILD 无 `-dirty`） |
| 产品定位 | 学习站优先；感知/可用优先 |
| 短剧面 | Tabs 阶段（剧本/资产/分镜…），非节点默认 |
| 自由画布 | 有节点原语；空态弱；添加菜单工业风；面板叠盖 |
| 市场/工具箱 | 命名分裂；端口号外露；与首页入口镜像 |

### 1.3 本方案目标

1. 用真实 GitHub 竞品说明行业里「阶段 vs 画布 vs 节点」怎么分工。  
2. 给出 **ToIV 可执行的分阶段改造方案**（仍不写业务代码）。  
3. 列出 **2～4 个须用户拍板** 的决策点。

---

## 2. 调研范围与方法

### 2.1 关键词

中文：AI短剧、AI漫剧、短剧工作室、漫剧创作、分镜工作流、AI导演、剧本到视频、创作台。  
英文：AI short drama / micro-drama / comic drama / storyboard / infinite canvas / motion comic / AI director。  
Topics 线索：`ai-short-drama`、`storyboard`、`infinite-canvas`、`node-based-editor`。

### 2.2 方法

- GitHub `search_repositories` 多轮 + 浅克隆至 `/workspace/refs/peers/` 与既有 `/workspace/refs/LingGuo-Drama`。  
- 读 README / 功能文档 / `package.json`（查 `@xyflow`、`@vue-flow`、TDesign 等）。  
- 父会话深读笔记：`/workspace/refs/competitive-deep/PARENT_PRIMARY_NOTES.md`。  
- **排除**：hongguo-* 播放器/下载类；无关高星噪声（通用 Agent、书籍列表等）。  
- Skill/提示词包进附录，不进主矩阵「产品 UX」权重。

### 2.3 深挖维度（每条主竞品）

1. 产品定位 2. 创作主路径 3. UI 信息架构 4. 节点/工作流 5. 资产模型 6. 生成能力 7. 技术栈 8. 对 ToIV 可抄/不可抄 9. 证据链接

---

## 3. 竞品地图总表（主行 ≥15 + ToIV）

| # | 项目 | ★约 | 活跃 | 一句话定位 | UI 范式 | 自建开源 | 与 ToIV 相关度 |
|---|------|-----|------|------------|---------|----------|----------------|
| 0 | **ToIV（本产品）** | — | 自有 | 学习站向创作台：短剧 Tabs + 自由画布 + 市场 | **混合失控**（入口镜像） | 私有 | 基线 |
| 1 | [HBAI-Ltd/Toonflow-app](https://github.com/HBAI-Ltd/Toonflow-app) | 18.8k | 2026-10-21 | 短剧/漫剧无限画布创作平台 | **C 画布优先** | MIT，可自建 | 高（节点感标杆，勿作默认首页） |
| 2 | [chatfire-AI/huobao-drama](https://github.com/chatfire-AI/huobao-drama) | 16.5k | 2026-10-21 | 一句话到成片的短剧自动化台 | **A 左轨阶段** | CC BY-NC-SA | 高（阶段 UX） |
| 3 | [waooAI/waoowaoo](https://github.com/waooAI/waoowaoo) | 14.6k | 2026-10-21 | **图像/视频创作工作区：右侧 Assistant + 画布**（非短剧阶段台） | **C 画布+助手** | **Elastic 2.0** | 中（专家层；不宜学习默认壳） |
| 4 | [Forget-C/Jellyfish](https://github.com/Forget-C/Jellyfish) | 6.8k | 2026-10-21 | 端到端短剧生产工作台 | **A 准备态流水线** | Apache-2.0 | **很高**（任务中心/就绪态） |
| 5 | [dramaclaw/dramaclaw](https://github.com/dramaclaw/dramaclaw) | 6.4k | 2026-10-21 | 工业化 AIGC 视频引擎/流水线 | A 引擎流水线 | Elastic-2.0 | 高（网关/许可） |
| 6 | [yi1108/printfilm](https://github.com/yi1108/printfilm) | 5.8k | 2026-10-21 | **四模块：AI漫剧 + AI短视频 + 工具中心 + 管理后台** | **A 阶段默认 + 分镜画布可选** | MIT | **很高**（产品线拆分） |
| 7 | [ArcReel/ArcReel](https://github.com/ArcReel/ArcReel) | 5.6k | 2026-10-21 | 小说→短视频可审核流水线 | A Agent 流水线 | AGPL | 中高 |
| 8 | [shuyu-labs/BigBanana-AI-Director](https://github.com/shuyu-labs/BigBanana-AI-Director) | 2.4k | 2026-10-21 | 工业化短剧/漫剧导演台 Phase01–05 | **A Phase 阶段** | CC BY-NC-SA；源冻结走镜像 | 高（关键帧/定妆） |
| 9 | [xuanyustudio/LocalMiniDrama](https://github.com/xuanyustudio/LocalMiniDrama) | 2.2k | 2026-10-21 | 本地短剧助手，列表+画布双视图 | **E 双视图** | MIT | **最高 UX 参考** |
| 10 | [xhongc/ai_story](https://github.com/xhongc/ai_story) | 1.9k | 2026-10-21 | 主题→故事视频全流程 | A 阶段+导演模式开发中 | 开源 | 中 |
| 11 | [freestylefly/director_ai](https://github.com/freestylefly/director_ai) | 1.8k | 2026-10-21 | 手机端 AI 漫导 Agent | **D 对话驱动** | 开源 Flutter | 中（移动/对话） |
| 12 | [Stonewuu/ai-fusion-video](https://github.com/Stonewuu/ai-fusion-video) | 1.6k | 2026-10-21 | Agent 全流程短剧/漫剧（融光） | A 统一工作区 | 开源 Java | 中高 |
| 13 | [LingGuoAI/LingGuo-Drama](https://github.com/LingGuoAI/LingGuo-Drama) | 1.6k | 2026-10-21 | 用户已参考的简洁一站式短剧台 | **A TDesign Tabs** | MIT | 高（简洁标杆） |
| 14 | [alibaba/lumenx](https://github.com/alibaba/lumenx) | ~1.4k | 2026-10-21 | Studio 流水线 + Playground 工具台 | **E Studio/Playground 拆分** | MIT | **很高**（信息架构） |
| 15 | [gzxx-2025/aid-studio](https://github.com/gzxx-2025/aid-studio) | 1.1k | 2026-10-21 | 漫剧/电影/漫画；工作流与画布分入口 | **E 双入口** | MIT | **很高** |
| 16 | [TypeTale/TypeTale](https://github.com/TypeTale/TypeTale) | 0.9k | 2026-10-21 | 字字动画：免费短剧/电影/推文客户端 | 多视图后置画布 | 免费客户端 | 高（导出/后置画布） |
| 17 | [ChrisChen667788/wind-comic](https://github.com/ChrisChen667788/wind-comic) | 0.7k | 2026-10-21 | 多 Agent 短剧工作室 + 控片台 | A/E + React Flow 可视化 | MIT | 高 |
| 18 | [anymouschina/TapCanvas](https://github.com/anymouschina/TapCanvas) | ~0.7k | 2026-10-21 | Agent 原生无限画布 + 一键成片工作流 | **C Agent 画布** | 社区版 MIT | 高（专家层） |
| 19 | [Tenney95/AI-Canvas-tauri](https://github.com/Tenney95/AI-Canvas-tauri) | 0.3k | 2026-10-21 | 本地优先 AI 画布 + 短剧分集画布 | C + 多轨 | 源码可用→星满 MIT | 中高 |
| 20 | [murongg/openframe](https://github.com/murongg/openframe) | 0.1k | 2026-10-20 | 漫剧创作台，导出 FCPXML/EDL | **A 阶段链** | **AGPL-3.0** | 高（导出） |
| 21 | [lnblfkj-del/Dralo-Studio](https://github.com/lnblfkj-del/Dralo-Studio) | 8 | 2026-10-19 | 阶段+无限画布+多轨+3D 导演台 | **E 阶段模块+画布** | Apache-2.0 | 高（结构完整） |
| 22 | [JerrIsTheBesta/AI-Short-Drama-Studio](https://github.com/JerrIsTheBesta/AI-Short-Drama-Studio) | 30 | 2026-10-21 | 剧流 Studio：统一画布+经典步骤导航 | E 统一画布可退回步骤 | MIT | 中高 |
| 23 | [qiukaihui/comfyui-auto-drama](https://github.com/qiukaihui/comfyui-auto-drama) | 63 | — | ComfyUI+H3 编排控制台 8 步 | A 编排台（无创作画布） | MIT | 高（失败码/质检） |

**附录级（不进主 UX 权重）**：`eternityspring/shuohao-skills`、`zenstory-ai/drama-skills`、`liangdabiao/Seedance2-Storyboard-Generator`、`BidingCC/BuildingAI`（积木平台壳）、`Comfy-Org/ComfyUI`（通用节点引擎范式，非短剧产品）。

---

## 4. 范式分类（A–E）

| 范式 | 定义 | 代表 | 优势 | 风险 |
|------|------|------|------|------|
| **A 线性阶段台** | 左轨/Phase/Tabs，一步一主 CTA | 火宝、LingGuo、BigBanana、Jellyfish、Openframe、comfyui-auto-drama | 认知负担低、完成率高 | 缺「编排感」；高级用户觉得钝 |
| **B 节点画布（通用）** | Comfy 式自由图为默认 | ComfyUI（参照） | 极限灵活 | 学习成本极高；易乱 |
| **C 无限画布优先** | 进产品就是画布+节点 | Toonflow、TapCanvas、AI-Canvas-tauri | 节点感强、Agent 友好 | **不适合学习站默认首页** |
| **D 对话/Agent 驱动** | 聊天规划→自动流水线 | director_ai（Flutter）、部分风控片台 | 入口极低 | 失败难定位；可控性弱 |
| **E 混合（推荐解剖）** | 阶段/列表默认 + 画布投影或分入口 | **LocalMiniDrama、AID、LumenX、Dralo、剧流 Studio、TypeTale** | 兼顾简洁与节点感 | 需严格规定「何时露出画布」 |

### 4.1 对 ToIV 的范式结论（先讲清楚）

> **推荐：默认 A（Jellyfish/火宝/BigBanana/LingGuo）+ 可选 E 双视图流水线画布（LocalMiniDrama/AID）+ C 仅作专家/Agent 层（Toonflow/TapCanvas）。**  
> 禁止把 Toonflow/TapCanvas 式「进门即无限画布」当作学习用户默认首页。


### 4.2 「阶段 vs 画布」硬证据表（默认首页 / 双视图 / 节点库是否露引擎名）

> 证据来自各仓 README / LICENSE / `package.json` 依赖实读（2026-10-22）。「引擎名」指把 H3/Wan/本地引擎型号当作添加菜单一级节点类型。

| 项目 | 默认进产品后第一主界面 | 双视图？ | 画布库 | 节点/添加菜单是否暴露引擎名 | 许可 | 对 ToIV |
|------|------------------------|----------|--------|-----------------------------|------|---------|
| **火宝 huobao-drama** | 项目卡 → **左侧进度轨阶段台** | 无 | 无 xyflow | N/A（无创作节点菜单） | CC BY-NC-SA | 学阶段轨；勿抄 NC |
| **Jellyfish** | 项目/章 → **镜头准备→ready→生成台** | 无自由画布 | 无 | N/A；任务中心语义 | Apache-2.0 | **任务回跳+就绪态标杆** |
| **LingGuo** | Tabs/Steps 阶段 | 无 | 无 | N/A | MIT | 简洁标杆 |
| **BigBanana** | Phase01–05 导演台 | 无无限画布 | 无（九宫格/时间线） | N/A | CC BY-NC-SA | Phase+关键帧 |
| **ai_story** | Pipeline：主题→…→视频 | 无；导演模式开发中 | 无 | N/A | README 未明示 LICENSE 头 | 阶段回滚 |
| **Openframe** | 项目→剧本→资产→分镜→生产/导出 | 无无限画布默认 | 未见 xyflow | N/A | **AGPL-3.0** | 学 FCPXML/EDL；勿拷代码 |
| **ArcReel** | 可审核 Agent 流水线工作台 | 无「列表+竖排画布」双视图营销 | 未见 xyflow 默认 | N/A；供应商在设置 | **AGPL-3.0** | 学人工确认+剪映草稿；勿拷 |
| **printfilm** | 工作台；漫剧走项目/分集/剧本/分镜；短视频走模板流水线 | 漫剧：**分镜编辑与画布**可选 | `@xyflow/react` | 模型在管理后台路由，非「添加节点=引擎名」叙事 | MIT | **学产品线拆分** |
| **融光 ai-fusion** | 统一工作区（项目/剧本/分镜/Agent） | 无无限画布默认 | 无 xyflow | 模型在设置 | MIT | Agent 工作区参考 |
| **LocalMiniDrama** | 制作页**列表**；可切**画布** | **是（同源）** | `@vue-flow`（计划/实现） | 节点=剧本/角色/分镜/首尾帧/视频等**创作语义** | MIT | **最高 UX 参考** |
| **AID Studio** | **工作流创作**入口 | **双入口**（流程 vs canvas） | `@xyflow/react` | 画布独立入口，可返回步骤 | MIT | 双入口文案 |
| **LumenX** | Studio 管线；另有 Playground | Studio/Playground 拆分 | 非画布优先 | 模型 catalog，非节点类型 | MIT | Studio vs 工具台 |
| **Dralo** | 阶段模块表，画布为模块之一 | 阶段+画布分治 | React Flow | 视频节点区分参考/首/尾帧 | Apache-2.0 | 模块分治 |
| **剧流 Studio** | **新建即统一画布** | 可退回经典步骤 | `@vue-flow/*` | 创作节点+模型可换 | MIT | 「可退回步骤」；默认偏激进 |
| **wind-comic** | 多 Agent 流水线 + **控片台** | 创作工坊有流图 | `@xyflow/react` | 流图=Agent/环节就绪，非引擎目录 | MIT | 控片就绪灯 |
| **Toonflow** | **无限画布为创作主场** | 弱阶段轨 | `@vue-flow/core` | 插件/节点可扩；偏画布原语 | MIT | 专家层 only |
| **TapCanvas** | Agent 无限画布 | 画布中心 | `@xyflow/react` | 强类型节点/端口 | MIT（组件或 AGPL） | 专家层 |
| **AI-Canvas-tauri** | **画布即产品**（分集各一画布） | 资产 Tab+多轨剪辑 | `@xyflow/react` | 多模态节点类型；Comfy/Agent 接入 | 源码可用→10k★转 MIT | 专家/桌面参考 |
| **waoowaoo** | **右侧 Assistant + 画布**整理图/视频 | 非短剧双视图 | `@xyflow/react` + Temporal | 模型经 OpenRouter；画布整理资产 | **Elastic 2.0** | **纠正：非短剧阶段台**；专家层 |
| **director_ai** | 移动端聊天驱动 | 无画布 | 无 | N/A | README 未声明 | 场景级重试 |
| **ToIV（现状）** | 首页多入口镜像；短剧 Tabs；另有自由画布 | **未接轨**的双心智 | 有节点原语 | **是：添加菜单≈本地引擎目录** | 私有 | **本方案改造对象** |

**硬结论：** 高完成率产品把「默认首页」压在阶段/列表/就绪态；画布要么是**同源投影**，要么是**第二入口/专家层**。把引擎型号挂到添加菜单一级，是 ToIV 特有噪音，主流短剧台不做。


---

## 5. 主竞品深度档案（1–8 维）

### 5.1 chatfire-AI/huobao-drama（火宝）— A

1. **定位**：创作者一站式 AI 短剧自动化；可自建；**CC BY-NC-SA（禁商用）**。  
2. **主路径**：项目 → 配置 AI → 剧本改写 → 资产提取生图 → 分镜拆镜+批量视频 → FFmpeg 合并导出。左侧进度轨始终标阶段。  
3. **IA**：项目卡片列表；工作台左侧**进度轨**；无无限画布。  
4. **节点**：无 React Flow；工作流=阶段状态+任务抽屉。  
5. **资产**：剧本→角色/场景提取→分镜镜头。  
6. **生成**：LLM Agents（Mastra：script_rewriter / extractor / storyboard_breaker / prompt_generator）；视频 Seedance/Wan/MiniMax；FFmpeg 合片。  
7. **栈**：Nuxt3/Vue3 + Hono + Drizzle + SQLite + Electron。  
8. **ToIV**：✅ 学左轨阶段进度、成片合并与「跟着走」教程结构；❌ 别学 NC 许可；节点若保留须专家层。  
9. **证据**：https://github.com/chatfire-AI/huobao-drama ，README.zh-CN「图文教程」第 1–6 步。

### 5.2 xuanyustudio/LocalMiniDrama — E（最强 UX 参考）

1. **定位**：本地优先短剧/漫剧；下载即用；**MIT**。  
2. **主路径**：故事→剧本→角色→场景→道具→分镜→图/视频→合成；一键流水线+失败重试。  
3. **IA**：**列表精细编辑 + 画布批量编排双视图，单数据源**；顶栏切换「列表 | 画布」。  
4. **节点**：`@vue-flow/core`；画布=**竖排流水线投影**（分镜行：文本→首/尾帧→视频），非乱自由图；框选建 workflow_groups 整组重跑；节点内面板（nodrag）。  
5. **资产**：SQLite + project.json；`canvas_layout` / `workflow_groups` 仅 metadata。  
6. **生成**：通义/火山/可灵/Gemini 等自备 API；本地素材不上云。  
7. **栈**：Vue3 + Element Plus + Express + Electron。  
8. **ToIV**：✅ **默认列表/阶段，画布=流水线投影**——直接对治「节点乱」；✅ 列表↔画布双向；❌ 勿把引擎名当节点类型。  
9. **证据**：README 双视图表；`docs/plans/2026-06-15-drama-canvas-workflow-plan.md`。

### 5.3 gzxx-2025/aid-studio — E 双入口

1. **定位**：开源 AI 漫剧/短剧/电影/漫画平台；可自建计费；**MIT**。  
2. **主路径**：三工作流（漫剧短剧 / 电影 / 静态漫画）；创作流程页推进。  
3. **IA**：**工作流创作** 与 **workflow canvas** 明确两个入口；作品级/分集级画布。  
4. **节点**：`@xyflow/react`；从「我的作品」或流程顶栏进画布；可「保存布局并返回步骤流程」。  
5. **资产**：角色/场景/分镜/配音/成片预览。  
6. **生成**：多模型后台配置；视频+语音。  
7. **栈**：Java17 SpringBoot3 + MySQL + Redis + RocketMQ；React admin/web；Docker。  
8. **ToIV**：✅ 学双入口分离文案与导航；❌ 别把企业后台（计费/MQ）复杂度搬进学习站。  
9. **证据**：README「Three Main Creative Workflows」；`frontend/web/README.md` 流程画布节。

### 5.4 LingGuoAI/LingGuo-Drama — A（用户已爱简洁）

1. **定位**：一句话到短剧/漫剧后台工作台；**MIT**；可二次开发。  
2. **主路径**：项目→剧本→角色/场景/道具→分镜→图片/视频→FFmpeg 合并。  
3. **IA**：Vue3 + **TDesign** 管理台；Tabs/菜单；**无无限画布**。  
4. **节点**：无。  
5. **资产**：剧本实体提取。  
6. **生成**：异步 Asynq；AI 生图视频。  
7. **栈**：Go Gin GORM + Vue3 TDesign Pinia + MySQL Redis。  
8. **ToIV**：✅ 学信息克制、单一主 CTA、组件一致性；❌ 单独不够「节点感」——需叠加 E 的流水线投影。  
9. **证据**：https://github.com/LingGuoAI/LingGuo-Drama README；本机浅克隆 `/workspace/refs/LingGuo-Drama`。

### 5.5 alibaba/lumenx — E Studio / Playground

1. **定位**：AI 原生短漫剧平台；**MIT**。  
2. **主路径（Studio）**：剧本→分镜→资产→视频→合成→导出。  
3. **IA**：**Studio（pipeline-first）** 与 **Playground（独立生成台）** 拆分——对标 ToIV「短剧流水线 vs 市场/引擎」。  
4. **节点**：非画布优先；Studio 分镜工作台+时间线。  
5. **资产**：角色三视图、场景定调、道具。  
6. **生成**：DashScope 多模型；CosyVoice/Qwen3-TTS；I2V/R2V。  
7. **栈**：Next.js + Python 3.11。  
8. **ToIV**：✅ 强制拆「创作流水线 / 工具试验台」导航与命名；❌ 勿让市场与短剧首页同权镜像。  
9. **证据**：README 模块表；`#/playground`。

### 5.6 shuyu-labs/BigBanana-AI-Director — A Phase

1. **定位**：工业级短剧/漫剧导演台；反对抽卡；**CC BY-NC-SA**；后续以 Docker 镜像为主（源冻结倾向）。  
2. **主路径**：Phase01 叙事 → 02 一致性资产 → 03 镜头制作 → 04 成片交付 → 05 提示词管理。  
3. **IA**：项目中心 / 导演工作台 / 九宫格 / CutOS 时间线——**阶段 IA，非画布优先**。  
4. **节点**：无自由节点默认；**关键帧驱动**（首尾帧再插值视频）。  
5. **资产**：定妆照 + 衣橱 + 上下文感知生成（三重一致性）。  
6. **生成**：多模型；AntSK 等。  
7. **栈**：工作台+IndexedDB 本地线索（以 README 为准）。  
8. **ToIV**：✅ Phase 命名、关键帧锁定、一致性资产优先于乱连线；❌ NC 许可与闭源化路径。  
9. **证据**：README Phase 01–05 与关键帧章节。

### 5.7 Stonewuu/ai-fusion-video（融光）— A Agent 统一工作区

1. **定位**：Agent 驱动的视频创作平台；项目/剧本/分镜/素材/图视频生成整合；**MIT**。  
2. **主路径**：按分集和场景组织剧本 → 整理分镜 → 镜头素材生成与管理；Agent 工作区可流式对话、工具权限、Skill、MCP、子 Agent。  
3. **IA**：统一工作区 + 系统管理（初始化向导、用户角色）；**非**无限画布默认首页。  
4. **节点**：未见 `@xyflow` 为创作默认；Agent 工具调用可视化偏会话而非自由图。  
5. **资产**：项目素材统一管理；本地或 S3 兼容存储。  
6. **生成**：设置页集中配置文本/图/视频模型（OpenAI 兼容、Anthropic、Gemini、DashScope、Ollama 等）。  
7. **栈**：Java 21 + Next.js 16 + Docker Compose；AgentScope。  
8. **ToIV**：✅ 分集/场景组织与 Agent 权限模型；✅ 「模型进设置、不进添加菜单」；中高参考，非画布范式来源。  
9. **证据**：README 功能表与 Agent 章节；LICENSE=MIT。

### 5.8 murongg/openframe — A 阶段链 + 专业 NLE 导出（细节加深）

1. **定位**：面向 AI 漫剧/剧情短视频的创作工作台；**Web + 桌面**双端。  
2. **主路径（README 原句）**：`项目 -> 剧本 -> 角色/道具/场景 -> 分镜 -> 生产/导出`。  
3. **IA**：一站式阶段链；分镜后进画面/视频生产与**时间线编排**；无「默认无限画布」营销。  
4. **节点**：`package.json` 未见 `@xyflow`；非画布优先产品。  
5. **资产**：剧本 AI 辅助（补全/想法成剧/小说改编/润色）；结构化提取角色道具场景分镜；**人物关系图谱**可持续优化。  
6. **生成**：文本 / 生图 / 视频**三类模型与服务地址独立配置**；关键帧/镜头视频；存储本地或 S3/COS/OSS。  
7. **导出细节**：支持 **合并视频、FCPXML、EDL**（README 写明便于接入 **PR / 达芬奇**）；Web 用浏览器本地存储；Desktop 强化本地目录与原生导出。  
8. **栈 / 许可**：Web+Desktop；**AGPL-3.0（传染风险，禁止直接拷代码进 ToIV）**。  
9. **ToIV**：✅ P4 导出规格可对齐「FCPXML/EDL + 站内合并」；✅ 三类模型独立配置的设置 IA；❌ 零拷贝 AGPL 实现。  
10. **证据**：README「项目功能」「导出能力」「开源协议」；LICENSE=AGPL-3.0。

### 5.9 lnblfkj-del/Dralo-Studio — E 结构完整（星少但范式清晰）

1. **定位**：短剧工坊；本地自备模型；Apache-2.0。  
2. **主路径**：故事策划→制作准备→分集镜头→**自由画布**→多轨成片。  
3. **IA**：阶段模块表 + 无限画布 + 任务中心 + 3D 导演台——**模块分治**。  
4. **节点**：React Flow；连线表达引用/生成；视频节点区分参考图/首帧/尾帧。  
5. **资产**：资产中心+项目素材复用。  
6. **生成**：多渠道；Worker；FFmpeg。  
7. **栈**：React Vite Ant Design + FastAPI SQLite + Three.js 导演台。  
8. **ToIV**：✅ 「阶段模块与画布分治」说明书级结构；星少勿当产品成熟度担保。  
9. **证据**：README 阶段表；`docs/FEATURES.md`。

### 5.10 HBAI-Ltd/Toonflow-app — C 画布优先

1. **定位**：短剧/漫剧开源创作工具；无限画布+Agent+MCP+插件；**MIT**。  
2. **主路径**：画布内写剧本分镜→资产→视频→整理下载；另有 3D 导演台。  
3. **IA**：项目首页后进入**无限画布为创作主场**。  
4. **节点**：Vue Flow；节点菜单/分组；插件扩展节点。  
5. **资产**：角色场景道具可在画布组织。  
6. **生成**：自选模型/ComfyUI；多语言 21 种。  
7. **栈**：Bun 生态、插件市场、MCP。  
8. **ToIV**：✅ 学节点菜单分组、导演台、插件边界；❌ **勿把无限画布当学习用户默认首页**。  
9. **证据**：README 亮点表与截图 `canvasDark.png` 等。

### 5.11 dramaclaw/dramaclaw — A 工业流水线

1. **定位**：通用 AIGC 视频引擎；剧本到成片；Elastic-2.0。  
2. **主路径**：工业化流水线（脚本→分镜→资产→成片）；强调自有产线。  
3. **IA**：引擎/控制台气质，非无限画布营销。  
4. **节点**：非创作画布优先。  
5. **资产**：故事图等（文档矩阵）。  
6. **生成**：多模型网关。  
7. **栈**：Python FastAPI + React 线索。  
8. **ToIV**：✅ 模型网关抽象、功能矩阵自检表；注意 Elastic 与商用边界。  
9. **证据**：https://github.com/dramaclaw/dramaclaw README。

### 5.12 Tenney95/AI-Canvas-tauri — C 本地画布（master/README 实读）

1. **定位**：本地优先 AI 多模态画布 + AI 短剧 + 资产管理；集成 ComfyUI、对话 Agent、MCP；在线体验 + Tauri 桌面。  
2. **主路径**：同一画布编排文本/图/视频/音频/分镜/全景/手绘；项目可拆**剧集——每一集一张画布**；角色库与素材整剧共用。  
3. **IA**：画布即产品（首屏可试用演示画布）；资产库；独立多轨剪辑；3D 导演台等能力偏桌面完整版。  
4. **节点**：`@xyflow/react`（React Flow 12）；节点类型创作语义为主（非「本地·引擎名」一级菜单叙事）。  
5. **资产**：人物/场景/道具 + 本地素材；插件（JS / 可信 Python）。  
6. **生成**：ComfyUI 工作流；Agent 可查改画布、派只读子智能体、沉淀项目记忆。  
7. **栈**：Tauri 2 + React 19 + React Flow 12 + TypeScript；当前 tip 示例 `v0.10.13`；默认分支 **master**（README 齐全）。  
8. **许可**：**Source-Available**；README 承诺 **GitHub Stars 达 10,000 后自有代码转 MIT**；此前以 LICENSE 为准。  
9. **ToIV**：✅ 分集一画布 + 整剧资产共用；✅ 桌面本地优先；❌ **勿作学习默认首页**；注意许可未 MIT 前的分发边界。  
10. **证据**：README 开篇、开源计划、界面预览、LICENSE 头「Source-Available」。

### 5.13 TypeTale/TypeTale — 多视图后置画布

1. **定位**：成熟免费 Windows AIGC 客户端（短剧/电影/小说推文）。  
2. **主路径**：文案→分镜→生成→剪映等导出；后增画布投影与 OmniBoard。  
3. **IA**：主/编/音/素材多视图；**画布后置**（与 LocalMiniDrama 同课）。  
4. **节点**：支持 ComfyUI；独立 OmniBoard 产品。  
5. **资产**：分镜重排、热门克隆。  
6. **生成**：多厂商+插件。  
7. **栈**：桌面客户端（闭源发行+开源仓库混合叙事，以官方为准）。  
8. **ToIV**：✅ 多视图+专业导出优先于先上自由画布。  
9. **证据**：https://github.com/TypeTale/TypeTale README。

### 5.14 JerrIsTheBesta/AI-Short-Drama-Studio（剧流 Studio）— E（画布默认偏激进）

1. **定位**：本地优先；把剧本→合成整条链放进**一张可视化画布**；**MIT**（AI Cut contributors）。  
2. **主路径**：README 明确「不再区分普通创作和自由画布」——**新建后直接进统一画布**；也可导入素材从任意步开始；**仍可使用经典步骤导航**（文案→分镜→配图→视频→剪辑→导出）。  
3. **IA**：首页「新建」→画布；左侧智能体可规划并调用画布工具；另有剧本库/剪辑/设置。  
4. **节点**：`@vue-flow/core|background|controls|minimap` 全家桶；节点覆盖剧本/人物/场景/分镜/图/视频/合成。  
5. **资产**：可导入图片/视频/音频/Markdown 剧本。  
6. **生成**：多厂商/中转/ComfyUI；配音字幕剪辑；FFmpeg。  
7. **栈**：Vue3 + Electron；桌面默认存「文档/AI-Cut」。  
8. **ToIV**：✅ **「统一画布 + 可退回经典步骤」是 D1-B 的真实样本**；学习站若选 D1-A，只借鉴「可退回」而**不要**默认新建进画布；星级较低，交互细节需实机验证。  
9. **证据**：README「一张画布完成整个创作」条目；package.json vue-flow 依赖。

### 5.15 freestylefly/director_ai — D

1. **定位**：Android「AI漫导」Agent；一句话→剧本→生图→图生视频。  
2. **主路径**：聊天规划→资产→合成；场景级重试。  
3. **IA**：对话卡片+进度。  
4. **节点**：无。  
5. **资产**：关键帧图为视频底座。  
6. **生成**：GLM + CogView + CogVideo 等。  
7. **栈**：Flutter。  
8. **ToIV**：✅ 场景级失败重试；❌ 勿把学习站默认改成纯聊天。  
9. **证据**：`docs/需求补充.md` 等。

### 5.16 ChrisChen667788/wind-comic — A/E + 控片台

1. **定位**：多 Agent 短剧工作室；小说分集；导演控片台；**MIT**。  
2. **主路径**：编剧→导演→Style Bible→角色/场景→分镜→锁脸→嘴型→剪辑。  
3. **IA**：控片台看各环节就绪；React Flow 可视化 Agent 节点+Chat 侧栏。  
4. **节点**：xyflow 展示流水线进度，非纯自由创作图。  
5. **资产**：可复用角色。  
6. **生成**：多供应商；配音口型；多轨时间线。  
7. **栈**：Next.js + `@xyflow/react`。  
8. **ToIV**：✅ 控片台「就绪可视化」；节点=流水线状态而非引擎目录。  
9. **证据**：README；自有 `docs/COMPETITIVE-GAP-*.md`。

### 5.17 Forget-C/Jellyfish — A 生产工作台（任务中心标杆）

1. **定位**：端到端 AI 短剧生产工作台；**Apache-2.0**。  
2. **主路径**：`剧本拆镜 → 镜头准备 → 候选确认 → ready → 生成工作台`；**prepared ≠ generating**。  
3. **IA**：项目/章；资产实体一等公民；**统一异步任务中心可跳回项目/章/镜**。  
4. **节点**：非无限画布默认；生成台围绕镜头。  
5. **资产**：角色/演员/场景/道具/服装集中管理防漂。  
6. **生成**：图/视频任务；批量预检；写回镜头。  
7. **栈**：React+Vite + FastAPI；OpenAPI 生成前端。  
8. **ToIV**：✅ **任务中心上下文跳转 + 就绪态**——直接服务超时「仍在跑」与失败恢复叙事；✅ 候选确认降低乱生成。  
9. **证据**：https://github.com/Forget-C/Jellyfish README Core Capabilities。

### 5.18 anymouschina/TapCanvas — C Agent 画布

1. **定位**：Agent 原生无限画布；影视/漫剧；社区版 **MIT**（商业版独立）。  
2. **主路径**：章节画布上资产/分镜/视频；系统工作流「一键成片」；导演台。  
3. **IA**：画布中心；Agents+Skills+DAG。  
4. **节点**：强类型节点/端口；xyflow。  
5. **资产**：跨章节复用；多状态造型。  
6. **生成**：多模型网关（鲁班 API）。  
7. **栈**：pnpm monorepo TypeScript。  
8. **ToIV**：✅ 画布作专家/Agent 层与系统工作流；❌ 勿当学习默认首页。  
9. **证据**：https://github.com/anymouschina/TapCanvas；演示 https://lluban.cn/about/。

### 5.19 yi1108/printfilm — A 阶段默认 + 分镜画布可选（产品线拆分标杆）

1. **定位**：「把故事做成能播的片子」；**四模块**——AI 漫剧 / AI 短视频 / **工具中心**（单点能力）/ **管理后台**；模板驱动；**MIT**；v0.2.0。  
2. **主路径**：`主题或剧本 → 分镜 → 生图 → 生视频（Seedance 自带口播）→ FFmpeg 合成`；**每阶段可回头重做单镜**；任务离开页面继续跑。  
3. **IA**：  
   - 漫剧：项目列表 → 分集工作台 → 剧本解析 → **分镜编辑与画布** → 资产库。  
   - 短视频：历史 / 分镜工作台 / 成片预览；`full` 或 `image_text` 模板模式。  
   - 工具中心：文生图/图生图/文生视频等**不走完整流水线**。  
   - 管理后台：用户、订单、模板、任务中心、模型路由；开放 `/api/v1`。  
4. **节点**：`frontend` 依赖 `@xyflow/react`；README 明确「解析成镜后进入分镜编辑与画布」——**画布是漫剧分镜子能力，不是默认首页**。  
5. **资产**：角色/场景/道具可复用；两条产品线共用上游生成能力。  
6. **生成**：TokenFree New API；Seedance 口播随片；进程内 scheduler/executor/poller（无独立 Celery）。  
7. **栈**：Python 3.12 FastAPI + SQLAlchemy + PostgreSQL + Redis；React 19 + Vite 8；Docker 一键。  
8. **ToIV**：✅ **学「短剧流水线 / 工具中心 / 管理」拆分**（对标 LumenX Studio/Playground，且更贴国内短剧）；✅ 阶段可回跳+单镜重做；✅ 画布后置到分镜；❌ 勿把计费/订单复杂度塞进学习站 P1。  
9. **证据**：README「核心功能」1–4；工作流程代码块；`docs/EPISODE_RULES.md`；LICENSE=MIT。


### 5.19b waooAI/waoowaoo — C 画布 + 右侧 Assistant（定位纠偏）

> **纠偏（2026-10-22 加深）：** 矩阵旧述「工业级 AI 影视 Agent / 短剧阶段台」**不准确**。README 自述是 **images and videos creative workspace**：右侧 Assistant 发展 brief、上传参考、在 **canvas** 上整理与精修。

1. **定位**：图像/视频 AI 创作工作区（Preview）；**非**火宝式短剧阶段轨。  
2. **主路径**：Assistant 对话产 brief/资产 → 画布上组织参考与生成结果 → 按模型能力选画幅/时长/首帧或首尾帧/参考图模式 → 版本精修保留原版。  
3. **IA**：画布中心 + 右侧助手；UI 中英；日韩仅 README。  
4. **节点**：`@xyflow/react`；Temporal 工作流编排（`@temporalio/workflow`）。  
5. **资产**：画布内整理文件与生成媒体。  
6. **生成**：Preview 暴露 **OpenRouter**（GPT Image 2、Nano Banana、Seedance、MiniMax H3/H3 Max 等）；音乐/配音控件未进 Preview；H3 Max 当前仅单首帧。  
7. **栈**：Next.js 生态 + Temporal + MySQL + MinIO（README：预构建 Docker 免本机装 Node/MySQL/Redis/Temporal/FFmpeg）；自 v0.5.0-beta.1 起 **Elastic License 2.0**。  
8. **ToIV**：✅ 可作**专家层「助手+画布」**参考；❌ **不宜当短剧学习默认壳**；❌ Elastic 2.0 商用分发需法务审；勿在矩阵再写成「短剧阶段 Agent 平台」。  
9. **证据**：README 开篇定位句；Features；LICENSE Elastic 2.0；`package.json` 含 `@xyflow/react` 与 Temporal。

### 5.20 qiukaihui/comfyui-auto-drama — A 编排台

1. **定位**：ComfyUI+H3 自动化短剧流水线控制台；**MIT**；教学/演示向。  
2. **主路径**：8 步：剧本→提示词→参考资产→提交→监控→合成；链式衔接。  
3. **IA**：Web 控制台步骤；**无创作无限画布**。  
4. **节点**：节点感在远程 ComfyUI；控制台是编排。  
5. **资产**：角色四视图/场景/分镜；质检。  
6. **生成**：远程 H3；本地/云 LLM 与生图可切换。  
7. **栈**：Python 标准库控制台 + SQLite。  
8. **ToIV**：✅ **失败码体系 + 质检**；证明「节点感≠必须 React Flow」。  
9. **证据**：https://github.com/qiukaihui/comfyui-auto-drama。

### 5.21 ArcReel/ArcReel — A 可审核 Agent 流水线（剪映导出）

1. **定位**：开源自托管 AI 视频生产工作台；小说/剧本/商品素材 → 角色一致、过程可控、成本可追踪、可继续编辑的短视频；面向漫剧改编、旁白解说、广告带货。  
2. **主路径**：内容分析 → 资产管理 → 分镜 → 媒体生成 → 费用追踪 → 导出；**每个阶段可 Agent 编排，也可人工审核/调整/重做/回滚**。  
3. **IA**：工作台+设置（配置 ArcReel Agent 与文/图/视频）；文档站点完备；**非**列表+竖排画布双视图叙事。  
4. **节点**：未见 xyflow 默认创作画布。  
5. **资产**：跨分镜复用参考图；历史版本回滚。  
6. **生成**：多供应商；费用追踪。  
7. **导出**：**直接合成**或 **导出剪映草稿**（面向中国大陆版剪映；CapCut 兼容性未验证）。  
8. **栈 / 许可**：Docker 自托管；**AGPL-3.0**。  
9. **ToIV**：✅ 学「关键阶段人工确认」与剪映草稿交付（P4）；❌ 禁止拷 AGPL 代码。  
10. **证据**：README 价值主张、流程图「剪映草稿导出」、LICENSE 徽章 AGPL-3.0。


---

## 6. 设计模式抽取（跨项目）

| 模式 | 做法 | 来源 | ToIV 用法 |
|------|------|------|-----------|
| 左轨/Phase 主路径 | 一屏一主 CTA，进度可见 | 火宝、BigBanana、LingGuo | 短剧默认壳 |
| prepared≠generating | 就绪确认后再进生成 | Jellyfish | 修任务中心与超时文案 |
| 任务中心可回跳上下文 | 任务→项目/章/镜 | Jellyfish | 修 `/toiv/tasks` 与侧栏任务中心 |
| 双视图同源 | 列表真源，画布投影 layout | LocalMiniDrama | 治节点乱 |
| 双入口文案 | 「步骤流程」vs「流程画布」 | AID | 导航命名 |
| Studio vs Playground | 流水线 vs 试验台 | LumenX | 拆短剧 vs 市场 |
| 流水线节点非引擎节点 | 节点=创作步骤 | LocalMiniDrama、wind-comic | 重做添加菜单 |
| 关键帧锁定 | 首尾帧再视频 | BigBanana、LMD、Dralo | 分镜生成默认 |
| 面板不盖节点 | 侧检视器/节点下展开 nodrag | LMD 计划 | 修画布壳 |
| 失败码/质检 | 可定位错误 | comfyui-auto-drama | 设定卡失败抽屉 |
| 专业导出 | FCPXML/EDL/剪映 | Openframe、TypeTale | 中期 |
| Agent 画布后置 | 系统工作流挂专家层 | TapCanvas、Toonflow | 非默认首页 |
| 助手+画布工作区 | 右侧 Assistant 产 brief，画布整理媒体 | **waoowaoo** | 专家层；非短剧默认 |
| 产品线/工具中心拆分 | 漫剧流水线 ≠ 短视频模板 ≠ 单点工具 | **printfilm** | 对标工具台 vs 短剧 |
| 可审核流水线+剪映 | 阶段确认+草稿导出 | **ArcReel** | P4 导出 |
| 分集一画布 | 每集画布、整剧资产共用 | AI-Canvas-tauri | 专家/桌面 |

---

## 7. ToIV 差距 → 改法对照表（痛点锚点加厚）

| # | ToIV 已验证痛点 | 竞品反例（谁做对了） | 改法（落到方案阶段） | 验收信号 |
|---|-----------------|----------------------|----------------------|----------|
| G1 | 首页入口三重镜像（侧栏+瓷砖+快捷胶囊） | printfilm 工作台分区；LumenX Studio/Playground；火宝单主 CTA | **P1**：首页只留 1 主 CTA + 最近项目；能力入口只保留侧栏一处 | 新用户 10 秒能指出「下一步」；同能力不出现 3 个入口 |
| G2 | 状态中英混用（如裸 `ready`） | Jellyfish readiness 人话；火宝中文阶段名 | **P1–P2**：状态字典中文化（已就绪/生成中/失败…）+ 四色语义锁定 | UI 无裸英文枚举；色盲友好对比足够 |
| G3 | 任务中心错位（监控页塞「描述需求创建」） | Jellyfish：任务中心=异步追踪+取消+**回跳项目/章/镜** | **P1–P2**：Create 迁出任务中心；任务行可跳回上下文 | 任务中心无创作表单；点任务能回到对应镜头/项目 |
| G4 | 公网 `/toiv/tasks` 404 | 火宝/Jellyfish 深链可达 | **P1**：未登录 → 登录后回跳原 URL；或统一到存活工作室路径 | 登录后打开原深链不再 404 |
| G5 | 画布壳层叠盖（参数浮层盖住节点） | LocalMiniDrama：节点下/内面板 `nodrag`；侧检视器 | **P3**：参数改右侧检视器或节点内展开；禁止大 popover 盖选中节点 | 选中节点时参数面板不遮端口与连线 |
| G6 | 添加菜单=本地引擎目录（「本地·H3/Wan…」当节点类型） | LMD/剧流/wind-comic：节点=创作步骤；融光/printfilm：模型在设置/后台 | **P3**：一级类型=文本/图像/视频/音频/合成/分组；**模型选择进节点设置** | 添加菜单无引擎型号一级项 |
| G7 | 短剧 Tabs 与自由画布双心智未接轨 | AID 双入口文案；LMD 双视图同源；printfilm 分镜画布后置 | **P2–P3**：短剧默认阶段轨；「流水线视图」显式二级入口；数据同源 | 不进自由画布也能成片；流水线视图与列表改动能互相同步 |
| G8 | 想要节点感但 LingGuo 式过纯会「钝」 | LMD 竖排流水线投影；Dralo 模块分治 | **P3**：受控投影画布，不默认 Toonflow 化 | 单集竖排「文→帧→视频」可读 |
| G9 | 绿色语义过载 / 「正在开发」混入主路径 | Jellyfish `prepared ≠ generating`；ai_story 阶段进度诚实 | **P1–P2**：色板锁定；开发中能力进「实验室」或隐藏 | 主路径无「正在开发」死按钮 |
| G10 | 工程文案外露（端口号、BUILD、版本噪音） | 竞品面向创作者文案；运维进设置 | **P1**：端口/版本进设置或 admin | 默认产品面无端口号 |

---

## 8. 推荐产品方向（论证）

### 8.1 一句话

**默认阶段/列表主路径（Jellyfish × 火宝 × BigBanana × LingGuo）+ 可选「流水线画布」双视图（LocalMiniDrama × AID）+ Agent/无限画布仅专家层（Toonflow × TapCanvas）。**

### 8.2 为何不是「全面 Toonflow 化」

- Toonflow/TapCanvas 星高、节点感强，但默认无限画布与 ToIV「学习站、感知/可用优先」冲突；现网用户已反馈「难受/乱」。  
- 高星阶段台（火宝 16.5k、Jellyfish 6.8k）证明**简洁阶段仍是主流完成路径**。  
- LocalMiniDrama 用「画布=投影」同时满足节点感与不乱——证据链最贴 ToIV。

### 8.3 短剧信息架构草图（方案层）

```
项目列表
  └─ 短剧项目（默认）
        ├─ 阶段轨：剧本 → 资产 → 分镜准备(ready) → 生成 → 合成导出
        ├─ 任务中心（只读追踪 + 回跳）
        └─ [可选] 流水线视图（竖排节点投影，同源）
  └─ 自由画布 / Agent 画布（专家入口，侧栏次级）
  └─ 工具台/市场（= LumenX Playground，禁止与首页主 CTA 同权）
```


### 8.4 若选推荐拍板包（D1-A + D2-A + D3-A + D4-C）的完整路径

> 供通读：确认拍板前不编码；下列为产品/交互规格级路径。

**A. 信息架构（稳态）**

```
侧栏（一词一义）
├─ 短剧项目          ← 默认落地
├─ 任务中心          ← 只读追踪 + 回跳（无 Create）
├─ 工具台            ← LumenX Playground / printfilm 工具中心
├─ 自由画布（专家）  ← 次级；可折叠「高级」
└─ 设置              ← 模型/端口/版本/运维

首页
└─ [主 CTA] 新建短剧  |  继续最近项目卡片
   （禁止再放与侧栏同权的市场/画布/工具镜像瓷砖）

短剧项目内
├─ 阶段轨：剧本 → 资产 → 分镜准备(ready) → 生成 → 合成
├─ [二级] 流水线视图（列表↔竖排节点投影，同源）
└─ 任务条：跳到任务中心并带项目/镜上下文
```

**B. 用户一次最小闭环（学习站）**

1. 首页点「新建短剧」→ 进阶段轨「剧本」。  
2. 生成/粘贴剧本 →「资产」提取角色场景 → 确认。  
3. 「分镜准备」：拆镜、挂资产、候选确认 → 状态变「已就绪」。  
4. 「生成」：批量或单镜；失败可人话重试；任务中心可回跳。  
5. 「合成」：站内预览（P2）；导出剪映/FCPXML 留 P4。  
6. （可选）切「流水线视图」看竖排节点，不离开同一数据源。  
7. （可选，专家）侧栏进自由画布做非常规编排——**不在新手引导默认路径**。

**C. 与「全面画布化」的分界**

| 要 | 不要 |
|----|------|
| 阶段默认 + 就绪确认 | 新建即 Toonflow/剧流统一画布 |
| 流水线投影节点 | 添加菜单挂本地引擎名 |
| 工具台独立 | 工具/市场与首页主 CTA 同权 |
| 任务中心回跳 | 任务中心塞创作表单 |
| 站内合成先跑通 | P2 并行上 NLE 导出抢工期 |


---

## 9. 完整改造方案（分阶段 · 交付物 · 验收 · 人天粗估）

> 人天=「熟悉 ToIV 前端的 1 名全栈/前端」粗估，含联调自测，不含大规模视觉重设计。确认拍板后才开编码窗。

### P0 — 调研验收（本文档）｜0 编码人天

| 交付物 | 状态 |
|--------|------|
| ≥15 主竞品矩阵 + 范式 A–E | ✅ |
| 优先清单 9 维深度档案（含本轮名单仓补档） | ✅ |
| 阶段 vs 画布硬证据表 | ✅ |
| 差距→改法对照（G1–G10） | ✅ |
| 推荐方向 + 若选推荐包完整路径 | ✅ |
| 待拍板 D1–D4 | ✅ 待用户选 |

**验收：** 用户通读本节与 §0 摘要后能拍板；确认前不开 P1 编码。

### P1 — 信息架构收敛（首页/侧栏/命名/深链）｜**3–5 人天**

| 项 | 交付物 | 验收标准 |
|----|--------|----------|
| P1.1 | 首页去镜像：1 主 CTA + 最近项目 | 同能力入口 ≤1 处出现在首页 |
| P1.2 | 侧栏一词一义：短剧项目 / 任务中心 / 工具台 / 自由画布(专家) / 设置 | 无「工具箱」「应用市场」双名并存 |
| P1.3 | 端口号、BUILD 噪音撤出默认产品 UI | 默认面无端口；版本进设置 |
| P1.4 | 状态字典中文映射上线（至少任务/镜头常用态） | 无裸 `ready/failed` 英文枚举 |
| P1.5 | `/toiv/tasks` 深链：登录回跳或 301 到存活路径 | 公网登录后深链可达 |
| P1.6 | 任务中心去掉 Create 表单（迁到短剧或工具台） | 任务中心仅列表/筛选/取消/回跳 |

**不做：** 不改生成后端；不上新画布；不做 NLE 导出。

### P2 — 短剧主路径简洁化（火宝 × Jellyfish × LingGuo × printfilm）｜**5–8 人天**

| 项 | 交付物 | 验收标准 |
|----|--------|----------|
| P2.1 | 项目内左轨或顶 Phase：剧本→资产→分镜准备→生成→合成 | 不进自由画布可走完一集最小闭环 |
| P2.2 | `prepared ≠ generating`：候选确认后才批量生成 | 未就绪镜头不可一键狂生（有拦截文案） |
| P2.3 | 任务行回跳到项目/分集/镜头 | 从任务中心 1 点击达上下文 |
| P2.4 | 失败态：人话原因 + 重试；设定卡拒图预览挂钩（若已有） | 失败可理解、可重试 |
| P2.5 | 主路径无「正在开发」死按钮；未就绪能力进实验室或隐藏 | 主 CTA 可点且有反馈 |
| P2.6 | 站内合成预览（火宝级最小） | 能预览拼接结果（导出外置 P4） |

**不做：** 不做竖排流水线画布（留给 P3）；不做剪映/FCPXML。

### P3 — 受控节点体验（LocalMiniDrama × AID × 治 G5/G6）｜**6–10 人天**

| 项 | 交付物 | 验收标准 |
|----|--------|----------|
| P3.1 | 短剧内「流水线视图」二级入口；与列表/阶段**单数据源** | 列表改镜头，画布投影同步（layout 可单独存） |
| P3.2 | 竖排投影：分镜行 ≈ 文本→首/尾帧→视频 | 单镜链路一眼可读；非蜘蛛网 |
| P3.3 | 自由画布添加菜单改创作语义；模型进节点设置 | 菜单无「本地·H3/Wan」一级项 |
| P3.4 | 参数→右侧检视器或节点内 `nodrag` 展开 | 浮层不再盖住选中节点端口 |
| P3.5 | 空画布 ≥3 模板；≥2 节点才露小地图；一键正交整理 | 空态有引导；整理后边不交叉成团 |
| P3.6 | 端口悬停显示业务名 | 悬停可见，不靠猜 |

**不做：** 不默认新建进统一画布（除非用户改拍 D1-B）；不上 3D 导演台。

### P4 — 增强与导出（按需切片）｜**各 2–6 人天/切片**

| 切片 | 来源 | 条件 | 粗估 |
|------|------|------|------|
| 关键帧驱动为分镜默认 | BigBanana / LMD / Dralo | P2–P3 后 | 2–4 |
| 失败码表 + 质检提示 | comfyui-auto-drama | P2 后 | 2–3 |
| 控片台就绪灯 | wind-comic | P2 增强 | 2–4 |
| 剪映草稿或 FCPXML/EDL | ArcReel / Openframe / TypeTale | **D4 若改 B 则提前；推荐仍先站内** | 4–6 |
| Agent 一键成片工作流 | TapCanvas | 仅专家开关 | 4–8 |
| 3D 导演台 | Toonflow / Dralo / AI-Canvas | 专家层远期 | 8+ |

### 9.1 推荐包总工期量级

| 包 | 内容 | 合计粗估 |
|----|------|----------|
| **MVP 感知修复** | P1 + P2 | **8–13 人天** |
| **+ 节点感** | P1 + P2 + P3 | **14–23 人天** |
| **+ 导出/高级** | 再加 P4 选片 | 另计 |

## 10. 风险、不做清单、待拍板

### 10.1 风险

- 同时改首页+短剧+画布 → 回归面大；须按 P1→P2→P3 切片。  
- 误把 AGPL（Openframe/ArcReel）或 NC（火宝/BigBanana）代码/资源拷进仓库。  
- 「全面画布化」短期好看、学习转化差。  
- Dralo/剧流星少，交互可参考结构但勿神化完成度。

### 10.2 不做清单（本方案窗 + 推荐包默认）

- 不重写成 Toonflow / TapCanvas / waoowaoo 克隆（画布默认壳）。  
- 不引入第二套计费/MQ 企业后台（AID / printfilm 后台级）。  
- 不把 ComfyUI 当学习用户默认 UI。  
- 不把 AGPL（Openframe / ArcReel）或 NC（火宝 / BigBanana）代码/资源拷进仓库。  
- 推荐包下：**P2 不做 NLE/剪映导出**（留给 P4）；**P1 不上新画布**。  
- 本调研窗：**不写业务代码、不 commit、不 push、不部署**。

### 10.3 待用户拍板（请选）

**决策 D1 — 默认主壳**  
- **D1-A（推荐）**：短剧阶段轨默认；流水线画布可选；自由画布专家。  
- D1-B：进项目即统一画布（剧流/Toonflow 向）。  
- D1-C：纯阶段、暂缓任何画布投影。

**决策 D2 — 流水线画布出现时机**  
- **D2-A（推荐）**：P3 与列表双视图同源（LMD）。  
- D2-B：仅 AID 式独立「流程画布」入口，不做竖排投影。  
- D2-C：只修自由画布壳层，短剧不做第二视图。

**决策 D3 — 工具台与短剧关系**  
- **D3-A（推荐）**：LumenX 式拆分（Studio vs Playground）。  
- D3-B：保持现状市场与首页同权（不推荐）。

**决策 D4 — 导出优先级**  
- D4-A：先站内合成预览（火宝级）。  
- D4-B：并行规划剪映/FCPXML（TypeTale/Openframe）。  
- **D4-C（推荐）**：P2 只做站内合成；导出放 P4。

---

## 11. 附录

### 11.1 主竞品链接清单

- https://github.com/HBAI-Ltd/Toonflow-app  
- https://github.com/chatfire-AI/huobao-drama  
- https://github.com/Forget-C/Jellyfish  
- https://github.com/dramaclaw/dramaclaw  
- https://github.com/yi1108/printfilm  
- https://github.com/ArcReel/ArcReel  
- https://github.com/shuyu-labs/BigBanana-AI-Director  
- https://github.com/xuanyustudio/LocalMiniDrama  
- https://github.com/LingGuoAI/LingGuo-Drama  
- https://github.com/alibaba/lumenx  
- https://github.com/gzxx-2025/aid-studio  
- https://github.com/Stonewuu/ai-fusion-video  
- https://github.com/xhongc/ai_story  
- https://github.com/freestylefly/director_ai  
- https://github.com/murongg/openframe  
- https://github.com/lnblfkj-del/Dralo-Studio  
- https://github.com/Tenney95/AI-Canvas-tauri  
- https://github.com/TypeTale/TypeTale  
- https://github.com/ChrisChen667788/wind-comic  
- https://github.com/anymouschina/TapCanvas  
- https://github.com/JerrIsTheBesta/AI-Short-Drama-Studio  
- https://github.com/qiukaihui/comfyui-auto-drama  
- https://github.com/waooAI/waoowaoo  

### 11.2 Skill / 提示词附录

- https://github.com/eternityspring/shuohao-skills  
- https://github.com/zenstory-ai/drama-skills  
- https://github.com/liangdabiao/Seedance2-Storyboard-Generator  
- https://github.com/UnderleveledBuilder/awesome-short-drama-skills  

### 11.3 本地材料

- 浅克隆：`/workspace/refs/peers/*`、`/workspace/refs/LingGuo-Drama`  
- 父笔记：`/workspace/refs/competitive-deep/PARENT_PRIMARY_NOTES.md`  
- LocalMiniDrama 画布计划：上游 `docs/plans/2026-06-15-drama-canvas-workflow-plan.md`

### 11.4 修订记录

| 时间 (Asia/Shanghai) | 说明 |
|----------------------|------|
| 2026-10-22 | 初版厚文档：矩阵 23 主行、深度档案、范式、差距、P0–P4、拍板 D1–D4 |
| 2026-10-22 深夜加深轮 | 文首决策摘要；§4.2 阶段vs画布硬证据表；G1–G10 差距→改法；§8.4 推荐包完整路径；§9 交付物/验收/人天；**waoowaoo 纠偏**（画布+Assistant / Elastic 2.0）；printfilm 四模块加深；Openframe 导出细节；AI-Canvas master README；ArcReel 剪映+AGPL；剧流/融光/ai_story/wind 补强；名单仓浅克隆实读 |
| 2026-10-22 总执行合成 | 追加 §14 指针 → `docs/ux/EXECUTION_MASTER_PLAN_20261022.md`；正文 §0–§13 不改 |

### 11.5 本轮浅克隆与笔记

- `/workspace/refs/peers/{waoowaoo,ArcReel,Jellyfish,printfilm,wind-comic,AI-Short-Drama-Studio,ai-fusion-video,director_ai,ai_story,openframe,AI-Canvas-tauri,…}`  
- `/workspace/refs/competitive-deep/BATCH2_DEEP_NOTES.md`、`PARENT_PRIMARY_NOTES.md`  
- 提取缓存：`/workspace/refs/competitive-deep/_round3_extract.json`

---

**下一步**：请用户通读 §0 与 §8.4 后拍板 D1–D4；确认前不开业务编码窗。

---

## 12. 本地 AI 驱动层规格（基于 ToIV 实况）

> 追加日期：2026-10-22（Asia/Shanghai）  
> 事实源：`docs/ux/research/TOIV_LOCAL_AI_CAPABILITY_MAP_20261022.md`（本机 tip `e5307c63` + AGENTS 2026-10-15）  
> 原则：**§0–§11 的 UX 壳层（P1–P3）与本地 AI 驱动层并行、不同层**——改 Tabs/侧栏不替代 Ref2VA/TTS/门禁/舰队契约；反之亦然。

### 12.1 能力地图摘要（10 维）

| 维 | tip 实况一句话 | 相对 UX 推荐包 |
|----|----------------|----------------|
| 1 算力/模型生命周期 | WS 舰队+NAS+hold/VRAM 预算厚；创作者无装模/水位 UX | 不进 P1 菜单；另开 L1 规格 |
| 2 AI 导演契约 | Agent+六角色+Agent Team 人闸**已有代码**；默认仍人手阶段 | 勿把「一键成片」只扔 P4 当从零做 |
| 3 声画一体 | IndexTTS:9200 + pad lipsync + assemble 主链有 | P1–P3 必须给阶段位，不能只谈画面 |
| 4 一致性 | 设定卡/资产锚点/face≥0.45/VLM QA/Ref2VA 已厚 | 升为默认闭环，非 P4 点缀 |
| 5 质量/失败 | 门禁+自愈+hold 强；创作者语义弱 | P2 验收含失败标红/重试 |
| 6 资产/作业 | drama_pipeline 断点重算+雨夜种子+NAS 落盘 | 任务中心回跳对齐实况 |
| 7 混合云边界 | 事实本地优先；降级未产品化 | 设置/空态写清依赖 |
| 8 叙事+R18 | Spark+SVML+D-U1=B | 剧本步接尺度；canvas R18≠短剧默认壳 |
| 9 学习脚手架 | 雨夜样本+dogfood_ci；学员包装薄 | 与 P1 首页示例 CTA 合并 |
| 10 KPI | analytics API 雏形；无产品看板 | 定义 4 个北向指标后再编码 |

**文档滞后校正（勿被 10-08 产品方案 §8 误导）：** tip 上 `DEFAULT_VIDEO_PIPELINE="ref2va"` 已落地并有单测；产品 md 仍写「默认仍是 c、尚未做」。推荐包**不得**再把「切 Ref2VA 默认」当成未开工的主叙事；应改为「核对生产部署=tip + UI 管线选择 + 真机一镜」。INTENT c「配音 TTS」是体验/意图积压——**不是**「没有 IndexTTS」。

### 12.2 与 §0 UX 推荐如何咬合

```
用户默认路径（D1-A）          本地 AI 驱动层（本节 L1–L6）
─────────────────────          ──────────────────────────
短剧阶段轨                     ← 消费 drama_pipeline next_step
  剧本                         ← LLM/SVML + R18 策略
  资产（定妆选角）             ← character_sheet + asset + 人闸
  分镜准备 ready               ← 参考齐/门禁前置（≠ generating）
  生成                         ← 默认 ref2va @ H3:8264；seam=continue→c
  配音 → 对口型                ← IndexTTS:9200 → lipsync（pad）
  合成                         ← assemble 规格归一
任务中心只读回跳               ← jobs + hold 状态中文化
工具台 / 自由画布专家          ← 市场 Comfy / canvas；不抢短剧默认
```

P1–P3 只改信息架构与视图；**不改** worker 端口、不静默改管线默认、不关 IndexTTS。

### 12.3 L1–L6 规格建议（可拍板，未编码）

| ID | 层 | 规格要点 | 建议插入波次 |
|----|----|----------|--------------|
| **L1** | 舰队可见性 | 创作台只读「忙闲/排队/hold 等待」；端口/BUILD 仍对用户隐藏；Admin 保留深潜 | 可并行 P1 文案 |
| **L2** | 导演契约 | 默认=阶段轨人手推进；「剧组/导演」开关启用 Agent Team；**人闸固定三点**：定妆选角确认、镜过脸/VLM 门、合成 assembly_gate | 契约文案 P1；入口 P2/P3 |
| **L3** | 声画阶段 | 阶段轨显式「配音」「对口型」；无声可「跳过口型直接合成」但须标注；BGM 声床 P4 | **P2 必须含位** |
| **L4** | 一致性默认闭环 | 无定妆参考禁止批量视频；过门禁才级联下一镜；失败「改提示优先于原样重抽」 | P2 验收 |
| **L5** | 降级边界 | 设置页三态：WS 可达 / TTS 可达 / H3 可达；缺一则禁用对应 CTA 并给学习站说明 | P1 空态或 P2 |
| **L6** | 学习+KPI | 首页「打开雨夜示例」；推荐组合（大显存=本集群默认）；北向 KPI：首集成片率、不进自由画布完成率、一致性返工次数、本地队列 P50 等待 | 仪表可 P4；种子 CTA 进 P1 |

### 12.4 待拍板 D5–D8（接 D1–D4）

- **D5 — 导演默认**  
  - **D5-A（推荐）**：阶段轨默认；Agent 剧组为显式模式（对齐现有 runner 原则 20）。  
  - D5-B：进短剧即 Agent 自动推进，仅三点人闸。  
  - D5-C：暂缓 Agent Team 产品入口，只用手点阶段。

- **D6 — 声画是否进 P2 主路径**  
  - **D6-A（推荐）**：P2 阶段轨含配音→口型→合成（与产品方案一致）。  
  - D6-B：P2 只到无声拼接；声画整包放 P4。  
  - D6-C：配音要、口型可选跳过。

- **D7 — Ref2VA 文档/生产对齐**  
  - **D7-A（推荐）**：修订产品方案 §8；生产核对 tip 默认；UI 暴露 ref2va|c|c_hybrid。  
  - D7-B：保持文档现状，另开「切默认」工程卡（**不推荐**——与 tip 矛盾）。

- **D8 — 学习站示例**  
  - **D8-A（推荐）**：P1 首页主路径旁「雨夜示例」一键种子。  
  - D8-B：仅文档/DOGFOOD，产品面不放。  

### 12.5 P1–P4 如何插入本地 AI 工作（不冲突）

| 波次 | UX 壳层（已有 §9） | 并行插入的本地 AI（本节） | 不做 |
|------|-------------------|---------------------------|------|
| **P1** | 1 主 CTA、侧栏一词一义、任务中心只读、中文状态、藏端口 | L1 忙闲文案（只读）；L5 依赖三态空态；L6 雨夜 CTA；修订文档 D7 | 改 Comfy 端口；重启战役中 api；关 IndexTTS |
| **P2** | 阶段轨 prepared≠generating；站内合成；主路径无「正在开发」 | **L3 声画步**；L4 定妆门禁 UX；L2 三点人闸文案；任务回跳对齐 shot 状态机 | 把默认管线改回 `c`；进门即自由画布 |
| **P3** | 列表↔竖排双视图；添加菜单创作语义；右侧检视器 | 双视图投影 **refs/音色/门禁状态** 同源字段；检视器显示 pipeline=ref2va|c | 在添加菜单挂「本地·H3:8264」 |
| **P4** | 关键帧、失败码、控片灯、剪映/FCPXML、Agent 一键 | Agent 一键=打开 D5 剧组模式（复用 agent_team_graph）；BGM；KPI 看板；M3 LoRA 仍后置 | 算力商业化计费；开放第三方上架；移动端创作 |

### 12.6 不做清单（本地 AI 层）

- 不把 UX 推荐包宣称为「本地 AI 驱动完成」。  
- 不盲抄 2026-09 `SERVICE_INVENTORY` 端口（H3≠:8195）。  
- 不在学习站默认壳推 Toonflow/TapCanvas「进门即画布」。  
- 不停 IndexTTS:9200；不把 legacy disable unit 当成「产品无配音」。  
- 不把 INTENT c 积压写成「TTS 未建设」。  
- 不把 tip 已存在的 Ref2VA 默认切换重复立项为 P0 代码（除非生产未部署 tip）。  
- 不在未拍板 D5–D8 前开业务编码窗（与 §10.3 纪律一致）。

### 12.7 修订记录（本节）

| 时间 (Asia/Shanghai) | 说明 |
|----------------------|------|
| 2026-10-22 | 初追加 §12：对齐能力地图 10 维；L1–L6；D5–D8；P 波插入表；文档 vs tip Ref2VA 校正 |


## 13. 全栈审计总表（2026-10-22）

> 追加日期：2026-10-22（Asia/Shanghai）  
> 分册：`docs/ux/research/AUDIT_{A,B,C,D}_*_20261022.md`  
> **通读主件：** `docs/ux/research/AUDIT_MASTER_KEEP_OPTIMIZE_REPLACE_20261022.md`  
> 原则：本节只做指针 + 一页摘要；**不推倒** §0–§12。

### 13.1 一页摘要

四路只读审计（算力 / 短剧管线 / 前端壳 / 架构文档）结论一致：**不是换栈，是默认入口、契约与文档对齐。**

| 口径 | 数 |
|------|----|
| 约 KEEP / OPTIMIZE / REPLACE | **~71 / ~54 / ~13** |
| 近窗必做（N1–N10） | **10** |
| 可延后 REPLACE（Dly1–Dly12） | **12** |

**近窗必做（确认后工程卡，本窗仍不编码）：** H3 默认→**:8264**；**fleet_registry+单测**对齐 AGENTS；首页/侧栏主新建→**短剧**；添加菜单→**创作语义**；产品 md 承认 tip **ref2va**；Studio **无台词越过 voice**；Drama **只读收敛**；INVENTORY **过期横幅**；任务 Create 迁出 + 产品面**去端口徽章**。

**明确不做：** 整仓 Toonflow 化；关 IndexTTS；重做「切 Ref2VA 默认」立项；近窗换密 / alembic 切流 / DRT 关停 / 微服务。

**与拍板包：** 加固 D1–D4 + §12 D5–D8（推荐 A 包）；MASTER §0 有咬合表。

### 13.2 分册与 MASTER

| 件 | 路径 |
|----|------|
| MASTER | `docs/ux/research/AUDIT_MASTER_KEEP_OPTIMIZE_REPLACE_20261022.md` |
| A 舰队 | `docs/ux/research/AUDIT_A_FLEET_MODELS_20261022.md` |
| B 管线 | `docs/ux/research/AUDIT_B_DRAMA_PIPELINE_20261022.md` |
| C 壳层 | `docs/ux/research/AUDIT_C_FRONTEND_SHELL_20261022.md` |
| D 架构 | `docs/ux/research/AUDIT_D_ARCH_DOCS_20261022.md` |

### 13.3 修订记录（本节）

| 时间 (Asia/Shanghai) | 说明 |
|----------------------|------|
| 2026-10-22 | 初追加 §13：指向 MASTER；近窗 10 / 可延后 12；不推倒 §0–§12 |

## 14. 总执行方案指针（2026-10-22）

> 追加日期：2026-10-22（Asia/Shanghai）  
> **通读执行入口：** `docs/ux/EXECUTION_MASTER_PLAN_20261022.md`  
> 原则：本节只做指针；**不推倒** §0–§13。

近窗确认拍板后，按总执行方案组织两轨并行：

1. **壳层轨**：Wave Doc（N9∥N6∥N8）→ Default（N1→N2）→ P1 壳 → P2 轨 → P3 节点感（工程卡 + IA 规格）。  
2. **权重轨（Wave M）**：M0→M1→…；与壳层错峰；**用户确认后才下载 / 改 gate**；IndexTTS KEEP；H3 生产 int8 不强制替换。

**拍板包不变：** D1-A + D2-A + D3-A + D4-C + D5-A + D6-A + D7-A + D8-A（详见总方案 §2）。  
**纪律不变：** 确认前不开业务编码；默认不 commit / push / 部署；安全换密等见 MASTER Dly。

深潜材料地图见总方案 §1；竞品加深与 Wave M 细节见 `docs/ux/research/DEEP_DELTA_COMPETITIVE_AND_WAVE_M_20261022.md`。

### 14.1 修订记录（本节）

| 时间 (Asia/Shanghai) | 说明 |
|----------------------|------|
| 2026-10-22 | 初追加 §14：指向 EXECUTION_MASTER_PLAN；两轨并行摘要；不推倒 §0–§13 |
