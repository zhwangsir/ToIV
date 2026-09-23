# ToIV 智能体对标调研（2026-09-23）

目标：对照同类产品，定位 ToIV「AI 助手仍有问题」的产品根因，给出可落地改法。
锁定：对话就是智能体（单入口）。

## 1. 对标摘要

| 产品 | 入口 | 对话里能否完成生成 | Skill 含义 | 失败闭环 | 知识底座 |
|------|------|-------------------|------------|----------|----------|
| RunningHub × ComfyUI-Copilot | Comfy 侧栏 Copilot | 召回工作流→Accept 上画布→可跑；偏开发助手 | 工作流/节点/模型召回 + Debug/Rewrite | Debug 缺模型可引导下载 | 平台海量工作流/节点/模型 KB |
| ComfyUI-Copilot v2 / Agent Mode | 画布旁聊天 | PLAN→EXECUTE→VALIDATE→REPORT；改画布 | Master + Rewrite/Debug 子 Agent + MCP tools | 校验环 + 工具预算 | 7K nodes / 62K models / 9K workflows |
| MiniMax Design | Agent 主台 | Brief→拆任务→多 Agent 并行→画布成片 | 可安装/对话生成的方法 Skill | 关键节点人工审核 | Skill 广场 + 本地资产 |
| LibTV (libtv-skills) | Agent-IM 会话 | 传话→轮询→结果回会话（核心通路） | SKILL.md 强制「凡创作必触发」 | 轮询超时给画布链接 | 后端专业 Agent，用户侧只搬运 |
| Krea Agent | 侧栏 Agent | 对话里出片、改片、选模型 | 可保存的可复用流程 + context library | 对话内 refine | 品牌/参考库 + 全模型目录 |
| **ToIV 现状** | 侧栏「智能体」= home | 有 `run_app`/`submit_generation`/job 卡，但门户与部分意图仍跳工作台 | 门户「技能」= 工作台快捷入口（非可执行 Skill） | selfheal/smoke 偏运维；用户失败环弱 | 静态 `agent/knowledge/*.md` + 有限 RAG |

## 2. 各家最值得抄的点

### LibTV（对 ToIV 市场应用路径最贴）
- 会话即生产线：`create_session` → 8s 轮询 → 结果嵌对话。
- 用户侧 Agent 是搬运工：不扩写 prompt、不拆镜、不自编排；原话 + 参考图交给后端。
- 完成才给画布链接；过程中只说「生成中」。

### MiniMax Design
- Agent Mode：意图→拆解→多角色并行→合并。
- Skill = 可安装方法，不是导航按钮。
- 审核节点：关键决策问用户，其余自动跑。

### RunningHub / ComfyUI-Copilot
- 厚知识库驱动：先召回平台真实工作流/应用，再 Accept。
- Debug 一等公民：缺模型/连线错在对话里修。
- Agent Mode 可视化步骤条 + 工具预算防死循环。

### Krea Agent
- 侧栏唯一 Agent；结果与修改都在对话。
- Skill 沉淀到 context library，团队可复用。
- Agent 自己选模型，用户不必先懂菜单。

## 3. ToIV 代码侧证据（MateBook 仓）

- 主循环：`apps/api/app/agent/runner.py` — 原则已要求「创作意图主动调工具」「视频优先 list_apps→run_app」。
- 执行工具已有：`run_app` / `submit_generation` / `check_jobs` / `generate_*` / drama 分镜工具。
- 逃逸工具也有：`navigate_view` / `prefill_generate`（故意跳工作台）。
- 前端：`AssistantView` 已处理 `ui_action` 与 job 卡，且约 8s poll（接近 LibTV）。
- 门户：`PortalEmpty.tsx` 明文「@ 技能面板一期 = 工作台快捷入口」——与 MiniMax/Krea 的 Skill 语义相反。
- 任务页：`/agent-runs` 仍独立（已降级为「任务」深链），未完全折进对话时间线。
- 知识：`apps/api/app/agent/knowledge/*.md` 静态；市场说明书 / smoke / MODEL_SOURCES 未成活 RAG。

## 4. 根因判断（为何「还是有问题」）

1. **产品语义分裂**：入口叫智能体，但空态技能仍是「去工作台」；用户体感是聊天壳 + 跳转。
2. **闭环不稳**：异步 job 卡有了，但复杂能力（译制/数字人等）仍鼓励 `navigate_view`；失败后缺少「同线程 Debug→重跑」主路径。
3. **Skill 三套皮**：门户快捷入口 / Skill 市场 / Agent 人格 / H3 skills 未统一成「可执行方法」。
4. **知识不贴集群真相**：助手不知道当前市场卡是否真能出片、缺什么权重——对标 RH Copilot 的厚 KB 差一截。
5. **编排可见性弱**：无 PLAN/EXECUTE 步骤条；大需求易变成「说了去工作台」或静默多工具乱打。

## 5. 建议落地（按优先级）

### P0（立刻改体感）
1. **生成意图禁止默认跳转**：system + 工具描述收紧——凡市场/引擎能 `run_app`/`submit_generation` 的，禁止先 `navigate_view`；跳转仅保留「尚无 API 的重表单页」。
2. **门户技能改成对话 chips**：`SKILL_ENTRIES` 从 `goView` 改为预填用户句并留在智能体（例：「用市场应用做一个图生视频」），由 `list_apps→run_app` 收口。
3. **任务进度回对话**：Agent Team / 长任务进度用现有 job/proposal 卡样式嵌进同一会话，弱化离开去 `/agent-runs`。

### P1（对齐 LibTV / Copilot）
4. **活知识**：`search_knowledge` 接入市场卡说明书摘要 + keep/smoke 状态 + MODEL_SOURCES 缺口提示。
5. **失败同线程修复**：用户侧「这次失败了帮我修」→ explain → 改参/换卡 → `run_app` 重提；selfheal 从运维工具升为用户可见卡。
6. **步骤条**：多步计划（propose_plan 后）前端显示 PLAN/跑中/完成，对标 Copilot Agent Mode。

### P2（对齐 MiniMax / Krea）
7. **统一 Skill 模型**：一个 SKILL.md 规格 = 何时触发 + 调哪些 tool + 成功标准；门户/市场/人格共用。
8. **Context library**：主体库 + 最近作品 + 用户文档已有雏形，做成「Agent 默认带着跑」而非可选挂载。
9. **H3/短剧**：坚持「操作员不编剧」——对话只传话+轮询+出片（已有产品记忆，落到 runner 硬约束）。

## 6. 参考链接（2026-09 查阅）

- ComfyUI-Copilot README: https://github.com/AIDC-AI/ComfyUI-Copilot
- ComfyUI-Copilot 论文: https://arxiv.org/html/2506.05010
- RunningHub×Copilot 报道: https://m.jiemian.com/article/13817841.html
- MiniMax Design: https://design.minimax.cn/
- LibTV skills: https://github.com/libtv-labs/libtv-skills
- Krea Agent: https://www.krea.ai/creative-agent
- Krea for ChatGPT: https://www.krea.ai/blog/generate-ai-images-and-videos-in-chatgpt-with-krea

## 7. 建议下一步

先做 P0 三项（产品代码，单主干 main），部署 core 后用「帮我做一个图生视频」「修一下刚才失败」两条狗食路径验收。
