# 融合 W6 · 画布降级 + Cosmos 断路由 Handback（F4/F12 · 只 FE）

**日期**：2026-10-28（Asia/Shanghai）  
**执行**：前端开发（跨端 FE）  
**基线 tip**：`2ac61fa1`（W5 已发 BUILD `20261028-105302-2ac61fa1`）  
**分支**：`work/p0-fusion-20261016`  
**机器**：MateBook `/Users/wangzhenyu/Desktop/ALLProject/ToIV`  
**范围**：只 FE；**禁 commit / push / deploy**（本 handback 等 TL 过审）  
**stash**：已 `git stash drop` 原 `stash@{0}` = `ops:temp-stash-pre-deploy-b63cebb9-W5-wip`（内容为已合入 W5 旧片段；更旧 ops stash 未动）

## 目标落地

| # | 目标 | 落地 |
|---|---|---|
| 1 | 画布降级 | 侧栏画布只在「高级 / 专家面」；⌘K 无 canvas/project；首页 capability 去掉 /canvas 四项；去掉「新建画布」次入口；最近区改标「最近自由画布（专家）」 |
| 2 | 项目门禁 | `lib/project-track-gate.ts` 写死短剧=`/create?project=`、自由画布库=`/project`；画布库 PageHeader + `/projects/:id` info banner 明示双轨 |
| 3 | Cosmos 断路由 | SPA：`/desktop*` → `<Navigate to="/create" replace />`；web：裸 `/desktop*` 308 → `/studio/create`；**源码/文档保留**（`pages/desktop`、`components/desktop`、`COSMOS_APP_SHELL_SEED.md`） |

## 路由表 before → after

| 路径 | Before | After |
|---|---|---|
| `/` | → `/create`（W1） | 不变 |
| `/home` | HomePage | 不变（非默认） |
| `/desktop` | DesktopHomePage | → `/create` |
| `/desktop/store` | AppStorePage | → `/create` |
| `/desktop/legacy-home` | HomePage | → `/create` |
| `/desktop/*` | （无） | → `/create` |
| `/project`·`/projects` | CanvasPage（自由画布库） | **仍可达**（专家面；侧栏/首页不再主推） |
| `/canvas`·`/canvas/:id` | 可达 | **仍可达**（专家；非一级） |
| `/projects/:id` | ProjectDetail / local→canvas | 仍可达 + 门禁文案 |
| `/toiv/drama` → 卡 | → `/create?project=` | 不变 |
| 裸 `/desktop*`（web） | 未拦 | 308 → `/studio/create` |

## 改动文件

| 文件 | 动作 |
|---|---|
| `apps/canvas/web/src/router.tsx` | `/desktop*` Navigate→`/create`；卸 Desktop lazy（源码保留） |
| `apps/canvas/web/src/lib/project-track-gate.ts` | **新** 双轨常量 + 门禁文案 |
| `apps/canvas/web/src/components/layout/workspace-sidebar-nav.tsx` | 「高级 / 专家面」；自由画布库 / 新建自由画布 |
| `apps/canvas/web/src/components/layout/workspace-command-palette.tsx` | 注释钉 W6（白名单本已无 canvas） |
| `apps/canvas/web/src/pages/home/home-data.ts` | capability 去掉 canvas/video/image/audio（均指 /canvas） |
| `apps/canvas/web/src/pages/home/home-dashboard.tsx` | 去「新建画布」；最近区专家文案 |
| `apps/canvas/web/src/pages/canvas/index.tsx` | 标题「自由画布库」+ 门禁 description；返回 `/create` |
| `apps/canvas/web/src/pages/projects/detail.tsx` | info banner 门禁 hint |
| `apps/canvas/docs/COSMOS_APP_SHELL_SEED.md` | 路由节改为默认不可达；再挂步骤更新 |
| `apps/web/middleware.ts` | `/desktop*` 308 + matcher |
| `apps/canvas/web/test/fusion-w6-canvas-demote.test.ts` | **新** W6 冒烟 |
| `apps/canvas/web/test/agent-product-entry-retired.test.tsx` | 对齐 W1/W6 首页文案 |
| `apps/canvas/web/test/local-capability-surface.test.ts` | 对齐「打开创作台」、禁 /canvas 主推 |
| `apps/web/tests/f12RetiredRedirects.test.ts` | matcher/源码断言含 desktop；运行时 invoke desktop（若本机 next/server 可解析） |
| `apps/canvas/docs/FUSION_W6_CANVAS_DEMOTE_HANDBACK.md` | 本文件 |

## 种子保留说明

- **保留**：`web/src/pages/desktop/**`、`components/desktop/**`、`lib/desktop/**`、`stores/use-desktop-store.ts`、`styles/desktop-shell.css`、M0–M2.1 handback/shots、`COSMOS_APP_SHELL_SEED.md`
- **UserLayout**：仍 `AppWorkspaceShell`；**无** `<DesktopShell>` 默认挂载
- **再挂**：见种子文档；禁未经 TL 接回 ToIV 默认交付

## 测结果（Asia/Shanghai）

```
bun test fusion-w6-canvas-demote + workspace-command-palette-f9
      + agent-product-entry-retired + local-capability-surface
→ 34 pass / 0 fail

node --test tests/f12RetiredRedirects.test.ts
→ 源码断言 pass（含 desktop matcher）
→ 真实 middleware 动态 import：本机 next/server 解析失败（与 W1 handback 既有环境债相同，非本波引入）
```

## 明确未做 / 禁区

- **未** commit / push / deploy
- **未** 动 `redline.ts` 姿势闸 / pose-gallery API / SoftGlow / 首页意图墙 / 第六导航
- **未** 删 App Shell 源码；**未** 夹 `apps/api/**`、`deploy/backups/**`、二进制
- `/project`·`/canvas` 深链与高级入口仍可达（专家面，非删除）
- 托管项目详情页完整 IA 收敛留给后波（本波只加门禁文案）

## 残留脏树

- `?? deploy/backups/`（既有；勿 stage）
- 本波 FE 改动全部 unstaged，等 TL 过审后再 tip

## 验收建议（过审后）

1. 硬刷 `/studio/` → `/studio/create`；侧栏一级仍五项；展开「高级 / 专家面」才见自由画布
2. ⌘K 搜「画布」无条目；直访 `/studio/desktop` → 落 `/studio/create`
3. `/toiv/drama` 点项目 → `/create?project=`；`/project` 标题为「自由画布库」且有门禁说明
