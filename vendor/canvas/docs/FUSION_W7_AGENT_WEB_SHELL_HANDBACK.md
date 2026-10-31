# 融合 W7 · Agent/插件收口 + web 薄壳 Handback（F6/F11/F9 · 只 FE）

**日期**：2026-10-28（Asia/Shanghai）  
**执行**：前端开发（跨端 FE）  
**基线 tip**：`bf3f9748`（W6 BUILD `20261028-110918-bf3f9748`）  
**分支**：`work/p0-fusion-20261016`  
**机器**：MateBook `/Users/wangzhenyu/Desktop/ALLProject/ToIV`  
**范围**：只 FE；**禁 commit / push / deploy**（本 handback 等 TL 过审）

## 目标落地

| # | 目标 | 落地 |
|---|---|---|
| 1 | 对话只留 `/create` | `/toiv/agent` 仍 Navigate→`/create`；侧栏去掉「外部 Agent」；⌘K 无独立 Agent 面；浮窗 stash → create composer 消费 |
| 2 | 插件收口 | **主入口 = 市场 ToolsIntent「扩展 / 插件中心」→ `/plugins`**；⌘K 同深链；禁新一级导航 |
| 3 | web 薄壳 | `/studio/desktop*` middleware 308→`/studio/create`（防 hydrate 闪页）；tokens 双生钉 canvas 真源；EngineStudioView 已 @deprecated 挂账不盲删 |

## 插件入口选型（二选一写清）

**选型：市场 ToolsIntent 为主入口。**

- 理由：工具台已是扩展能力密台（姿势参考等同模式）；插件是「能力扩展」而非设置偏好；避免设置再开一节造成双入口。
- `/plugins` 路由与 `RequireFeature(pluginCenterEnabled)` **保留**（Eagle 深链/安装流仍可达）。
- 设置区：**不**新增 plugins section；外部 Agent **客户端**仅保留设置折叠内链 → `/agents`（非对话面、非侧栏）。

## agent → create 映射表

| 路径 / 入口 | Before | After |
|---|---|---|
| `/toiv/agent` | → `/create`（已有） | 不变 |
| 侧栏「外部 Agent」 | `/agents`（高级组） | **移除** |
| ⌘K Agent / agents | 无 | 仍无 |
| 浮窗「在对话页打开」 | stash + `/create`（无消费者） | stash + `/create`；**create composer 消费** |
| 画布「发到对话」 | stash draft + `/create`（无消费者） | 同左；**composer 吃 draft** |
| `/agents` 路由 | 外部 Agent 客户端页 | **保留**（设置侧链）；非对话面 |
| 裸 `/desktop*` | 308→create（W6） | 不变 |
| `/studio/desktop*` | SPA Navigate only | **middleware 308→`/studio/create`** |

## composer pending 结论

- **缺口（W1–W3 挂账）**：浮窗写 `toiv_agent_pending_session` / 画布写 `toiv_agent_draft`，legacy AgentPage 卸后无消费者。
- **本波**：`creation-agent-handoff.ts` + `create/index.tsx` hydrate 后 `consumeCreationAgentHandoff`：
  1. `takeAgentDraft()` → 空 composer 填 prompt（带节点 title 时 toast）
  2. `takePendingAgentSession()` → `fetchAgentHistory` → 写入当前空会话（或新建）消息列表
- take 即删；历史拉取失败则 session 已消费、toast 警告，不阻塞创作台。
- 浏览器测 `director-layout.browser.test.ts` 已对齐 create aria-label（不再找 legacy placeholder）。

## web 删 / 留 / 挂账

| 项 | 处置 | 说明 |
|---|---|---|
| `middleware` `/studio/desktop*` | **改** | 308→create |
| `toiv-freezone-tokens.css`（web↔canvas） | **留双生** | 注释已钉 Sync twin；**真源 = canvas**，web 保持 identical（本波 diff 为空） |
| `EngineStudioView` + `components/generate/**` + `apps.css` | **挂账** | 已 @deprecated、page 不挂载；仍被单测/配方回归引用，**不确定不盲删** |
| `app/agent-runs` / `app/drama` | **留** | 仅 redirect 到 studio，属薄壳深链 |
| SoftGlow / 首页意图墙 / DesktopShell 默认挂载 | **未动** | 禁区 |

## 改动文件

| 文件 | 动作 |
|---|---|
| `apps/canvas/web/src/pages/create/creation-agent-handoff.ts` | **新** pending/draft 消费 |
| `apps/canvas/web/src/pages/create/index.tsx` | hydrate 后消费 handoff |
| `apps/canvas/web/src/components/layout/workspace-sidebar-nav.tsx` | 去掉外部 Agent |
| `apps/canvas/web/src/components/layout/workspace-command-palette.tsx` | ⌘K +插件中心 |
| `apps/canvas/web/src/components/toiv/tools-intent-grid.tsx` | 扩展组→/plugins |
| `apps/canvas/web/src/pages/canvas/toiv-agent-float.tsx` | openInCreateComposer |
| `apps/canvas/web/src/services/toiv/agent-draft.ts` | 注释对齐 W7 |
| `apps/canvas/web/src/pages/settings/channel-settings-pane.tsx` | 侧链文案 |
| `apps/canvas/web/src/router.tsx` | `/agents` 注释 |
| `apps/web/middleware.ts` | `/studio/desktop*` 308 |
| `apps/canvas/web/test/fusion-w7-agent-web-shell.test.ts` | **新** |
| `apps/canvas/web/test/toiv-agent-chat.test.ts` | 侧栏断言对齐 W7 |
| `apps/canvas/web/test/toiv-agent-float-f9.test.ts` | openInCreateComposer |
| `apps/canvas/web/test/director-layout.browser.test.ts` | create composer 消费 |
| `apps/web/tests/f12RetiredRedirects.test.ts` | studio/desktop 源码断言 |
| `apps/canvas/docs/FUSION_W7_AGENT_WEB_SHELL_HANDBACK.md` | 本文件 |

## 测结果（Asia/Shanghai）

```
bun test fusion-w7 + fusion-w6 + toiv-agent-* + workspace-command-palette-f9
      + agent-product-entry-retired
→ 43 pass / 0 fail

node --test tests/f12RetiredRedirects.test.ts
→ 源码断言 pass（含 studio/desktop）
→ 真实 middleware 动态 import：本机 next/server 解析失败（与 W1/W6 handback 既有环境债相同，非本波引入）
```

## 明确未做 / 禁区

- **未** commit / push / deploy
- **未** 动 redline 姿势闸 / pose-gallery / W6 project-track-gate / SoftGlow / 首页意图墙 / 第六导航 / 接回 DesktopShell
- **未** 夹 `apps/api/**`、`deploy/backups/**`、二进制
- **未** 删 EngineStudioView / generate 死码（挂账）
- `/agents` 客户端页仍可达（设置侧链），非对话 Agent 面

## 残留脏树

- `?? deploy/backups/`（既有；勿 stage）
- 本波 FE 改动全部 unstaged，等 TL 过审后再 tip

## 验收建议（过审后）

1. 侧栏一级五项；高级组无「外部 Agent」；设置→外部 Agent 客户端仍开 `/agents`
2. `/toiv/market` ToolsIntent「扩展」→ 插件中心；⌘K「插件中心」
3. 浮窗「在对话页打开」→ `/create` 且消息恢复；画布发到对话 → composer 预填
4. 直访 `/studio/desktop` → 308/落 `/studio/create`（无闪页）
