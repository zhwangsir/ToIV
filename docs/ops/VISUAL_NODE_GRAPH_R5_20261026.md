# ToIV 节点编排 UI · 第5轮调研简报

- **日期**：2026-10-26（Asia/Shanghai）
- **执行**：模型调研帮手（Node Graph R5）
- **状态**：硬尺寸已并入 R6 tip 校准 （见 ASSET_MEDIA_POOL_R6_HANDBACK）
- **承接**：R1 DNA、R2 双闸、R3 `--toiv-create-*`、R4 `--toiv-shot-*`
- **已钉死**：accent `#5ba0ff`；成人 glow/字色 `#4f8cff`；文案「普通｜成人」；创作台左 280 / 右常驻 320 / 详情 420；成人不改几何
- **方法**：
  - **A 优先实读**：Toonflow-app（Vue Flow + `nodeSkeleton`）、dramaclaw Freezone（`@xyflow/react` + DESIGN/`index.css`）、ComfyUI 现代前端（`Comfy-Org/ComfyUI_frontend` → `LiteGraphGlobal` / `LGraphCanvas`）
  - **CineGen**：确认**无节点图**（阶段台 Stage*，非 graph）——本轮作「非照抄」对照
  - **B 仓重写**：对 R1 列表其余仓**重扫**节点相关模式（不复述 R1 旧句）

---

## ⚡ TL / 跨端立刻可用 · 推荐默认 + 硬尺寸表

### 推荐默认（一句话）

**节点圆角 12–14、标题栏约 28–32、端口视觉 8（命中扩到 ~18）、连线 stroke 2 / 选中 2.5、选中用 accent ring+glow（24px / 0.25）不用重阴影；网格 gap 16（或 Comfy 10）；小地图右下可钉。成人模式只滤节点内容可见性，不改任何几何 token。**

### 硬尺寸表（跨端可抄 → `--toiv-node-*`）

| Token | 值 | 用途 / 来源对齐 |
|---|---|---|
| `--toiv-node-w-default` | **280–320px** | 逻辑/资产节点默认宽（dramaclaw `DEFAULT_NODE_WIDTH=320`；介于 Toonflow 文本 220 与媒体 338） |
| `--toiv-node-w-compact` | **220px** | 纯文本/Style 紧凑（Toonflow skeleton `width:220`；dramaclaw Style `220`） |
| `--toiv-node-w-media` | **338–440px** | 媒体预览节点（Toonflow media≈338；dramaclaw storyboard node `440`） |
| `--toiv-node-w-export` | **480px** | 导出结果（dramaclaw `EXPORT_RESULT_NODE_DEFAULT_WIDTH`） |
| `--toiv-node-min-h` | **100–200px** | 最小高（Toonflow cardHeight `max(100,…)`；dramaclaw routing fallback `200`） |
| `--toiv-node-radius` | **12–14px** | 节点圆角（dramaclaw dark `--node-radius:14` / DESIGN `rounded.node`；Toonflow card≈`--ui-radius-large=12`） |
| `--toiv-node-radius-comfy` | **8px** | Comfy 兼容档（`LiteGraph.ROUND_RADIUS=8`）——仅 Comfy 嵌入视图用 |
| `--toiv-node-title-h` | **28–32px** | 标题栏高（Toonflow titleBar≈`14/20 + pad 8`；Comfy `NODE_TITLE_HEIGHT=30`） |
| `--toiv-node-title-fs` | **14px** | 标题字号（Toonflow / dramaclaw `text-[14px]` / Comfy `NODE_TEXT_SIZE=14`） |
| `--toiv-node-title-icon` | **16px** | 标题图标（Toonflow） |
| `--toiv-node-body-pad` | **8–12px** | 内容 pad（Toonflow card `8`；dramaclaw `spacing.md=12` / DESIGN canvas-node） |
| `--toiv-node-gutter` | **12px** | 节点内沟槽（dramaclaw DESIGN `node-gutter`） |
| `--toiv-node-bg` | `#15161d` | 卡面（R1 surface；对齐 dramaclaw Level1 / BeefTV dark `#262626` 密度） |
| `--toiv-node-border` | `1px solid #22232c` | 默认边（R1） |
| `--toiv-node-border-active` | `1px solid #5ba0ff` | 选中边（换 ToIV accent；禁止 Comfy 白 `#FFF` 轮廓当主态） |
| `--toiv-node-selected-ring` | `0 0 0 1px rgb(91 160 255 / 0.45)` | 选中 ring（R4 卡同款气质） |
| `--toiv-node-selected-glow` | `0 0 24px rgb(91 160 255 / 0.25)` | 选中 glow（dramaclaw `--ui-glow-accent`；成人态同几何、色走 `#4f8cff` 仅顶栏闸，节点几何不变） |
| `--toiv-node-shadow` | **none / 极轻** | Freezone：选中用 glow 不用重投影（DESIGN）；BeefTV 默认可有 `0 8px 24px`，ToIV **默认关掉**以免与 glow 叠两套 |
| `--toiv-node-port-d` | **8px** | 端口视觉直径（dramaclaw handle `8×8`；端口点 `PORT_DOT_RADIUS=4`） |
| `--toiv-node-port-hit` | **18–24px** | 命中区（Toonflow handle `18` + `::before inset -13`；dramaclaw `::before inset -12`） |
| `--toiv-node-port-offset` | **12px** | 端口伸出节点边（Toonflow left/right `-12`） |
| `--toiv-node-port-color` | `#94a3b8` | 默认端口灰（dramaclaw `rgb(148 163 184)`；PrintFilm edge 同色系） |
| `--toiv-node-port-valid` | `#5ba0ff` | 可连/hover（Toonflow primary；dramaclaw connecting glow `rgba(96,165,250,…)` → 换 accent） |
| `--toiv-node-port-invalid` | 危险红 | Toonflow `el-color-danger` |
| `--toiv-node-port-type-*` | 见下表 | 类型色（Comfy 习惯；ToIV 精简子集） |
| `--toiv-node-edge-stroke` | **2px** | 默认线宽（dramaclaw base `2`；PrintFilm `2`） |
| `--toiv-node-edge-stroke-active` | **2.5px** | 选中/关联加粗（dramaclaw selected `2.5` / processing `2.2–2.7`） |
| `--toiv-node-edge-stroke-comfy` | **3px** | Comfy 兼容（`connections_width=3`） |
| `--toiv-node-edge-color` | `rgba(176,176,183,0.45)` | 默认线（dramaclaw `baseStroke`） |
| `--toiv-node-edge-color-active` | `rgba(205,209,216,0.64)` 或 accent | 选中高亮；处理中可用 `accent / 0.94` |
| `--toiv-node-edge-hit` | **24px** | 透明命中描边（dramaclaw） |
| `--toiv-node-edge-disconnect` | **32–40px** | 断开按钮（Toonflow `32`；dramaclaw `40`） |
| `--toiv-node-grid-gap` | **16px** | 点阵/吸附主档（Toonflow Background `gap=16` + snap `[16,16]`；BeefTV snap `16`） |
| `--toiv-node-grid-gap-comfy` | **10px** | Comfy `CANVAS_GRID_SIZE=10` |
| `--toiv-node-grid-dot` | **2px / `#4a4a4a`** | dramaclaw Dots；BeefTV dark dots 低对比 |
| `--toiv-node-snap-align` | **8 / 12 px** | 屏幕吸附阈值（dramaclaw `SNAP_ALIGN_SCREEN_THRESHOLD=8` / release `12`） |
| `--toiv-node-arrange-gap` | **96–160 / 160–320** | 自动整理 node/rank gap（Toonflow arrangeCanvas） |
| `--toiv-node-minimap` | 右下 popover；可钉；M 键 | dramaclaw MiniMap；Toonflow `@vue-flow/minimap` bottom≈46 |
| `--toiv-node-dur` | **150–300ms** | hover/选中/线色（R1/R2 + dramaclaw edge `300`） |
| `--toiv-node-ease` | `cubic-bezier(0.22, 1, 0.36, 1)` | ease-out-quint |
| `--toiv-node-adult-geometry` | **unchanged** | 成人闸禁止改上表任何几何 |

#### 端口类型色（Comfy 习惯 → ToIV 子集）

| 类型 | 建议色 | 来源 |
|---|---|---|
| IMAGE | `#64B5F6` | Comfy 社区惯例 |
| LATENT | `#FF6E6E` | 同上 |
| MODEL | `#B39DDB` | 同上 |
| CLIP | `#FFD54F` | 同上 |
| VAE | `#FF9CF9` | 同上 |
| CONDITIONING | `#FFA931` | 同上 |
| AUDIO / VIDEO | `#4ADE80` / `#F472B6` | ToIV 扩展（非 Comfy 原文） |
| STRING / * | `#94a3b8` / accent | 默认灰；通配跟 accent |

> Comfy 官方 `default_connection_color_byType` 可为空表，运行时由扩展/类型键填色；ToIV 应用上表作**固定子集**，避免随插件漂移。

---

## ① 深度调研与像素级拆解

### A. CineGen-ShortDrama — **无节点编排图**

- 栈：React + Tailwind 阶段台（`StageScript / StageAssets / StageDirector / StageExport`），**无** `reactflow` / `xyflow` / `litegraph` 依赖。
- 结论：R5 **不抽节点几何**；其「阶段流」已在 R3/R4 消费。勿把分镜网格误当节点图。

### B. Toonflow-app — Vue Flow 节点骨架（1:1 可抄最多）

实读 `packages/nodeScaffold/src/nodeSkeleton.vue` + `apps/web/.../canvas/index.vue`：

| 项 | 像素 / 行为 |
|---|---|
| 默认节点宽 | **220px**（媒体探索页可到 338；group 640×440） |
| 标题栏 | icon 16 + 字 14 / 行高 20；下 pad 8；动作钮 24×24 hover 显 |
| 内容卡 | `el-card` pad **8**；选中边 `color-mix(primary 50%, border)` |
| Handle | **18×18**；左右偏移 **-12**；图标 CircleDashed/Dot；hover opacity；valid→primary / invalid→danger |
| 命中扩环 | `::before inset -13` |
| 网格 | Background **gap 16**；snap `[16,16]`（默认关，可开） |
| 连线 | `defaultEdgeOptions`；active stroke → `--canvasEdgeColor`（可 custom / primary） |
| 小地图 | `@vue-flow/minimap`；controls 高 34；窄壳上移 |
| 断开 | 固定 **32×32** 剪刀钮 |
| 端口类型 | `STRING/INT/FLOAT/BOOLEAN/IMAGE/MASK/LATENT/AUDIO/VIDEO/FILE/MODEL/CLIP/VAE/CONDITIONING/*`（Comfy 同构命名） |

气质：Element Plus 卡片节点 + 端口图标化；选中偏 **边框变色**，glow 弱于 dramaclaw。

### C. ComfyUI 现代暗色（`Comfy-Org/ComfyUI_frontend` litegraph）

实读 `LiteGraphGlobal` / `LGraphCanvas` 构造常量：

| 常量 | 值 |
|---|---|
| `CANVAS_GRID_SIZE` | **10** |
| `NODE_TITLE_HEIGHT` | **30** |
| `NODE_SLOT_HEIGHT` | **20** |
| `NODE_WIDGET_HEIGHT` | **20** |
| `NODE_WIDTH` / `MIN` | **140** / **50** |
| `ROUND_RADIUS` | **8** |
| `NODE_TEXT_SIZE` / `SUBTEXT` | **14** / **12** |
| 默认色 | title `#999`；bg `#353535`；box `#666`；text `#AAA`；选中标题 `#FFF`；轮廓 `#FFF` |
| `LINK_COLOR` | `#9A9` |
| `connections_width` | **3** |
| 连接默认 | input/output on `#7F7`；off `#778` |
| 阴影 | `DEFAULT_SHADOW_COLOR rgba(0,0,0,0.5)`；`render_shadows=true` |
| 背景清屏 | `#222` |

气质：密、偏工程工具；圆角更小、线更粗、白轮廓选中——**适合嵌入 Comfy 视图**，不宜直接当 Freezone 主 DNA。

### D. dramaclaw Freezone（主跟，重扫）

实读 DESIGN.md + `frontend/src/index.css` + edges/domain：

| 项 | 值 |
|---|---|
| 默认节点宽 | **320**（storyboard 节点宽 **440**；export **480**） |
| 圆角 | dark **14**（light 12）；DESIGN `rounded.node=14` |
| 选中 | **glow 24px accent/0.25** + 标题变 accent；**禁止投影当选中** |
| Handle | 视觉 **8×8** 灰；多数 **opacity:0**（锚点隐蔽，「+」连线）；skill 输入口显式 |
| 连线 | stroke **2** / 选中 **2.5**；processing dash；端点圆 r=4 外偏 4 |
| 网格 | Dots **gap 20 size 2** `#4a4a4a` |
| 吸附 | snap-align 屏阈 **8 / 12** |
| 小地图 | MiniMap 可钉；遮罩 `rgba(0,0,0,0.62)`；节点色灰 |
| 落点反馈 | drop-target 顶出 + 流动边框角动画 |

### E. B 仓重写（节点相关模式，非 R1 复述）

| 仓 | 节点图？ | 可抽模式（本轮新扫） |
|---|---|---|
| **PrintFilm** | ✅ `@xyflow/react` Free Canvas | edge `#94a3b8` / width **2**；底栏 snap + minimap 开关；节点选择器圆角 16；框选蓝系（ToIV 应换白虚线/accent，勿抄蓝） |
| **BeefTV** | ✅ 自研 Canvas 节点图（非 xyflow） | dark 画布 `#141414`；node fill `#262626` / stroke 白 18%；edge 白 18%；shadow `0 8px 24px`；snap **16**；选中 activeStroke 近白——ToIV 选中应改 accent glow |
| **AID-Studio** | ✅ `@xyflow/react` 在 `/create/studio` | 有图库依赖；本波未见独立几何常量文件——模式：「创作台内嵌 React Flow」，尺寸跟默认 xyflow，落地时再钉 |
| **ai_story** | 后端 workflows，前端非 Freezone 节点 UI | **勿抽像素**；仅知有 workflow 模型层 |
| **ArcReel / BigBanana / LumenX / Koma** | 无（或极弱）节点图库命中 | **无节点几何可抄**；BigBanana 阶段流已在 R4 |
| **AIMovieStudioV2** | 无实质节点 UI 源 | 跳过 |

---

## ② 照抄与融合方案（对 ToIV Canvas / 节点）

### 1:1 照抄

1. **dramaclaw**：选中 = accent ring + **glow 24px**（无重阴影）；handle 可视觉隐藏、保留命中；edge 2→2.5；MiniMap 可钉；Dots 网格。
2. **Toonflow**：标题栏结构（icon+可编辑名+hover 动作）；handle 18 命中扩环；snap 16；断开钮；端口类型命名与 Comfy 同构。
3. **Comfy（仅嵌入视图）**：`ROUND_RADIUS=8`、`connections_width=3`、`NODE_TITLE_HEIGHT=30`、grid 10——隔离 token 前缀 `--toiv-comfy-*`，不污染 Freezone。

### 融合（ToIV 默认 Freezone）

| 决策 | 取舍 |
|---|---|
| 圆角 | **12–14**（跟 DNA panel；拒绝 Comfy 8 做主档） |
| 默认宽 | **300±20**（折中 220 紧凑 / 320 Freezone） |
| 端口 | 默认 **8 视觉 + 18 命中**；连线中/hover 再亮；类型色用上表子集 |
| 线宽 | **2 / 2.5**（拒绝默认 3，除非 Comfy 模式） |
| 选中 | **glow 优先**（dramaclaw）；可选极轻边，禁止 BeefTV 重阴影 + glow 叠用 |
| 网格 | **16** 主；Comfy 视图 10 |
| 框选 | 白虚线（dramaclaw），**不抄 PrintFilm 蓝框** |

### 拒绝

- CineGen 阶段台冒充节点图  
- Comfy 白轮廓选中当 Freezone 主态  
- BeefTV 近白 activeStroke 当成人强调（成人色只在顶栏闸 `#4f8cff`）  
- 成人模式改圆角/线宽/端口径  

---

## ③ 落地蓝图（`--toiv-node-*`）

1. **CSS vars** 挂在 `/create` Freezone 根（与 R3 shell、R2 双闸同层）：实现上表；`--toiv-node-selected-glow` 的 rgb 引用 `--toiv-accent-rgb`（普通 `#5ba0ff`），**不要**在成人模式下改这个几何变量——成人只切内容过滤器与顶栏字色。
2. **React Flow / 自研 Canvas** 映射：
   - `nodeStyle.borderRadius` ← `--toiv-node-radius`
   - `defaultEdgeOptions.style.strokeWidth` ← 2；selected 2.5
   - `Background gap` ← 16；`snapGrid` ← [16,16]
   - Handle：宽高 8，hitArea / ::before 扩到 18–24
3. **类型色 map**：`portTypeColor[type]` 上表；未知回落 `--toiv-node-port-color`。
4. **Comfy 嵌入**：独立 class `.toiv-comfy-graph` 覆盖 radius 8 / stroke 3 / grid 10 / title 30。
5. **小地图**：右下；默认 hover 显 / 可钉；不进成人几何差分。
6. **与 R3/R4**：节点在中栏画布；选中节点可开右 Inspector 320 或详情 420——壳宽 token 不进本表。

### Token 声明草稿（跨端可直接贴）

```css
:root, .toiv-create {
  --toiv-node-w-default: 300px;
  --toiv-node-radius: 12px;
  --toiv-node-title-h: 30px;
  --toiv-node-port-d: 8px;
  --toiv-node-port-hit: 18px;
  --toiv-node-edge-stroke: 2px;
  --toiv-node-edge-stroke-active: 2.5px;
  --toiv-node-grid-gap: 16px;
  --toiv-node-selected-glow: 0 0 24px rgb(91 160 255 / 0.25);
}
```

---

## ④ 双闸与连贯性校验

| 检查项 | 结论 |
|---|---|
| 成人模式改节点圆角/线宽/端口？ | **禁止**（`--toiv-node-adult-geometry: unchanged`） |
| 成人模式改什么？ | 仅：**内容过滤**（NSFW 节点/预览/模型条目可见性）+ 顶栏「普通｜成人」字色/glow `#4f8cff` |
| 节点选中 glow 用成人色？ | **否**。节点仍用 accent `#5ba0ff` glow，保持画布工具中性；成人强调只在闸控件 |
| 与 R2 quiet pill | 顶栏闸不变；节点图不出现第二套模式开关 |
| 与 R3 三栏 | 节点画布 = 中栏；左右壳宽不因成人变化 |
| 与 R4 分镜卡 | 分镜**列表卡**用 `--toiv-shot-*`；画布上 storyboard **节点**用本表（宽 440 可与 R4 `canvas-node-w` 对齐） |
| Comfy 嵌入 | 可保留 Comfy 自身选中白边；外层 Freezone chrome 仍 ToIV DNA |
| 后端 | 不拦；闸在前端 |

**连贯性一句话**：Freezone 节点几何全站一套；成人只滤「看见什么」，不滤「长什么样」。

---

## Blocker / 未决

1. **AID-Studio** 有 `@xyflow` 但本波未抽出独立几何常量 → 若要 1:1 对齐需再开一刀读其 node 组件。  
2. **Comfy 类型色**官方 `byType` 表可为空，上表为社区惯例钉死——若要「与本机 Comfy 插件色完全一致」需对运行时 `link_type_colors` 再采样。  
3. **ToIV 现网 Canvas** 若已是 Go/自研而非 React Flow：token 仍适用，但 Handle/edge API 映射由跨端改写，本简报不写业务码。  
4. **未 commit / 未 push**（按口令）。

---

## 交付路径

- MateBook：`/Users/wangzhenyu/Desktop/ALLProject/ToIV/docs/ops/VISUAL_NODE_GRAPH_R5_20261026.md`
- 箱备：`/workspace/docs/ops/VISUAL_NODE_GRAPH_R5_20261026.md`
