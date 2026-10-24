> ⚠️ **历史快照 · 非现行事实**（DOC_TRUTH_SWEEP 2026-10-23 Asia/Shanghai）。
> 现行主机 / 端口 / 权重 / DOWN 口 → [`docs/ops/CLUSTER_TRUTH.md`](CLUSTER_TRUTH.md)。正文仅作考古，禁止盲抄配置。

# ToIV UI 统一 × 六仓深度融合方案（2026-10-14 晚）

| 项 | 内容 |
|----|------|
| **触发** | 用户指令：①「UI 现在还是完全两个项目，完全使用 BeefTV 那一套」②学习 hypit/Toonflow/dramaclaw/OpenMontage/ChatCut/video-use 等参考项目特色功能，与 ToIV **完全融合**（「现在的融合度还是太低了」）③先做调研出方案 |
| **性质** | 调研结论 + 执行方案。与 `TECH_STACK_PLAN_20261014.md`（T 波次）合流不互斥：T 波=模型/引擎轴，本方案=**UI 统一轴 + 特色功能融合轴** |
| **调研方法** | 6 仓本地克隆深读（AI-OSS-Reference 调研仓，逐仓 LICENSE 原文）+ ToIV 双 UI 全量视图测绘（web page.tsx 全视图 ↔ canvas router 全路由逐条对照） |
| **状态** | `ui_unify_fusion_plan_2026_10_14`（STATE 同键） |

---

## 0. 结论摘要

1. **UI「两个项目」的真相**：绞杀者迁移（S12/F1–F8）其实已完成大半——studio/entities/resources/audio/imageEdit/videoEdit/dub/animatic 八个 web 视图已退役跳转 canvas。剩下的「两个项目感」来自四处：**web 助手首页（5410 行）vs canvas /toiv/agent**、**web 引擎工作台（4669 行）vs canvas /create**、**web 媒体库（5715 行）vs canvas /library**、以及 web 自有导航壳（侧栏/⌘K/任务中心）。合计约 1.6 万行待收编。
2. **统一终态**：**canvas（BeefTV 套件）= 唯一 SFW 主 UI**；web 缩为极薄壳 = 登录 + R18 经典面 + 官网落地。**R18 去留是唯一需要用户拍板的分叉**（见 §4 决策点）——canvas 纯 SFW 是既有红线，方案默认不推翻。
3. **六仓融合按 ToIV 能力线归并**（不按仓罗列）：短剧线吃 dramaclaw+Toonflow+hypit 三家之长（场景一致性/门控工作流/词锚定时间轴），成片剪辑线吃 video-use（MIT 可并码，直接移植）+ ChatCut（GPL 只读理念），助手编排线吃 hypit 文件即记忆 + Toonflow SOP 技能化 + OpenMontage 组织法（AGPL 只读）。
4. **许可新发现**（修正旧账）：dramaclaw=Elastic-2.0（**本地自用可并码**，需保留 notice）；video-use=纯 MIT（**可自由并码**）；ChatCut=GPL-3.0（协议设计可借鉴，**代码与 skill 文本一个字都不抄**）；Toonflow=MIT；OpenMontage=AGPL（维持只读）；hypit=修改版 Apache（单租户可并码，已留档）。

---

## 1. 双 UI 测绘（2026-10-14 实测）

### 1.1 web→canvas 已收编（F1–F8 完成，勿重复做）

| web 视图（行数） | canvas 去处 | 状态 |
|---|---|---|
| studio 六段工作区(4669) | /studio/toiv/drama、/toiv/ws/:id | ✅ F1 退役跳转 |
| entities 主体库(1098) | drama 工作区资产段 | ✅ F1 |
| resources/models/backlot | settings?section=channels | ✅ F1 |
| audio(1048) / imageEdit(2205) / videoEdit(2535) / dub 译制(2130) / animatic(604) | /toiv/audio、/toiv/image-tools、/toiv/video-tools、/toiv/dub-tools、drama「从图片创建」 | ✅ F3–F7 |
| fusion/canvas(84+1960) | home/create | ✅ S12 |
| market(170) / library(5715) | /toiv/market、/library(+works/:id 7337 行) | ✅ F8（留 ?classic=1 逃生口） |

### 1.2 剩余重叠（「两个项目感」的真实来源）

| 重叠面 | web 侧 | canvas 侧 | 差距 |
|---|---|---|---|
| 助手/首页 | home=助手对话（assistant* 共 5410 行：浮层/霓虹启动/⌘K/SideRail/BottomNav 壳） | /toiv/agent | canvas 缺浮层启动序列与 ⌘K 全局命令面 |
| 引擎工作台 | image/video EngineStudioView（4669 行：技能 tab/保存视图/超分/3D） | /create creation-workspace | 主链路通；技能 tab、保存视图、3D、超分四个缺口 |
| 媒体库 | library(5715 行) | /library + works/:id | 主链路通；?classic=1 逃生口未拔 |
| 全局壳 | web 侧栏/任务中心/命令面板 | canvas 自有壳 | 双壳并存=「两个项目」观感主源 |
| R18 经典面 | web image/video/market/library R18 上下文+NSFW 头 | **canvas 零 R18 钩子**（纯 SFW 拍板） | 硬分叉，见 §4 |

---

## 2. 六仓特色功能 → ToIV 融合矩阵

> 引入方式三类：**并码**（许可干净，代码级移植）/ **设计采纳**（学设计自研实现）/ **只读借鉴**（AGPL/GPL，连 skill 文本都不抄）。

### 2.1 短剧创作线（用户最高优先）

| 特色功能 | 来源(许可) | 它怎么做 | ToIV 落点 | 方式 |
|---|---|---|---|---|
| **场景派生变体** | dramaclaw(Elastic-2.0) | 场景存 base_scene_id，派生场景只存 variant_prompt 增量+time_of_day，生成时拼 基础+增量+时段 | scene_asset 试点：scene 实体加 base/variant/time_of_day 三概念 | 设计采纳 |
| **背景锚点冻结** | dramaclaw | 每 beat 记 render_anchor_id（master/reverse 正反参考图/3D 截图），锚点图快照冻结为该 beat 背景，跨镜一致 | scene_asset：锚点枚举+快照落盘+shot 级 scene_ref 字段 | 设计采纳 |
| **空间契约**（正反图拓扑锁） | dramaclaw | master/reverse 两张图先锁空间关系再生成全景/3D；无 LoRA 依赖 | scene_asset 进阶路线（3GS 后置） | 设计采纳 |
| **角色双层参考 + character_tag** | dramaclaw | Portrait 锁脸 + Identity 锁服装（服装参考图分层），prompt 用短标签 `[XieZ]` 锁定 | 角色资产协议 v1→v1.5：补 character_tag 与双层参考 | 设计采纳 |
| **导演走位 blocking** | dramaclaw | world.json 存 actor position/yaw/gaze + CameraPreset{position,target,fov} + 座位锚点，agent 发语义操作 | scene_layout 模块升级（衔接 T-W world_camera） | 设计采纳 |
| **逐阶段门控+算力确认** | Toonflow(MIT) | 每阶段产出可审阅成果，表单确认才推进；生成前强制展示模型/规格/数量/费用 | 短剧管线编排器（drama-workspace 六段流加门控确认卡） | 设计采纳 |
| **三视图参考板规范** | Toonflow | 特写+正面全身+右侧90°+背面全身合一参考板（ToIV 现有正/侧/背，缺特写位与模板化提示词） | 角色卡生成模板（MIT 可直接抄提示词模板） | 并码(模板) |
| **{{ref N}} 多参引用顺序** | Toonflow | 资产图连节点端口，referenceOrder 决定提示词里第 N 项引用哪张图 | 分镜→ComfyUI 舰队参考图注入协议（H3 多参已类似，统一语义） | 设计采纳+并码 |
| **片段合并生成** | Toonflow | 一个片段多镜头合并为一次视频生成请求（三段式提示词），保连续性省算力 | 视频生成队列（与 H3 多镜 fl2va 链路合流） | 设计采纳 |
| **词锚定时间轴投影** | hypit(修改版Apache) | Moment/Selection 词锚投影成绝对时间窗口，改台词自动重排时序；拖拽时间轴=回写声明源而非存覆盖值 | 已落 SVML 导入端点（本日批次2）；下一步 canvas 分镜时间线视图 +「改词重排」 | 设计采纳 |
| **管线声明化 manifest** | OpenMontage(AGPL,只读) | pipeline_defs/*.yaml 声明 stage/skill/produces/success_criteria + JSON Schema 校验；checkpoint+history 归档；asset manifest id 引用 | drama 合成流程 stage 化声明 + process_data 加 checkpoint 历史 + drama/output 建 asset_manifest | 只读借鉴 |
| **三层 skill 知识组织** | OpenMontage(只读) | 工具注册(有什么)→项目约定(怎么用)→通用知识(按需)，INDEX.md 发现 | 三件套交付规范的 skill 文档层 | 只读借鉴 |

### 2.2 成片/剪辑线（video-use 直接并码，本方案最大增量）

| 特色功能 | 来源(许可) | 它怎么做 | ToIV 落点 | 方式 |
|---|---|---|---|---|
| **Packed Transcript** | video-use(MIT) | 词级 ASR→按静音/换人断句→压成带 [start-end] 时间戳短语级 markdown，1 小时素材≈12KB，token 降 10× | 媒体库：生成视频入库时生成该视图，作为 LLM 检索/选片唯一文本面；ASR 用自家 whisper 集群（**必须开 word_timestamps verbatim**） | **并码移植** pack_transcripts.py |
| **EDL JSON 中间表示** | video-use | LLM 不碰视频，只输出 {source,start,end,beat,quote,reason} 声明决策表，渲染器执行 | agent-runner↔ffmpeg 合成的标准解耦协议（runner 产 EDL，合成端消费） | **并码** schema+render 等价物 |
| **词边界剪规硬规则** | video-use | 绝不词内切/切边 pad 30–200ms/静音≥400ms 才安全/字幕最后烧/分段抽取无损拼接 | 自动选片 agent 硬规则+合成 ffmpeg 模板（消灭切字中间/爆音事故） | **并码** |
| **按需视觉下钻** | video-use | 不逐帧喂模型；歧义点才生成「胶片条+波形+词标签」单张复合 PNG 给 VLM 看一次 | 候选片段终审/生成视频质检接 :9311 VLM | **并码** timeline_view.py |
| **渲染后自评闭环** | video-use | 对成片每剪点±1.5s 自检跳帧/爆音/字幕遮挡 + ebur128 量响度 + critic 找茬，上限 3 轮 | 成片合成尾部 QA 步骤（自动验收不过关自动修或上报） | **并码** |
| **帧原生批量原子 edit 工具** | ChatCut(GPL,只读理念) | edit_item 单工具承载 adds/updates/deletes 一 draft，全过才 publish，validateOnly 干跑，未知字段拒绝；时间字段全用帧 | agent-runner 剪辑工具面：收敛为 1 个 `edit_timeline` 原子批量工具（对应三件套 MCP 规范） | 只读借鉴(协议设计) |
| **文稿级口播剪辑** | ChatCut(只读理念) | transcript→script 双层，改台词先改文稿再映射时间线，字幕统一 refresh | 译制/口播剪辑线（衔接 V5 W4-5 词锚定） | 只读借鉴 |
| **分层分页发现** | ChatCut(只读理念) | read_project(轻)→preview_timeline(分页)→inspect_item(≤10)，防 context 爆炸 | MCP server 工具面规范补条目 | 只读借鉴 |

### 2.3 助手/编排线

| 特色功能 | 来源(许可) | 它怎么做 | ToIV 落点 | 方式 |
|---|---|---|---|---|
| **文件即记忆** | hypit | Brief/Treatment/Analysis/Progress 项目文档让任意会话可续 | agent-runner 长任务会话状态（短剧项目记忆文件） | 设计采纳 |
| **plan→build→get** | hypit | 执行计划先行、产物候选显式复用、失败保留产出 | 舰队调度（对应 H-4「产物在就回写」的协议化） | 设计采纳 |
| **SOP 技能化** | Toonflow(MIT) | 管线 SOP 写成 SKILL.md+references 喂 agent，agent 用工具操作而非改存储 | agent-runner 技能注册表（衔接 T-S 波，agentskills 规范对齐） | 设计采纳 |
| **known-errors skill 沉淀** | ChatCut(只读) | 每个工具域配 known-errors/verification skill，踩坑沉淀供 agent 运行时读 | AGENTS 易错点的 agent 可读版（P-9 文案纪律落技能层） | 只读借鉴 |

---

## 3. UI 统一波次（F9–F12，续接 F1–F8 绞杀者纪律）

> 原则：**canvas 唯一 SFW 主 UI**；每波单独可部署可回滚；?classic=1 逃生口在缺口补齐前不拔。

### F9 助手统一（先行——用户最常用面）
- canvas /toiv/agent 吸收 web 助手的浮层启动序列、⌘K 全局命令面板、任务中心抽屉三件（web assistant* 5410 行中对齐 canvas 交互习惯的部分；R18 门控逻辑不迁）。
- web home 首页改为**跳转壳**（登录后 302 → /studio），不再渲染第二套助手。
- 验收：⌘K 在 canvas 全局可用；助手对话/工具卡/会话分叉在 canvas 全功能等价；web 首页无第二套对话面。

### F10 引擎工作台收编
- canvas /create 补四缺口：技能 tab（editorial-mg-pv 等正典技能直出）、保存视图（引擎参数预设）、超分入口（:8262/:8263 fleet）、3D 工具位。
- web image/video 引擎台退役跳转；R18 上下文按 §4 决策处置。
- 验收：四个缺口在 canvas 真机 e2e；web 引擎台 302。

### F11 媒体库收编
- canvas /library 补齐 web library 的 R18 逃生口能力对账（技能 tab 类缺口在 F10 已处理）；确认 7337 行 toiv 库页与 web 5715 行功能等价矩阵。
- 拔 web library（302）；?classic=1 逃生口保留至 F12 复核。
- 验收：canvas 库页全功能走查 + web 302。

### F12 web 壳退役
- web 只保留：login/auth、R18 经典面（按 §4 决策）、官网 landing、admin 跳转。侧栏/任务中心/命令面板/SKILL_ENTRIES 等第二套壳全部下线。
- web 测试大清洗：121 个测试文件中绑定被退役视图的按批报废/迁写（预期保留 <30%）。
- 验收：全站导航树只有一套（canvas）；外网双域名回归；R18 上下文按决策验证。

---

## 4. 决策点

| # | 决策 | 状态 |
|---|------|------|
| **D-U1** | **R18 面去留** | ✅ **已拍板（2026-10-15 用户）**：「不想设置任何红线和限制，纯本地学习测试使用，不可能泄露到外面」→ **选 B**：canvas 建 R18 门控模式（设置开关+进入确认门+API 附加 X-NSFW 上下文），web **整体退役**到只剩登录+官网落地，不再保留独立 R18 面。红线架构撤销；**唯一绝对禁区=涉未成年内容（法律底线，非架构红线）**。既有后端 X-NSFW 语义与 R18 上下文切换机制复用 |
| D-U2 | F9–F12 与短剧融合包的先后 | ✅ 默认生效：先 FU1/FU2（短剧+视频优先）再 UI 统一 |
| D-U3 | Toonflow 画布式「agent 驱动画布」是否引入 | ✅ 默认生效：只吸收方法论（SOP 技能化+门控工作流），不引其画布引擎 |

---

## 5. 执行波次总表（FU 系融合 + F9–F12 统一，与 T 波次合流）

| 波 | 内容 | 主要来源 | 方式 | 验收 |
|---|------|---------|------|------|
| **FU1 短剧深融合包 1** | scene_asset 试点升级（base/variant/time_of_day+背景锚点冻结+角色双层参考 character_tag）；SVML 导入 UI 进 canvas 分镜工作区；词锚定时间轴视图 v1（改词重排） | dramaclaw+hypit | 设计采纳（api+canvas） | 1 场景跨镜一致对照样片；SVML 脚本从 UI 导入出分镜；改台词时间轴自动重排 demo |
| **FU2 成片剪辑包** | Packed Transcript 入媒体库 + EDL 协议 + 词边界剪规 + timeline_view 视觉下钻接 VLM + 渲染后自评闭环；`edit_timeline` 原子工具设计入三件套规范 | video-use 并码+ChatCut 理念 | **并码**(MIT)+设计采纳 | 1 条多 take 素材自动剪出成片（自检闭环过）；媒体库任一生成视频可文本检索 |
| **FU3 管线门控+资产协议 v1.5** | 六段工作区逐阶段门控确认卡+算力确认；角色卡三视图参考板模板；{{ref N}} 多参注入统一 | Toonflow | 设计采纳+并码(模板) | 管线每段有确认门；1 角色新参考板出图 |
| **F9 助手统一** | 见 §3 | — | 前端 | canvas ⌘K+浮层等价；web 首页 302 |
| **F10 引擎台收编** | 见 §3 | — | 前端 | 四缺口 e2e |
| **F11 库收编** | 见 §3 | — | 前端 | 功能等价矩阵走查 |
| **F12 壳退役** | 见 §3（依赖 D-U1 拍板） | — | 前端+测试清洗 | 单导航树回归 |
| FU4 编排吸收 | 文件即记忆+plan-build-get+known-errors skill 层 | hypit/ChatCut | 设计采纳 | agent 长任务跨会话续接 demo |
| FU5 OpenMontage 组织法 | 管线 manifest 声明化+checkpoint 历史+asset manifest | OpenMontage | 只读借鉴 | drama 合成清单 id 化可审计 |

**互锁**：FU1 吸收进 T6-4 scene_asset 试点；FU2 吸收进 V5 W4（剪辑出口）与 T-S 三件套规范；F9–F12 消化「12 视图渐进迁移」开口项；所有新 agent 能力守三件套（MCP+节点+CLI）。

## 6. 许可红线清单（本批更新）

| 仓 | 许可 | 并码 | 条件 |
|----|------|------|------|
| video-use | MIT | ✅ 自由 | 保留版权声明 |
| Toonflow | MIT | ✅ 自由 | 保留版权与许可声明 |
| hypit | 修改版 Apache | ✅ 本地自用 | 多租户/商业转售禁；CLI/报告 LOGO 不可移除；转公开前清 |
| dramaclaw | Elastic-2.0 | ✅ 本地自用 | 禁托管 SaaS 化；不得移除其版权/品牌 notice（并码文件保留归属） |
| OpenMontage | AGPL-3.0 | ❌ 只读 | 组织法借鉴，代码不看不抄进仓 |
| ChatCut | GPL-3.0 | ❌ 只读 | 协议/理念可学；**代码与 skill 文本一律不复制**（文本也有版权） |

## 7. 风险

| # | 风险 | 缓解 |
|---|------|------|
| R1 | GPL/AGPL 传染（含 skill 文本） | 只读仓设「只读目录」隔离（调研仓内），ToIV 仓内禁止出现其代码/文本 |
| R2 | web 退役报废 121 个测试文件 | F9–F12 每波只迁写当波涉及文件；测试报废清单入账 |
| R3 | 迁移期双入口混乱 | ?classic=1 逃生口策略延续：缺口补齐前不拔插销，302 而非删除 |
| R4 | dramaclaw 设计采纳走样（无码可抄，全靠理解） | 每项设计采纳配 1 份「它怎么做→我们怎么做」对照小节进 EXEC_LOG |
| R5 | video-use 移植依赖 ElevenLabs Scribe（外部付费 API） | ASR 捃自家 whisper 集群（词级 verbatim 已支持），不引外部依赖 |
| R6 | UI 统一与 R18 决策耦合阻塞 | D-U1 默认 A 先行，B 不阻塞 F9–F11 |
