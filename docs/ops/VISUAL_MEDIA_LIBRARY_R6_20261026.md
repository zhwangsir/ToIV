# ToIV 媒体库 UI · 第6轮调研简报

- **日期**：2026-10-26（Asia/Shanghai）
- **执行**：模型调研帮手（Media Library R6）
- **状态**：硬尺寸已落地 `--toiv-media-*`（见 ASSET_MEDIA_POOL_R6_HANDBACK §G）
- **承接**：R1 DNA、R2 双闸、R3 `--toiv-create-*`、R4 `--toiv-shot-*`、R5 `--toiv-node-*`
- **已钉死**：accent `#5ba0ff`；成人字色/glow `#4f8cff`；文案「普通｜成人」；创作台左 280 / 右常驻 320 / 详情 420 / 双轨 PiP；成人不改几何
- **方法**：
  - **A 优先实读**：LumenX（`AssetLibraryPage` + atelier CSS）、Toonflow-app（`assetBrowser`/`assetLibrary`）、Toonflow-web（`views/assets`）、ArcReel（`AssetGallery` / `AssetLibraryPage` / `useAssetPages` / `LoadMoreSentinel`）
  - **B 仓只学模式**：BeefTV director screenshot gallery（2 列紧凑）、CineGen `StageAssets`（角色 2–5 列 / 场景 1–3 列、hover 遮罩）、DramaClaw（本轮无独立媒体库网格，沿用 R1 密台气质）

---

## ⚡ TL / 跨端立刻可用 · 推荐默认 + 硬尺寸表

### 推荐默认（一句话）

**媒体库网格 `auto-fill minmax(220–240px)`、gap 16、卡圆角 12–16；滤签用 inset pill（高 ~28、字 11–13、圆角 999）；无限滚动 batch 60 + rootMargin 下沿 480px；hover 用 scale 1.05 / 抬升 4px 或边框高亮（150–220ms），不弹独立浮层改几何；成人闸只滤条目可见性，不改任何 `--toiv-media-*` 几何。**

### 硬尺寸表（跨端可抄 → `--toiv-media-*`）

| Token | 值 | 用途 / 来源对齐 |
|---|---|---|
| `--toiv-media-grid-min` | **220–240px** | 列 min（Toonflow-app `minmax(220px,1fr)`；ArcReel lorebook/库 `minmax(240px,1fr)`） |
| `--toiv-media-grid-gap` | **16px** | 主 gap（Toonflow 16；ArcReel `gap-4`；LumenX `gap-4`） |
| `--toiv-media-grid-gap-dense` | **8–12px** | 侧栏/紧凑（BeefTV gallery `gap-2`；Toonflow-web 列表 thumb 区） |
| `--toiv-media-grid-cols-bp` | **2 / 3 / 4 / 5** | 断点列（LumenX `grid-cols-2 md:3 lg:4 xl:5`；CineGen 角色同档） |
| `--toiv-media-pad-x` | **20–28px** | 内容区左右 pad（Toonflow grid pad 20；LumenX `px-7`；ArcReel toolbar `px-5`） |
| `--toiv-media-pad-y` | **12–20px** | 内容区上下（ArcReel gallery `py-5`；LumenX `pt-3 pb-10`） |
| `--toiv-media-card-radius` | **12–16px** | 卡圆角（Toonflow `--ui-radius-large=12`；ArcReel `rounded-lg≈8–12`；LumenX atelier-asset-card **16** / `--card-radius:14`） |
| `--toiv-media-card-radius-rec` | **12px** | ToIV 默认（对齐 R4 分镜卡 12；可升 14 与 R5 节点同档） |
| `--toiv-media-card-border` | `1px solid #22232c` | 默认边（R1） |
| `--toiv-media-card-border-hover` | `1px solid` 略亮 / `#5ba0ff` 选中 | ArcReel `hover:border-input`；LumenX 选中 `border-primary/60` |
| `--toiv-media-card-selected-ring` | `0 0 0 1px rgb(91 160 255 / 0.45)` | LumenX `ring-1 ring-primary/40` → 换 ToIV accent |
| `--toiv-media-card-bg` | `#15161d` | R1 surface |
| `--toiv-media-thumb-aspect` | **4/3**（图/通用） / **16/9**（视频/库卡） / **1/1**（道具） | Toonflow visual `4/3`；ArcReel `aspect-video`；LumenX 角色 `4/3`、scene/prop `square` |
| `--toiv-media-thumb-list` | **80×80 / r4** | Toonflow-web 表格式预览格 |
| `--toiv-media-footer-pad` | **10–13px** | 卡脚（Toonflow name pad 13；ArcReel `p-3 pt-2.5`；LumenX `p-3`） |
| `--toiv-media-title-fs` | **14px / medium** | 卡名（三源一致 `text-sm`） |
| `--toiv-media-meta-fs` | **11–12px** | 副文（LumenX `0.6875rem`；Toonflow details 12） |
| `--toiv-media-chip-h` | **28px** | 滤签视觉高（LumenX `py-1.5`+`text-[0.6875rem]` ≈28；对齐 R2 quiet pill） |
| `--toiv-media-chip-pad-x` | **12–14px** | `px-3` / `px-3.5` |
| `--toiv-media-chip-fs` | **11–13px** | LumenX pill `0.6875rem`；FieldTagChip `13px`；ArcReel Toggle sm≈`0.8rem` |
| `--toiv-media-chip-radius` | **999px** | inset pill（LumenX atelier-pill-tabs）；备选 ArcReel `rounded-lg` outline group |
| `--toiv-media-chip-gap` | **6–8px** | chip 内 icon/字；行内 `gap-2`–`gap-3` |
| `--toiv-media-chip-track-pad` | **3px** | 外轨 inset（LumenX `p-[3px]`） |
| `--toiv-media-chip-count-fs` | **9.5–11px** | mono 计数（LumenX `0.59375rem`；atelier-badge `9.5px`） |
| `--toiv-media-badge-overlay` | `px-2 py-[3px]` + `bg-black/55` + blur | 卡面角标（变体数/类型） |
| `--toiv-media-star-hit` | **28×28** | LumenX 星标按钮 |
| `--toiv-media-more-hit` | **27–28** | Toonflow more 27；菜单常驻不靠 hover（ArcReel） |
| `--toiv-media-play-d` | **43px** | Toonflow 视频 play 圆钮 |
| `--toiv-media-batch` | **60** | ArcReel `ASSET_PAGE_SIZE`（全局库无限滚） |
| `--toiv-media-prefetch-margin` | **480px** | `LoadMoreSentinel` `rootMargin: 0px 0px 480px 0px` |
| `--toiv-media-page-size-table` | **10** | Toonflow-web 表格分页（列表态备档，非主网格） |
| `--toiv-media-skeleton` | `animate-pulse` + `bg-muted` + `rounded-md` | ArcReel Skeleton；首屏可用同几何空卡 |
| `--toiv-media-hover-lift` | **translateY(-4px)** | LumenX hover（spring 0.22s） |
| `--toiv-media-hover-scale` | **1.05** | LumenX `group-hover:scale-105` 图 |
| `--toiv-media-hover-border-only` | **150ms** | Toonflow / ArcReel quiet 档（仅 border-color） |
| `--toiv-media-hover-overlay` | opacity 0→1 + blur mask | CineGen / Toonflow-web 表格式「预览」遮罩 |
| `--toiv-media-hover-delay` | **0–80ms** | 竞品几乎无长 delay；ToIV 建议 **0**（边框）或 **≤80ms**（遮罩防闪） |
| `--toiv-media-dur-fast` | **150ms** | ArcReel `--duration-fast` |
| `--toiv-media-dur-lift` | **220ms** | LumenX card transform |
| `--toiv-media-ease-lift` | `cubic-bezier(0.34, 1.56, 0.64, 1)` | LumenX spring |
| `--toiv-media-ease-out` | `cubic-bezier(0.22, 1, 0.36, 1)` | 与 R1/R2 统一 |
| `--toiv-media-reveal-stagger` | **50ms** cap **250ms** / anim **450ms** | LumenX `atelier-reveal` |
| `--toiv-media-toolbar-h` | **~44–52px** | ArcReel sticky `py-2.5` + controls；LumenX 双行 toolbar |
| `--toiv-media-search-max-w` | **340px** | LumenX search `max-w-[340px]` |
| `--toiv-media-inspector` | 选中才出；宽跟创作台右栏 **320 / 详情 420** | LumenX `AssetInspector`；不另开几何 |
| `--toiv-media-adult-geometry` | **unchanged** | 成人闸禁止改上表任何几何 |

---

## ① 深度调研与像素级拆解

### LumenX（A · 画廊主模板）

- **结构**：顶栏标题（mono 眉题 + display 大字）→ 工具行（视图轴 pill + 类型 pill 带计数 + 星标 + 搜索 pill + 排序）→ 分组标题+尾线 → **响应式网格** → 选中右侧 Inspector。
- **网格**：`grid-cols-2 md:3 lg:4 xl:5` + `gap-4`（16px）。角色图 `aspect-[4/3]`（毛玻璃铺底 + `object-contain`）；scene/prop `aspect-square` + `object-cover`。
- **卡**：`atelier-asset-card` 圆角 **16**、玻璃底、hover **抬升 4px** + 更深阴影（0.22s spring）；图 `group-hover:scale-105`；选中 `border-primary/60` + `ring-1 ring-primary/40`。
- **Chip**：外轨 `p-[3px] rounded-full bg-surface-inset`；项 `px-3.5 py-1.5 rounded-full text-[0.6875rem]`；计数 mono 更小。标签/角标另有 overlay pill（`bg-black/55 backdrop-blur`）。
- **滚动**：前端一次拉全量再本地滤；**无** IntersectionObserver 无限滚（库规模中等假设）。骨架=居中 loading 文案。
- **Hover**：抬升+缩放+边框；**无**独立 hover 浮层预览（点卡开 inspector / 大图走 lightbox 共享组件）。

### Toonflow-app / Toonflow-web（A · 创作台内素材 + Web 表）

- **App 展开态 `assetBrowser`**：左目录树 + 右 `assetGrid`：`repeat(auto-fill, minmax(220px, 1fr))` **gap 16**，卡圆角 `--ui-radius-large`（基 8×1.5=**12**），缩略 **4:3**，hover **仅边框** 0.15s；视频中心 play **43**；更多钮 **27**。折叠态 `assetLibrary`：宽 **≤320**、行高 **36**、缩略 **32×32**（树列表，非网格）。
- **Web `views/assets`**：主路径是 **表格 + 80×80 预览格**（r4），hover 出「预览/播放」遮罩文案；分页 `pageSize:10`。适合「资产台账」，不是暗色密台主画廊。
- **启示**：创作台左栏可复用树/紧凑；全页媒体库跟 LumenX/ArcReel 网格，不跟 Web 表。

### ArcReel（A · 无限滚与安静卡）

- **项目画廊 `AssetGallery`**：`grid … minmax(240px,1fr) gap-4`；`AssetBrowseCard` `rounded-lg` + `aspect-video`；菜单**常驻**不靠 hover；滤签 `ToggleGroup` outline sm（全部/pending/stale + 计数）；toolbar sticky。
- **全局库 `AssetLibraryPage`**：同网格公式；`ASSET_PAGE_SIZE=60`；`LoadMoreSentinel` **`rootMargin` 底边 480px**；失败显示重试、不再自动打。Skeleton=`animate-pulse rounded-md bg-muted`。
- **Hover**：`duration-fast=150ms` 边框变亮；**无**抬升、**无**浮层预览（点开 Sheet / ImageViewer）。PreviewableImageFrame 仅右上角放大钮 `opacity-0 → group-hover:opacity-100`。
- **Chip 模式**：线型 Tabs + 计数（库）；ToggleGroup（画廊状态）——比 LumenX pill 更「工具产品」、更少仪式感。

### B 仓模式（只学）

| 源 | 可学 | 不照抄 |
|---|---|---|
| BeefTV screenshot gallery | `grid-cols-2 gap-2` 紧凑；`aspect-video`/`square` | 不当全页媒体库密度 |
| CineGen StageAssets | 角色 2–5 列 `gap-6`；hover 遮罩操作条；卡 `rounded-xl` | 亮色白 CTA / 大 gap 6 作备选「疏」档 |
| DramaClaw | 暗色 surface / 无独立 media grid | — |

---

## ② 照抄与融合方案

| 要素 | 1:1 照抄 | 融合 / 改 |
|---|---|---|
| 网格公式 | ArcReel/Toonflow `auto-fill minmax(220–240)` + gap 16 | 大屏可叠加 LumenX 断点上限 5 列 |
| 滤签轨 | LumenX inset pill（对齐 R2 双闸气质） | 状态筛可用 ArcReel Toggle outline 作二级 |
| 卡圆角 | 默认 **12**（R4/R5） | 全页画廊可 **14–16**（LumenX）作 `--toiv-media-card-radius-gallery` |
| Hover | Toonflow/ArcReel **border-only 150ms** 作默认 quiet | LumenX lift+scale 作「画廊强调档」可选；禁止默认弹大浮层改布局 |
| 无限滚 | ArcReel batch **60** + margin **480** | 项目内中小集合可本地全量（LumenX） |
| 菜单 | ArcReel「更多常驻」 | 避免 hover 才露操作（触控友好） |
| 列表态 | Toonflow-web 80 方格仅备档 | 主路径坚持网格 |
| 成人 | — | **只滤内容**；chip/网格/卡几何锁死 |

**融合一句话**：LumenX 负责「画廊仪式感（pill+分组+抬升可选）」；ArcReel 负责「工程化滚动与安静卡」；Toonflow 负责「创作台内 220 网格与折叠树」。

---

## ③ 落地蓝图（`--toiv-media-*`）

1. **Token 落点**：与 R1–R5 同层 CSS vars；媒体库页 /create 资产抽屉共用一套几何，仅 density 用 `gap-dense` / `grid-min` 两档。
2. **组件切分**（不写业务码，仅蓝图）：
   - `MediaToolbar`：inset pill 类型轨 + 搜索 + 排序；成人态不增宽。
   - `MediaGrid`：`auto-fill` + gap 16；空态 / 无匹配 / skeleton。
   - `MediaCard`：thumb aspect token 化；选中 ring=accent；更多菜单常驻。
   - `MediaInfinite`：batch 60 + sentinel 480；错误重试。
3. **Hover 策略**：默认 `hover-border-only`；设置项或画廊页可开 `hover-lift`（不改 token 几何宽高）。
4. **与创作台对齐**：左资产轨折叠=树（Toonflow 320）；展开全页/大抽屉=网格；Inspector 宽度吃钉死的 320/420。
5. **验收**：切换「普通｜成人」前后，量 `--toiv-media-grid-min/gap/card-radius/chip-h` 像素差必须为 0。

---

## ④ 双闸与连贯性校验

| 检查项 | 结论 |
|---|---|
| 成人是否改列数/gap/min card | **否** — 只隐藏/过滤 NSFW 标记条目 |
| 成人是否改 chip 尺寸/圆角 | **否** — 文案与 accent 走 `#4f8cff` 仅顶栏闸；媒体轨保持 `#5ba0ff` 选中态或中性 |
| 成人是否改 hover 动效幅度 | **否** — 动效 token 共用 |
| 网格在双闸切换时是否 CLS | **禁止** — 过滤用同几何占位或瞬时移除但不改 track |
| 与 R2 pill / R3 壳 / R4 卡 | chip-h 28、卡 r12、gap 16 与前轮一致 |
| 后端 | 不拦；可见性前端模式过滤（红线已收） |

**连贯性**：媒体库是「内容面」不是「闸面」——闸在顶栏右光幕；库内最多加内容级 badge（成人条目角标），不得复制一套更大的模式开关。

---

## 源路径（实读）

- LumenX：`frontend/src/components/library/AssetLibraryPage.tsx`；`frontend/src/app/globals.css`（atelier-asset-card / pill-tabs）；`FieldTagChip.tsx` / `AssetChipBar.tsx`
- Toonflow-app：`apps/web/.../assetBrowser.vue`；`assetLibrary.vue`
- Toonflow-web：`src/views/assets/index.vue`
- ArcReel：`components/canvas/lorebook/AssetGallery.tsx`；`GalleryToolbar.tsx`；`components/assets/{AssetCard,AssetThumb,useAssetPages,LoadMoreSentinel}.tsx`；`pages/AssetLibraryPage.tsx`；`index.css`（duration-fast）
- B：BeefTV `director-screenshot-gallery.tsx`；CineGen `StageAssets.tsx`

## Blocker

- **无硬 blocker**。LumenX/ArcReel 本地 peers 曾缺 frontend，本轮已 `git checkout` 补全后实读。
- 未跑实机截图像素尺；尺寸来自源码 class / CSS（与 R1–R5 同口径）。
- BeefTV/DramaClaw 无对等「全页媒体库」实现 → 仅模式参考。

---

*简报结束 · 未 commit*
