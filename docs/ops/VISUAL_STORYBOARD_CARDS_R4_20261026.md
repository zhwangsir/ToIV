# ToIV 分镜卡片流 · 第4轮调研简报

- **日期**：2026-10-26（Asia/Shanghai）
- **执行**：模型调研帮手（Storyboard Cards R4）
- **状态**：已落地 canvas R4 tip（见 `SCRIPT_STORYBOARD_R4_HANDBACK.md`）；调研本身只钉尺寸
- **承接**：R1 DNA、R2 双闸、R3 `--toiv-create-*` 三栏壳
- **已钉死**：accent `#5ba0ff`；成人 `#4f8cff`；文案「普通｜成人」；`/create` 唯一创作台；成人不改几何
- **方法**：BigBanana 阶段（README + 截图像素观察）；CineGen `StageDirector` 实读；dramaclaw 双轨（sparse 实读 beat-card / storyboardGroup / StoryboardNode）；B 仓只抽模式

---

## ⚡ TL / 跨端立刻可用 · 推荐默认 + 卡片尺寸表

### 推荐默认（一句话）

**分镜主卡：16:9 媒体 + 头栏 shot# + 2 行摘要；网格 gap 16 / 圆角 12；默认 4 列（3–5）；选中时右栏扩到 420（上限 480），取消回 320，**不另开**挡中栏浮层；双轨默认 PiP（草图 2:3 叠成片 16:9），不用 tab；九宫格 gap 8。成人模式只滤内容，不改卡片几何。**

### 硬尺寸表（跨端可抄 → `--toiv-shot-*`）

| Token | 值 | 用途 / 来源对齐 |
|---|---|---|
| `--toiv-shot-media-aspect` | **16 / 9** | 主媒体窗（CineGen `aspect-video`；BigBanana 镜头卡；dramaclaw landscape） |
| `--toiv-shot-media-aspect-sketch` | **2 / 3** | 草图/竖构图轨（dramaclaw beat `aspect-[2/3]`） |
| `--toiv-shot-card-radius` | **12px** | 卡片圆角（CineGen `rounded-xl`；介于 dramaclaw beat `8` 与 R1 panel `16`） |
| `--toiv-shot-card-border` | `1px solid #22232c` | 默认边（R1）；hover 升 `#2f3036` |
| `--toiv-shot-card-border-active` | `1px solid #5ba0ff` + ring `0 0 0 1px rgb(91 160 255 / 0.45)` | 选中（CineGen indigo ring → 换 ToIV accent） |
| `--toiv-shot-card-bg` | `#15161d` | 卡面（R1 surface；对齐 CineGen `#1A1A1A` 密度） |
| `--toiv-shot-card-header-h` | **36px** | 头栏（CineGen `px-3 py-2` ≈ 32–36） |
| `--toiv-shot-card-header-pad-x` | **12px** | 头栏水平 pad |
| `--toiv-shot-card-footer-pad` | **12px** | 摘要区 pad（CineGen `p-3`） |
| `--toiv-shot-card-footer-lines` | **2** | `line-clamp-2`（CineGen） |
| `--toiv-shot-card-footer-fs` | **12px** | 摘要字号（R1 body / CineGen `text-xs`） |
| `--toiv-shot-meta-fs` | **10px** | `SHOT 01` mono（CineGen `text-[10px]`） |
| `--toiv-shot-tag-fs` | **9px** | 运镜 pill（CineGen `text-[9px]`） |
| `--toiv-shot-tag-radius` | **9999px** 或 **4px** | 运镜标签；顶栏气质用 pill，卡内可 4 |
| `--toiv-shot-grid-gap` | **16px** | 主分镜网格间距（CineGen `gap-4`；BigBanana 目视 16–20） |
| `--toiv-shot-grid-pad` | **24px** | 网格容器 pad（CineGen `p-6`） |
| `--toiv-shot-grid-cols-default` | **4** | 未选中默认列（CineGen `lg:grid-cols-4`；xl→5） |
| `--toiv-shot-grid-cols-compact` | **2** | 选中缩列 / 窄壳（CineGen 选中时 `lg:grid-cols-2`） |
| `--toiv-shot-grid-cols-max` | **5** | 宽屏上限（CineGen `xl:grid-cols-5`） |
| `--toiv-shot-beat-gap` | **14px** | 双轨 beat 网格（dramaclaw `gap-3.5`） |
| `--toiv-shot-beat-cols-wide` | **3** | beat 容器 ≥520 → 3 列 |
| `--toiv-shot-beat-cols-narrow` | **2** | beat <520 → 2 列 |
| `--toiv-shot-beat-radius` | **8px** | beat 卡圆角（dramaclaw `rounded-[8px]`） |
| `--toiv-shot-beat-min-h-text` | **100px** | 无媒体时最小高 |
| `--toiv-shot-detail-w` | **420px** | 选中时**右栏扩宽**（非浮层抽屉）；介于 R3 Inspector `320` 与 CineGen `480` |
| `--toiv-shot-detail-w-max` | **480px** | 详情上限（1:1 CineGen `w-[480px]`） |
| `--toiv-shot-kf-gap` | **16px** | Start/End 并排间距（CineGen `grid-cols-2 gap-4`） |
| `--toiv-shot-kf-aspect` | **16 / 9** | 关键帧窗 |
| `--toiv-shot-context-thumb` | **112×80** | 场景上下文小图（CineGen `w-28 h-20`） |
| `--toiv-shot-nine-cols` | **3** | 九宫格列（BigBanana Phase 03） |
| `--toiv-shot-nine-gap` | **8px** | 九宫格格缝（dramaclaw `STORYBOARD_CELL_GAP=8`；BigBanana 目视 8–12） |
| `--toiv-shot-nine-pad` | **12px** | 宫格内边（dramaclaw `STORYBOARD_PADDING=12`） |
| `--toiv-shot-canvas-node-w` | **440px** | Freezone 分镜节点默认宽（dramaclaw `STORYBOARD_NODE_WIDTH_PX`） |
| `--toiv-shot-canvas-node-min-h` | **320px** | 分镜节点最小高 |
| `--toiv-shot-canvas-thumb-w` | **560px** | 合并分镜组缩略格宽（dramaclaw `STORYBOARD_THUMB_WIDTH`；画布组用，列表卡勿直接套） |
| `--toiv-shot-gallery-minmax` | **220px** | auto-fill 最小列（dramaclaw sketch-grid `minmax(220px,1fr)`） |
| `--toiv-shot-badge-video` | 绿点/角标 12–16 | 「已有视频」（CineGen / BigBanana VIDEO badge） |
| `--toiv-shot-hover-scale` | **1.008** 或选中 **0.98** | dramaclaw hover `1.008`；CineGen active `scale-[0.98]`——二选一，禁止同态叠两套 |
| `--toiv-shot-dur` | **150–200ms** | 选中/边框（R1/R2） |
| `--toiv-shot-ease` | `cubic-bezier(0.22, 1, 0.36, 1)` | ease-out-quint |
| `--toiv-shot-adult-geometry` | **unchanged** | 成人闸禁止改上表任何几何 |

**列宽随 R3 壳**：完整三栏时用 3–4 列；右详情打开时主网格压到 2 列（CineGen 模式）。

---

## ① 深度调研与像素级拆解

### A. BigBanana · 阶段流（README + 截图观察；无前端源码仓）

公开仓以文档/镜像为主，**无 TSX 可钉 class**。阶段信息架构：

| Phase | 名 | 与卡片流关系 |
|---|---|---|
| 01 | 叙事规划 | 结构化剧本；预审「九宫格 vs 首尾帧」链路 |
| 02 | 一致性资产 | 角色/场景/道具定妆——卡片上游 |
| **03** | **镜头制作 / 导演工作台** | **网格化镜头卡 + 首尾帧 + 九宫格预览** |
| 04 | 成片交付 | 时间线/粗剪 |
| 05 | 提示词管理 | 跨阶段改 prompt |

**Phase 03 卡片模式（截图）**

- 主台：多列镜头卡网格；头栏 `SHOT nnn` + 运镜 pill；中区 16:9；底区 2–3 行说明；有片角标 VIDEO。
- 九宫格弹层：左 3×3 候选格（格缝约 8–12）、右视角列表；可「整图作首帧」或「采用选中格」。
- 关键帧理念：先 Start/End，再插值视频；双视频链路（I2V / 首尾帧）。

→ ToIV：**抄阶段语义与卡解剖 + 九宫格交互**；尺寸用 CineGen/dramaclaw 实数钉死，不猜 BigBanana CSS px。

### B. CineGen · Shot / Keyframe（实读 · 列表卡主源）

`StageDirector.tsx`：

| 项 | 值 |
|---|---|
| 网格 | 未选：`2/3/4/5` 列；选中：`1/2/2`；`gap-4`；容器 `p-6` |
| 卡 | `rounded-xl`；头 `px-3 py-2`；媒体 `aspect-video`；脚 `p-3` + `line-clamp-2` `text-xs` |
| 选中 | `border-indigo-500 ring-1 ring-indigo-500/50 scale-[0.98]` |
| 详情栏 | 右 `w-[480px]`；内 Start/End `grid-cols-2 gap-4` 各 `aspect-video` |
| 上下文 | 场景图 `w-28 h-20`；角色圆头 `w-6 h-6` |
| 数据 | `Shot.keyframes: start\|end` + `interval` 视频 |

导出条：镜头条 `h-14` 迷你块（时间线缩略，非主卡）。

→ ToIV：主卡几何与选中→详情 **1:1 可抄**；indigo → `#5ba0ff`。

### C. dramaclaw · 双轨（实读 · 管道轨 + Freezone）

**轨 1 — Series / Beat 工作台（清单密台）**

- `beat-card-grid`：`gap-3.5`；≥520px → 3 列，否则 2。
- `beat-card`：圆角 8；hover `scale 1.008`；媒体 portrait `2/3` / landscape `16:9`；无媒体 `min-h 100`；画中画角标宽约 24–32%。
- `sketch-grid-gallery`：`minmax(220px,1fr)` + `gap-3`（九宫草图组）。

**轨 2 — Freezone 画布分镜**

- `StoryboardNode`：宽 **440**、最小高 **320**；拆格目标宽 **150**；导出格缝 **1px**。
- `storyboardGroup`：`CELL_GAP=8`、`PADDING=12`、`THUMB_WIDTH=560`、header 预留 **34**；默认列 `ceil(√n)`；aspect 16:9/4:3/1:1/3:4/9:16。

→ ToIV：`/create` 列表用轨 1 密度；进画布节点用轨 2。双轨 = **同一 shot 对象，两种表面**（草图 2:3 + 成片 16:9 可同卡叠角标，学 beat-card）。

### D. B 仓只抽模式

| 仓 | 模式 | 跳过 |
|---|---|---|
| ArcReel | 分镜网格「组卡 + media-first」；grid storyboard | 无本波 px |
| aid-studio | 分镜脚本/批量视频管道（后端重） | 不抄业务 |
| Toonflow | 分镜编辑器/画布节点流 | 非网格卡主源 |
| AIMovieStudio | shot 为故事板单元；长镜 keyframe 插值 | 布局见 R3 |
| BeefTV | 画布 storyboard 表格式节点（行高 48 / 头 124） | 表格式≠卡片流；仅作备选 |

---

## ② 照抄与融合（对 ToIV `/create`）

### 1:1 照抄

1. CineGen 卡解剖：头 meta + 16:9 + 2 行摘要 + 选中 ring。
2. 选中后右详情：Start/End 双窗 + 生成动作（宽 420–480，可并入 R3 Inspector）。
3. BigBanana 九宫格：3×3 候选 → 选格/整图作首帧。
4. dramaclaw 双轨语义：sketch 竖构图 + render 横构图可并存。

### 融合

1. 列默认 **4**（CineGen lg），宽屏 5；打开详情压 **2**（保持画布可读）。
2. gap **16**（列表）；宫格内 **8**（九宫/合并组）。
3. 圆角卡 **12**；beat 密台表面可用 **8**。
4. 选中态用 accent ring，**不要**同时 scale 0.98 与 hover 1.008——列表用 ring，画布节点用 R1 glow。
5. 成人闸：卡几何不动；NSFW 镜头缩略可模糊/锁，但宽高比与 gap 不变。

### 跳过

- BigBanana 亮色营销壳当默认皮肤（ToIV 维持暗色 Freezone）。
- BeefTV 表格式分镜行当主卡片流。
- 把 `STORYBOARD_THUMB_WIDTH=560` 直接当列表卡宽（那是画布组缩略）。

---

## ③ 落地蓝图（组件 × token）

```text
/create · Storyboard surface
├─ Toolbar（批量首帧 / 进度 n/N）
├─ ShotGrid (gap: var(--toiv-shot-grid-gap); cols…)
│   └─ ShotCard
│       ├─ Header (h: header-h)  SHOT ## · camera tag
│       ├─ Media (aspect: media-aspect)  ± VIDEO badge ± dual-track PiP
│       └─ Footer (clamp 2)
├─ Right Inspector expands to detail-w on select (no overlay)
│   ├─ Context thumbs
│   ├─ Start | End (kf-gap, kf-aspect)
│   └─ Generate video
└─ NineGridModal (cols 3, gap nine-gap)   // BigBanana Phase 03
```

CSS 挂在 `[data-toiv-surface=storyboard]`；与 R3 `[data-toiv-shell=create]` 并列，**共享** audience 属性、**不共享** width 覆盖。

Strangler：先 ShotCard + Grid；再 Detail；再 NineGrid；画布 StoryboardNode 最后接 Freezone。

---

## ④ 双闸与连贯性校验

| 校验 | 期望 |
|---|---|
| 切「成人」后卡宽/gap/aspect | **不变** |
| 九宫格弹层尺寸 | **不变** |
| 列表列数算法 | **不变**（只内容过滤） |
| 选中 ring 色 | 仍用创作 accent `#5ba0ff`；成人光幕只在顶栏 pill |
| 模糊/锁 NSFW 缩略 | 允许；必须保持同一 aspect 盒子 |

**一句话**：分镜卡是密台内容单元；成人闸换片源可见性，不换卡架。

---

## 证据路径

- BigBanana：`README.md` Phase 01–05；`images/导演工作台.png`、`镜头九宫格.png`、`镜头与帧.png`（观察，无源码 class）
- CineGen：`components/StageDirector.tsx`；`types.ts` Shot/Keyframe
- dramaclaw（sparse）：`beat-card.tsx` / `beat-card-grid.tsx` / `use-responsive-columns.ts`；`storyboardGroup.ts`；`StoryboardNode.tsx`；`AssetBoardCard.tsx`；`sketch-grid-gallery.tsx`；`DESIGN.md` 间距
- B：ArcReel changelog grid；BeefTV `canvas-storyboard-layout.ts`（表格式备选）

---

## Blocker / 未决

1. **BigBanana 无开源前端 class** → 阶段/交互可抄，px 以 CineGen+dramaclaw 为准；若要像素级对齐需再开官方站人肉尺（本波不做）。
2. **详情栏 420 vs 并入 R3 右栏 320**：建议镜头选中时右栏临时升到 `--toiv-shot-detail-w`（420），离开选中回 320——需跨端拍板。
3. **双轨 UI**：同卡 PiP（dramaclaw）vs 两个 tab——默认建议 PiP + toggle，省纵向。
4. 未 commit / 未改产品码。
