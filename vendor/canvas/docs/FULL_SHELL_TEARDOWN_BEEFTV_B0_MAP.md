# FULL SHELL TEARDOWN · B0 BeefTV Primary Map（对照表）

- **日期**：2026-10-28（Asia/Shanghai）
- **范围**：仅 B0 只读对照；**未改产品代码**；禁 commit / push / deploy
- **ToIV tip**：`0a426713`（`work/p0-fusion-20261016`，脏工作树叠 A0–A6+A4.1）
- **配色锁（本波不回退）**：黑白壳 + accent `#4A7FC1`（A6）；禁玫红主 CTA；禁 cyan 霓虹抢戏
- **口径**：登录后全站壳 **只跟 BeefTV 一套**；DramaClaw 仅节点几何数字；Toonflow **禁止**进默认壳 / 登录后 chrome；未登录门面本波不动

---

## 源路径（本机 + 远程）

| 角色 | 路径 | 备注 |
|---|---|---|
| **主体远程** | `https://github.com/glanderness/BeefTV` @ `main` tip **`6a155448096d`** | 公仓；本刀只读 |
| **本机可全文读** | `/Users/wangzhenyu/beeftv_p1_xfer/toiv-m6a/`（`web/src/...` 同构） | 旧快照；结构与文件名对齐 BeefTV，侧栏文案略旧（无「技能」） |
| **本机 third_party 对照树** | `/Users/wangzhenyu/Desktop/ALLProject/ToIV/third_party/reference-repos/glanderness--BeefTV/` VERSION `v2.0.4` | README 称 BeefTV 已并入 `apps/canvas`；此树供对照 |
| **ToIV 落点** | `/Users/wangzhenyu/Desktop/ALLProject/ToIV/apps/canvas/web/` | 壳组件名与 BeefTV 同源（`user-layout` / `AppWorkspaceShell` / `workspace-*` / `canvas-*`） |

> 说明：MateBook 无独立名为 `BeefTV` 的干净 clone；**以 GitHub `glanderness/BeefTV` 为口径主体**，本地用 `toiv-m6a` + `third_party/.../glanderness--BeefTV` 实读 globals / layout / dock。

---

## 1. Token 三层（primitive → semantic → component）

| BeefTV 概念 | BeefTV 落点（证据） | ToIV 现落点 | 缺口 / B1·B2 建议 |
|---|---|---|---|
| **Primitive 中性色板** | `web/src/styles/globals.css` `:root` `--color-neutral-0…950`（oklch） | 同文件仍在 `apps/canvas/web/src/styles/globals.css`；产品壳色另由 `--toiv-*` 主导 | B1：继续以 `--toiv-*` 为登录后壳唯一色源；globals 中性板可留作 Ant/shadcn 底层，**勿再平行发明第三套** |
| **Semantic 表面层级（暗）** | `.dark`：`--background:#0f0f0f` · `--card/#181818` · `--workspace-surface:#181818` · `--workspace-surface-strong:#2a2a2a` · `--workspace-border:#222` · `--muted-foreground:#a8a8a8` · 文字体 `#a8a8a8/#888/#666` | Freezone A6：`--toiv-bg:#0b0c0f` · `--toiv-surface:#14151a` · `--toiv-surface-raised:#1a1b21` · text `#f4f6f7` · muted `#8b8e98`；`toiv-freezone-desk.css` 把 product workspace 的 `--workspace-*` **桥到** `--toiv-*` | **近黑密台气质已对齐方向**（ToIV 略更深）。B1：清掉 desk/product 里仍写死的旧 `#0f0f0f/#181818` 双轨，统一走 `--toiv-bg/surface` |
| **Semantic「壳强调色」** | BeefTV **chrome accent = 近白灰** `--workspace-accent:#f5f5f5`（导航选中），**不是**彩 CTA | ToIV `--toiv-accent:#4A7FC1` 锁为 **交互 CTA/选中边条/playhead/focus**（≤10%） | **不要**把 BeefTV 的灰 accent 与 ToIV 蓝 CTA 混成双彩。B1：nav active / pill 用灰阶 surface-hover；**仅**按钮·焦点·playhead 用 `#4A7FC1` |
| **Component 壳尺寸** | `:root` `--workspace-sidebar-width:250px` · collapsed `67px` · gutter `6px` · card-gap `4px`；`.app-user-workspace` 另有 `312/86` + `--workspace-topbar-height:56px` 覆盖；画布 `--canvas-topbar-h:48px`（spatial 可 64）· inset `16px` · dock-popover `50px` | Freezone：`--toiv-shell-sidebar:216px` · collapsed `56px` · topbar `56px` · control `32px` · nav-row `36px`；`workspace-product.css` 引用这些 | **密度偏瘦于 BeefTV 基准 250/67**。B1：登录后壳尺寸向 BeefTV 密台靠（建议 sidebar **250** / collapsed **64–67** / topbar **48–56** 取一档钉死），去掉 product 层残留的夸张 89px topbar 历史值 |
| **Status / danger** | BeefTV：`--destructive:#ff4d4d` · success `#33d17a` · warn `#fbbf24` · loading `#60a5fa` | A6：danger `#B85C5C` · ok `#3D8B6E` · warn `#C4A35A`；info/锁 `#6B7280` | **保持 A6**（用户口令）。B1 不搬 BeefTV 霓虹绿/亮红做壳 |
| **残彩风险** | BeefTV 自身有 `--cn-spatial-glow: rgba(125,162,255,…)`（空间工作台） | ToIV `globals.css` **仍残留**同系蓝 glow + `--shadow-glow-*` | B1：**登录后 chrome 禁用**该 glow；画布 spatial 若保留须压到不可见或改灰，避免与 `#4A7FC1` 双蓝抢戏 |
| **注释污染** | — | `toiv-freezone-tokens.css` 头注释仍写「DNA dramaclaw」「Toonflow badge」 | B1：注释改钉 **BeefTV primary + A6 色**；DramaClaw 仅标在 `--toiv-create-*` / 节点几何 |

---

## 2. 色阶 / 表面层级（一眼密台）

| 层级 | BeefTV（暗） | ToIV A6（暗） | 映射动作 |
|---|---|---|---|
| Canvas / page | `#0f0f0f` | `#0b0c0f` (`--toiv-bg`) | 保留 ToIV（更深密台 OK） |
| Elevated card | `#181818` / surface `#1f1f1f` | `#14151a` / raised `#1a1b21` | 保留 ToIV；B1 确保侧栏=bg、内容卡=surface，**勿** DramaClaw 第二套表面 |
| Border | `#222` / strong `#333` | `rgba(255,255,255,.10/.14)` | 保留 ToIV 软边；B1 禁彩边 |
| Ink | `#fff` / body `#a8a8a8` | `#f4f6f7` / muted `#8b8e98` | 对齐 |
| Interactive | 灰 nav accent | `#4A7FC1` CTA only | **分工钉死**（见上） |
| Light | BeefTV 浅灰白台 | A6 `#f7f7f5` / elev `#fff` / border `#e4e4e2` | 已定稿；B1 勿回 DramaClaw 灰 brand |

---

## 3. 侧栏序与密度

### BeefTV 一级导航（GitHub `workspace-sidebar-nav.tsx` @ tip `6a155448`）

1. **新建项目** → `/canvas?mode=new`
2. **首页** → `/`
3. **项目** → `/project`
4. **资产** → `/assets`
5. **技能** → `/skills`
6. **模型配置** → `/settings?section=channels`
7. （桌面）**存储设置**
8. **BeefTV MCP** → `/agents`

密度：展开宽 **250px**（user-workspace 可 312）；折叠 **67px（或 86）**；行高 `min-h-11` + pill `layoutId=workspace-nav-active-pill`；footer = 更新 + 主题切换（账号进用户卡）。

### ToIV 现导航（产品死令保留）

**一级：** 创作 · 短剧项目 · 任务中心 · 工具台 · 设置  
**高级/更多：** 首页 · 画布库 · 新建画布 · 媒体库 · 外部 Agent · 学习看板  

壳组件：同名 `WorkspaceSidebarNav` + `AppWorkspaceShell`；宽 **216 / 56**（freezone）。

| 项 | 缺口 | B1 建议 |
|---|---|---|
| IA 路由 | ToIV 产品序 ≠ BeefTV 产品序 | **保留 ToIV 一级五项**（用户产品死令）；只对齐 **密度/行高/折叠轨/选中 pill 节奏** |
| 宽度 | 216 vs 250 | 向 BeefTV 加宽到 **250**（或 240–250 一档），collapsed **64–67** |
| 装饰 | 无 | 禁 Toonflow/DramaClaw 第二套侧栏表面；品牌字标可留 ToIV |
| 选中态 | 已有 motion pill | 选中底用灰阶；**不要**整行铺 `#4A7FC1` |

---

## 4. 顶栏工具带

| BeefTV | ToIV 现况 | B1 建议 |
|---|---|---|
| `WorkspaceTopBar`：移动侧栏钮 · 面包屑（非 home）· `WorkspaceTopBarExtensionSlot` · 右「模型配置」链到 channels | 同结构；home 有 `is-home`；光幕 chip 可进 extension；模型配置链到 **`/settings?section=models`** | 结构保留；**高度钉 48–56**（禁历史 89px 回潮）；utility 高度跟 `--toiv-shell-control`；图标色用 muted，hover 才可轻微 accent |
| 画布顶栏 `--canvas-topbar-h:48px` · offset `56px` | spatial 等仍部分用 globals | B2/画布：跟 BeefTV inset/topbar 节奏，勿另起 Toonflow 顶栏 |

---

## 5. Assistant dock 宽与 resize

| 常量 | BeefTV | ToIV | 状态 |
|---|---|---|---|
| `ASSISTANT_DEFAULT_WIDTH` | **380** | **380** | ✅ 已对齐 |
| `ASSISTANT_MIN_WIDTH` | **320** | **320** | ✅ |
| `ASSISTANT_MAX_WIDTH` | **560** | **560** | ✅ |
| Resize handle | `.canvas-assistant-resize` 宽 9px · `col-resize` · 左侧 -4px | 同 | ✅ |
| 面板语义 | `--background/--border/--muted` | 同 + freezone 桥 | ✅ 结构同源 |
| **呈现模式** | BeefTV 默认 **右侧 dock** | ToIV 另有 **dock ↔ float** 开关，文案写「悬浮（**Toonflow**）」 | **B1 缺口**：默认壳禁 Toonflow 浮层；登录后 chrome **只保留 dock**（float 可藏进高级/实验室，不得当默认） |

---

## 6. 工具条节奏（canvas-toolbar / refresh-shell）

| BeefTV | ToIV | B1·B2 |
|---|---|---|
| `CanvasToolbar`：底中 floating dock · `canvas-inset-x/y` · popover offset `50px` · LibTV compat / Director orb 入口 | 同文件树仍在；create 三栏另有 studio chrome | **B1（登录后非画布页）**：页面 chrome 跟 BeefTV workspace，不搬工具条到 home |
| `canvas-refresh-shell`：骨架底栏 h-14 · 圆角 xl · border+blur | 同 | 保持；禁彩 blur glow |
| Director workspace tokens | `--director-sequencer-*` / `--director-dock-*`（近黑抬面） | ToIV director 组件在；表面应吃 `--toiv-surface` | B1：director 壳色跟 freezone，不跟 DramaClaw 彩 |

---

## 7. Create / 节点几何（B2 预告 · 本刀不动）

| 项 | 口径 | ToIV 现落点 |
|---|---|---|
| 三栏几何 | **可保留**现有 `--toiv-create-*`（left 240 / right 320 / splitter 等） | `toiv-freezone-tokens.css` 已钉 |
| 表面/边线/工具条/空态 | **跟 BeefTV 工作台**（近黑密台 + A6 蓝交互） | A4.1 已安静空态；B2 再扫 create 外壳残留 |
| 节点卡 | **仅 DramaClaw 数字**（宽/圆角/端口）；不搬其壳色 | `--toiv-radius-node:14px` 等；注释仍写 DNA dramaclaw → B2 改注释+确认无彩壳 |

---

## 8. 组件映射总表（BeefTV → ToIV）

| BeefTV | ToIV 路径 | 状态 | B1/B2 |
|---|---|---|---|
| `layouts/user-layout.tsx` | `apps/canvas/web/src/layouts/user-layout.tsx` | ✅ 同源；ToIV 多 import `toiv-freezone-desk.css` | 保留 desk 桥；禁再挂 Toonflow 全局 |
| `AppWorkspaceShell`（`app-top-nav.tsx`） | 同名 | ✅ | B1：折叠宽与 creation 特例复核 |
| `workspace-sidebar-nav.tsx` | 同名 | ⚠️ IA 已产品化 | 密度对齐；序保留 ToIV |
| `workspace-top-bar.tsx` (+ extension) | 同名 | ⚠️ 高度/utility | 钉密台高度 |
| `workspace-sidebar-account*` | 同名 | ✅ | — |
| `globals.css` dark + workspace | 同 + freezone 覆盖 | ⚠️ 双轨+glow 残 | 单一色源；清 spatial 彩 glow |
| `workspace-product.css` | 同 | ⚠️ 多历史密度层 | B1 收敛到 freezone shell token |
| `canvas-refresh-shell.tsx` | 同 | ✅ | — |
| `canvas-toolbar.tsx` | 同 | ✅ 节奏同源 | 禁第二套装饰 |
| `canvas-assistant-sidebar(+css)` / `use-canvas-assistant` | 同 | ⚠️ Toonflow float | **默认只 dock** |
| Director workbench | `components/canvas/director/*` | ✅ | 表面跟 BeefTV/A6 |
| DramaClaw | `third_party/dramaclaw` + create 几何 | ⚠️ 曾作壳色源 | **仅几何** |
| Toonflow | `third_party/toonflow` + assistant float + NOTICE | ⚠️ 仍进 chrome | **踢出默认登录后壳** |

---

## 9. 主缺口 / 风险（给 TL）

1. **多仓拼壳未停干净**：壳骨架已是 BeefTV，但 freezone 注释/Toonflow float/DramaClaw DNA 文案 + globals 蓝 glow 仍造成「第二套气质」。
2. **密度数字分叉**：ToIV shell 216/56 vs BeefTV 250/67（及 user-workspace 312/86 历史层）——B1 必须 **钉一档**，删掉死 CSS 回潮（89px topbar）。
3. **Accent 语义冲突**：BeefTV chrome accent=灰；ToIV 产品 accent=蓝 —— 映射时 **分层**，禁止整侧栏/顶栏刷蓝。
4. **IA 不可照搬**：BeefTV「项目/资产/技能」≠ ToIV「创作/短剧/任务/工具/设置」；B1 只对齐壳，不改产品一级路由（除非用户另令）。
5. **本地无独立 BeefTV git clone**：对照依赖 GitHub tip `6a155448` + third_party 树 + `toiv-m6a`；若需逐行 diff 最新 BeefTV，建议后续浅克隆只读（仍禁改 ToIV tip）。
6. **未登录门面 / 后端 NSFW**：本波明确不动。

---

## 10. B1 / B2 建议动作（摘要 · 等 TL 开刀）

**B1（登录后壳对齐 BeefTV · 建议下一刀）**

1. Shell 尺寸：`--toiv-shell-sidebar/collapsed/topbar` → BeefTV 密台档；清 `workspace-product` 冲突层。  
2. 表面：product workspace 只吃 `--toiv-*`；清 DramaClaw/Toonflow 第二表面。  
3. 侧栏/顶栏节奏：行高、pill、折叠轨、utility 密度对齐；nav 序保持 ToIV 一级。  
4. Assistant：**默认 dock only**；去掉或降级 Toonflow float 入口文案。  
5. 残彩：globals `cn-spatial-glow` / shadow-glow 在登录后 chrome 关闭；accent 仅 CTA。  
6. 注释与 absorption 口径：主体钉 BeefTV。

**B2（create）**

1. 三栏 `--toiv-create-*` 几何保留。  
2. 表面/工具条/空态跟 B1 密台。  
3. 节点卡只保留 DramaClaw 数字，不搬壳色。

---

## 交付自检

- [x] 对照表路径：`apps/canvas/docs/FULL_SHELL_TEARDOWN_BEEFTV_B0_MAP.md`
- [x] 覆盖：色阶/表面、侧栏序与密度、顶栏、assistant 宽与 resize、工具条节奏、token 三层
- [x] **未改**产品代码；未 commit / push / deploy / reset / clean
- [x] tip 仍 **`0a426713`**

