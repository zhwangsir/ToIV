# Asset / Media Pool · R6 Handback（含 R5 节点硬尺寸校准）

日期：2026-10-26（Asia/Shanghai）  
分支：`work/p0-fusion-20261016`  
基 tip：`a140e360`（R5 node graph visual）  
合规：Toonflow / LumenX = **A**（本轮**未并码**，仅对照媒体库网格/标签模式后 Freezone 重写）；禁 B 仓并码。  
不动：光幕顶栏、三栏几何、节点选中色语义（仍 `#5ba0ff`）。

调研：`docs/ops/VISUAL_NODE_GRAPH_R5_20261026.md`（本 tip **顺手校准** `--toiv-node-*`）；媒体库尺寸调研到后可再灌 `--toiv-asset-*`。

---

## A. 调研融合点

| 源 | 闸 | 取 | 舍 |
|----|----|----|----|
| Freezone / R1 | repo | surface / border / radius 12；accent 芯片 | 廉价灰块网格 |
| Toonflow / LumenX 媒体库 | A | 筛选条 + 标签芯片 + 空态节奏 | 未复制源文件；无 NOTICE 增量 |
| redline 资产闸 | repo | `filterNsfwListableAssets` / `isNsfwAssetSelectable` / `assetLooksNsfw` | 自造第二套 NSFW 判定 |
| R3 左资产栏 | repo | 挂载媒体池，不新开第二壳 | — |

---

## B. 1:1 / 钉死点

### 媒体池
| 项 | 值 |
|----|-----|
| 挂载 | `/create` 左栏 `CreationStudioAssetRail` 内 |
| 网格 | `--toiv-asset-grid-cols: 2` · gap 10 · 卡圆角 12 · 缩略 4:3 |
| 筛选 | 类型芯片 + 智能标签（频次 Top8）+ 搜索 |
| 空态 | 无素材 / 筛选空 / 普通态隐藏未评级 |
| 无限滚动 | IntersectionObserver，页长 24 |

### NSFW（普通 / 成人）
| 态 | 行为 |
|----|------|
| **普通** | 已知 NSFW：**可见**但灰化 + `NsfwLockBadge`（锁图标+「NSFW」双通道）**不可点**；`unknown` **隐藏** |
| **成人** | listable 均可选；未评级显出 |
| 切换 | 仅顶栏光幕；本组件只读 `subscribeR18Mode` |

### R5 节点 token 校准（同 tip）
| 项 | 钉 |
|----|----|
| 宽 | default 300（280–320）/ compact 220 / media 360 / export 480 |
| 圆角 | 12；preferred 14；comfy 8 |
| 标题 | h 30 · fs 14 |
| 端口 | 视觉 8 · 命中 18 · offset 12 · 默认灰 `#94a3b8` · valid `#5ba0ff` |
| 线 | 2 / 选中 2.5 · 命中描边 24 · glow `0 0 24px` / 0.25 |
| 网格 | gap 16 · snap 8/12 |
| 成人几何 | unchanged |

---

## C. 落地蓝图（挂载路径）

| 层 | 路径 |
|----|------|
| 左栏入口 | `components/create/creation-studio-asset-rail.tsx` |
| 媒体池 | `components/create/creation-studio-media-pool.tsx` + `.css` |
| 全库卡壳 | `components/assets/asset-library-card.tsx`（Freezone class） |
| 全库 NSFW | `pages/assets/index.tsx`（listable 过滤 + `AssetCover` 锁标） |
| Token | `toiv-freezone-tokens.css`（canvas ↔ web）`--toiv-asset-*` + 校准 `--toiv-node-*` |
| 连线校准 | `canvas-connections.tsx`（2 / 2.5 / hit 24） |
| 视觉 glow | `canvas-node-graph-visual.css`（24px / 0.25） |

---

## D. 双闸连贯性

| 项 | 规格 |
|----|------|
| 光幕 | 未改 paddle / `--toiv-switch-*` |
| 列表过滤 | 媒体池 + `/assets` 共用 redline 函数 |
| 色盲 | 锁图标 + NSFW 文案 + 灰化，不只靠色 |
| 文案 | 「普通 / 成人」 |
| 三栏 / 节点选中色 | 未改几何；选中仍 accent `#5ba0ff` |

---

## E. 风险 / 未完成

- 媒体池读本地 `useAssetStore`；远端 canonical 分页未在左栏复用（全库仍走 `/assets`）。
- 媒体库专用像素调研未到；`--toiv-asset-*` 为可用默认，后续可再灌。
- 卡片点击跳转 `/assets?focus=`（focus 深链若页面未消费，仅落库页）。
- **未 push**。
