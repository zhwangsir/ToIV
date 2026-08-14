# ToIV AI 底层驱动改造方案(Harness 化)

> 参照:[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 技术架构(docs/architecture.md,2026-08-14 读档)
> 性质:实现方案 + 落地路线(H1→H3)
> 约束:FastAPI/Python 栈不改语言;对外 API 契约零变更;R3.1/R3.2 已上线的 Agent Team 不动契约

---

## 〇、dsh 架构精髓 → ToIV 映射

| dsh 概念 | 精髓 | ToIV 现状 | 改造目标 |
|---|---|---|---|
| 一切皆插件(Cordis) | 服务/类型化事件/可逆效应挂共享 ctx;卸载即回收 | 引擎有声明式注册表;工具/质量门/人格硬编码散布 | `app/harness/` 插件运行时:ctx 服务注册 + 可逆效应 + 事件总线 |
| Service Provider 缝 | Definition/Provider/Consumer 三角色;换 Provider 全局生效 | `llm.chat` 被 10+ 处直接 import,无抽象 | `ctx.llm` 统一适配缝:L1-L4 分层 + fallback + NSFW 路由收进 Provider |
| Session log 即事实源 | append-only 事件流;**model-visible means logged**;fork/replay 从日志派生 | agent 对话零服务端持久化(前端 localStorage 按天存) | `SessionEvent` 追加日志表 + `derive_messages` 投影;会话回放/分叉/跨设备 |
| 工具注册 + 守卫管线 | scoped registry;tools/pre-execute→execute→post-execute waterfall | TOOL_SCHEMAS/execute if-elif/runner.SYSTEM 三处手工同步 | `ctx.tools`:工具插件自注册(schema+executor+说明单一事实源);守卫钩子(限流/R18 门/审批) |
| 事件三域 | session/*(持久事实)/agent/*(在飞拦截)/capability/*(策略挂载) | AgentEvent 只有 run 级流水;对话无事件域 | 事件总线三域,emit + waterfall(next() 委托) |
| Profiles/bundles | 启动时按层组合插件树,patch 可替换任意行 | main.py 静态 import 55 路由,功能无组合开关 | profile 配置组合插件集(默认全量;裁剪场景可减配) |

**不做的事**:不引入 Cordis(TS 生态);不换 LangGraph(R3.2 已定);不改任何对外 API 形状;harness 是后端内部架构层。

---

## 一、H1:harness 内核 + LLM 适配缝

### 1.1 新包 `app/harness/`

```
app/harness/
  context.py    # HarnessContext:services(set/get/has)、effects(注册即返回回收器,unload 逆序回收)
  events.py     # 类型化事件总线:on/emit/fire-and-forget;waterfall(next() 链式委托,对齐 dsh)
  plugin.py     # Plugin 协议:name/activate(ctx)/deactivate();PluginRegistry 启动组合
  llm_seam.py   # ctx.llm:LLMProvider 协议 + LayeredProvider(包装现有 agent/llm.py 全部能力)
```

### 1.2 LLM seam 设计(Provider 三角色)

- **Definition**:`LLMProvider` 协议 — `chat(messages, tools, **kw)` / `chat_layered(messages, layer, **kw)` / `embed(texts)`(收编 embed_url 逻辑)
- **Provider**:`LayeredLLMProvider` 薄包装现有 `agent/llm.py`(重试/降级/fallback/NSFW 路由/reasoning 合并全部保留);构造参数注入 settings
- **Consumer 迁移**:10+ 处 `from app.agent import llm` 直调点(runner/optimize/manju/drama_studio/storyboard/agent_team/decision 等)改为 `ctx.llm`——经 `app/harness/ctx.py` 进程级单例(`get_ctx()`),路由内 `ctx = get_ctx()` 取用
- **收益**:换 Provider 全局生效(如未来 vLLM 直连适配器);测试可注入 fake Provider(现有测试 mock llm.chat 的点收敛为一处)

### 1.3 事件域(本期最小集)

`agent/pre-step`(waterfall)、`agent/request`(waterfall)、`tools/pre-execute`(waterfall)、`tools/post-execute`、`session/event`(持久事实)。dsh 全量域按需后补。

### 1.4 验收

- 内核单测(ctx 服务/效应回收/waterfall 顺序与中断/插件启停)
- LLM seam 单测(Provider 包装行为与现有 llm.chat 一致;fake Provider 注入)
- 既有测试全绿(mock llm.chat 的测试经兼容 shim 不炸:harness ctx 默认 Provider 即原 llm 模块)

---

## 二、H2:会话日志 + 工具管线

### 2.1 SessionEvent 追加日志(model-visible means logged)

- 新表 `AgentSession` / `AgentMessage`(事件流):字段含 run 制式(id/user_id/created_at)+ 消息(role/content/tool_calls/媒体产物 JSON/token 数)
- `derive_messages(session_id)` 投影模型历史;`fork(session_id, boundary)` 分叉
- `POST /api/agent/chat` 落库(每条 user/assistant/tool 消息追加);新增 `GET /api/agent/sessions`、`GET /api/agent/sessions/{id}`(回放)、`POST /api/agent/sessions/{id}/fork`
- 前端 AssistantView 从 localStorage 迁移为服务端会话(保留本地缓存做离线兜底);R18 上下文会话按 nsfw_ctx 过滤

### 2.2 工具缝(ctx.tools)

- 工具插件自注册:`ToolSpec{name, schema(OpenAI function), executor, summary, nsfw_gate, rate_scope}`——schema/执行器/说明**单一事实源**,runner.SYSTEM 由注册表自动生成(消灭三处同步)
- 守卫管线:`tools/pre-execute` waterfall 挂守卫(R18 门 nsfw_ctx、限流 ratelimit scope、参数校验)→ executor → `tools/post-execute`(结果审计/产物落 Job)
- 8 个既有工具(generate_image/generate_music/generate_video/edit_image/generate_3d/list_models/search_knowledge/run_workflow)逐一改为插件,行为逐一对齐(既有测试锁死)

### 2.3 验收

- 会话落库/回放/分叉测试;R18 过滤测试
- 工具注册表→SYSTEM 生成快照测试;守卫命中测试(无 X-NSFW 调 NSFW 工具 403 语义);8 工具回归
- AssistantView 端到端:发消息→刷新页面→会话仍在(服务端回放)

---

## 三、H3:引擎/质量门/编排插件化 + profile

1. **引擎插件**:engine_registry `_REGISTRY` 20 条目迁为引擎插件(每条补 `submit_route` 绑定,收敛「注册表只覆盖元信息、提交链各自为政」);前端 `/api/models/engines` 输出不变
2. **质量门插件**:quality/* 挂 capability 事件(orchestrator render 完成事件 → advisory 评估),接线点从硬编码 import 改事件订阅;`evaluate_text_faithfulness` 死代码接入或删除
3. **人格进对话**:`Agent.llm_model_override` 字段(现存无消费方)接入 LLM seam;人格前缀注入 agent chat(目前只服务 optimize)
4. **profile 组合**:`TOIV_HARNESS_PROFILE`(默认 full)决定启动哪些插件;`--dump-config` 等价端点 `GET /api/system/harness`(admin)展示插件树
5. **routes ↔ services 循环依赖清理**:agent_team_graph 惰性 import routes/agent_team 的节点函数下沉 services,消除脆弱结构

---

## 四、里程碑顺序与依赖

| 里程碑 | 内容 | 依赖 | 风险 |
|---|---|---|---|
| **H1** | harness 内核 + LLM seam + 消费方迁移 | 无 | mock 点收敛引起既有测试适配 |
| **H2** | 会话日志 + 工具缝 + 前端会话迁移 | H1 | AssistantView 会话迁移 UX |
| **H3** | 引擎/质量门/编排插件化 + profile | H1/H2 | 引擎插件搬迁面广,逐引擎对齐 |

每里程碑:TDD 测试 + 全量回归(pytest/vitest/build)+ STATE.json/TEST_LOG.md 登记 + 部署 core。
