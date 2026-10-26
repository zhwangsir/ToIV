# ToIV 设置 / 模型管理 UI · 第10轮调研简报

- **日期**：2026-10-26（Asia/Shanghai）
- **执行**：模型调研帮手（Settings / Model Manager R10）
- **状态**：未 commit / 未写业务码 / 未 push
- **承接**：R1–R9；accent `#5ba0ff`；成人 `#4f8cff`；创作台右栏 320/详情 420；成人不改几何
- **方法**：
  - **A 优先实读**：Toonflow-app `settings/index.vue` + `providerList.scss` + media/language Model 面板；dramaclaw `settings-dialog.tsx`（模型/存储/技能）；LumenX Line-A `settings.html`（`--sidebar-w: 224`）；Linear 公开 DESIGN（侧栏 220–230 / 行 28 / 控 32）；Vercel Dashboard（公开 changelog + shadcn sidebar 规格 16rem，无登录像素）
  - **B 浅扫**：aid-studio（生成设置 hook，无独立暗色 Settings shell）；ArcReel/printfilm/CineGen（无对标双栏设置对话框）

---

## ⚡ TL / 跨端立刻可用 · 推荐默认 + 硬尺寸表

### 推荐默认（一句话）

**设置用居中双栏 Dialog（非整页）：宽 max 1120 / 高 min(82vh,760)；左导航 176（窄屏图标轨 56）；导航行高 40；内容区表单标签列 140、控件高 36；模型供应商卡头标 40、行间距 12；模型明细编辑走嵌套 Dialog≈560 或右抽屉 420（对齐 R3 详情）；分区 eyebrow 11 + 段间距 20；成人闸零几何差。**

### 硬尺寸表 · `--toiv-settings-*`

| Token | 值 | 用途 / 来源对齐 |
|---|---|---|
| `--toiv-settings-shell` | **dialog** | Toonflow/dramaclaw 居中对话框；全页 Settings 仅备档（LumenX/Vercel） |
| `--toiv-settings-dialog-w` | **1120px** max | dramaclaw `sm:max-w-[1120px]`；Toonflow **1080** 备档 |
| `--toiv-settings-dialog-w-min-margin` | **32px**（`100vw-32`） | Toonflow `calc(100vw - 32px)` |
| `--toiv-settings-dialog-h` | **min(82vh, 760px)** | dramaclaw；Toonflow `min(72vh, 100dvh-140)` 备档偏矮 |
| `--toiv-settings-dialog-radius` | **12px**（`rounded-lg`） | |
| `--toiv-settings-header-h` | **~56px** | `px-5 py-4` ≈ 16+24+16 |
| `--toiv-settings-footer-h` | **~52px** | `px-5 py-3.5` |
| `--toiv-settings-nav-w` | **176px** | dramaclaw `sm:w-44`；Toonflow **160** / LumenX **224** 取中密台档 |
| `--toiv-settings-nav-w-icon` | **56px** | dramaclaw `w-14`；LumenX global-rail 同宽感 |
| `--toiv-settings-nav-item-h` | **40px** | dramaclaw `h-10`；Toonflow pad `10×12` ≈ 同档 |
| `--toiv-settings-nav-item-px` | **12px**（icon 轨 **8**） | |
| `--toiv-settings-nav-item-gap` | **8–10px** | icon↔文案 |
| `--toiv-settings-nav-item-radius` | **8px**（`rounded-md`） | |
| `--toiv-settings-nav-item-mb` | **4px** | Toonflow |
| `--toiv-settings-nav-group-label-fs` | **11–12px** | Toonflow 12 muted；LumenX eyebrow 9 mono 备档 |
| `--toiv-settings-nav-group-mt` | **14px** | Toonflow group label |
| `--toiv-settings-nav-icon` | **16px** | dramaclaw `size-4`；LumenX 15 备档 |
| `--toiv-settings-nav-active-bar` | **3×18px** 左边条 | LumenX `.set-link.active::before`；色 `#5ba0ff` |
| `--toiv-settings-content-px` | **20px** | Toonflow content；dramaclaw section `px-5`=20 |
| `--toiv-settings-content-py` | **20px** | section `py-5` |
| `--toiv-settings-panel-title-fs` | **18px** | Toonflow `.panelTitle` |
| `--toiv-settings-panel-title-mb` | **20px** | |
| `--toiv-settings-section-gap` | **20px** | 分区间距 |
| `--toiv-settings-section-title-fs` | **14px / 500** | dramaclaw `text-sm font-medium` |
| `--toiv-settings-section-desc-fs` | **12px** | `text-xs` muted |
| `--toiv-settings-form-label-w` | **140px** | 介于 dramaclaw **120** 与 LumenX **200**；密台对话框钉 140 |
| `--toiv-settings-form-gap` | **12–16px** | dramaclaw gap-3；LumenX 18 偏松 |
| `--toiv-settings-form-row-py` | **12–14px** | LumenX frow 14；about-row 10 |
| `--toiv-settings-control-h` | **36px** | dramaclaw `h-9`；Linear 32–36 |
| `--toiv-settings-control-fs` | **13–14px** | |
| `--toiv-settings-control-radius` | **8px** | |
| `--toiv-settings-toggle-w` | **36px** | dramaclaw `w-9`；LumenX 42 备档 |
| `--toiv-settings-toggle-h` | **20px** | dramaclaw `h-5`；LumenX 24 备档 |
| `--toiv-settings-details-summary-py` | **12px** | dramaclaw details `py-3` |
| `--toiv-settings-scrollbar-w` | **4px** | dramaclaw scroll-area `!w-1` |
| `--toiv-settings-page-max-w` | **760px** | 仅全页模式内容柱（LumenX `.wrap`） |
| `--toiv-settings-vercel-sidebar-ref` | **256px**（16rem） | Vercel/shadcn 对照；ToIV 对话框**不取**此宽 |
| `--toiv-settings-adult-geometry` | **unchanged** | 成人只滤模型条目可见性 |

### 硬尺寸表 · `--toiv-model-mgr-*`

| Token | 值 | 用途 / 来源对齐 |
|---|---|---|
| `--toiv-model-mgr-provider-gap` | **12px** | Toonflow `.providerItem` margin-bottom |
| `--toiv-model-mgr-provider-mark` | **40×40** | Toonflow `.providerMark` |
| `--toiv-model-mgr-provider-logo` | **24×24** | |
| `--toiv-model-mgr-provider-mark-radius` | **8px** | el border-radius-base |
| `--toiv-model-mgr-provider-name-fs` | **15px** | Toonflow；备档 14 |
| `--toiv-model-mgr-provider-meta-fs` | **12px** | 「N 个模型」info |
| `--toiv-model-mgr-provider-header-gap` | **12px** | |
| `--toiv-model-mgr-provider-footer-mt` | **16px** | |
| `--toiv-model-mgr-provider-actions-gap` | **8×12** | |
| `--toiv-model-mgr-add-grid` | **1fr 1fr** gap 12 | Toonflow `.providerActions` 双 CTA |
| `--toiv-model-mgr-row-h` | **40px** | 模型子行（对齐 nav item / Linear 控高附近） |
| `--toiv-model-mgr-row-h-dense` | **36px** | 密表 |
| `--toiv-model-mgr-row-h-comfortable` | **48–56px** | 双行标题+meta |
| `--toiv-model-mgr-status-dot` | **6–8px** | dramaclaw `size-1.5`–`2` |
| `--toiv-model-mgr-badge-fs` | **10px** | dramaclaw chip `text-[10px]` |
| `--toiv-model-mgr-edit-dialog-w` | **560px** | 嵌套编辑（介于 R3 详情 420 与主设置 1120） |
| `--toiv-model-mgr-edit-drawer-w` | **420px** | **对齐 R3 详情**；全页设置右推可用 |
| `--toiv-model-mgr-partitions` | **models / storage / skills · general / keys / about** | dramaclaw 三页 + LumenX 五链；ToIV 建议：**模型｜引擎｜存储｜通用｜关于** |
| `--toiv-model-mgr-section-card-radius` | **8px** | details / provider 卡 |
| `--toiv-model-mgr-section-card-pad` | **12px** | |
| `--toiv-model-mgr-fetch-spin` | **14px**（`size-3.5`） | 获取模型按钮内 |

---

## ① 深度调研与像素级拆解

### Toonflow（A · 设置壳 + 供应商列表主模板）

- **壳**：`el-dialog` 宽 `min(1080px, 100vw-32)`；内网 `160px | 1fr`；高 `min(72vh, 100dvh-140)`。
- **导航**：分组 label 12 muted；item pad **10×12**、圆角 base、mb **4**、icon gap **10**；active = primary-light 底。
- **内容**：左右 pad **20**；面板标题 **18** / mb **20**；滚动区底垫 **50**。
- **模型**：`providerList` 头标 **40**、logo **24**、名 **15**、项间距 **12**、footer mt **16**；双列添加按钮。
- 分区：通用 / UI / 语言模型 / 媒体模型 / MCP / 插件 / 隐私 / 关于 等（侧栏多组）。

### dramaclaw（A · 模型配置对话框）

- **壳**：`max-w 1120`、`h min(82vh,760)`、`rounded-lg`、无 ring；头 `px-5 py-4`；底栏 `px-5 py-3.5`。
- **导航**：窄 **56** / 宽 **176**；item **h-10**；页：模型 / 存储 / Freezone 技能。
- **表单**：标签列 **120** + 控 **h-9**；开关 **36×20**；折叠 details summary **py-3**。
- **模型区**：状态点 + section 标题 14 + 描述 12 + 外链 11；官方/自建分区用 details。

### LumenX Line-A（A · 全页设置对照）

- 设置侧栏 **`--sidebar-w: 224px`**（atelier 248）；链路：通用 / 模型 / API 密钥 / 存储 / 关于。
- 链接 pad **9×11**、icon **15**、active 左条 **3×18**。
- 表单行 **200 | 1fr**、py **14**、内容柱 max **760**；偏「控制台全页」，对话框场景需压标签列。

### Linear / Vercel（公开规格）

- Linear：侧栏 **220–230**、行 **28**、控 **32**——设置页同密度，适合**页内**而非 1120 对话框。
- Vercel：2026-02 侧栏导航默认；shadcn sidebar **16rem=256** / icon **3rem** / mobile drawer **18rem** / 可拖 **160–360**——作全页仪表盘对照，**不直接作 ToIV 设置 Dialog 导航宽**。

---

## ② 照抄与融合方案

| 项 | 1:1 照抄 | 融合 | 不抄 |
|---|---|---|---|
| 壳形态 | dramaclaw 1120×760 Dialog | Toonflow 1080/72vh 作矮屏备档 | Vercel 整页侧栏当默认 |
| 导航宽 | dramaclaw 176 / 56 | Toonflow 160→升 176；LumenX 224 仅全页 | 256 设置导航 |
| 行高 | nav/控件 40/36 | Linear 28 仅极密表 | 营销大行 |
| 模型卡 | Toonflow 40 mark + 12 gap | dramaclaw details 分区 | 浅色大插画空供应商 |
| 编辑态 | 嵌套 Dialog 560 或抽屉 420 | 对齐 R3 详情宽 | 另开无规范宽 |
| 分区 IA | 模型优先（dramaclaw/LumenX） | ToIV：**模型｜引擎｜存储｜通用｜关于** | 插件市场塞进首屏 |

---

## ③ 落地蓝图

1. 落地 `--toiv-settings-*` / `--toiv-model-mgr-*`；设置入口 = Dialog，与 `/create` 壳分离。
2. 左导航固定 176（≤700px 收 56 图标轨）；active 可用 soft fill + 可选 3px 左条（色 `#5ba0ff`）。
3. 模型页：供应商列表（Toonflow 卡头）+ 展开模型子行 36–40；添加供应商双 CTA。
4. 编辑供应商/模型：优先嵌套 Dialog **560**；若从创作台 Inspector 唤起则用抽屉 **420**。
5. 表单统一 label **140** / control **36** / radius **8**；动效用 R9 150/220。
6. 成人模式：模型列表按前端闸过滤；行高/抽屉宽不变。

---

## ④ 双闸与连贯性校验

| 检查 | 口径 |
|---|---|
| 成人几何 | 导航宽/行高/Dialog/抽屉 **不变**；仅模型条目可见性与标签 |
| 与 R3 | 编辑抽屉 **420** = 详情档；常驻 Inspector 320 不承载完整设置 |
| 与 R7 | 获取模型 spin 14、hold 可跟 800ms |
| 与 R9 | 开关/hover 150ms；Dialog 入场 220ms；skeleton 用于模型列表首载 |
| Blocker | 无硬 blocker。待钉：① Dialog 高用 760 还是 Toonflow 72vh；② 标签列 120 vs 140；③ 「引擎」是否独立导航项还是并进「模型」 |

---

## B 仓浅扫

| 仓 | 结论 |
|---|---|
| aid-studio | 有 generate settings hooks，无双栏 Settings Dialog 像素可抄 |
| ArcReel / printfilm / CineGen | 无对标暗色设置+模型管理壳；跳过 |
| BigBanana / koma | 本轮无独立 settings UI |
