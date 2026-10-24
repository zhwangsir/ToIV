> ⚠️ **历史快照 · 非现行事实**（DOC_TRUTH_SWEEP 2026-10-23 Asia/Shanghai）。
> 现行集群真源 → [`docs/ops/CLUSTER_TRUTH.md`](../../ops/CLUSTER_TRUTH.md)。命名铁律：一个权重一个 id；served 不得伪装异家族。

# BATCH2 竞品深度笔记（第二路）

> 调研日：2026-10-22（Asia/Shanghai）  
> 用途：供父会话合并进 ToIV 总方案。禁止业务代码 / commit / push。  
> ToIV 痛点锚点：**入口乱 + 画布节点感不适** → 默认宜「阶段/列表主路径」；画布仅作受控管线投影或专家层。  
> 父笔记已读：`/workspace/refs/competitive-deep/PARENT_PRIMARY_NOTES.md`；Toonflow / Dralo 父会话结论已并入。

---

## 0. 范式总表（BATCH2 + 父笔记交叉）

| 项目 | UI 范式判定 | 默认主路径 | 画布？ | 许可 | 栈提示 |
|------|-------------|------------|--------|------|--------|
| HBAI-Ltd/Toonflow-app | **纯画布** | 无限画布 | 默认强制 | MIT | Bun + Electrobun + 插件/MCP |
| alibaba/lumenx | **Studio+Playground 双模块 / 阶段流水线** | Studio 管线 | 未在 README 宣称无限画布 | MIT | Next.js + Python + Tauri |
| shuyu-labs/BigBanana-AI-Director | **阶段主路径（Phase 01–05）** | Phase 阶段台 | 否（九宫格/导演台） | CC BY-NC-SA | Docker 镜像为主；源码冻结 |
| Stonewuu/ai-fusion-video | **阶段+Agent 工作区** | 项目/剧本/分镜 | 未强调无限画布 | MIT | Java Spring + Next.js |
| lnblfkj-del/Dralo-Studio | **阶段模块 + 可选无限画布** | 剧本→分镜→成片 | React Flow 可选 | Apache-2.0 | React+AntD+FastAPI+SQLite |
| Tenney95/AI-Canvas-tauri | **纯画布（多模态节点）** | 画布即产品 | React Flow 12 | Source-Available（10k★转 MIT） | Tauri2+React19 |
| dramaclaw/dramaclaw | **工业流水线工作台（含节点画布）** | 流水线+故事板 | DESIGN 含 canvas-node | Elastic 2.0 | Python+uv+gateway |
| TypeTale/TypeTale | **分镜列表多视图 + 后期加画布** | 分镜主视图 | 9.0 新增画布/OmniBoard | 商业客户端（README 未开源码） | Windows 客户端+Comfy |
| JerrIsTheBesta/AI-Short-Drama-Studio | **统一画布优先（仍保留经典步骤）** | 新建即进画布 | Vue Flow | MIT | Vue3+Electron |
| freestylefly/director_ai | **聊天驱动阶段（移动端）** | Chat→剧本确认→并发生成 | 无画布 | 未在 README 声明（pubspec publish_to none） | Flutter |
| ChrisChen667788/wind-comic | **多 Agent 流水线 + 控片台/时间线** | 一句话→成片管线 | 创作工坊有 Agent 流图 | MIT | Next.js+SQLite/PG |
| xhongc/ai_story | **线性 Pipeline 阶段台** | 主题→文案→分镜→图→视频 | 导演模式开发中 | CC BY-NC-SA | Django+Celery+Vue |
| LingGuoAI/LingGuo-Drama | **线性 Tabs/Steps** | 项目→剧本→实体→分镜→合并 | 无 | MIT | Vue3+TDesign+Go+Asynq |
| qiukaihui/comfyui-auto-drama | **Comfy 流水线控制台** | 8 步控制台 | 无 | MIT | Python stdlib + ComfyUI H3 |
| Forget-C/Jellyfish | **阶段主路径（准备态→生成）** | 剧本拆镜→准备确认→生成 | 无无限画布 | Apache-2.0 | FastAPI+Vue/pnpm+MySQL |
| anymouschina/TapCanvas | **Agent 原生纯画布** | 无限画布+Agents | React Flow | MIT（new-api 为 AGPL） | Hono+Agents Bridge+new-api |
| yi1108/printfilm | **模板驱动阶段台（双产品线）** | 主题/剧本→分镜→图→视频→成片 | 漫剧有分镜画布提及 | MIT | FastAPI+React+PG+Redis |

---

## 1. HBAI-Ltd/Toonflow-app

**UI 范式：纯画布（默认强制无限画布）**  
**对照 ToIV 一句：** 默认纯画布会加重「节点乱」——ToIV **不宜**把无限画布当唯一主路径；可学插件化与 Agent/MCP 扩展。

### 1 定位
开源 AI 短剧/漫剧/短视频创作平台；~高星（社区口径约 18k★ 量级，以 GitHub 实时为准）。把剧本、资产、视频片段放进同一张无限画布。

### 2 创作主路径
文本节点写剧本分镜 → 图节点做角色/场景 → 连参考生成视频 → 画布整理下载。另有「灵感模式」、3D 导演台、插件市场。

### 3 UI 信息架构
- 首页 / 灵感创作 / 创作画布（深浅主题）/ 资产（角色场景道具）/ 3D 导演台 / 插件市场。  
- **没有**独立「阶段进度轨」作为默认壳；阶段感靠节点与分组表达。

### 4 节点/工作流范式
内置节点+工具；插件可扩展节点；开放 Agent（提示词/工具/A2A）；MCP 连接外部工具。节点菜单与分组操作在截图区有明示。

### 5 资产模型
画布内组织角色、场景、道具；项目工作区 `data/workspaces/`；Docker 卷 `toonflowData`。

### 6 生成能力
自由接入第三方 API / 本地 ComfyUI / LLM；官方 TF-Router 中转；示例用 Seedance 2.0 / GPT Image 2 / Claude。

### 7 技术栈
Bun 后端（1.3.14）；Electrobun 桌面；Android APK（内置 Bun）；Docker/服务器；端口 **3000 无独立登录鉴权**（公网需反代鉴权）。

### 8 对 ToIV 可抄 / 不可抄
- **可抄：** 插件市场与开放 Agent/MCP；多端部署；FFmpeg 内置；「灵感模式」与工作区概念。  
- **不可抄：** 默认强制无限画布作唯一主路径；无鉴权直接公网暴露。

### 9 证据链接
- https://github.com/HBAI-Ltd/Toonflow-app  
- README（master）：无限画布默认、MIT、不追溯 AGPL→Apache→MIT、端口 3000 无鉴权。

---

## 2. alibaba/lumenx

**UI 范式：Studio（pipeline-first）+ Playground（独立生成台）**  
**对照 ToIV 一句：** 「Studio vs Playground」拆分强烈对标 ToIV「剧作管线 vs 市场/引擎试玩」——主路径是阶段流水线，不是节点乱画布。

### 1 定位
阿里 StarLotus 开源的 AI 原生短漫剧 & 视频创作平台：「Render Noise into Narrative」。

### 2 创作主路径（Studio）
剧本分析 → 可控美术指导 → 多模型资产（角色三视图/场景/道具）→ AI 分镜视频（I2V/R2V+批量抽卡）→ TTS → 时间线合成导出。

### 3 UI 信息架构
- Studio：分镜工作台（阶段式）。  
- Playground：`/#/playground` 独立创作台（6 种生成模式）。  
- Settings / API Docs（17177）。

### 4 节点/工作流范式
**Pipeline-first**，非 React Flow 无限画布。模型 catalog YAML→JSON；任务并发与状态追踪在 Playground。

### 5 资产模型
本地优先 `output/`；可选 OSS 镜像+签名 URL；角色/场景/道具结构化提取。

### 6 生成能力
DashScope 中心（Wan 2.7、Kling V3、Vidu Q3、PixVerse、CosyVoice/Qwen3-TTS、Qwen 3.7）；MuleRun（Seedance 2.0、GPT-Image-2）；可切 Kling/Vidu 原厂。

### 7 技术栈
Python 3.11+ / Node 18+；`frontend/` Next.js；`src/apps/comic_gen` + `playground`；Tauri 打包脚本；Docker。

### 8 对 ToIV
- **可抄：** Studio/Playground 产品切分；模型 catalog 架构；本地优先+可选 OSS。  
- **不可抄：** 过强 DashScope 绑定作为唯一默认（ToIV 需多渠道网关）。

### 9 证据
- https://github.com/alibaba/lumenx  
- USER_MANUAL.md、README.md、docs/playground PRD。

---

## 3. shuyu-labs/BigBanana-AI-Director

**UI 范式：阶段主路径（Phase 01–05 工业化）**  
**对照 ToIV 一句：** Phase 命名 + 关键帧锁定是「阶段台」教科书；**不要**学其闭源镜像路径与 CC BY-NC-SA。

### 1 定位
「大香蕉」AI 漫剧工场；Script-to-Asset-to-Keyframe；反抽卡式。

### 2 创作主路径
项目中心 → 季/集 → Phase01 叙事 → Phase02 一致性资产 → Phase03 镜头工作台（九宫格/首尾帧）→ Phase04 CutOS 成片 → Phase05 提示词管理。

### 3 UI 信息架构
项目管理、世界观、导演工作台、镜头九宫格、CutOS 剪辑——**明确阶段 IA**，非自由画布。

### 4 节点/工作流范式
关键帧驱动（Start/End + Veo 插值）；双视频链路（I2V / 首尾帧）；无「无限画布节点图」主叙事。

### 5 资产模型
定妆照 + 衣橱 + 场景概念图 + 道具；IndexedDB 本地；跨集复用。

### 6 生成能力
默认 AntSK API 聚合（文本/图/视频）；公开版 Docker 镜像。

### 7 技术栈
公开仓库以说明 + `docker-compose.yaml` 为主；**后续版本不再公开同步源码**；Electron 桌面约 122MB；在线 director.tree456.com。

### 8 对 ToIV
- **可抄：** Phase 01–05 命名与「先资产后镜头」；九宫格选构图；关键帧锁一致性。  
- **不可抄：** CC BY-NC-SA；闭源镜像策略；强绑单一中转。

### 9 证据
- https://github.com/shuyu-labs/BigBanana-AI-Director  
- README 版本发布说明（源码冻结）、Phase 截图区。

---

## 4. Stonewuu/ai-fusion-video（融光）

**UI 范式：阶段工作区 + Agent 侧栏（非纯画布）**  
**对照 ToIV 一句：** 项目/剧本/分镜结构化主路径清晰，Agent 是增强而非入口——对「入口乱」是正面参照。

### 1 定位
Agent 驱动的视频创作平台；项目、剧本、分镜、素材、图/视频生成统一工作区。

### 2 创作主路径
项目与团队 → 按分集/场景组织剧本 → 拆解分镜 → 镜头素材生成 → 素材库；Agent 流式对话推进。

### 3 UI 信息架构
系统管理（初始化向导、用户角色）；设置页集中模型与存储；Agent 工作区展示推理/工具/任务状态。

### 4 节点/工作流范式
AgentScope（Skill、MCP、子 Agent）；会话持久化；**未**把无限画布写成默认壳。

### 5 资产模型
项目素材统一管理；本地磁盘或 S3 兼容对象存储。

### 6 生成能力
OpenAI 兼容 / Anthropic / Gemini / DashScope / Ollama；图片视频多服务按能力选用。

### 7 技术栈
Next.js 16 + React 19 + TS + Tailwind 4 + Zustand；Java 21 + Spring Boot 3.5 + Spring AI + AgentScope + MyBatis-Plus；MySQL 8 + Redis + Flyway；Docker Compose + Nginx。

### 8 对 ToIV
- **可抄：** Agent 工作区与工具权限；Flyway/团队协作；前后端分离部署模式。  
- **不可抄：** 过重 Java 单体若 ToIV 已定栈不同；勿默认暴露弱密码（compose 示例需改）。

### 9 证据
- https://github.com/Stonewuu/ai-fusion-video  
- README 功能表 / 技术栈 / AGENTS.md。

---

## 5. lnblfkj-del/Dralo-Studio

**UI 范式：阶段模块 + 可选无限画布（一体产品）**  
**对照 ToIV 一句：** 最接近「阶段模块 + 可选画布」；方案须写清**默认落点在阶段台**，无限画布勿默认露出以免节点感。

### 1 定位
开源 AI 短剧创作工作台：剧本→角色场景→分集分镜→无限画布→AI 图/视频→多轨剪辑。

### 2 创作主路径
上传/粘贴剧本或灵感 → 故事设定/人物/分集大纲 → 制作准备资产 → 分集镜头 → 画布连线生成 → 多轨成片。

### 3 UI 信息架构
资产中心、任务中心、模型渠道、智能体/Skill、市场探索、3D 分镜导演台；单机浏览器访问 `127.0.0.1:8000`。

### 4 节点/工作流范式
React Flow；节点：提示词 / 人物 / 场景 / 图 / 视频 / 声；视频节点区分参考图、首帧、尾帧；3D 导演台 Three.js / R3F。

### 5 资产模型
SQLite `data/app.db` + `storage/`；项目素材可在画布与项目间复用。

### 6 生成能力
自配 OpenAI 兼容 / Gemini / Anthropic 等；Worker 异步任务；FFmpeg 媒体处理。

### 7 技术栈
apps/web（React+Vite+AntD+TanStack Query+Zustand）；apps/server（FastAPI+SQLAlchemy+Alembic+SQLite）；apps/director-upstream；pnpm monorepo；Apache-2.0；**无官方安装包**（源码启动）。

### 8 对 ToIV
- **可抄：** 任务中心；多轨成片；视频节点首尾帧语义；3D 导演台边界（程序化人物）。  
- **不可抄：** 默认把用户丢进空画布；R3 内测边界需诚实标注。

### 9 证据
- https://github.com/lnblfkj-del/Dralo-Studio  
- docs/FEATURES.md、ARCHITECTURE.md、README 流程图 SVG。

---

## 6. Tenney95/AI-Canvas-tauri

**UI 范式：纯画布（多模态节点桌面应用）**  
**对照 ToIV 一句：** 能力极强但「画布即家」——与 ToIV 节点不适痛点同构，只宜作专家层参考，不宜默认首页。

### 1 定位
本地优先 AI 多模态画布；短剧/资产管理/分镜；ComfyUI + Agent + MCP。

### 2 创作主路径
画布上组织文本/图/视频/音频/分镜/全景/3D 导演台 → Comfy/云模型生成 → 剧集分集（每集一张画布，角色库共用）→ 内置多轨剪辑。

### 3 UI 信息架构
资产库 Tab、帧动画编辑器、对话 Agent（独立窗口）、帮助中心；在线体验 vs 桌面完整能力分界清晰。

### 4 节点/工作流范式
React Flow 12；远景轻节点；AI 应用节点（Agent/MCP 创建）；用户 JS/Python 插件；MCP stdio/HTTP。

### 5 资产模型
IndexedDB + 项目媒体落盘；角色卡多参考图；`.aicanvas` 项目包。

### 6 生成能力
ComfyUI 多服务器、RunningHub、Dreamina、ONNX、CCC 多 Key、火山账本等。

### 7 技术栈
Tauri 2 + Rust；React 19；Zustand 5；Tailwind 3；Vitest。许可：Source-Available（承诺 10k★ 转 MIT）。

### 8 对 ToIV
- **可抄：** 剧集=多画布共享资产；插件沙箱；MCP 按需发现；设置冲突检测。  
- **不可抄：** 默认纯画布 IA；非 OSI 许可商用风险。

### 9 证据
- https://github.com/Tenney95/AI-Canvas-tauri  
- README v0.10.13、doc/文档导航.md。

---

## 7. dramaclaw/dramaclaw

**UI 范式：工业流水线工作台（DESIGN 含 canvas-node，但营销非「无限画布」）**  
**对照 ToIV 一句：** 学 gateway 抽象与功能矩阵 checklist；暗色密集仪表盘可参考，但 Elastic 2.0 禁托管 SaaS 需注意。

### 1 定位
团队自用工业化短剧生产线开源；「Tear down the wall」；Elastic License 2.0（可商用自托管，禁转售托管 SaaS；需 Powered by 角标）。

### 2 创作主路径
脚本→故事板→资产→成片全链；Official / Custom / Hybrid 模型模式经 RelayClaw 或 bundled gateway。

### 3 UI 信息架构
暗色优先信息密集工作台（DESIGN.md）；节点画布、故事板、生成队列、长任务面板；下载/登录页为营销例外。

### 4 节点/工作流范式
DESIGN 定义 `canvas-node`；故事图 Cognee；任务 in-process（无 Ray/Redis/Celery）。

### 5 资产模型
本地文件系统 + SQLite；`ce-data` volume；无强制 Postgres。

### 6 生成能力
DC-Media 契约经 dramaclaw-gateway（New API fork）：ComfyUI、MiniMax、Seedance、Kling、Jimeng、Gemini、Sora、Suno 等。

### 7 技术栈
Python 3.11–3.12 + uv；frontend pnpm；Docker 三服务 api/newapi/web；端口 8080/8780/3000。

### 8 对 ToIV
- **可抄：** 模型网关与 Official/Custom/Hybrid；功能矩阵行作验收清单；DESIGN token 纪律。  
- **不可抄：** Elastic 对托管的限制若 ToIV 要 SaaS；过度信息密度可能劝退新手。

### 9 证据
- https://github.com/dramaclaw/dramaclaw  
- README、DESIGN.md、docs/en/concepts/features.md。

---

## 8. TypeTale/TypeTale（字字动画）

**UI 范式：分镜列表多视图为主；9.0 起叠加画布/OmniBoard**  
**对照 ToIV 一句：** 长期以「分镜表+章节」为主路径，画布是后来叠加——证明阶段主路径可做成完整商业产品；但仓库几乎只有 README（闭源客户端），难抄实现。

### 1 定位
小说推文 / AI 短剧 / AI 电影 AIGC 客户端；承诺基础功能永久免费；官网 typetale.top；OmniBoard omniboard.tv。

### 2 创作主路径
文案预处理 → 智能分镜 → 角色/场景提取 → 提示词推理 → 图/音频/视频 → 对口型 → 导出剪映；支持视频克隆、剧本作品模式。

### 3 UI 信息架构
主视图 / 编辑视图 / 音频视图 / 素材视图 / 章节；9.0 新「画布」视图（分镜可投影到画布）；3D 导演台；AI 侧栏 Codex/Agent。

### 4 节点/工作流范式
可视化工作流编排（条件分支）；ComfyUI 工作流；Python 插件（panel/project/app 三级）；后处理模板链。

### 5 资产模型
角色/场景/物品 + Sora 客串上传；个人知识库；素材库预设；剪映草稿。

### 6 生成能力
SD WebUI / ComfyUI / MJ / Nano Banana / Qwen；Wan/Veo/Sora/即梦；EdgeTTS/GPTSoVITS/IndexTTS2；算力云镜像。

### 7 技术栈
Windows 客户端为主；README 仓库无应用源码（仅说明）；飞书文档 wiki。

### 8 对 ToIV
- **可抄：** 多视图（主/编辑/音频/素材）IA；章节=集；提示词四类（图/视频/首/尾）；剪映导出；插件三级。  
- **不可抄：** 闭源商业绑定；即梦 CLI 会员墙；把画布当后来补丁却默认露出。

### 9 证据
- https://github.com/TypeTale/TypeTale  
- README 更新日志 6.x–9.0（画布与 OmniBoard）。

---

## 9. JerrIsTheBesta/AI-Short-Drama-Studio（剧流 Studio）

**UI 范式：统一画布优先，仍保留经典步骤导航**  
**对照 ToIV 一句：** 「新建即进画布」会复现节点感；但其「经典步骤仍可用」是双视图雏形——ToIV 应**反转优先级**：默认步骤，画布可选。

### 1 定位
本地优先、模型自由接入的开源 AI 视频创作工作台；MIT；Windows Electron 安装包。

### 2 创作主路径
配置 LLM → 接入助手粘贴 API 文档 → 新建项目告诉智能体 / 或经典步骤：文案→分镜→配图→视频→剪辑导出。另有视频复刻、智能口播、纯剪辑入口。

### 3 UI 信息架构
首页多入口（普通/复刻/自由画布/口播/剪辑）；统一画布左侧智能体；设置多套模型。

### 4 节点/工作流范式
Vue Flow；节点：剧本/人物/人设图/场景/场景图/故事看板/分镜图/视频/音频/导出/预览；分组框承载流程；自由图/视频节点。

### 5 资产模型
桌面「文档/AI-Cut」；项目 `project.json`；公共图片库；Web IndexedDB。

### 6 生成能力
H3/万相/APIMart/AutoDL/Zealman/ComfyUI；TTS/音乐；FFmpeg.wasm 本机合成。

### 7 技术栈
Vue 3 + TS + Pinia + Vue Flow + Electron + FFmpeg.wasm。

### 8 对 ToIV
- **可抄：** 接入助手（粘贴 API 文档配模型）；局部重做节点；视频复刻/口播产品线切分。  
- **不可抄：** 默认统一画布为唯一新建落点。

### 9 证据
- https://github.com/JerrIsTheBesta/AI-Short-Drama-Studio  
- FEATURES.md、README。

---

## 10. freestylefly/director_ai

**UI 范式：聊天驱动阶段（Flutter 移动端）；无无限画布**  
**对照 ToIV 一句：** 入口极简（一句话）但靠「剧本确认门」避免全自动黑盒——可学确认门；README 名实不符需警惕。

### 1 定位
「An AI Agent that turns text ideas into videos」；Flutter App（Android 能力：MediaMuxer 合并、相册保存）。

### 2 创作主路径
Chat 识别视频意图 → GLM 剧本草稿 → 角色三视图 → **用户确认剧本** → 并发生成分镜图+视频 → 可选合并。

### 3 UI 信息架构
`chat_screen` / `screenplay_review_screen` / `asset_pack_screen` / `scene_media_viewer` / `settings_screen` / `log_viewer`。

### 4 节点/工作流范式
无节点画布；Provider 协调 DraftController / ScreenplayController / VideoMergerService。

### 5 资产模型
Hive 本地；CharacterSheet 三视图 URL；Screenplay scenes 状态机。

### 6 生成能力
智谱 GLM-4.7 剧本；Gemini 图；Tuzi Sora 视频；豆包 ARK 识别（文档所述）。

### 7 技术栈
Flutter + Provider + Dio + Hive + video_player；**根 README 误留 Vite 模板文案**（证据不足处已标）；docs 中文流程完整。

### 8 对 ToIV
- **可抄：** 生成前剧本确认门；角色三视图锚点；场景并行度配置。  
- **不可抄：** 把聊天当唯一专业工作台；忽视桌面复杂项目管理。

### 9 证据
- https://github.com/freestylefly/director_ai  
- docs/视频生成完整流程.md、docs/人物一致性实现方案.md、pubspec.yaml、lib/screens/*。  
- **未在 README 找到**正式产品说明（README 为模板噪音）。

---

## 11. ChrisChen667788/wind-comic（青枫漫剧）

**UI 范式：多 Agent 流水线 + 导演控片台 + Cinema 时间线（非自由无限画布主路径）**  
**对照 ToIV 一句：** 「制作/平台层」护城河（节奏门禁、EDL、协作）对 ToIV 极有启发；创作工坊的 Agent 流图≠让用户手拖节点生产。

### 1 定位
一句话→整部短剧（剧本/角色/分镜/配音/时间线/mp4）；MIT；BYO LLM。

### 2 创作主路径
编剧→导演→Style Bible→角色/场景→分镜（vision 审计）→视频多引擎竞速→TTS→嘴型→剪辑烧字幕。

### 3 UI 信息架构
创作工坊、导演台、11-tab 控片台、Cinema 时间线、节奏分析、成片质检、模板市场、团队积分、API 健康看板。

### 4 节点/工作流范式
多 Agent 契约（types/agents.ts）；导演台 3D 摆位→提示词站位锁+布局草图；片段重拍；PACING_GATE 可选硬拦截。

### 5 资产模型
可复用角色（三视图+DNA）；SQLite↔Postgres 双驱动；模板市场含音色。

### 6 生成能力
12+ 媒体引擎路由；Veo/Kling/MiniMax/Vidu/Seedance/Grok 等 BYO；失败诚实降级为 animatic。

### 7 技术栈
Next.js；Yjs 实时协作；Docker demo `MOCK_ENGINES=1`；大量 Vitest。

### 8 对 ToIV
- **可抄：** Style Bible；节奏/冲突审计门禁；EDL/FCP7/AAF 导出；API 健康看板；成本归因。  
- **不可抄：** 过度营销对比表需自行复核；全自动一句话对专业用户可能失控。

### 9 证据
- https://github.com/ChrisChen667788/wind-comic  
- README.zh-CN.md、docs/COMPETITIVE-GAP-*.md。

---

## 12. xhongc/ai_story

**UI 范式：线性 Pipeline 阶段台**  
**对照 ToIV 一句：** 阶段进度+可回滚最贴近「不乱」；导演模式仍开发中——说明阶段台可先于画布交付。

### 1 定位
从文案到视频一键生成的故事视频平台。

### 2 创作主路径
输入主题 → 文案改写 → 分镜 → 图片 → 运镜规划 → 图片转视频 → 导出；支持暂停/恢复/重试/阶段回滚。

### 3 UI 信息架构
项目管理看板；提示词管理；模型配置；导演模式 UI 截图（开发中）。

### 4 节点/工作流范式
Pipeline 责任链；Celery 异步；非无限画布。

### 5 资产模型
Docker volume `./storage`；项目模板复用。

### 6 生成能力
多 LLM/多生图/多视频平台；负载均衡策略。

### 7 技术栈
Django + Celery + Redis + Vue；Docker 镜像 xhongc/ai_story-*；CC BY-NC-SA。

### 8 对 ToIV
- **可抄：** 阶段回滚与进度追踪；提示词集版本。  
- **不可抄：** CC BY-NC-SA；过黑盒一键若无确认门。

### 9 证据
- https://github.com/xhongc/ai_story  

---

## 13. LingGuoAI/LingGuo-Drama（灵果）

**UI 范式：线性 Tabs/Steps（阶段主路径）**  
**对照 ToIV 一句：** 干净阶段 UI、弱节点感——父笔记已标为正面参照。

### 1 定位
开源 AI 短剧/动漫工作台；二次开发友好。

### 2 创作主路径
创建项目 → 剧本 → 提取角色/场景/道具 → 生成实体图 → 拆分镜与帧提示词 → 分镜图/视频 → FFmpeg 合并。

### 3 UI 信息架构
Vue3 + TDesign 管理后台；异步任务可观测。

### 4 节点/工作流范式
**无无限画布**；Asynq 任务队列。

### 5 资产模型
MySQL `spirit_fruit`；实体图绑定。

### 6 生成能力
多 provider 环境变量（OPENAI/GETGOAPI/VOLCES/MINIMAX 等）。

### 7 技术栈
Go Gin GORM Cobra；Vue3 Vite TDesign Pinia；Redis Asynq；Docker Compose；MIT；默认 admin/123456（部署必改）。

### 8 对 ToIV
- **可抄：** 线性步骤文案与实体提取顺序；Go worker 分离。  
- **不可抄：** 弱默认密码；功能深度弱于 DramaClaw/Wind。

### 9 证据
- https://github.com/LingGuoAI/LingGuo-Drama  

---

## 14. qiukaihui/comfyui-auto-drama

**UI 范式：Comfy 流水线控制台（8 步，无画布）**  
**对照 ToIV 一句：** 证明「控制台步骤」可驱动 H3 工业化生产，无需节点画布。

### 1 定位
ComfyUI + MiniMax H3 自动化短剧/漫剧流水线演示/教学。

### 2 创作主路径（8 步）
创建项目 → 脚本生成 → 改写 → 规范提示词 → 参考资产（四视图/场景/分镜）→ 预览确认 → 提交生成（T2V/I2V/R2V+链式）→ 记录导出/一键合成。

### 3 UI 信息架构
单文件 `console/index.html` + Python stdlib 服务；资产状态表；失败码体系。

### 4 节点/工作流范式
远程 ComfyUI 工作流模板；chain_daemon 链式推进；**无**前端节点编辑器。

### 5 资产模型
SQLite `console.db`；素材/输出目录；config.json。

### 6 生成能力
H3 ref2va；本地 LM Studio / 云端 LLM；Boogu 或云端生图；视觉质检。

### 7 技术栈
Python 3.10+ 零第三方控制台；MIT。

### 8 对 ToIV
- **可抄：** 规范提示词六段式；资产批准态；失败码；链式末帧衔接。  
- **不可抄：** 演示级 UI 直接当产品壳。

### 9 证据
- https://github.com/qiukaihui/comfyui-auto-drama  

---

## 15. Forget-C/Jellyfish（增补优先）

**UI 范式：阶段主路径（准备态机 → 生成工作区）**  
**对照 ToIV 一句：** 「shot preparation / readiness」把确认做成一等公民——直接缓解入口乱与过早生成。

### 1 定位
End-to-end AI short drama production workspace；一致性一等公民；Apache-2.0。

### 2 创作主路径
`script breakdown → shot preparation → candidate confirmation → shot ready → generation workspace`。

### 3 UI 信息架构
项目/章节仪表盘；镜头准备与确认；生成工作区；全局任务中心（可跳回项目/章/镜）；模型与提示词基础设施。

### 4 节点/工作流范式
**无无限画布**；异步任务取消/恢复；OpenAPI 驱动前后端契约（`front/src/services/generated/`）。

### 5 资产模型
角色/演员、场景、道具、服装共享实体；候选接受/忽略/链接已有实体。

### 6 生成能力
多 provider/多模型；镜头级图视频编排；批量预检。

### 7 技术栈
backend uv + uvicorn FastAPI；front pnpm；MySQL + Redis + RustFS；Docker Compose 端口 7788/8000。

### 8 对 ToIV
- **可抄：** readiness 状态机；候选确认 vs 生成分离；任务中心上下文回跳；OpenAPI 生成客户端。  
- **不可抄：** 无——整体与 ToIV 阶段台方向高度同向。

### 9 证据
- https://github.com/Forget-C/Jellyfish  

---

## 16. anymouschina/TapCanvas（增补优先）

**UI 范式：Agent 原生纯画布**  
**对照 ToIV 一句：** Agent 自动建节点可减轻手拖，但默认无限画布仍会「节点感」——ToIV 可学 Agents Bridge，勿学默认落点。

### 1 定位
面向 AI 影视/漫剧的 Agent 原生无限画布社区版；在线商业版独立；MIT（apps/new-api 为 AGPL）。

### 2 创作主路径
画布强类型节点组织文档/角色/分镜/媒体 → `POST /public/agents/chat` DeepSeek Harness Bridge → Skills/子代理/工作流 → 任务 Workers → 可验证交付；系统工作流 v135「一键成片」需自配模型。

### 3 UI 信息架构
Web :5175；鲁班 API 管理台 :4455；导演台独立 app（DirectorDesk）；图片对比节点等。

### 4 节点/工作流范式
React Flow；可复用 DAG；异步 Worker；失败恢复；Agent 装配/冲突判定。

### 5 资产模型
项目化素材库、版本、生成历史、delivery evidence；跨章节角色造型状态。

### 6 生成能力
new-api 网关动态下发；HeyRoute/Droid 号池等渠道补丁。

### 7 技术栈
pnpm monorepo：apps/web、hono-api、agents-cli、new-api、director-desk；Postgres；Prisma。

### 8 对 ToIV
- **可抄：** Agents Bridge 与 Skills；工作流版本保留历史资产；渠道号池；诚实版本边界文案。  
- **不可抄：** 社区版默认画布主路径；AGPL 网关许可证传染需隔离评估。

### 9 证据
- https://github.com/anymouschina/TapCanvas  
- README、AI_RUNTIME_ARCHITECTURE.md。

---

## 17. yi1108/printfilm（增补优先）

**UI 范式：模板驱动阶段台（短视频流水线 + 漫剧分集台）**  
**对照 ToIV 一句：** 双产品线共用生成能力 + 模板入口，入口清晰；漫剧「解析成镜后进分镜编辑与画布」表明画布在阶段之后。

### 1 定位
「把故事做成能播的片子」；AI 漫剧 + AI 短视频；MIT；v0.2.0。

### 2 创作主路径
主题/剧本 → 分镜 → 生图 → 生视频（Seedance 自带口播）→ FFmpeg 成片；短视频可选 `full` / `image_text`。

### 3 UI 信息架构
工作台；短视频历史/分镜/成片；漫剧项目列表/分集/剧本解析/分镜编辑/资产库；工具中心；管理后台。

### 4 节点/工作流范式
进程内 scheduler/executor/poller（无 Celery）；模板驱动；单镜可重做。

### 5 资产模型
漫剧角色/场景/道具库；见 docs/EPISODE_RULES.md。

### 6 生成能力
TokenFree New API（文字/图/视频）；Seedance 口播一体；开放 `/api/v1`。

### 7 技术栈
Python 3.12 FastAPI SQLAlchemy PG Redis；React 19 Vite；admin Tailwind+shadcn；Docker 公开镜像。

### 8 对 ToIV
- **可抄：** 双产品线信息架构；模板目录；进程内任务平台；管理后台模型路由。  
- **不可抄：** 过绑单一 TokenFree（应抽象网关）。

### 9 证据
- https://github.com/yi1108/printfilm  

---

## 18. 扩搜新发现（真同类，排除播放器）

| 仓库 | 为何同类 | 初判范式 | 备注 |
|------|----------|----------|------|
| Forget-C/Jellyfish | 短剧生产工作台+准备态 | 阶段主路径 | BATCH2 已深挖 |
| anymouschina/TapCanvas | 漫剧/影视无限画布+Agent | 纯画布 | BATCH2 已深挖 |
| yi1108/printfilm | 漫剧+短视频模板流水线 | 阶段台 | BATCH2 已深挖 |
| ChrisChen667788/wind-comic | 短剧多 Agent 成片 | 流水线+控片台 | BATCH2 已深挖 |
| JerrIsTheBesta/AI-Short-Drama-Studio | 短剧统一画布 | 画布优先 | BATCH2 已深挖 |
| （父笔记已有）huobao / LocalMiniDrama / AID / Openframe | — | 阶段/双视图 | 见 PARENT_PRIMARY_NOTES |

排除：hongguo 类播放器、纯白板（excalidraw/tldraw）、纯渲染库。

---

## 19. 给 ToIV 总方案的合并要点（第二路结论）

1. **默认主路径投票：** 阶段/列表（BigBanana Phase、Jellyfish readiness、LingGuo、LumenX Studio、printfilm、comfyui-auto-drama、ai_story）远多于纯画布成功叙事；纯画布高星项目（Toonflow、TapCanvas、AI-Canvas-tauri、剧流默认画布）与用户「节点不适」同构。  
2. **双视图黄金样本：** LocalMiniDrama / AID（父笔记）+ 剧流「经典步骤仍可用」+ TypeTale「分镜投影到画布」→ ToIV 建议 **默认阶段，画布=投影/专家**。  
3. **一致性三件套反复出现：** 定妆/三视图、衣橱/造型态、首尾帧/关键帧（BigBanana、Dralo、director_ai、TypeTale）。  
4. **基础设施可抄：** 模型网关（DramaClaw/TapCanvas/融光）、任务中心（Jellyfish/Dralo）、Studio vs Playground（LumenX）、节奏门禁与 EDL（Wind）。  
5. **许可雷区：** CC BY-NC-SA（BigBanana、ai_story）、Source-Available（AI-Canvas）、Elastic 禁托管 SaaS（DramaClaw）、AGPL 子模块（TapCanvas new-api）。

---

## 20. 深度达标自检

| 目标 | 9 维写满？ | README/结构证据 | 备注 |
|------|------------|-----------------|------|
| Toonflow-app | ✅ | README 全文 | 父会话结论并入 |
| lumenx | ✅ | README+USER_MANUAL | |
| BigBanana | ✅ | README | 源码冻结已标 |
| ai-fusion-video | ✅ | README | |
| Dralo-Studio | ✅ | README+apps 结构 | 父会话并入 |
| AI-Canvas-tauri | ✅ | README+src | |
| dramaclaw | ✅ | README+DESIGN | DESIGN 偏视觉规范 |
| TypeTale | ✅ | README（无源码） | 实现细节有限 |
| AI-Short-Drama-Studio | ✅ | README+FEATURES | |
| director_ai | ✅ | docs+lib/screens | README 模板噪音已标 |
| wind-comic | ✅ | README.zh-CN | |
| ai_story | ✅ | README | |
| LingGuo-Drama | ✅ | README | |
| comfyui-auto-drama | ✅ | README | |
| Jellyfish | ✅ | README | 增补 |
| TapCanvas | ✅ | README | 增补 |
| printfilm | ✅ | README | 增补 |

---

*End of BATCH2_DEEP_NOTES.md*
