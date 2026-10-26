# ToIV 全局视觉系统重置 · 第1轮调研简报

- **日期**：2026-10-26（Asia/Shanghai）
- **执行**：模型调研帮手（视觉 DNA R1）
- **状态**：未 commit / 未改产品代码
- **方法**：GitHub 实读 CSS / DESIGN.md / theme tokens（禁止大段粘贴版权代码；仅数值表与模式）
- **对照公开资料**：Linear / Runway 仅描述公开暗色工作台模式，**未抓到官方公开 hex 则不编造**

---

## ⚡ TL 立刻可用 · 三块硬数字（优先读）

### 1) 暗色 bg / surface / border / text / accent（实查）

| 源 | bg | surface | border | text | accent |
|---|---|---|---|---|---|
| **dramaclaw**（`DESIGN.md` ↔ `frontend/src/index.css`） | `#0a0c12`（画布 RGB `10 12 18`；`.dark --background` 另见 `#090909`） | `#15161d`；panel `#13141b`；modal `#1b1c23`；field `#0d0e14` | `#22232c`；soft `#1f2026`；strong `#2f3036`；soft alpha `rgba(255,255,255,0.05)` | `#e8eaf0`；muted `#6f7079` | **画布蓝** `#5ba0ff`；**shadcn 青** `#00bdcf`（双强调，按表面选） |
| **BeefTV**（`web/src/styles/globals.css` `.dark`） | `#0f0f0f`；user-page `#101010`；director-workspace `#0b0d0f` | card/workspace `#181818`；user `#161616`；raised `#1b1b1b`；muted `#202020` | `#222222`；strong `#333333`；user `rgba(255,255,255,.09)` | `#ffffff`；body `#a8a8a8`；muted `#888888` | **工作台近白** `#f5f5f5`；**导演色** `#4f8cff`（hover `#6ba0ff`）；glow 蓝 `rgba(125,162,255,*)` |
| **Toonflow-web**（`src/assets/main.scss` `theme-mode=dark`） | `--bgc #3a3b3b`；`--page #242424`；page-container `#202222` | container `#2c2e2e`；secondary `#3a3b3b` | L1 `#494a4a`；L2 `#6a6b6b` | primary `rgba(255,255,255,0.9)`；secondary `0.55`；placeholder `0.35` | **灰度品牌** `--td-brand-color` → `#8c8c8c`（非彩强调） |
| **Toonflow-app**（`apps/web/src/assets/main.scss`） | **未自带暗色色板**；圆角 `--ui-radius: 8px`，品牌色映射 Element/TDesign primary | （同左，依赖 UI 库） | （同左） | （同左） | 跟 `--el-color-primary` / TDesign brand 走 |

> 结论：**真正匹配「暗色 Freezone 密台」的是 dramaclaw；BeefTV 是近黑密台 + 可选彩强调；Toonflow 是 TDesign 中灰暗色工具壳，不宜 1:1 当 Freezone DNA。**

### 2) 圆角 / 内阴影·glow / 字号阶梯

| 源 | 圆角 | 阴影 / glow | 字号阶梯（产品主力） |
|---|---|---|---|
| **dramaclaw** | field `12` / node `14` / panel `16` / xl `20` / pill `9999`；`--radius: 1rem` → TW sm/md/lg≈12/14/16 | panel：`0 14px 34px rgba(0,0,0,0.5)` + **inset** `0 1px 0 rgba(255,255,255,0.03)`；glow：`0 0 24px rgb(91 160 255 / 0.25)`；blur：`saturate(180%) blur(18px)` | 12 / 14 / 16 / 18 / 20 / 24 / 30；label 12/500；mono 12 |
| **BeefTV** | `4/6/8/12/14/16/20/24/32` + full；card `16`；control `12` | glow：`0 0 12/24/40px rgba(125,162,255,0.2/0.3/0.4)`；暗色 elevation hairline：**inset** `0 0 0 1px rgba(255,255,255,0.085)`；overlay `0 28px 72px rgba(0,0,0,0.62)` | `7/9/10/11/12/14/15/16/18/22/36`（产品建议仍以 ≥12 为主） |
| **Toonflow-web** | `2/3/6/9/12/999`（TDesign） | `--td-shadow-1/2/3` 多层黑影；inset `#5e5e5e` | `12/14/16/18/20/24/28/36/48/64` |
| **Toonflow-app** | base `8`；small `4`；large `12` | 跟库默认 | 跟库默认 |

### 3) 可 1:1 复刻 vs 仅融合

| 等级 | 项 |
|---|---|
| **✅ 1:1 复刻（优先）** | dramaclaw 画布色板（bg/surface/border/text/accent 蓝）；玻璃面板 elevation（半透明 + 1px soft border + 深投影 + inset 高光）；安静胶囊按钮 / chip；4px 间距密台；选中用 glow 不用重阴影；动效 150/220/320 + ease-out-quint |
| **🔀 融合** | BeefTV 三层 token 架构（primitive→semantic→component）与 director `#4f8cff` 作「可选第二强调（光幕/闸）」；Toonflow 字号阶梯与组件密度作表单/设置页；lumenx 5 档表面层级作深度参考；ArcReel oklch 紫主色作备选品牌线（不默认） |
| **⛔ 跳过** | Toonflow 灰度 brand 当创作台强调色；printfilm 亮色+荧光绿营销壳；lumenx 热粉/bloom 落地页装饰进工作台；后台风换栈/大推翻；bounce/elastic；后端拦 NSFW |

---

## DNA 约束（本波必须遵守）

1. **暗色 Freezone 密台、内容优先**（外壳退后，内容与画布占视觉权）
2. **`/create` 唯一创作台**（信息架构不因主题切换分叉）
3. **顶栏右光幕成人双闸**：SFW 默认 / NSFW 可切换；闸在**前端单文件**；后端不拦
4. **不换栈**：Next 15 + FastAPI + Go Canvas
5. **Strangler**：渐进替换 token/壳层；拒绝后台风大推翻
6. **大胆照抄可用视觉点**；拒绝后台风

---

## ① 深度调研与像素级拆解

### A. dramaclaw（最强 DNA 对齐）

- 自述定位：「暗色优先、信息密集的工作台」「仪表盘不是海报」——与 ToIV Freezone 密台同构。
- **双色板**：画布 RGB 系（`--*-rgb`，alpha 友好）+ shadcn oklch 语义系；**同一表面不混用**。画布强调蓝 `#5ba0ff`，shadcn 主色青 `#00bdcf`。
- **层次**：L0 不透明底 `#0a0c12` → L1 节点 panel → L2 半透明玻璃 panel（blur 18px）→ L3 模态不透明决策面。
- **形状签名**：可点非提交控件一律 **pill**；容器 12–20 柔矩形。
- **密度**：间距基线 4px；正文主力 12/14；一屏一个高饱和焦点。
- **证据路径**：`DESIGN.md`（机读镜像）、`frontend/src/index.css`。

### B. BeefTV（近黑密台 + 工业化 token）

- `.dark` 近黑：`#0f0f0f` / `#181818` / `#222222` / 白字；工作台 accent 偏 **近白中性**，真正彩强调在 **director `#4f8cff`** 与 glow 蓝。
- 完整 **4px 栅格 + 10 档圆角 + glow/elevation 分离**（暗色浮层用黑影 + hairline，避免白影刺眼）。
- 用户工作区另有一套 `--user-*`（暗：page `#101010` / surface `#161616`），适合「创作台外壳 vs 画布」分层参考。
- **证据路径**：`web/src/styles/globals.css`。

### C. Toonflow-web / Toonflow-app

- **web**：TDesign 暗色灰度工具壳；`--bgc #3a3b3b`、`--page #242424`，brand 为灰阶 `#8c8c8c`——适合后台/设置密度，**不是 cinematic Freezone**。
- **app**：仅统一圆角 `8/4/12` 与 brand→Element/TDesign 映射，**无独立暗色 hex 表**。
- 可抄：字号阶梯、滚动条 6px、组件尺寸节奏；不可抄：把灰度 brand 当创作强调。

### D. Linear / Runway（公开模式，无实查 hex）

- 公开观感共性（**不写未抓到的 hex**）：近黑画布、极低对比边线、单一冷静强调色、内容区大留白/密信息二选一中偏密工具态、动效短促减速。
- ToIV 落地时以 dramaclaw/BeefTV **已钉 hex** 为准，Linear/Runway 只作气质校验，不直接灌 token。

### E. 浅扫可用点（配色/排版/阴影/圆角/间距）

| 仓 | 可用点（浅） | 跳过 |
|---|---|---|
| ArcReel | 暗色 oklch 紫主 `primary ~ oklch(0.76 0.09 295)`；radius `0.625rem`；popover 不透明表面；glow-primary 弱紫光 | 整套紫品牌默认覆盖 ToIV |
| lumenx | atelier-dark：`bg #0c0b0e` / surface `#131116` / text `#f2ede4` / primary `#34d8c4` / accent `#ffa94d`；cyber：`#050508` + `#646cff`/`#ff0080`；5 档表面；card-radius `14` | bloom/halation 进工作台；双高饱和同屏 |
| printfilm | radius `14/10`；但 **亮色+lime `#b6ff00` 营销壳** | 作 Freezone DNA |
| aid-studio / BigBanana / AIMovieStudiov2 / ai_story / CineGen / koma-studio | 本波未拿到可钉 CSS hex（树检索弱/非前端 token 为主） | 本轮不强行猜色 |

---

## ② 照抄与融合方案（对 ToIV）

### 直接照抄（Strangler 第 0–1 刀）

1. **Freezone 画布 token**：dramaclaw 画布 RGB 系（bg/surface/border/text/accent 蓝）。
2. **浮层玻璃**：半透明 panel + soft border + 深投影 + inset 顶高光 + 可选 backdrop-blur。
3. **控件形状**：安静按钮/chip/筛选用 pill；输入 12、节点 14、面板 16。
4. **密度与字号**：4px 基线；属性行 12，中英标签 14；一屏一个高饱和。
5. **选中态**：accent ring + glow，不用「拖拽感」重阴影。

### 融合（保留 ToIV 身份）

1. **强调色策略**：默认创作强调取 dramaclaw 蓝 `#5ba0ff`（或 BeefTV director `#4f8cff` 二选一钉死，禁止双彩并存于同屏）。shadcn/表单主按钮可用略偏青的 primary，但必须文档化「表面归属」。
2. **顶栏右光幕双闸**：视觉借用 BeefTV glow（`0 0 24px` 蓝系）表达 NSFW「点亮」；SFW 态用 muted chip（dramaclaw chip 静止态）。
3. **设置/账户等非创作页**：可融合 Toonflow 字号与灰阶容器节奏，但仍挂同一套 CSS 变量，避免第二套皮肤。
4. **token 工程**：学 BeefTV 三层命名（`--toiv-*` primitive / semantic / component），便于 Strangler。

### 明确跳过

- 换栈、重写路由信息架构、后端 NSFW 403。
- printfilm 亮色营销、lumenx 落地页 bloom、Toonflow 灰 brand 当 CTA。
- 把 Linear/Runway 未核实 hex 写进生产 token。

---

## ③ 落地蓝图（建议 CSS 变量名）

> 建议落在前端单文件或 `styles/toiv-tokens.css`，由 `/create` 与顶栏双闸共同消费。数值以 **dramaclaw 画布 + BeefTV glow** 为默认提案。

### 色

```css
:root, .toiv-dark {
  /* canvas / freezone */
  --toiv-bg: #0a0c12;
  --toiv-surface: #15161d;
  --toiv-surface-panel: #13141b;
  --toiv-surface-modal: #1b1c23;
  --toiv-surface-field: #0d0e14;
  --toiv-border: #22232c;
  --toiv-border-soft: rgba(255, 255, 255, 0.05);
  --toiv-border-strong: rgba(255, 255, 255, 0.12);
  --toiv-text: #e8eaf0;
  --toiv-text-muted: #6f7079;
  --toiv-accent: #5ba0ff;          /* 创作焦点：钉死其一 */
  --toiv-accent-alt: #4f8cff;      /* 备选/光幕，勿同屏双开 */
  --toiv-primary: #00bdcf;         /* 表单/提交表面 */
  --toiv-danger: #ea4335;
  --toiv-success: #51bf6f;
  --toiv-warning: #efa831;

  /* RGB 便于 alpha */
  --toiv-accent-rgb: 91 160 255;
  --toiv-bg-rgb: 10 12 18;
  --toiv-surface-rgb: 21 22 29;
}
```

### 字号

```css
--toiv-fs-caption: 12px;
--toiv-fs-body: 14px;
--toiv-fs-body-lg: 16px;
--toiv-fs-title: 18px;
--toiv-fs-headline: 20px;
--toiv-fs-headline-lg: 24px;
--toiv-fs-display: 30px;
```

### 圆角

```css
--toiv-radius-field: 12px;
--toiv-radius-node: 14px;
--toiv-radius-panel: 16px;
--toiv-radius-xl: 20px;
--toiv-radius-pill: 9999px;
```

### 阴影 / glow

```css
--toiv-shadow-panel: 0 14px 34px rgba(0, 0, 0, 0.5), 0 1px 0 rgba(255, 255, 255, 0.03) inset;
--toiv-glow-accent: 0 0 24px rgb(var(--toiv-accent-rgb) / 0.25);
--toiv-ring-focus: 0 0 0 3px rgb(var(--toiv-accent-rgb) / 0.12);
--toiv-blur-panel: saturate(180%) blur(18px);
```

### 间距

```css
--toiv-space-1: 4px;
--toiv-space-2: 8px;
--toiv-space-3: 12px;
--toiv-space-4: 16px;
--toiv-space-5: 24px;
--toiv-space-6: 32px;
```

### 动效

```css
--toiv-duration-fast: 150ms;
--toiv-duration-base: 220ms;
--toiv-duration-slow: 320ms;
--toiv-ease-out: cubic-bezier(0.22, 1, 0.36, 1);
```

---

## ④ 双闸与连贯性校验

### 信息架构（不破坏）

- SFW / NSFW **只切换可见模型/素材过滤与光幕态**，不切换路由树：`/create` 仍是唯一创作台。
- 闸在**前端单文件**（模式 store + 可见性 filter）；后端不拦——与既有红线一致。

### 视觉连贯

| 态 | 顶栏右光幕 | Freezone / 创作台 |
|---|---|---|
| **SFW 默认** | 安静 pill/chip：muted 字 + 弱边；无 glow | 全套 `--toiv-*` 暗色密台；强调色仅用于当前选中节点/主 CTA |
| **NSFW 可切换** | 同形状控件：文字/边走 `--toiv-accent`，叠加 `--toiv-glow-accent`（光幕「点亮」） | **不换底色板**；仅模型列表/徽章出现 NSFW 标记色（可用 warning 或 accent soft fill），避免第二套皮肤 |

### 校验清单（落地验收）

1. 切换双闸后，bg/surface/border/text **不变**，只变闸控件与列表过滤。
2. 同屏高饱和元素 ≤ 1（闸点亮时，节点选中 glow 降级或互斥）。
3. `/create` 外壳与画布均引用同一 token 文件；禁止页内写死 hex。
4. 对比度：正文对 bg ≥ AA；chip 静止态欠账勿扩大（dramaclaw 已知 chip ~3.83:1）。
5. 不因 NSFW 模式改左侧导航结构或拆第二创作路由。

---

## 给 TL 的 5 条可执行下一步（跨端落地）

1. **钉死强调色**：在 `#5ba0ff`（dramaclaw）与 `#4f8cff`（BeefTV director）中选 1 个为 `--toiv-accent`，写进前端 token 单文件并冻结。
2. **Strangler 第 1 刀**：只替换 `/create` 壳 + Freezone 画布背景/边线/字色到上表；业务组件暂不动。
3. **双闸单文件**：顶栏右光幕控件接同一 token；SFW/NSFW 仅驱动 filter + `data-gate` 样式，不改路由。
4. **跨端对齐**：Go Canvas 节点选中态用同一 accent RGB 与 glow 数值；FastAPI 不增加内容拦截。
5. **视觉回归**：截图对比「闸关/闸开」两态各 3 屏（空画布、选中节点、模型抽屉），确认底色不变、仅光幕与列表变。

---

## 证据索引（路径）

- dramaclaw: `DESIGN.md`, `frontend/src/index.css`
- BeefTV: `web/src/styles/globals.css`
- Toonflow-web: `src/assets/main.scss`
- Toonflow-app: `apps/web/src/assets/main.scss`
- 浅扫: ArcReel `frontend/src/index.css`；lumenx `frontend/src/app/globals.css`；printfilm `frontend/src/index.css`

## 风险 / Blocker

- **无硬 blocker**（只读调研，未改代码）。
- 浅扫仓中部分未解析到可钉 hex（aid-studio 等）——不影响 R1 落地，因主 DNA 已由 dramaclaw + BeefTV 覆盖。
- Linear/Runway **无实查 hex**——刻意不编造；气质校验即可。
