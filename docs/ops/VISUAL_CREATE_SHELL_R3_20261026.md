# ToIV `/create` 三栏创作台 · 第3轮调研简报

- **日期**：2026-10-26（Asia/Shanghai）
- **执行**：模型调研帮手（Create Shell R3）
- **状态**：几何钉已落地（R3 tip + R3补 280/320）；见 R4 handback 校正说明
- **承接**：`docs/ops/VISUAL_DNA_RESET_R1_20261026.md`、`docs/ops/VISUAL_MODE_SWITCH_R2_20261026.md`
- **已钉死**：accent `#5ba0ff`；成人字色/glow `#4f8cff`；文案「普通｜成人」；暗色 Freezone 密台；`/create` 唯一创作台；顶栏右光幕双闸
- **方法**：优先实读 Toonflow-web/app、CineGen、AIMovieStudiov2、BeefTV；Figma/Runway 仅公开规格/模式（**未抓到的 px 不编造**）；B 仓只抽模式

---

## ⚡ TL / 跨端立刻可用 · 推荐默认 + 硬尺寸表

### 推荐默认（一句话）

**左资产 280 / 中画布 flex+0 gutter（面板贴齐）/ 右 Inspector 320；折叠左/右均收成 56 icon-rail；分隔条可视 1px、命中 8px；成人模式只换内容与双闸能量，不改三栏几何。**

### 关键尺寸表（跨端可抄 → `--toiv-create-*`）

| Token | 值 | 用途 / 来源对齐 |
|---|---|---|
| `--toiv-create-left-default` | **280px** | 左资产默认（介于 Toonflow/BeefTV `240` 与 CineGen `288`、AIMovie Scene `256`） |
| `--toiv-create-left-min` | **200px** | 左栏可拖最小（低于此可读性崩） |
| `--toiv-create-left-max` | **360px** | 左栏可拖最大（BeefTV folder 预览档 `360` 作上限参考） |
| `--toiv-create-left-collapsed` | **56px** | 左折叠 icon-rail（密于 Toonflow-app `72` / workbench `64`，仍可点；触控可升 64） |
| `--toiv-create-right-default` | **320px** | 右 Inspector 默认（对齐 BeefTV Assistant **min 320**；轻于 AIMovie `420`） |
| `--toiv-create-right-min` | **280px** | 右栏最小（属性行仍可读） |
| `--toiv-create-right-max` | **420px** | 右栏最大（1:1 AIMovie Inspector 展开档；生成/对话重时可拖到此） |
| `--toiv-create-right-collapsed` | **56px** | 右折叠 icon-rail（与左对称；AIMovie 用 `40` 过瘦，不照抄） |
| `--toiv-create-right-expanded` | **420px** | 分镜选中时右栏扩宽（= `--toiv-shot-detail-w`；**非浮层**） |
| `--toiv-create-right-expanded-max` | **480px** | 选中扩宽上限 |
| `--toiv-create-canvas-gutter` | **0px** | 中画布与左右栏贴齐（内容优先；**不**再加壳内边距） |
| `--toiv-create-canvas-inset` | **12px** | 画布**内部**节点/内容 gutter（dramaclaw `node-gutter: 12`；与壳 gutter 分离） |
| `--toiv-create-splitter-visual` | **1px** | 分隔可视线（Toonflow splitter 透明+1px margin / 暗色 hairline） |
| `--toiv-create-splitter-hit` | **8px** | 拖拽命中区（BeefTV assistant resize `9px` 取 8；禁用纯 1px 命中） |
| `--toiv-create-splitter-bg` | `transparent` / hover `rgba(255,255,255,0.06)` | 默认隐身，hover 弱显 |
| `--toiv-create-splitter-active` | `rgb(91 160 255 / 0.45)` | 拖拽中用 accent 细线（勿 glow 进分隔条） |
| `--toiv-create-shell-min-w` | **1050px** | 三栏完整态最小壳宽（BeefTV `ASSISTANT_DOCK_MIN_SHELL_WIDTH=1050`） |
| `--toiv-create-break-stack` | **900px** | ≤900：强制左右收 icon-rail 或叠层（Toonflow-app `@media max 900`） |
| `--toiv-create-panel-radius` | **0**（贴边）或顶内 `16` | 壳级左右栏贴窗：圆角 0；若浮层面板再用 R1 panel `16` |
| `--toiv-create-panel-border` | `1px solid #22232c` / `rgba(255,255,255,0.08)` | R1 dramaclaw border |
| `--toiv-create-dur-collapse` | **200ms** | 折叠宽动画（AIMovie `duration-200`；画布禁 anim width 时改用 clip/transform） |
| `--toiv-create-ease` | `cubic-bezier(0.22, 1, 0.36, 1)` | R1/R2 ease-out-quint |
| `--toiv-create-adult-geometry` | **unchanged** | 成人闸**禁止**改任何上表几何 token |

**拖拽持久化建议**：`localStorage` 分键存 left/right 宽（学 BeefTV `canvas:assistant-width`）；刷新恢复；越界用 min/max clamp。

---

## ① 深度调研与像素级拆解

### A. Figma（公开规格 · 模式强、px 官方未公开）

- 五区：顶导航 / 左 sidebar（Layers·Assets）/ 中画布 / 右 properties /（UI3）底工具条。
- **可调宽、可折叠、可最小化 UI**（Help：拖左栏右缘；Minimize 时左栏收、选中时右栏可展开）。
- **官方未公布默认 px** → 本简报**不编造** Figma 默认宽；只抄模式：「内容居中 + 双侧可拖可折 + 命中区大于可视线」。
- Community 偶见「菜单 240」**不是**编辑器侧栏默认，禁止当证据。

### B. Runway（公开 UI · 无像素级 CSS）

- 帮助站本波遇 Cloudflare，**无实抓 hex/宽**。
- 公开观感（与 R1 一致）：近黑工作台、安静 chrome、画布权重大；主题入口偏账户菜单而非顶栏双栏几何。
- ToIV：只作风气校验，**不灌尺寸 token**。

### C. Toonflow-web（实读）

| 表面 | 数字 | 证据 |
|---|---|---|
| 工作台左 icon rail | **64px** | `pages/workbench/index.vue` |
| 工作台强调竖条 | **4px** | 同文件 |
| scriptAgent 双栏 | **30% / 70%**；左 `min-size=15`、右 `min-size=30`；左内容 `min-width: 250px` | `views/scriptAgent/index.vue` Splitpanes |
| splitter | 背景透明；`margin-left: 1px` | 同 + `main.scss` `.splitpanes__splitter` |
| production 右 Chat | 默认/最小 **400px**；把手 **4px** | `rightChatBox/index.vue` |

结论：Toonflow 是「左窄轨 + 中主舞台」或「百分比双栏」，**不是**标准资产|画布|Inspector 三栏；可抄 **64 icon-rail**、**1px 分隔**、右对话 **≥400** 作「重聊天」上限参考（ToIV Inspector 默认勿直接 400）。

### D. Toonflow-app（实读）

| 态 | 宽 |
|---|---|
| 首页侧栏默认 | **`--sidebarWidth: 240px`** |
| 折叠 / ≤900px | **`72px`** icon-rail |

可抄：240↔72 双态；断点 900。创作台左资产默认建议略宽于 240（卡片/缩略图），折叠取更密 **56–64**。

### E. CineGen-ShortDrama（实读）

| 区 | 宽 | 角色 |
|---|---|---|
| 全局左 Sidebar | **`w-72` = 288px** 固定；主区 `ml-72` | 阶段导航，非资产库 |
| StageScript 配置列 | **`w-96` = 384px** | 中左「项目配置」 |
| 剧本编辑 | `flex-1` | 中主编辑器 |

模式：**固定左导航 + 中配置 + 中主编辑**，缺独立右 Inspector。可抄 288 作「宽导航」上限参考；ToIV 左资产默认取更低的 280。

### F. AIMovieStudiov2（实读 · 最接近三栏）

| 区 | 默认 | 折叠 |
|---|---|---|
| ScenePanel（左） | **`w-64` = 256px** | **`w-10` = 40px** |
| Inspector（右，project page） | **`w-[420px]`** | **`w-10` = 40px** |
| Previs 右侧 aside | **`w-[240px]`** | — |
| 动效 | `transition-all duration-200` | |

结论：**左清单 256 + 右重 Inspector 420** 是短剧工作室强样本；ToIV 右栏默认压到 **320**（属性密台），最大保留 **420** 兼容生成/音频重面板；折叠 **40 过瘦** → ToIV 用 **56**。

### G. BeefTV（实读 · 右停靠最强）

| 项 | 值 |
|---|---|
| 用户工作区 sidebar 参考 | **240px** |
| Canvas Assistant 右栏 | default **380** / min **320** / max **560** |
| resize 命中 | **9px** |
| 可停靠壳宽 | **≥1050** |

模式：画布为主、右侧可拖助手；左 240 参考壳。ToIV 右 Inspector 默认取 **320**（其 min），最大不必跟到 560（助手聊天态，非属性检视）。

### H. dramaclaw（浅 · 非经典三栏）

- Freezone 是**节点画布**，非左资产|右检视壳。
- 可抄：`node-gutter: 12px` → `--toiv-create-canvas-inset`；sidebar 仅色值 `#111b21`（几何不照搬）。

### I. B 仓只抽模式（浅扫）

| 仓 | 模式 | 跳过 |
|---|---|---|
| **aid-studio** | 创作壳 + `HomeNewSidebar` **64px** icon rail | 不抄业务流 |
| **printfilm** | 文档明确 **NO left sidebar dashboard** | 营销壳 |
| **lumenx** | GlobalSidebar 导航入口 | 无三栏 px |
| **ArcReel** | 可拖 sidebar + Agent panel（changelog） | 本波未钉 px |
| **ai_story** | sidebar collapsed 状态持久化 | 无钉宽 |
| **KomaStudio** | 左/右 sidebar + resize handle | 浅扫未钉 DEFAULT px |
| **BigBanana** | 树空/弱 | 不强猜 |
| **BeefTV / dramaclaw** | 见上（有三栏气味则已记） | — |

---

## ② 照抄与融合方案（对 ToIV `/create`）

### 1:1 照抄

1. **三栏骨架**：左资产 | 中画布 | 右 Inspector（对齐 AIMovie 信息架构，不换栈）。
2. **双态宽**：展开 px + 折叠 icon-rail（Toonflow-app / AIMovie）。
3. **右栏可拖 + clamp**（BeefTV Assistant 的 min/default/max 思路）。
4. **分隔条**：可视 1px + 命中 ≥8px（BeefTV 9 / Toonflow 隐身 splitter）。
5. **壳最小宽 1050** 才保证三栏完整；≤900 收轨（Toonflow-app）。

### 融合（ToIV 身份）

1. 左默认 **280**（资产缩略密台，不是 CineGen 288 导航、也不是纯 240 链接列表）。
2. 右默认 **320**（属性+轻生成；需要重面板再拖到 420）。
3. 折叠 **56**（对称、可点；拒绝 AIMovie 40）。
4. 画布壳 gutter **0**；内容 inset **12**（dramaclaw）——外壳退后、内容优先。
5. 顶栏「普通｜成人」双闸（R2）**独立于**三栏几何；成人模式过滤列表/模型可见性，**不**改 `--toiv-create-*` 宽。

### 明确跳过

- Figma/Runway 未核实 px；printfilm 无侧栏营销壳；Toonflow 右 Chat 默认 400 当 Inspector 默认；整页换栈；后端拦成人。

---

## ③ 落地蓝图（跨端 token 用法）

```text
/create shell
├─ Topbar（含右「普通｜成人」pill · R2）  ← 高度不进本表
└─ Body (flex row, min-width: var(--toiv-create-shell-min-w))
   ├─ LeftAsset     width: default|drag|collapsed
   ├─ SplitterL     hit 8 / visual 1
   ├─ Canvas        flex:1; padding: var(--toiv-create-canvas-inset) /* 内部 */
   ├─ SplitterR     hit 8 / visual 1
   └─ Inspector     width: default|drag|collapsed
```

**CSS 变量挂载点建议**：`:root` 或 `[data-toiv-shell=create]`；成人仅设 `data-toiv-audience=sfw|nsfw`，**选择器不得改 width 变量**。

**Strangler**：先挂变量 + 壳布局；业务面板（资产网格 / Go Canvas / 属性表）逐个迁入，不一次重写。

---

## ④ 双闸与连贯性校验

| 校验项 | 期望 | 结果口径 |
|---|---|---|
| 切「成人」后左/右/中宽 | **像素不变** | 几何 token 与 `data-toiv-audience` 解耦 |
| 切「成人」后折叠态 | **不变** | 禁止顺带 collapse |
| 切「成人」后 splitter | **不变** | 禁止换色成强 glow（分隔条保持 hairline；光幕只在顶栏 pill） |
| 资产/模型列表 | 可按受众过滤 | **内容**变、**栏宽**不变 |
| accent | 创作强调仍 `#5ba0ff`；成人字/glow `#4f8cff` 仅双闸 | 一屏不双彩抢权（R1） |
| 文案 | 「普通｜成人」 | 与 R2 一致；本波不改控件几何 |

**连贯性一句话**：成人模式 = 同一密台骨架上的内容闸，不是第二套布局。

---

## 证据路径（机读）

- Toonflow-web：`src/pages/workbench/index.vue`；`src/views/scriptAgent/index.vue`；`src/views/production/components/rightChatBox/index.vue`；`src/assets/main.scss`
- Toonflow-app：`apps/web/src/pages/home/index.vue`（`--sidebarWidth`）
- CineGen：`components/Sidebar.tsx`（`w-72`）；`components/StageScript.tsx`（`w-96`）；`App.tsx`（`ml-72`）
- AIMovieStudioV2：`components/shots/ScenePanel.tsx`；`app/project/[id]/page.tsx`（`w-[420px]` / `w-10`）；`components/previs/PrevisStage.tsx`（`w-[240px]`）
- BeefTV：`pages/home/home-dashboard.css`（240）；`pages/canvas/use-canvas-assistant.ts`（320/380/560/1050）；`canvas-assistant-sidebar.css`（resize 9px）
- dramaclaw：`DESIGN.md`（`node-gutter: 12px`）
- Figma：Help Center UI3 文章（可调/可折；**无官方默认 px**）

---

## Blocker / 未决

1. **Figma / Runway 官方默认 px 未公开** → 已用竞品实读钉 ToIV 数；若 TL 要「更 Figma」，只能再做人肉截图像素尺（本波不做）。
2. **右栏默认 320 vs 380 vs 420**：本简报钉 **320**（属性密台）；若 `/create` 右栏以对话助手为主，可升默认至 **380**（BeefTV）——需 TL/跨端拍板。
3. **折叠 56 vs 64**：触控优先可选 64；桌面密台保持 56。
4. 未改 JSON 账本、未 commit、未改产品代码。
