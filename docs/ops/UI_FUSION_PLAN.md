# 两项目完全融合方案（ToIV × BeefTV，2026-10-06 立版）

> 用户裁决：当前 /studio + 跳转不是融合，要求完全融合为一个项目。
> 本档为唯一规划依据；执行按里程碑推进，每批可独立验收/回滚。

## 一、两张皮的本质（现状盘点）

| 维度 | BeefTV（ToIV-canvas） | ToIV（main） |
|---|---|---|
| 前端 | Vite+React19 SPA，antd6+tailwind4，三层 token 21.7k 行 | Next.js，123 个视图 tsx，自有 token（今晨已对齐 BeefTV 色值） |
| 后端 | Go(gin+gorm)，**仅 sqlite 驱动**，per-user 每人一进程（120MB/人） | FastAPI，PG+Redis 中央，全部业务（市场/作品/任务/智能体/短剧/渲染编排） |
| 认证 | gate cookie（JWT 换发 + exchange 桥） | ToIV JWT（localStorage） |
| 数据 | 画布/项目/资产/模型配置在 per-user sqlite | 市场 6773 应用/作品库/agent-runs/短剧项目在 PG |
| 挂载 | /studio 经 Next rewrite → gate :8281 | /?view=* 全部视图 |

**跳转感的根源**：两个独立前端 + 两个数据域 + 两套认证；侧栏 external 链接只是把缝隙盖住了。

## 二、终态定义（什么才算"完全融合"）

```
浏览器 → toiv.wineryz.top
  ┌─────────────────────────────────────────────┐
  │ 单一前端：BeefTV SPA 承载全部产品功能          │
  │  /  首页(画布+ToIV模块卡)                      │
  │  /canvas/*  画布(现状)                        │
  │  /toiv/tasks /toiv/library /toiv/market      │
  │  /toiv/agent(对话) /toiv/drama(短剧工作台)     │  ← 全部原生路由页，同壳同语言零跳转
  └─────────────────────────────────────────────┘
  /api/*       → toiv-api(FastAPI+PG)            ← 业务数据域
  /canvas-api/* → canvas-api(Go 单实例+PG)        ← 画布数据域(表迁入同一 PG)
  认证：ToIV JWT 直读直校（同源），gate 退役
  仓库：ToIV main 单仓（apps/canvas-web + canvas 后端并入），单 CI 单部署
  Next 仅存：marketing 落地页 + 登录 + 静态托管 SPA
```

四条硬标准：①SPA 内无整页跳转 ②单一 PG 数据平面（画布与业务互相引用资产）③单一认证 ④单仓单部署。

## 三、里程碑

### M1 模式建立 + 小模块原生化（1-2 天）——先证明全链模式
- BeefTV web 内建 `services/toiv/` 客户端：同源 `/api/*` + `localStorage.toiv_token`（JWT 直带，不再依赖 gate 换发）
- 新增原生路由页：`/toiv/tasks`（agent-runs 列表）、`/toiv/library`（作品库网格）——antd 风格重写，消费 ToIV API 契约（对齐 main 仓 lib/api.ts 端点）
- 侧栏「TOIV 创作」组 external 链接 → 内部路由（task/library 先切）
- 验收：SPA 内点任务中心/作品库零跳转、数据与旧视图一致；模式（api client/页面骨架/错误态）沉淀为模板

### M2 大模块迁移（3-5 天）
- `应用市场`：列表/筛选/详情原生页；「运行应用」→ 创建 ToIV job → 结果引导至任务中心
- `智能体对话`：**推荐组件移植而非重写**——把 ToIV chat 面块（SSE+工具卡+会话管理，逻辑已成熟）包装为 BeefTV 内嵌组件，外层换 BeefTV 壳与 token；跑通 /toiv/agent 路由
- 旧 Next 对应视图开始降级为 fallback（模块级开关 toiv_module_fallback）

### M3 短剧工作台迁移（5-8 天，最大件）
- 项目列表 → 角色/设定卡编辑 → 分镜板 → 渲染管线状态 → 成片预览，逐块原生迁移（API 全部现成，纯前端工程）
- 完成后旧 Next 视图退役（Next 仅留 marketing+login+静态托管）

### M4 服务与仓融合（3-4 天）
- Go 后端补 postgres 驱动（gorm 分支 + sqlite→PG 迁移脚本），canvas-api 单实例化，per-user 进程模型与 gate 退役（serve.mjs 的静态托管/代理职责移交 Next 或 nginx）
- JWT 直校验：Go 侧验 ToIV JWT（共享密钥或内省端点）
- ToIV-canvas 源码并入 main 单仓：`apps/canvas-web`（SPA 源码）+ `services/canvas-api`（Go），统一 CI；GitHub ToIV-canvas 仓归档只读
- 部署合一：deploy.sh 一条命令出全站

## 四、关键决策点（需拍板）

| # | 决策 | 推荐 | 理由 |
|---|---|---|---|
| D1 | 产品主干 | **BeefTV SPA** | 设计体系成熟、画布是产品核心资产；Next 视图是过渡遗产 |
| D2 | 画布后端归宿 | **补 PG 单实例化** | 终态单数据平面；per-user sqlite 省事但两域永存、120MB/人不可扩展 |
| D3 | 智能体对话 | **组件移植起步** | 逻辑成熟（SSE/工具卡/会话），重写风险高；后续再渐进重构 |
| D4 | 迁移期兼容 | 模块级 fallback 开关 | 每个模块新旧并行到验收，单模块可秒退 |

## 五、风险与对策
1. 交互细节损耗（antd vs 原组件）：M1 模板先立交互基线，逐模块对照验收
2. 短剧工作台状态复杂（渲染轮询/门禁状态机）：最后迁，届时已有 5 个模块经验
3. sqlite→PG 数据迁移：写一次性迁移脚本 + 双写校验窗口；画布数据量小（个人用）
4. 双仓合并期 CI：M4 前两仓并存（现状已可），合并动作独立成批
5. gate 退役风险：保留 gate 代码与 ENTRY_ON 开关一个版本周期，R0 回滚路径不变

## 六、总量
专注开发约 **3-4 周**（M1 1-2d / M2 3-5d / M3 5-8d / M4 3-4d）；每里程碑独立交付可停可退。

## 附录 A：ToIV 功能点分解 → BeefTV 强化形态清单（2026-10-06 M1 落地版）

> 原则：不止「搬页面」，每个功能点都带**加强点**——与画布/模型配置/任务体系互通。

| # | ToIV 功能点 | 融合形态 | 加强点（超越旧版） | 批次 | 状态 |
|---|---|---|---|---|---|
| 1 | 任务中心(agent-runs) | `/toiv/tasks` 原生页 | 与 BeefTV 顶栏任务 chip 双向联动；画布作业也进统一时间线 | M1 | ✅ 已上线 |
| 2 | 作品库列表(boards) | `/toiv/library` 原生页 | 卡片封面网格；M4 后作品资产可直接拖入画布作节点输入 | M1 | ✅ 已上线 |
| 3 | 作品库详情(items) | 原生 board 详情页 | 预览/删除/回收站/变体分组原生交互 | M2 | 待做 |
| 4 | 智能体对话 | `/toiv/agent`（SSE chat+工具卡组件移植） | 对话产物一键入画布；画布节点右键「发到对话」续创 | M2 | 待做 |
| 5 | 应用市场 | `/toiv/market` 列表/详情/运行 | **市场应用直接注册为画布 provider**；运行→job→任务中心闭环 | M2 | 待做 |
| 6 | 工具箱 21 intents | 画布「新建节点」intent 模板 | 换装/对口型/补帧等成为画布快捷创建流+对话 chips | M3 | 待做 |
| 7 | 短剧工作台 | `/toiv/drama` 全家 | 分镜板与画布镜头互转；设定卡资产进画布引用库 | M3 | 待做 |
| 8 | 数字人/音频编排 | 画布音频节点增强 | tts/分离/拼接/混音变体编排在节点上完成 | M3 | 待做 |
| 9 | 资源中心/实体库 | `/toiv/resources` | 模型资产与 BeefTV 模型配置页合一视图 | M3 | 待做 |
| 10 | 画布后端 PG 化 | canvas-api 单实例 | 画布与业务单一数据平面，资产互引 | M4 | ✅ 2026-10-06 切流上线（单实例 :8290 承接全量 /studio 流量，见 DRAMA_UI_PLAN M4-3） |
| 11 | 认证/部署合一 | gate 退役 + 单仓 CI | ToIV JWT 直用；deploy.sh 一条命令全站 | M4 | 🔶 2026-10-06：JWT 直验已上线（Phase A 内省式 + Phase B 直连切流）；单仓合并已完成（apps/canvas subtree+GitHub ToIV-canvas 归档）；剩 Phase C gate 全面退役+统一 CI+deploy.sh 一条命令 |

### M1 已落地明细（本批）
- `services/toiv/client.ts`：ToIV API 客户端（同源 /api + toiv_token JWT；与画布 apiClient 两平面隔离）
- `pages/toiv/tasks-page.tsx` / `library-page.tsx`：antd 风格原生页（加载/错误/空态/刷新）
- router `/toiv/tasks` `/toiv/library`；侧栏两项 external→内部路由（**零跳转达成**）
- 真机验证：两页均实时渲染 ToIV PG 数据（agent-runs 状态徽标/子任务进度；boards 网格）

## 附录 B：BeefTV × ToIV 全功能点对比清单（2026-10-06，供保留决策）

> 基底已拍板：**BeefTV**。本表列出两侧全部功能点；「决策」列留白待用户圈选。
> 标记说明：独有=仅一侧存在；重叠=两侧都有功能等价物；◆=建议保留源。

### A 组 · 画布创作核心（BeefTV 独有，ToIV 无对应物）
| # | 功能点 | 说明 | 决策 |
|---|---|---|---|
| A1 | 自由画布节点编辑器 | 10+ 节点类型（图/视频/文/音/配置/脚本/绘图/帧/角色引用/技能），拖拽连线 | ☐ |
| A2 | 导演模式 | director workbench+sequencer+dock，项目分镜化时间线编排 | ☐ |
| A3 | 智能剪辑创作会话 | creation conversations+时间线转写（开发中 flag） | ☐ |
| A4 | 生成任务中心 | provider 直连生成视频/图，重试/日志/失败查询 | ☐ |
| A5 | 深度捕捉 | depthcapture 模块 | ☐ |
| A6 | 语音转写 | transcription 模块 | ☐ |
| A7 | 播放/编辑内核 | playback+editing 模块 | ☐ |
| A8 | 提示词库/技能 | prompts+skills 模块（skills 页已重定向退役） | ☐ |
| A9 | Eagle 资产插件 | 本地素材库直连 | ☐ |
| A10 | 桌面端+CLI/MCP | Wails 桌面、命令行、自动更新 | ☐ |

### B 组 · ToIV 业务域（ToIV 独有，BeefTV 无对应物）
| # | 功能点 | 说明 | 决策 |
|---|---|---|---|
| B1 | 门户智能体对话 | SSE/思考时间线/工具卡6族/21意图chips/会话fork/文档挂载 | ☐ |
| B2 | Agent Team | L0-L2 计划/审批/子任务编排 | ☐ |
| B3 | 应用市场 | 6773 应用/烟测状态/说明卡/rh-acc | ☐ |
| B4 | 作品库 | boards/变体分组/回收站/整组删除/导出 | ☐ |
| B5 | 短剧工作台 | 项目/角色设定卡/分镜/管线C渲染/配音/对口型/成片/一键成片 | ☐ |
| B6 | 工具箱 21 工具 | 换装…3D 全 intent | ☐ |
| B7 | 数字人+音频编排 | tts/分离/拼接/混音/变体（sfx 未实现） | ☐ |
| B8 | 资源中心 | 模型资产815/百科/知识图谱/引擎注册表 | ☐ |
| B9 | 实体库 | entities | ☐ |
| B10 | ComfyUI 二次编辑 | open-in-comfy / save-from-comfy | ☐ |
| B11 | 管理系统 admin | 设备域/作业队列/审计/运营（:3200） | ☐ |
| B12 | LLM 代理 | /api/llm/v1 OpenAI 兼容（BeefTV 助手已在用） | ☐ |
| B13 | 微信小程序 | token 预设+H5 | ☐ |
| B14 | 后端运营能力 | whisper 集群/视频评分器/封面 autorefire/自愈修复器 | ☐ |

### C 组 · 重叠/冲突（两侧都有，需择一或融合）
| # | 功能点 | BeefTV 形态 | ToIV 形态 | 融合建议 | 决策 |
|---|---|---|---|---|---|
| C1 | 任务概念 | 画布生成任务（provider 直连） | jobs+agent-runs 统一作业 | 双层保留：统一时间线（画布任务+业务任务一屏） | ☐ |
| C2 | 资产/作品 | 画布 assets（sqlite） | 作品库 boards（PG） | M4 PG 化后合一，作品可直接入画布 | ☐ |
| C3 | 模型管理 | 模型配置 channels+modelcatalog | 资源中心 MODEL_SOURCES+引擎注册表 | 合一视图：渠道配置(BeefTV)+资产百科(ToIV) | ☐ |
| C4 | AI 助手 | 画布内 assistant（已接 ToIV LLM） | 门户智能体（工具/团队强） | ToIV 智能体为大脑，BeefTV 面板为载体 | ☐ |
| C5 | 视频剪辑 | 智能剪辑（开发中） | 成片 assemble/一键成片 | BeefTV 时间线为编辑器，ToIV assemble 为成片管线 | ☐ |
| C6 | 外部接入 | MCP 客户端+桌面端 | 小程序 | 各留各的通道 | ☐ |
| C7 | 技能/工具 | skills 模块（半退役） | 工具箱 21 intents | 工具箱以画布节点模板+对话 chips 融入 | ☐ |

## 附录 C：融合决策记录（2026-10-06 用户拍板）
- C1 任务/C2 资产/C3 模型管理：无异议，按建议执行（统一时间线/PG 化合一/合一视图）。
- **C4 画布内 assistant 也使用智能体**（升级为 ToIV 智能体，非纯 LLM chat）
- **C5 剪辑：引入优秀开源项目融合**（调研结论见下）
- **C6 外部接入做成全平台**
- **C7 工具箱→节点模板：效果不确定，先调研/试点再定**

### C4 实施规格：画布助手升级为真智能体
- 现状：BeefTV 画布 assistant = toiv-llm 文本通道（/api/llm/v1 纯 chat，无工具）。
- 目标：assistant 面板直连 **ToIV 智能体会话域**（同源 JWT）：`POST /api/agent/chat`（SSE）+ `GET /api/agent/sessions`（历史）+ fork（会话分叉）+ canvas-proposal（画布提案——ToIV 已有该端点，天然为画布设计！）。
- 关键增值：智能体工具调用（生成图/视频/查市场/短剧操作）在画布侧以 BeefTV 工具卡渲染；`canvas-proposal` 可把智能体产出直接落成画布节点图。
- 工作量：SSE 客户端复用 BeefTV 已有 assistant SSE 通道改造 + 工具卡 6 族组件移植（对齐 ToIV toolcards registry）+ sessions 列表面板。约 2-3 天。

### C5 调研结论：可融合的开源剪辑力量（2026-10 扫描）
| 项目 | 定位 | 融合方式 | 建议 |
|---|---|---|---|
| **Remotion** | React 程序化视频渲染框架（非 AI 编辑器，但 AI-agent 最爱驱动它） | 「成片合成渲染器」：agent 写 Remotion 组件→渲染成片，替代纯 ffmpeg assemble；字幕/动态版式/模板化片头 | ★ 推荐：与 React 栈同族，_license 商用注意（公司<4 人免费）|
| **auto-editor** | 静默/跳切自动粗剪（CLI/Python） | 封装为画布「粗剪节点」：一键去静默/去废帧 | ★ 推荐：单点极强，封装半天 |
| **OpenMontage**（calesthio，2026 新） | agentic 视频生产系统（52 工具/12 管线/700+ 技能，驱动 AI coding agent） | 不整体引入；**借鉴其技能分层与生产管线设计**（对 C7 节点模板的 intent 分层直接参考） | ○ 参考不引入 |
| WhisperX | 词级字幕对齐 | 升级现有 whisper 集群到词级（字幕卡点精确到词） | ○ 备选增强 |
- 落地序：auto-editor 粗剪节点（快赢）→ Remotion 成片渲染器（M3 短剧工作台成片段一并做）→ 借鉴 OpenMontage 分层做 C7。

### C6 全平台规格
- **Web**：BeefTV SPA（现 /studio，M4 后升 /）——主阵地
- **桌面**：BeefTV Wails 壳已有——接入同一 ToIV 智能体域与账号（替换其内嵌 backend 为远程模式，复用 LLM 代理通道）
- **移动**：SPA 响应式适配（BeefTV 已有 toiv-mobile.css 线索）+ PWA（manifest/offline 壳），重点保 画布浏览/任务/作品库/对话
- **小程序**：ToIV 小程序保留为轻入口（市场浏览/任务通知），深链跳 Web
- 统一账号（ToIV JWT）+ 统一数据（M4 PG 化）是全平台前提，故 C6 排 M4 之后收口。

### C7 试点方案（工具箱→节点模板）
- 不确定性：21 intents 全塞进「新建节点」菜单会造成选择过载；部分工具（如局部重绘）与画布节点原生能力重叠。
- **Spike（1 天）**：挑 2 个代表 intent——「文生图」（纯生成型）+「对口型」（组合型）做成画布节点模板；实测：入口发现性/参数面板复用度/与普通节点的差异混淆度。
- 试点通过 → 按 OpenMontage 式分层（生成/编辑/组合/音频 四族）组织模板库；不通过 → 降级为对话 chips + 快捷指令面板。
