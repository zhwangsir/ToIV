# 融合 W4 · 媒体库真融合 Handback（F3/F14）

**日期**：2026-10-28（Asia/Shanghai）  
**执行**：跨端设计 + 前端开发  
**基线 tip**：`b75ca18e`（脏改未 commit）  
**分支**：`work/p0-fusion-20261016`  
**范围**：只 FE；禁 SoftGlow / 首页意图墙 / DesktopShell 默认 / redline / 精选灵感；禁 W5 PosePicker / 灌图；禁 commit/push/deploy

## 目标

`/library` 不再按 `source` **整页 switch** 两套实现；用户感知是**一个媒体库**（作品 / 素材 / 生成历史 / 姿势预留），统一壳 + 轨 + 空态气质（BeefTV / ToivEmptyState）。

## 前后结构

### 前（W4 前）

```
MediaLibraryPage
  ├─ source=works     → <LibraryPage />     // 自带 WorkspacePage + Rail
  └─ else             → <AssetsPage />      // 自带 WorkspacePage + Rail
                                              // 内部再 history|personal 分叉
```

- 两套完整页面 chrome（双 WorkspacePage / 双 Rail 挂载点）
- 空态分裂：`library-works` 用 product `EmptyState`；library-page / assets 用 `ToivEmptyState`；历史空态用 `WorkspaceState`
- 无 `poses` 轨

### 后（W4）

```
MediaLibraryPage（唯一壳）
  WorkspacePage（class 随轨：fz-desk / canvas-library / generation-history）
    ├─ works     → <LibraryPage embedded />
    ├─ materials → <AssetsPage embedded forcedSource="materials" />
    ├─ history   → <AssetsPage embedded forcedSource="history" />
    ├─ poses     → <PosesComingSoonTrack />   // ToivEmptyState「即将接入」
    └─ <MediaLibrarySourceRail />             // 壳独占；含姿势项
```

- Track 面板 `embedded` 时不再包 WorkspacePage / 不再自挂 Rail（`MediaLibraryTrackShell`：embedded=fragment，standalone 仍可自包以兼容）
- 作品子页（画板 / 台词检索）经 `onRailActiveChange` 可取消来源高亮（Wave A 口径保留）
- 计数经 `onWorksCountChange` / `onCountsChange` 回传壳上 Rail

## 改动文件

| 文件 | 动作 |
|---|---|
| `apps/canvas/web/src/lib/media-library-routes.ts` | `MediaLibrarySource` +`poses`；href/parse；W5 URL 常量预留 `POSE_GALLERY_THUMB_PATH` / `POSE_GALLERY_IMG_PATH`（`/api/pose-gallery/*`，禁 `/static`） |
| `apps/canvas/web/src/components/library/media-library-source-rail.tsx` | 四轨：作品 / 素材 / 生成历史 / 姿势 |
| `apps/canvas/web/src/pages/library/media-library-page.tsx` | **真单壳**：WorkspacePage + 轨切换 + poses 空态 |
| `apps/canvas/web/src/pages/toiv/library-page.tsx` | `embedded` / rail·count 回调；壳外移 |
| `apps/canvas/web/src/pages/assets/index.tsx` | `embedded` + `forcedSource` + counts 回调；`MediaLibraryTrackShell`；历史/无匹配空态 → ToivEmptyState |
| `apps/canvas/web/src/pages/toiv/library-works.tsx` | 空态收敛 → `ToivEmptyState` |
| `apps/canvas/web/test/toiv-library-assets-unify.test.ts` | 断言改盯 W4 单壳 / poses 预留 |

## 仍双轨的 API（本波刻意分期）

| 轨 | 数据面 | 说明 |
|---|---|---|
| works | ToIV `/api/jobs` · `/api/boards` · trash | `LibraryWorks` / boards / transcript |
| materials | Go workspace assets API（+ local overlay） | `loadAssetLibraryPage` personal |
| history | 同上 API `generated` / history 过滤 | `GenerationHistorySurface` |
| poses | **无** | 仅空态；W5 再接 `/api/pose-gallery/thumbs|{img}` |

UI chrome 已齐；列表卡组件仍按数据形分叉（fz-card / AssetLibraryCard / generation-history-card）——**未**复制第三套列表，也未强行抽统一卡（避免半截改卡炸材料/历史交互）。

## 路由 / 入口（保持）

- `/library` → MediaLibraryPage（单壳）
- `/library?source=works|materials|history|poses`
- `/assets` → `AssetsLegacyRedirect` → materials / history
- `/toiv/library` → `/library?source=works`；`/toiv/library/:id` → `/library/works/:id`
- 侧栏 / ⌘K **不**回潮媒体库主推（W1 口径）

## 验收步骤

1. 硬刷进 `/library`（或 `?source=works`）：单壳右侧四轨；默认作品；精选灵感 / SoftGlow / 首页意图墙无回潮。
2. 点「素材」→ URL `?source=materials`，个人素材面；点「生成历史」→ history 面；**不**整页闪成另一套顶栏气质。
3. 点「姿势」→ `?source=poses`，空态「姿势库即将接入」+ 文案含 `/api/pose-gallery/...`；无图、无 PosePicker。
4. 作品内切「画板 / 台词检索」：Rail 可不亮「作品」（Wave A）；回「作品」再亮。
5. 直访 `/assets`、`/assets?tab=history`、`/toiv/library` 仍进统一壳对应轨。
6. 空态：作品失败/空、素材空、历史空均走 ToivEmptyState（或 AssetsEmptyState 包装的 ToivEmptyState）。

本地已跑：

`bun test test/toiv-library-assets-unify.test.ts test/beeftv-assets-history.test.ts test/f11-library-equivalence.test.ts test/assets-collection-layout.test.ts test/toiv-library-works.test.ts`  
→ **27 pass / 1 skip / 0 fail**

## 风险

- **CSS 依赖**：`.assets-library-page > div:first-child` 仍吃 WorkspacePage 内层；embedded 轨用 fragment，避免嵌套第二层 `assets-library-page` 抢走 Rail 的 `position:absolute` 祖先。
- **卡组件未统一**：材料 / 历史 / 作品卡交互差异大；本波只齐壳与空态。若要「一张卡打天下」需 W4.1+ 单独设计。
- **poses 仅枚举**：W5 灌图前勿把 `/static` 写进前端。
- **未做 fixture 截图**（脏树；等 TL 过审再补如需）。

## 明确未做

- W5 姿势灌图 / PosePicker
- W6 / W7
- SoftGlow / 首页意图墙 / DesktopShell 默认
- commit / push / deploy（**未 commit**，tip 仍 `b75ca18e`）

## 请 TL 过审后

放行再 commit+push；建议 message：

```
feat(fusion-w4): media library single shell + track rails

One WorkspacePage owns works/materials/history/poses;
embed track panels; unify ToivEmptyState; reserve poses
empty + /api/pose-gallery URL constants (no PosePicker).
```
