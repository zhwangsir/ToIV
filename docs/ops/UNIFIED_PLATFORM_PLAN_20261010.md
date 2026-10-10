# ToIV 统一创作平台 · 深度调研与重构方案（2026-10-10）

> 结论先行：**继续在经典壳上修补没有出路，推倒重写风险不可承受；推荐「目标态架构一次定义、绞杀者模式渐进交付」——以 canvas 为唯一壳的收敛式重构（方案 B），四个阶段（P0–P4）把平台收敛为「一个入口、一次登录、一个项目空间、剧本到成片不出壳」。**
> 依据：本地代码摸底（融合债 8 条实证）+ 13 家商业产品调研（可灵/即梦/Vidu/海螺/LibTV/RunningHub/小云雀/MagicLight/纳逗Pro/Updream/FlovaAI/TapNow/SlotLab 未检索到）+ 12 个开源项目（11 个已克隆到 `tmp/research-oss-20261010/`，Toonflow/ViMax/AI-NovelFlow 三个深读完成）。
> 立场约束（长期拍板不变）：ToIV 仅本地自用/学习，不公开运营；算力=自有 GPU 机队；开发模式=单用户+AI 会话批。

---

## 1. 现状诊断：为什么「还是两个项目」

### 1.1 应用盘点（摸底实证）

| 应用 | 路径/端口 | 形态 |
|---|---|---|
| 经典 web | `apps/web` :3100 | Next.js 单页壳，`?view=` 切 17 个视图（home/image/video/audio/fusion/imageEdit/videoEdit/animatic/avatartalk/canvas/studio/dub/library/entities/resources/market/settings）+ `/drama/[id]`、`/agent-runs` 等 |
| core API | `apps/api` :8090 | FastAPI，65 个路由模块（管线/市场/任务/agent/音频编排/H3 studio…） |
| admin | `apps/admin` :3200 | Next.js 单页 |
| canvas（原 BeefTV） | `apps/canvas/web` + `backend` :8290 | Vite+React19 SPA（antd6+tailwind4）+ Go gin；自由画布/导演模式/本地模型配置/插件；已内嵌 `/toiv/{drama,market,tasks,agent,library}` 五页 |
| 桌面壳 | `apps/canvas/backend/cmd/desktop` | Wails，同 SPA |
| 小程序 | `MiniProgram` | uni-app，对接 :8090 |

### 1.2 融合资债（跳转感的 8 个技术根因，均有代码证据）

1. **双壳整页跳转**：进入画布=`location.replace("/studio/")`（`apps/web/app/page.tsx:501`）；画布回经典=外链 `/drama/:id?classic=1`（`apps/canvas/web/src/pages/toiv/drama-detail.tsx:184`）。
2. **双导航壳**：经典 SideRail/BottomNav vs canvas UserLayout 侧栏，信息架构不同名不同序。
3. **双 API 前缀/双数据平面**：`/api/*`→FastAPI、`/studio/api/*`→Go（`apps/web/next.config.mjs:84-96`）；canvas 独立 schema。
4. **三凭证认证链**：ToIV JWT（localStorage）+ `toiv_session` HttpOnly cookie（exchange 发放）+ HMAC 签名头 `X-ToIV-User`（`studioIdentity.ts`/`toiv_jwt.go`）。
5. **双样式体系**：经典=自研 token+22 个手写 CSS；canvas=antd6+tailwind4 三层 token（`UI_FUSION_OPT_BACKLOG.md` 自认「ui-v3 紫强调与中性 accent 仍两套」）。
6. **双部署链路**：web 与 canvas 两次构建两套产物（`deploy/deploy.sh:200-245`）。
7. **双入口边缘**：openresty 与 frps 手工分址。
8. **残留死码**：gate(:8281) 已退役仍有注释与 `toiv_gate.go` 尸体。

**判定**：M1–M4 的融合把「入口」统一了，但壳、认证、数据面、样式、部署全是双轨——这不是文案问题，是架构中间态。「像跳转」是双壳的必然结果。

### 1.3 功能面缺口（对标商业产品后）

行业已在 2026 年收敛出标配形态（见 §2.1）：**剧本→自动分镜→资产引用逐镜生成→配音字幕→剪辑合成，全部发生在同一个工作区，且人类画布与 Agent 双入口等价**。对照 ToIV：

| 能力 | 行业标配 | ToIV 现状 |
|---|---|---|
| 剧本→分镜自动化 | 各家均有（小云雀/纳逗Pro/LibTV/MagicLight） | ❌ 无（分镜靠人工+设定卡局部） |
| 多视角分镜扩展（单图→多景别） | 可灵/Kling | ❌ 无 |
| 角色三视图/多参考槽位 | 小云雀/Flova/Vidu(7主体)/海螺(9图3视频3音频) | ◐ character_asset 有锚点/变体，无三视图规范、参考槽位未参数化 |
| 跨镜连续性（首尾帧/机位树） | ViMax/各家 | ◐ splice2 首尾帧拼接已拍板为默认；无系统性衔接 |
| 镜头级重生成/N 候选+质检门禁 | 各家 | ◐ 设定卡有双候选+face 门禁；未标准化到镜头级 |
| 时间线/粗剪 | 即梦时间轨/TapNow 播放列表 | ❌ 无（concat/mix 管线有，无编辑面） |
| 字幕对齐 | 各家 | ◐ whisper 在库，无产品化 |
| BGM/音效 | 各家 | ◐ tts/separate/concat/mix 有，sfx 501 |
| 断点续跑/任务对账 | NovelFlow/StoryClaw | ◐ E-7 双保险思想有，覆盖不全 |
| Agent 全流程代操 | 可灵 MCP/LibTV Skill/Toonflow 节点即工具 | ◐ 对话助手+工具卡有；与创作面未同构 |

---

## 2. 调研结论

### 2.1 商业产品矩阵（13 家；2026-10 在线调研）

| 产品 | 形态 | 分镜自动化 | 一致性方案 | 编辑器 | 对 ToIV 最大启示 |
|---|---|---|---|---|---|
| 可灵 Kling 4.0 | Agent+Canvas 节点 | 一键分镜+多视角分镜扩展 | 15 项多模态参考/10 关键帧 | 灵活画布+对口型+主体编辑 | 「多视角分镜扩展」低成本高收益；MCP/CLI 把平台变 Agent 可调度产能 |
| 即梦 Dreamina | 故事模式+时间轨 | 剧本→分镜→时间轨 | 多模态参考 | 智能画布四件套（重绘/扩图/消除/抠图） | 「时间轨分镜→逐镜→合成」是漫剧最可复制骨架；局部重绘应接自有模型 |
| Vidu Q4 | 模板+多主体参考 | 弱 | **7 主体一致性**（业界最多之一） | 弱（无剪辑） | 多主体参考而非训练=轻路径，与 ref2va 同路可深化；「拍同款」模板库 |
| 海螺 Hailuo H3 | 全能参考 | 弱 | 9图+3视频+3音频 分层参考槽 | 视频编辑 | **H3 开源=与自有机队唯一同型旗舰**；参考槽位分层（角色/风格/动作/音频）的参数设计直接抄 |
| LibTV（LiblibAI） | 无限画布五类节点+Agent Skill | 剧本→分镜节点+剧情推演四宫格/多机位九宫格 | 角色造型室+三视图 | 智能剪辑 | 与我们 canvas+agent 架构最直接对标；四宫格/九宫格=低成本预制节点（注：其「开源」说法存疑） |
| RunningHub | 云 ComfyUI+工作流市场 | 模板承载 | 工作流内解决 | 节点编辑器 | 任意工作流一键封装 API=工作流产品化输出（对 RH 应用市场有直接启示） |
| 小云雀（字节） | **一句话→短剧 Agent 全自动+可介入细粒度编辑** | Agent 自动分镜表（对白+情绪） | 三视图+故事板资产绑定 | 自由画布 | 「全自动+随时接管」双模式；三视图工程化 |
| MagicLight | 长片管线（50min） | 多场景自动转换 | 全片主角稳定 | 对口型/克隆音色/字幕 | 模板库降门槛；长片分集思想 |
| 纳逗Pro（爱奇艺） | 剧本空间+画布双态+**近 70 个垂类智能体虚拟剧组** | AI 导演手册/镜头草稿 | 角色库+真人参考+IP库 | 无限画布+Workbench | 「把影视工序拆成智能体」的组织学；CLI |
| Updream（B站） | 类 ComfyUI 画布+**Agent 节点**+技能上画布 | Skill 承载 | 真人参考 | 画布内剪辑 | 技能=可分发资产（"AI 视频界 GitHub"） |
| FlovaAI | story-first 线性管线 | storyboard/shot/audio 三层文档结构 | Multi-View 角色基准 | 镜头层+音频层 | 三层文档结构对齐专业审阅流程，适合「生成即制片」的数据模型 |
| TapNow | Agentic Canvas | 模板工作流 | 宣传稳定 | **播放列表节点**（排序/时长/合并预览/导出） | 播放列表式汇编=时间线的最小可行形态，先做这个 |
| SlotLab | **未检索到可靠公开资料**（疑似与「新片场 ShotLab」混淆，建议核实拼写） | — | — | — | — |

**四条行业共性规律**：
1. **双入口已收敛**：人类节点画布 + Agent（Skill/MCP/CLI）是 2026 标配形态，且两者操作同一数据面。
2. **一致性走多主体参考，不走训练**（Vidu 7 主体/可灵 15 项/海螺 9-3-3）；分层参考槽位是参数化共识。
3. **剧本→分镜自动化 + 逐镜生成 + 画布内合成**是漫剧工作流的公约数。
4. 商业模式趋同积分制；对自用平台无意义，**值得抄的全在创作流与数据组织**。

### 2.2 开源项目矩阵（12 个；11 已克隆 `tmp/research-oss-20261010/`）

| 项目 | 星/活跃 | 定位 | 对我们最值钱的部分 |
|---|---|---|---|
| **Toonflow-app** | 17.0k / 活跃 | 开源漫剧创作台（Vue3+Bun，本地优先） | 已深读，见 §2.3 |
| **ViMax**（HKUDS） | 12.6k / 活跃 | agentic 多镜头视频框架（Python） | 已深读，见 §2.3 |
| **AI-NovelFlow** | 113 / 活跃 | 小说→视频，**H3+ComfyUI 同栈** | 已深读，见 §2.3 |
| story-claw | 28 / 活跃 | ComfyUI+LTX 短剧五阶段管线 | ①阶段感知参考图（服装/道具实质变化才换参考）②每片段过 VLM 质检查幻脸自动重生成 ③进度 JSON 断点续跑 |
| Pixelle-Video | 28.8k | 主题→短视频引擎 | 「工作流即配置」：图像/视频/TTS 全部可选 ComfyUI 工作流，编排层怎么写的样本 |
| ai-short-drama | 49 | Next.js SaaS 短剧平台 | 四类 BullMQ worker 池+SSE 任务流+20+ 模型网关的任务系统划分 |
| Cyanyi-Drama | 4 / 高频提交 | LangGraph 漫剧制片流水线 | 六阶段制片工作区+草图预校验（生成前低成本闸门）+幂等媒体任务系统 |
| MoneyPrinterTurbo | 129k | 短视频自动化 | 模型接入面与四入口（Agent/WebUI/API/CLI）；素材是库存视频，非叙事生成，仅参考 |
| NarratoAI | 11.3k | 解说+自动剪辑 | LLM+VLM 选段→拼接→IndexTTS 配音→字幕→导出剪映草稿 |
| ShortGPT | 8.0k / 停更 20 月 | 概念源头 | **Editing Markup Language**：JSON 剪辑描述让 LLM 直接生成/操作时间线——时间线 DSL 灵感 |
| VACE（阿里） | 4.0k / 停更 | All-in-one 视频编辑模型 | 参考帧+控制信号的统一输入格式，ComfyUI 原生节点可用，H3 之外的一致性 A/B 候选 |
| StoryDiffusion | 6.5k / 停更 | 一致自注意力连环画 | 经典算法基线，经 ComfyUI 包装版验证即可 |

### 2.3 深读提炼：可直接引入的工程模式（附来源证据）

**来自 Toonflow（产品组织）**
- 画布=一个带魔数标记的 JSON 文件 + 每节点独立 `assets/<id>/` 目录 + GC 扫描（`panels/workspace/canvasFile.ts`）——项目工件组织范式。
- 节点用 `defineOptions(handles)` 声明**类型化端口**（IMAGE/VIDEO/AUDIO/STRING），连线即数据流（`packages/nodes/videoGenerationNode/src/index.vue:117`）。
- **节点即工具**：节点把 getConfig/setConfig/setPrompt/generate 注册给 Agent，人机同构操作同一数据面（同文件 355-426 行）——Agent 与创作面融合的正解。
- 模型**能力矩阵**（mode/durationResolutionMap/audio/ratios）驱动 UI 自动收敛参数（`apps/server/src/utils/media/generation.ts`）。
- Provider=用户可替换 TS 文件（vm 沙箱+宿主注入），**「AI 引导写适配器」接本地 ComfyUI**（`providerPrompt.ts`）——产品不必内置每家协议。
- 多参考 `{{ref N}}`+referenceOrder 持久化（`packages/nodeShared/src/useNodeReferences.ts`）。
- Agent 读画布用分页+路径投影+64KiB 上限防上下文爆炸（`packages/skills/canvas/SKILL.md`）。
- 团队清单 `team.json`+成员提示词+delegates → A2A AgentCard（`packages/teams/storyboardTeam/team.json`）。

**来自 ViMax（叙事管线）**
- **机位树首帧衔接**：LLM 构建 camera tree（parent_cam_idx/missing_info），子机位等父镜头首帧的 asyncio.Event，先出 transition video 再 scenedetect 取新机位图、按 missing_info 替换角色（`agents/camera_image_generator.py:122-233`）——多镜连续性的工程解。
- 三视图注册表（front/side/back 各带描述，side/back 以 front 为参考生成，`character_portraits_registry.json`）。
- ReferenceImageSelector 限选 ≤8 张并生成 "Image i:" 编号提示词。
- **N 候选并行 + VLM 方向校验择优**，落选留痕（`pipelines/script2video_pipeline.py:586-651`）。
- 工件落盘即断点续跑；候选图 selection.json 记 sha256 指纹，重跑只补失败候选。
- provider=class_path 动态加载+自动挂 RateLimiter（rpm/rpd），协议仅两方法（`tools/render_backend.py`）——H3 机队接入范本（其 H3 支持仍在 roadmap，我们先发优势）。
- 被依赖镜头优先调度 + frame_events 解耦「帧先行、视频等待」。

**来自 AI-NovelFlow（同栈实证：H3+ComfyUI+FastAPI）**
- **资产先行、分镜引用资产**：Novel—Character/Scene/Prop（各含 image_url/appearance/章节范围），Shot 以 JSON 引用资产；生图时多角色合并 merged_character_image，并按资产组合**自动选工作流类型**（单/双/三参考、scene/prop 组合，`constants/workflow.py:15-52`）。
- H3 全走自托管 ComfyUI 工作流：`first_last/three_frame/four_frame_video_minimax_h3_ref2va.json`（含 lightx2v 加速 LoRA）；**node_mapping 声明式注入**（prompt/first/last/keyframe_1..3/megapixels/duration 节点 ID+extension 约束，`constants/workflow.py:132-167`）——单帧/首尾/多关键帧零代码切换。
- prompt 组装模板化：h3_single/first_last/multi_keyframe 三模板 + `_audit_final_h3_prompt` 程序审计（`video_director_ai.py:281`）。
- **reconcile_active_tasks**：重启后按 ComfyUI prompt_id 对账恢复已完成 clip 续跑剩余窗口（`task_service.py:560-660`）。
- LLM 输出程序校验+带 previous_failed_attempts 重试；每 Shot 独立 API 可改可重生成；`skip_llm_when_prompt_exists` 复用人工确认结果。

---

## 3. 目标产品定义（ToIV Studio v2）

**一句话**：本地自用的漫剧制片厂——「一个项目空间里，从剧本到成片，人和 Agent 干同样的活」。

**核心循环**：写/改剧本 → 生成与维护资产（角色/场景/道具）→ 自动分镜+人工调整 → 逐镜生成（图→视频→配音→字幕，N 候选+质检）→ 汇编时间线 → 成片版本化交付。全程可被 Agent 代操（同一操作面），全程断点可续。

### 3.1 目标 IA（项目中心六工作区 + 自由画布 + Agent）

```
一级导航：项目 | 资产库(全局) | 任务中心 | 市场(RH, 冻结维护) | 设置(admin 收编)
项目工作区（六段，Cyanyi/小云雀/Flova 式）：
  ① 剧本   章节/分场/台词编辑；LLM 改编、续写、拆场（DSv4）
  ② 资产   角色/场景/道具卡：三视图、锚点、色板、变体（character_asset 升级为项目级）
  ③ 分镜   LLM 自动拆镜（对白+情绪+景别）；多视角扩展；表格/卡片双视图
  ④ 镜头   每镜状态机：图→视频→配音→字幕；N 候选+VLM 门禁；单镜重生成
  ⑤ 时间线 播放列表式汇编（排序/时长/预览）→ 真时间线（字幕轨/双音轨/转场）
  ⑥ 成片   版本、导出、发布到作品库、封面
并行工作面：自由画布（类型化端口节点，可与六段互转）；Agent 对话（工具=六段全部操作）
```

### 3.2 关键能力规格（对标后定的验收口径）

- **一致性**：角色三视图注册表（front 以锚点生成，side/back 以 front 为参考）；镜头引用按「阶段感知」换参考（story-claw）；ref2va/fl2va 多参考槽位参数化（角色/风格/动作分层，抄海螺 9-3-3 的槽位命名）。
- **分镜自动化**：LLM 输出结构化分镜 JSON（镜号/景别/机位/时长/出场资产/台词/情绪），程序校验+重试（NovelFlow 式）；单角色图→多景别候选（多视角分镜扩展，走现有 img2img 管线）。
- **镜头生成**：工作流模板+node_mapping 库（单帧/首尾帧/2-4 关键帧，H3 ref2va/fl2va）；N 候选+DSv4-VL 质检门禁（脸/服/场景一致性+幻脸检测）；产物落盘+指纹缓存，重跑只补失败。
- **汇编**：P3 先交付播放列表式（TapNow 思路，复用 concat/mix 管线），真时间线后置；字幕=台词↔whisper 对齐；BGM/音效=audio_orchestrate 扩展（sfx 若无引擎，用素材库+ffmpeg 混音落地，**不做假的**）。
- **任务系统**：统一 Job 模型（顶层 DB id 已是管线 C 契约）；reconcile 对账续跑；任务中心单入口（`/toiv/tasks` 升级为全平台任务枢纽）。
- **Agent**：六段操作全部工具化（对话助手现有工具体系扩展）；画布节点即工具（Toonflow 式）；技能/团队清单化（team.json）。

### 3.3 明确不做 / 冻结

- 小程序四步送审（用户侧，后置）；RH 市场扩容（冻结在 83，重心转向创作本体）；社区/UGC（既定拍板）；c_hybrid 长视频连续生成（已拍板维持 splice2）；多租户（保持默认关）；商业积分/计费（自用无意义）。

---

## 4. 技术路线：三个选项与推荐

| | A 渐进修补（现状路线） | **B 收敛式重构（推荐）** | C 推倒重写 |
|---|---|---|---|
| 思路 | 继续在经典壳嵌 canvas | **canvas 为唯一壳**，经典功能按目标 IA 内迁，绞杀者式退役经典 web | 全新仓库全新应用 |
| 跳转感 | 永远存在（双壳是结构性的） | 消除 | 消除 |
| 复用 | 最高 | 高（canvas 壳+FastAPI 引擎+管线+机队全保留） | 低 |
| 风险 | 低但慢性失血，功能债继续滚 | 中（回归风险靠 parity 清单+feature flag 控制） | 高（单用户+AI 开发无法承受长双轨） |
| 终态质量 | 差 | **≈C 的终态** | 最好但可能死在半途 |

**推荐 B，且吸收 C 的终态定义**：先用本文 §3 把目标 IA/数据模型冻结为「v2 契约」，然后逐页绞杀。**不做 big bang**。

### 4.1 目标态架构（文字版）

```
壳层    canvas SPA（React19+antd6+tailwind4，统一 token）＝Web 与 Wails 桌面同壳
        经典 Next.js 退役为：login+官网静态+过渡期 feature-flag 回退路由
认证    单 ToIV JWT（HttpOnly cookie），Go 侧同验；废除 exchange/HMAC 三凭证链（兼容期保留只读）
数据面  单 PG 实例：core schema + canvas schema → 渐进合并项目域实体
        （Project/Drama/Asset/Shot/Job/Render/Task）；文件工件统一 assets/<project>/<entity>/<id>/ 规范
API     FastAPI=引擎 API（生成/管线/任务/市场）；canvas Go=画布文档/BFF（文件/插件/画布 JSON）
引擎    不变：H3(:8264 生产/:8195 试验)、ComfyUI LB、LongCat、Wan-Animate、IndexTTS、
        whisper 集群、audio-sep、DSv4 LLM、embedding；新增：工作流模板库（node_mapping）
部署    单链路：deploy.sh 一条命令构建 SPA+api+桌面；/ 与 /api 单域名分址
```

**关键决策依据**：canvas 栈更现代且有自由画布/Agent/插件/桌面四件套（行业标配形态的底座已在我们手里）；FastAPI 引擎层 65 模块与 GPU 机队是多年资产，任何路线都不动它。

---

## 5. 分阶段路线图（绞杀者，每阶段可独立回滚）

> 估口径：一个「会话批」≈ 一个高强度 AI 开发日。总量 ≈ 9–13 批。

### P0 地基（1 批）——先止血，再动骨
- 统一登录：单 JWT 直发，删 exchange/HMAC 链（保留 30 天兼容读）。
- 快赢工程债：`/api/apps` limit+分页、画布市场分页、images/dub IDOR owner 强制开闸（`1816f320` 已合未部署→部署）。
- 冻结 v2 契约文档（本文件 §3/§4.1 细化为 API/DB 草案）；删除 gate 死码与 `toiv_gate.go`。
- **验收**：一次登录直达项目空间零中间跳；市场分页 <1s；IDOR 回归绿；契约文档评审通过。
- **回滚**：feature flag 恢复 exchange。

### P1 项目中心（2–3 批）
- canvas 侧新「项目工作区」骨架（六段空壳+路由）；剧详页从 `/toiv/drama` 升级为工作区入口。
- 迁移：设定卡+character_asset 面板、管线 B/C 创建流、任务中心升级为全平台枢纽（GenerationTask+ToIV jobs 一屏——吸收 UI_FUSION_OPT_BACKLOG M2/统一时间线两项）。
- **验收**：新剧「创建→设定卡→出图→出片→看任务」全程不出 canvas 壳；经典端对应视图访问量归零（埋点或日志判断）。
- **回滚**：路由开关指回经典五页。

### P2 叙事管线 v2（3–4 批）
- 剧本→分镜自动化（LLM JSON 契约+校验重试）；多视角分镜扩展。
- 资产先行数据流（Shot 引用 Character/Scene/Prop）；三视图注册表；阶段感知参考。
- 工作流模板库（node_mapping：单帧/首尾/多关键帧 × fl2va/ref2va）；机位树 lite（首尾帧衔接的工程化包装）。
- N 候选+VLM 质检门禁标准化；产物指纹缓存；reconcile 对账续跑全覆盖。
- **验收**：3000 字剧本→≥8 镜自动分镜（人工可改）；单镜重生成 ≤2 击；中断后 resume 恢复率 100%（kill -9 演练）；单镜候选质检误放行 <5%（抽检）。
- **回滚**：管线 v1（现管线 C/splice2）保留并行一版。

### P3 编辑器与音频（2–3 批）
- 播放列表式汇编（排序/时长/预览/合成）；字幕对齐（台词+whisper）；BGM 混音；sfx 素材库方案落地。
- 对口型（H3 audio conditioning 已有 T8 能力，产品化开关）。
- 真时间线（若播放列表不够用再上 Remotion 级方案，决策点后置）。
- **验收**：一集 8–12 镜从镜头区到导出 mp4 全程平台内完成，零外部工具。
- **回滚**：保留 concat/mix 旧出口。

### P4 收敛收尾（1–2 批）
- 经典 web 17 视图处置：已迁移的退役，长尾（R18 经典流、avatar talk 等）按「迁 or 存档只读」逐个拍板；admin 收进设置或保留独立。
- 设计 token 统一完成（消灭双样式）；部署单链路；桌面壳同步发版。
- **验收**：经典 web 仅剩 login/官网；桌面与 Web 同版本号一次构建。

---

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| 经典功能迁移回归（最大风险） | 每页迁移前建 parity 清单；feature flag 双跑；生产验证走 P-2 纪律（截图+BUILD_ID） |
| AI 会话批开发漂移 | 每阶段验收硬门禁（本文件口径），不过不放行下一阶段 |
| GPU 排队挤爆（N 候选×多镜） | QC 门禁前置降候选数；夜间批；候选数按机队空闲自适应 |
| 范围蔓延（越做越大） | §3.3 不做清单冻结；新想法一律进 backlog 不插队 |
| 双写期数据不一致 | 过渡期 canvas/core 各管各域，跨域只读 API；合并放 P4 |
| 单人不可持续 | 本方案本身就是「AI 会话批」可执行粒度；文档先行（本文件即交接契约） |

## 7. 现有资产处置映射

**保留不动**：GPU 机队与全部引擎服务；FastAPI 引擎层；管线 C/splice2；RH 市场 83 应用；小程序。
**升级**：character_asset→项目级资产库；任务中心→全平台枢纽；对话助手→六段工具化 Agent；canvas 画布→类型化端口+节点即工具。
**退役**：经典 web 17 视图（逐个）；gate 残骸；三凭证链；双部署链路；（评估）canvas Go 层远期并入。
**待拍板**：R18 经典流去向（P4）；真时间线技术选型（P3 末）；canvas Go BFF 远期去留。

## 8. 本周即可执行的快赢（不等 P0 排期）

1. `/api/apps` limit 实装+画布市场分页（已挂账的 0.4）。
2. IDOR owner 强制（`1816f320`）部署开闸。
3. 删 gate/`toiv_gate.go` 死码（低风险清理）。
4. 把本方案 §3.3「不做清单」同步进 UI_FUSION_OPT_BACKLOG 防漂移。

---

## 附录 A：调研来源（节选）

- 商业产品：kling.ai / jimeng.jianying.com / vidu.cn / hailuoai.com（H3 开源生态页）/ liblib.tv / runninghub.ai / xiaoyunque.com / magiclight.ai / nadoupro.iqiyi.com / updream.cn / flova.ai / tapnow.ai；SlotLab 未检索到可靠资料（疑似=新片场 ShotLab，aigc.xinpianchang.com，待用户核实拼写）。
- 开源（已克隆 `tmp/research-oss-20261010/`）：Toonflow-app、ViMax、AI-NovelFlow、story-claw、ai-short-drama、Cyanyi-Drama、Pixelle-Video、MoneyPrinterTurbo、NarratoAI、ShortGPT、VACE、StoryDiffusion（部分克隆仍在后台进行，完成为止均留作研究素材；**勿提交进仓库**）。
- 本地摸底：`apps/web/app/page.tsx`、`next.config.mjs`、`app/studio/[[...slug]]/route.ts`、`apps/canvas/web/src/pages/toiv/*`、`services/toiv/client.ts`、`backend/internal/transport/http/toiv_jwt.go`、`docs/ops/UI_FUSION_PLAN.md`、`UI_FUSION_OPT_BACKLOG.md`。

## 附录 B：与既有计划的关系

- 本文件取代 `UI_FUSION_PLAN.md` 作为融合线的总纲（该文件 M1–M4 已收口，历史价值保留）；`UI_FUSION_OPT_BACKLOG.md` 未做 4 项全部吸收进 P1/P3/P4。
- 与 `DRAMA_UI_PLAN.md`（管线 C/c_hybrid 线）不冲突：管线 v2 以管线 C 契约为基座演进，splice2 仍默认。
- 拍板请求：① 走方案 B？② P0 本周启动？③ R18 经典流 P4 前给去向意见。
