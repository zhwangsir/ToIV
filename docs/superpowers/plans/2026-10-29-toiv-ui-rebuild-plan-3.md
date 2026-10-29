# ToIV UI 重建 · Plan 3：画布面壳（项目库） Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans（本会话 inline）。

**Goal:** 画布面项目库新壳：ToonFlow projectHome 语法（封面卡网格 + 搜索 + 新建）+ dramaclaw 身份，strangler 替换 `/canvas` 与 `/projects`；`/canvas/:id` 引擎重壳延后 Plan 3b（本计划明示不做）。

**Architecture:** 数据经 `fetchDramaProjects`（client.ts:616）；新组件 `ProjectCard/ProjectGrid/CanvasHomeFace`；路由 `/canvas`、`/projects`、`/project` 指向新 route（flag `canvas` 回退旧 CanvasPage）。

**Spec:** `docs/superpowers/specs/2026-10-29-toiv-ui-rebuild-design.md` §4.2/§6。

## Global Constraints

同 Plan 1/2（锁纪律/无 antd/无硬编码色/!important=0/语义测试/URL 兼容/业务层不动/bun-only/四套件门禁/内联样式键白名单 left|width|paddingTop|backgroundImage）。

## File Structure

| 文件 | 职责 |
|---|---|
| `src/studio/faces/canvas/model.ts` | `loadCanvasHomeModel(): Promise<CanvasHomeModel>`（fetchDramaProjects → cards） |
| `src/studio/ui/ProjectCard.tsx` | 封面卡（still 占位/标题/状态/镜数） |
| `src/studio/ui/ProjectGrid.tsx` | 卡网格 + 空态 |
| `src/studio/faces/canvas/CanvasHomeFace.tsx` | 搜索框 + 新建按钮 + Grid |
| `src/studio/routes/studio-canvas-route.tsx` | `/canvas`、`/projects`、`/project` strangler |
| `src/router.tsx`（改） | 三路由指向新 route |
| 测试：`test/studio-canvas-model.test.ts`、`test/studio-components.test.tsx` 追加、`test/studio-canvas.browser.test.ts` + fixture | 契约/交互 |

---

### Task 1: 项目库模型适配器

- [ ] **Step 1 失败测试**（mock fetchDramaProjects 两条：title/status/shots 计数经 `shots_count?` 不存在则 0）：cards 映射 title/status；空列表 → `empty: true`。
- [ ] **Step 2 红**；**Step 3 实现**：`type ProjectCardModel = { id, title, status, stillSeed, shotCount }`；`loadCanvasHomeModel()` 调 fetchDramaProjects，stillSeed = id hash（简单字符串哈希取模 4），shotCount = `(project as {shots_count?: number}).shots_count ?? 0`。
- [ ] **Step 4 绿 + typecheck**；**Step 5 Commit** `feat(canvas): 项目库模型适配器`

### Task 2: ProjectCard / ProjectGrid

- [ ] **Step 1 失败测试**：card 渲染 title + 状态文案（STATUS_LABEL）+ aria-label；grid 空态含"新建项目"动作按钮。
- [ ] **Step 2 红**；**Step 3 实现**（`.pcard` 卡：still 占位 + 标题 + meta 行 + hover 抬升；grid `repeat(auto-fill,minmax(220px,1fr))`）。
- [ ] **Step 4 绿**；**Step 5 Commit** `feat(canvas): 项目卡与网格`

### Task 3: CanvasHomeFace + 路由 strangler

- [ ] **Step 1 失败测试**：face 含搜索 input（aria-label 搜索项目）、新建按钮、grid；route 组件在 flag 关闭时回落旧 CanvasPage（静态断言 flags 函数）。
- [ ] **Step 2 红**；**Step 3 实现**：face = bar(搜索+新建) + ProjectGrid；route 同 create/edit 模式（无数据回落旧页）；router 三路由换 lazy StudioCanvasRoute；FaceSwitcher 的 canvas 目标保持 `/canvas`。
- [ ] **Step 4 绿 + lint + typecheck**；**Step 5 Commit** `feat(canvas): 画布面项目库壳与路由接管`

### Task 4: 浏览器交互 harness

- [ ] 断言：搜索过滤卡（输入"草船"只剩匹配卡）、新建按钮 toast、卡点击记录 action、面切换按钮存在。
- [ ] 红→绿；Commit `test(canvas): 项目库交互 harness`

### Task 5: 门禁 + 全量 + 截图 + 推送

- [ ] 债务门禁、canvas 全量、lint/typecheck、web 两侧；截图 `/tmp/studio-canvas-{dark,light}.png`；commit；push 双远端。

## Self-Review

- Spec §4.2 画布面：本计划交付项目库壳；**引擎重壳（/canvas/:id）= Plan 3b，明示延后**（旧页 3,426 行数据接线风险高，单独计划）。
- 无占位符；shots_count 缺失时 0 为显式契约（测试覆盖）。
- 类型一致：ProjectCardModel 在 T1 定义，T2/T3 消费。
