# Agent SKILL 执行纪律标准化（DramaClaw 提炼 → ToIV 落地，2026-08-15）

> 来源：DramaClaw `.hermes/skills/dramaclaw/SKILL.md` + `playbooks/init.md` + `playbooks/resume.md`（调研报告 docs/2026-08-15-dramaclaw-deep-dive.md 第三节第 2 条）。
> 目的：把 DramaClaw 经实战的 agent 防失控 prompt 纪律提炼为 ToIV 标准化条款，并落到 ToIV agent 系统提示词。
> 落地位置：`apps/api/app/agent/runner.py` 的 `SYSTEM_SUFFIX`（原则段）；工具清单段由注册表自动生成（`app/harness/tool_seam.py`），保持不变。
> 每条纪律附 DramaClaw 原文条款出处与英文摘要对照，禁止脱离原文发挥。

---

## 一、核心原则（七条）

### P1 单轮写任务限制：一轮最多 1 个写任务

- **原则**：一次用户消息最多启动 1 个写操作/异步任务；启动成功后立即收口回复，不在同一轮等待完成后再启动下一步，也不为了确认完成而持续轮询。
- **来源（DramaClaw 条款）**：SKILL.md §1「单轮执行上限（防超时硬规则）」；§2「执行纪律（强制，违反即错）」第 3 条；playbooks/resume.md「项目级/单集 continuation 默认」（启动异步任务后立刻停止，不轮询到完成点）。
  - EN: *At most one write/async task per user turn; close the turn immediately after a successful start. No polling to completion, no chaining the next step in the same turn.*
- **ToIV 现状**：对话助手（runner.py）是**同步生成**——工具执行器内 `_wait_files` 阻塞到产物就绪（200-400s 超时），一条助手回合内多次调用出图是既有 feature（原则 4「生成4张不同风格」），且 ToIV 没有「启动异步任务后返回」的写任务形态。
- **应用方法**：**对话助手不采纳数量上限**（场景不同，见场景矩阵）；采纳其精神内核——**不在同一轮串接多阶段链路**（如"先出图→再图生视频→再配乐"未经用户确认一气呵成）。Agent Team 场景由 LangGraph 编排器承载（拓扑调度 + 渲染信号量限流 + 确认门），数量纪律是代码强制的，不靠 prompt。

### P2 错误处理机制：错误即停、原文转告、禁止换路径重试

- **原则**：任一工具返回失败/超时/不可用时，本轮立即停止后续动作，把错误原因如实转成简短自然语言告诉用户；禁止同轮反复重试同一工具、改猜其它参数/路径绕过、或编造不存在的机制来解释报错。
- **来源（DramaClaw 条款）**：SKILL.md §1「错误即停」（"把后端 `error/detail/message` 原文转成简短自然语言告诉用户…禁止在同一轮反复重试同一工具、改猜其它路径或继续往下执行"）；§2 执行纪律第 2 条（"把后端返回的 `error` 原文如实转告用户…不要继续往下试别的端点"）、第 4 条（队列满/任务进行中立即收口）、第 5 条（"严禁编造不存在的机制/端点/参数来'绕过'报错"）。
  - EN: *On any tool failure: stop the turn, relay the backend error verbatim (in plain language), point at the missing prerequisite. Never retry the same tool, guess alternate paths, or invent mechanisms to bypass the error.*
- **ToIV 现状**：工具执行器已把失败转成文本回给 LLM（如「提交失败: {e}」「暂无可用的图像 worker」），但系统提示词没有约束 LLM 如何处置失败——LLM 可能换参数重试或轻描淡写带过。
- **应用方法**：写入 `SYSTEM_SUFFIX` 原则段（落地条款 L1）。

### P3 Grounding 规则：只确认实际成功的字段/工具结果

- **原则**：只确认工具实际执行并成功返回的操作与结果，不声称做了实际没做的事；下游步骤未实际调用时，不说"已完成"。
- **来源（DramaClaw 条款）**：SKILL.md §1「确认内容必须基于实际 API 调用结果（grounding 规则）：只确认实际发送并成功返回的字段和操作，不声称做了实际没做的事。」（附带反例：只传了 name/role 不要说"已写入人设和外观提示词"）。
  - EN: *Confirm only what was actually sent and successfully returned. Never claim an action that was not executed, nor mark a downstream step "done" that was never invoked.*
- **ToIV 现状**：原则 3「简洁说明你做了什么」隐含此意，但没有明确的反向禁令。
- **应用方法**：写入 `SYSTEM_SUFFIX` 原则段（落地条款 L2）。

### P4 信息摄入优先级：覆盖性操作强制二次确认，优先级高于用户直接指令

- **原则**：重新摄入/覆盖/替换类破坏性操作必须先查当前状态，再强制二次确认（第一次确认"是否覆盖"，第二次告知具体损失范围）；即使用户说"直接覆盖/不用确认"，也必须走确认门。
- **来源（DramaClaw 条款）**：SKILL.md §1「重新摄入/覆盖项目的强制二次确认规则」（"该规则是硬性安全规则，优先级高于用户的一步式指令，例如'直接覆盖''不用确认''马上重做'也必须二次确认"）；playbooks/resume.md 草图图池规则（旧批次 `stale=true` 草图先警告再操作，"禁止 try→fail→force 模式"）。
  - EN: *Re-ingest/overwrite operations require a mandatory two-step confirmation gate: first confirm overwrite, then disclose the exact blast radius. The gate outranks direct user instructions like "just do it, skip confirmation".*
- **ToIV 现状**：对话助手没有覆盖性写操作；Agent Team 已有**计划确认门 + 合成确认门**（routes/agent_team.py `resume` 端点 + AgentApproval 落库，R3.1/R3.2），与 P4 同构——确认门是代码强制，不依赖 LLM 自觉。
- **应用方法**：对话助手无需 prompt 条款；编排场景维持代码门现状。**新增任何覆盖性工具/端点时，沿用"先查状态 → 确认门 → 记录裁决"三件套，不做成 prompt 恳求。**

### P5 状态驱动执行：先查状态再行动

- **原则**：回答"进度/状态/有哪些"类意图、或行动前依赖当前事实时，先调用工具查询当前真实状态再作答/再动手；不凭历史对话、记忆或猜测作答；下一步永远以查询结果为准，不自造步骤顺序。
- **来源（DramaClaw 条款）**：SKILL.md §0「幂等 GET，每次 skill 激活都固定先拉一次——不要依赖'我上一轮已经拉过'的判断」；§1「用户提到'项目''进度''状态'…先调用 API 获取当前状态，再回答；不要凭历史对话、日志、记忆或文件猜测」；§2 执行纪律第 1 条「下一步永远以 `GET /pipeline/status` 的 `next_step` 为准…不要自己推断/编造步骤顺序」。
  - EN: *Query current state before acting or answering status questions. Never answer from conversation history or memory; the next step is always determined by the live status response, never self-invented.*
- **ToIV 现状**：原则 6 已覆盖「ComfyUI/模型细节先 search_knowledge 查证」，但未覆盖「模型清单/能力查询」这类状态意图（`list_models` 工具存在，prompt 未引导先查再答）。
- **应用方法**：写入 `SYSTEM_SUFFIX` 原则段（落地条款 L3，与既有原则 6 并列）。

### P6 大任务先澄清拆解

- **原则**：覆盖多个阶段的大目标（如"做一部短片"）不得立即动手；第一轮先说明需要拆成明确小任务，给出拆解方案并征得用户确认，再逐步执行。
- **来源（DramaClaw 条款）**：SKILL.md §1「笼统大任务先澄清拆解」（"不得立即启动任何写工具…第一轮必须先告诉用户这类需求需要拆成明确小任务…然后询问用户是否需要先列出当前制作进度和建议下一步"）；§1「不要为完成大目标自动扩展范围」（用户没明确要求自动驾驶时，不得从"生成视频"自动扩展为全链路）。
  - EN: *Vague multi-stage goals must be clarified and decomposed first: present the breakdown as explicit small tasks and get user confirmation before any write tool is invoked. Never auto-expand scope to finish a big goal.*
- **ToIV 现状**：对话助手无拆解纪律（用户说"帮我做短片"时 LLM 可能直接连发 generate_video）；Agent Team 已由 Director Gate 分级（L0/L1/L2）+ 计划卡片 + 计划确认门承载拆解，是代码化实现。
- **应用方法**：对话助手写入 `SYSTEM_SUFFIX` 原则段（落地条款 L4，措辞与原则 4 协调——"一次多产"允许，"多阶段自动扩展"不允许）；多阶段需求引导用户到 Agent Team（/agent-runs 任务卡片）。

### P7 媒体展示 URL 原样透传

- **原则**：媒体结果由工具/展示层直接交付给用户；助手不手写媒体 URL、markdown 图片语法或 HTML 媒体标签，不自拼 host/下载路由，不把本地文件路径当展示源。
- **来源（DramaClaw 条款）**：SKILL.md §1.1「URL 必须原样透传给展示工具」（"不要自己拼、不要加 host/域名、不要改 query"）；「严禁使用文件系统路径作为媒体源」；「绝对禁止输出 markdown 图片语法、纯文本媒体 URL、任何 http/https 链接、HTML `<img>/<video>` 标签或任何手写媒体展示」。
  - EN: *Media URLs from API responses must be passed through verbatim to display tooling. Never hand-write markdown image syntax, plain-text URLs, or HTML media tags; never fabricate hosts/download routes or use local file paths as media sources.*
- **ToIV 现状**：架构上已规避大半——工具执行器产出 URL，经 runner 收集为 media 事件直推前端展示，LLM 只收到"已生成 N 张图片并展示给用户"的文本。但 prompt 未禁止 LLM 自行输出链接/图片语法（LLM 能看到工具文本里的部分信息，仍可能手写 URL）。
- **应用方法**：写入 `SYSTEM_SUFFIX` 原则段（落地条款 L5，补 prompt 层禁令）。

---

## 二、使用场景矩阵

| 原则 | 对话助手（/api/agent/chat, runner.py） | Agent Team 编排（/api/agent-runs, LangGraph） | API 调用（REST 直连工具端点） |
|---|---|---|---|
| P1 单轮写任务限制 | ✗ 不采纳（同步生成，多产是 feature） | ● 代码承载（图拓扑 + 渲染信号量 + 确认门） | ○ 不适用（无 LLM 在环） |
| P2 错误即停/原文转告 | ● prompt 落地（L1） | ● 代码承载（单任务 error 不中断分支 + blocked 事件） | ● 代码承载（HTTP 错误码/503 语义） |
| P3 Grounding | ● prompt 落地（L2） | ● 代码承载（任务 output_json 即执行证据） | ○ 不适用 |
| P4 覆盖操作二次确认 | ✗ 无覆盖性操作 | ● 代码承载（计划/合成确认门 + AgentApproval） | ● 代码承载（确认门端点） |
| P5 状态驱动 | ● prompt 落地（L3，并列原则 6） | ● 代码承载（断点续跑先查任务表） | ● 代码承载（状态端点） |
| P6 大任务先澄清拆解 | ● prompt 落地（L4，引导到 Agent Team） | ● 代码承载（Director Gate 分级 + 计划卡片） | ○ 不适用 |
| P7 媒体 URL 透传 | ● prompt 落地（L5，架构已半规避） | ● 架构承载（产物经 output_json + 签名 URL） | ● 架构承载（签名 URL，易错点 26） |

图例：●=适用并落地；○=该场景不存在此问题；✗=明确不采纳（附原因）。

---

## 三、在 ToIV agent 配置中的具体应用方法

### 落点：`apps/api/app/agent/runner.py` → `SYSTEM_SUFFIX`（原则段）

系统提示词三段式结构（**单一事实源**）：

```
SYSTEM_PREFIX（静态头：身份+能力声明）
+ get_ctx().service("tools").build_system_prompt()（工具清单段，注册表自动生成，不动）
+ SYSTEM_SUFFIX（静态尾：原则段 ← 本次落点）
```

- 工具清单段由 `app/harness/tool_seam.py` 的 `ToolRegistry.build_system_prompt()` 从各 ToolSpec.summary 生成，**本纪律不改它**；新增工具走 tool_seam 注册，summary 即进清单。
- 原则段新增 5 条（编号续既有 1-6），每条一行祈使句、中文、与既有风格一致：

```
L1(对应P2)  7. 工具返回失败/超时/不可用时,如实转告原因并停下;不要同一轮反复重试同一工具或改猜参数绕过。
L2(对应P3)  8. 只确认工具实际成功返回的结果;未执行或未成功的步骤不说成已完成。
L3(对应P5)  9. 用户问模型清单/能力等状态类问题时,先调用工具查当前结果再回答,不凭记忆猜测。
L4(对应P6) 10. 多阶段的大需求(如"做一部短片")先与用户确认拆解方案再动手,不自动连发一整串生成调用;必要时引导使用 Agent Team 任务编排。
L5(对应P7) 11. 生成结果由工具直接展示;不要自己输出媒体链接、markdown 图片语法或本地文件路径。
```

### 测试锁定同步

- 锁定点：`apps/api/tests/test_harness_tools.py` 的 `LEGACY_SYSTEM` 字面量 + `test_runner_system_prompt_byte_identical_to_legacy`（逐字节等价锁）。
- 机制：`runner.system_prompt()` 现拼三段与 `LEGACY_SYSTEM` 全等断言——**改 SYSTEM_SUFFIX 必须同步改 LEGACY_SYSTEM**，这是该锁的设计意图（防止提示词被无意漂移）。
- 本次为 deliberate 更新：在 `LEGACY_SYSTEM` 原则段末尾追加与 runner 完全一致的 5 行，并更新文件头 docstring 说明锁定范围已含纪律条款。

### 不落 prompt 的部分（避免 prompt 恳求替代代码强制）

- P1/P4 在 Agent Team 侧由 LangGraph 编排与确认门代码承载；未来给 Leader/Worker 子代理写 prompt 时（R5），再按本文档第一节原文条款裁剪引用。
- 工具执行器的错误文本是 P2 的事实源（LLM 只能转告它看到的内容）；保持执行器返回"原因+可操作建议"的现有风格，不要把错误吞成空串。
