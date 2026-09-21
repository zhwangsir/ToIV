# AI 对话（助手）UI 重设计：深度调研与完整方案（2026-09-22）

> 问题：用户报「AI 助手的 UI 需要重新进行设计」，四域方案 C 项深化专篇。
> 调研方法：生产 PG 会话实数 + 前端全组件/测试约束核查（行号截至 commit `a3d6db3`）。

---

## 一、问题定量（生产实数）

| 事实 | 数据 |
|---|---|
| 会话/消息 | 25 会话 / 209 消息，均值 8.4 条/会话，最深 56 条 |
| **工具结果占全部消息比** | **96/209 = 46%**——近一半消息是工具返回，但全部坍缩成一条 `av-tool-chip` 文字小条（转圈/绿勾/红叉），无结构化呈现、无跳转 |
| 工具调用分布（96 次） | optimize_prompt **38**(40%) / search_knowledge 13 / submit_generation 11 / propose_canvas_graph 9 / create_storyboard 6 / generate_image 3 / list_models 3 / selfheal 系(explain_app_failure+list_smoke_failures) 4 / navigate_view 2 / 其余 5 |
| 待确认提案 | 仅 1 会话有 pending_proposal（深度接管功能真实使用率低，但提案卡已就绪） |

**结论**：助手的真实工作负载是「工具驱动」（提示词优化+知识检索+生成+画板+自愈），UI 却把它当纯聊天渲染——**工具结果卡片化是重设计的第一价值点**，且有明确排期依据（按调用频次）。

## 二、问题清单（全部实锤，附行号）

1. **工具坍缩**：33 个注册工具结果统一渲染为 `av-tool-chip`（`AssistantView.tsx:2034-2050`），应用推荐/分镜/自愈等无专用卡、无深链按钮。
2. **移动端 CTA bug**：底部「对话」CTA 实际跳 fusion 页（`page.tsx:806` `ctaAction` 自 R3.1 遗留，W2 改 label 时未同步）。
3. **双系统割裂**：对话（单 agent SSE）与 agent-runs（DAG 运行台）数据/样式/入口全独立，仅列表页一条横幅互链；SideRail 无 agent-runs 入口（仅底部「更多」抽屉）。
4. **能力闲置**：`forkAgentSession` 前后端就绪零 UI 消费；popup 唤起仅 Shift+Enter，移动端不可达（空态还提示该快捷键）。
5. **工程债**：`AssistantView.tsx` 3502 行单组件 + styled-jsx ~1150 行；测试倒逼 workaround 多处（Modal 必须 lazy、useAgentRun 禁 useRef/useMemo）；「模型设置」注释/样式残留（`:3197/:3200`）；`AgentRunStyles.tsx` 空实现。
6. **测试红线**（重构必须保绿）：assistant* 十组不变式（onEvent 三分支/提案卡 resume/8s 轮询/回放归并/popup 互斥/Esc 让位/霓虹参数/离线导航/R18 门控/verdict 容错）。

## 三、方案（五阶段，按价值密度排序）

### A0 快赢清障（半日量，随最近批次带）
- CTA `ctaAction` 改 `home`（真对话）；popup 空态快捷键提示按断点隐藏；清「模型设置」残留注释与 `AgentRunStyles.tsx` 空文件；`lib/agents.ts:6` 头注释漂移修正。

### A1 工具结果卡片体系（核心；协议零改动）
- 建 `toolRenderers` 注册表（`components/assistant/toolcards/`）：按 `tool.name` 渲染，未注册回退现有小条（向后兼容）。
- 按生产频次定首批六族：
  1. **optimize_prompt 对照卡**（38 次/40%）：原文⇄优化文左右对照+「应用到输入框」；
  2. **search_knowledge 结果卡**（13 次）：条目列表（标题/摘要/出处徽标）；
  3. **submit_generation/generate_image 作业卡**：复用现有 AvJobCards（已就绪，仅接注册表）；
  4. **storyboard/board 卡**（9 次）：成员缩略条+「打开画板」深链；
  5. **selfheal 报告卡**（4 次）：失败归因/修复器/结果徽标+「查看应用」；
  6. **list_apps/list_models 列表卡**：应用封面+名称+用途+「打开应用」深链（`/?view=market&app=`）。
- tool 事件已携带 name+summary+结构化结果（`api.ts:1967` AgentEvent），前端纯消费，后端零改。

### A2 信息架构互通
- SideRail 补「智能体」入口（对话与运行台并存：轻交互 vs 重编排，不合并数据模型）。
- agent-runs 详情加「在对话中继续」（run 上下文 prefill）；对话内 DAG 场景出运行台深链卡。
- 会话 fork 入 UI（历史面板项「分叉」钮，调既有 forkAgentSession）。

### A3 组件工程化（跟随 A1/A2 落地）
- `AssistantView.tsx` 拆 MessageList/Composer/Portal/ToolCards/SessionDrawer 五模块；styled-jsx 外迁 `assistant-view.css`（P-2b 纪律：文件级+`av-` 前缀）。
- 红线：十组测试不变式逐模块迁移逐组验证；Modal lazy 与 useAgentRun 禁令保留并注释。

### A4 移动端
- 助手全屏 sheet 形态替代 popup；⌘K 入口移动端可见化；composer 工具行断点特化（已有基础）。

**不做**：不合并对话与 agent-runs 数据模型；不改 SSE 协议；不引入组件库/新依赖。

## 四、验证

- 每阶段：web jest 全绿（重点 assistant* 十组）+ 新增卡片组测试（toolRenderers 注册/回退/六族渲染）；
- e2e：authed-agent-drama（画板工具链）+ authed-agents-ui 复跑；
- 真机：CN 入口截图（门户/工具卡/提案卡/移动端 sheet）+ 控制台零错误；
- 每阶段 AGENTS.md/STATE 入账 + commit。
