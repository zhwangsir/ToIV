# 融合 W7.1 · 高级自由画布单入口 + 侧栏 pill 毛边 Handback（只 FE）

**日期**：2026-10-29（Asia/Shanghai）  
**执行**：前端开发（跨端 FE）  
**基线 tip**：`49e2b1e5`（W7 已发）  
**分支**：`work/p0-fusion-20261016`  
**机器**：MateBook `/Users/wangzhenyu/Desktop/ALLProject/ToIV`  
**范围**：只 FE；**禁 commit / push / deploy**（本 handback 等 TL 过审）

## 用户反馈 → 落地

| # | 问题 | After |
|---|---|---|
| 1 | 高级组「自由画布库」+「新建自由画布」功能重复 | 侧栏高级 **只留一条**「自由画布库」→ `/project`；新建迁库页 |
| 2 | 选中 pill 左侧圆角白/亮边外溢（layoutId） | 链接 `overflow:hidden` + 与 pill 同半径 `var(--r-md)`；pill `translateZ(0)` |

## Before / After 导航

| 位置 | Before | After |
|---|---|---|
| 侧栏「高级 / 专家面」 | ① 自由画布库 `/project` ② 新建自由画布 `/canvas?mode=new` | **仅** ① 自由画布库 `/project` |
| 一级五项 | 创作 / 短剧项目 / 任务中心 / 工具台 / 设置 | **未改** |
| ⌘K | 无 canvas/project 主推（W6） | **未改** |
| SoftGlow / 意图墙 / DesktopShell / redline / pose | — | **未动** |

## 库页新建 CTA 落点

路由：`/project`（及 `/canvas`、`/projects` 同页 `CanvasPage`）

1. **主按钮（本波新增）**：`PageHeader` actions 区 `type="primary"`「新建自由画布」→ `createAndEnter`
2. **空态 CTA（已有，保留）**：无画布时 WorkspaceState 同按钮
3. **网格入口卡（已有，保留）**：「开始创作」`libtv-create-project-card` → 同 `createAndEnter`

侧栏不再直链 `/canvas?mode=new`；深链常量 `FREE_CANVAS_NEW` / 库内加媒体路径仍可用（非导航）。

## 毛边修法

文件：`apps/canvas/web/src/styles/workspace-product.css`

- `.app-workspace-nav-link`：加 `overflow: hidden` + 显式 `border-radius: var(--r-md)`（与 Tailwind `rounded-[var(--r-md)]` 对齐）
- `.app-workspace-nav-active-pill`：`border-radius: var(--r-md)`（不用 inherit，避免 layout 投影期圆角丢失）、`overflow: hidden`、`transform: translateZ(0)` 促合成层，裁切 layoutId 弹簧位移外溢

## 改动文件

| 文件 | 动作 |
|---|---|
| `apps/canvas/web/src/components/layout/workspace-sidebar-nav.tsx` | 去掉 `canvas:new`；去掉未用 `Plus` import |
| `apps/canvas/web/src/pages/canvas/index.tsx` | Header 主按钮「新建自由画布」 |
| `apps/canvas/web/src/styles/workspace-product.css` | pill / link 裁切 |
| `apps/canvas/web/test/fusion-w6-canvas-demote.test.ts` | 断言改为「无新建自由画布」侧栏项 |
| `apps/canvas/web/test/fusion-w7-1-adv-canvas-nav.test.ts` | **新增** W7.1 回归 |
| `apps/canvas/docs/FUSION_W7_1_ADV_CANVAS_NAV_HANDBACK.md` | 本 handback |

**未动**：`apps/api/**`、`deploy/backups/**`、二进制、一级五项、redline、pose-gallery、W6–W7 收口语义。

## 测结果

```
bun test test/fusion-w7-1-adv-canvas-nav.test.ts test/fusion-w6-canvas-demote.test.ts
9 pass / 0 fail（Asia/Shanghai 本机）
```

- W7.1：3 测绿（单入口 / 库页主按钮 / pill 裁切）
- W6 demote：6 测绿（已改侧栏断言为 notContain 新建）

## 禁区自检

- [x] 未改一级五项
- [x] 未引 SoftGlow / 首页意图墙 / DesktopShell
- [x] 未 commit / push
- [x] 未夹 api / deploy/backups / 二进制
