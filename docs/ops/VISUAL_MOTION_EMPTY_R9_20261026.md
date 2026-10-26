# ToIV 空态 / 加载骨架 / 微动效 · 第9轮调研简报

- **日期**：2026-10-26（Asia/Shanghai）
- **执行**：模型调研帮手（Motion / Empty / Skeleton R9）
- **状态**：未 commit / 未写业务码 / 未 push
- **承接**：R1 DNA、R2 双闸（成人 glow `#4f8cff` / 24px）、R3–R8；ease 已用 `cubic-bezier(0.22,1,0.36,1)`；进出场 150–220ms；seek/progress 3px
- **已钉死**：accent `#5ba0ff`；成人 `#4f8cff`；文案「普通｜成人」；成人**不改几何**
- **方法**：
  - **A 优先实读**：Linear（tastekit DESIGN.md 2026-07 公开规格）、Toonflow-app `nodeSkeleton.vue`、dramaclaw（`skeleton.tsx` / `skeletons.tsx` / `episode-empty-state` / `task-center/empty-state` / `themed-toaster` / `index.css` 动效 token）、ToIV 现网 `Empty` + `LoadingBlock` + `motion.css`（BeefTV 吸收层）、LumenX `tokens.css` / `design-system.css` glow+duration、Runway（公开空态/加载模式，无源码像素）
  - **B 仓重写**（本轮重扫）：ArcReel（toast 规范+reduced-motion）、aid-studio `CreateFlowSkeleton`、printfilm 浅色 empty/skeleton 卡、CineGen `Loader2 w-6`、BigBanana（无独立暗色 empty/skeleton UI）

---

## ⚡ TL / 跨端立刻可用 · 推荐默认 + 硬尺寸/时长表

### 推荐默认（一句话）

**骨架行高 12 / 圆角 8 / 暗色 shimmer 1.6s（白光泽 10%）；空态三档 stage|section|inline（图标环 48、字 14/12/11）；模块 spinner 24、行内 16；微反馈 hover 150ms / 面板入场 220ms / toast 2200ms；光晕 blur 24 opacity 0.25–0.28（成人色相换 `#4f8cff`）；`prefers-reduced-motion` 压平动画并保留静态灰底；成人闸零几何差。**

### 硬尺寸 / 时长表（跨端可抄）

#### `--toiv-motion-*`

| Token | 值 | 用途 / 来源对齐 |
|---|---|---|
| `--toiv-motion-fast` | **150ms** | hover / 变色 / 双闸（dramaclaw `--duration-fast`；Linear 100–160 取严） |
| `--toiv-motion-base` | **220ms** | 面板入场、控件显隐、R7/R8 进出场（dramaclaw `--duration-base`；钉死 220 而非 ToIV 旧 200） |
| `--toiv-motion-slow` | **320ms** | 布局位移 / drawer / stagger 单段（dramaclaw / ToIV `--duration-slow`） |
| `--toiv-motion-ease` | `cubic-bezier(0.22, 1, 0.36, 1)` | ease-out-quint；与 R1–R8 统一 |
| `--toiv-motion-ease-standard` | `cubic-bezier(0.2, 0, 0, 1)` | 备档（dramaclaw `--ease-standard`） |
| `--toiv-motion-ease-linear-ref` | `cubic-bezier(0.25, 0.46, 0.45, 0.94)` | Linear 公开规格；**产品不切默认**，仅对照 |
| `--toiv-motion-micro` | **100–120ms** | 句柄/极微反馈（Toonflow handle 120；Linear color 100） |
| `--toiv-motion-stagger-step` | **30ms** | 列表入场阶梯（ToIV `stagger-container` / `at-card-in`） |
| `--toiv-motion-stagger-max` | **12–15** | 超限同拍，防长列表拖尾 |
| `--toiv-motion-enter-y` | **8px** | stagger translateY（ToIV）；备档 10（`at-card-in`） |
| `--toiv-motion-toast-ms` | **2200ms** | dramaclaw sonner `duration={2200}`；备档 ArcReel **5000**（产品密台取短） |
| `--toiv-motion-toast-visible` | **1** | dramaclaw `visibleToasts={1}`；ArcReel 最多 3 备档 |
| `--toiv-motion-ripple-ms` | **600ms** | ToIV `ui-ripple-spread`（可保留；成人不加粗） |
| `--toiv-motion-progress-fill` | **420ms** | 对齐 R7 `--toiv-job-progress-dur` |
| `--toiv-motion-view-crossfade` | **200ms** | ToIV view-stage / Linear 量级 |
| `--toiv-motion-loop` | **1.2s** | 不确定进度滑带（ToIV `--duration-loop`） |
| `--toiv-motion-forbid` | **no bounce / elastic** | dramaclaw DESIGN；顶栏禁 spring |

#### `--toiv-skeleton-*`

| Token | 值 | 用途 / 来源对齐 |
|---|---|---|
| `--toiv-skeleton-line-h` | **12px** | ToIV `.ui-loading--line`；dramaclaw 行文 `h-3.5`≈14 备档 |
| `--toiv-skeleton-line-h-title` | **16–24px** | `h-4` / DetailPane `h-6` |
| `--toiv-skeleton-line-last-w` | **62%** | 末行缩短（ToIV） |
| `--toiv-skeleton-radius` | **8px** | `rounded-md` / `--radius-badge`；卡面可升 **12** |
| `--toiv-skeleton-gap` | **8px** | `--space-2`；卡内 gap-2 |
| `--toiv-skeleton-card-ratio` | **16/9** | grid 卡（ToIV）；dramaclaw Episode **16/10** 备档 |
| `--toiv-skeleton-avatar` | **32×32** | SidebarList `size-8`；圆角 4–8 |
| `--toiv-skeleton-dot` | **8×8** | TaskList 状态点 `size-2` |
| `--toiv-skeleton-pill-h` | **20px** | 状态 pill `h-5` |
| `--toiv-skeleton-rows` | **5**（任务）/ **6**（侧栏）/ **8**（网格） | dramaclaw BusyList 默认 |
| `--toiv-skeleton-shimmer-dur` | **1.6s** | ToIV `--duration-pulse` + `.skeleton-shimmer`；Linear 约 1.5s |
| `--toiv-skeleton-shimmer-dur-media` | **2.2s** | dramaclaw keyframe video shimmer（媒体占位偏慢） |
| `--toiv-skeleton-shimmer-angle` | **100deg** | ToIV；dramaclaw 110deg 备档 |
| `--toiv-skeleton-shimmer-hi` | `rgba(255,255,255,0.10)` | **暗色**光泽（ToIV dark）；浅色 0.4 勿用于密台 |
| `--toiv-skeleton-shimmer-size` | **200% 100%** | 扫光背景宽 |
| `--toiv-skeleton-bg` | `var(--bg-surface-2)` / `bg-muted` | 静态底；reduced-motion 只留此底 |
| `--toiv-skeleton-aria` | `role="status" aria-busy` **包一层** | dramaclaw BusyList；禁每块宣布 |

#### `--toiv-empty-*`

| Token | 值 | 用途 / 来源对齐 |
|---|---|---|
| `--toiv-empty-icon-ring` | **48×48** | dramaclaw `size-12` 圆框（Episode / TaskCenter） |
| `--toiv-empty-icon` | **20px**（section）/ **28px**（stage） | ToIV Empty；dramaclaw lucide `size-5`=20 |
| `--toiv-empty-icon-stroke` | **1.5–1.7** | 线稿感 |
| `--toiv-empty-title-fs` | **14px / 600**（section） | dramaclaw `text-sm font-semibold`；stage 展示档另见 |
| `--toiv-empty-title-fs-stage` | **~20–24px** medium italic | ToIV stage display-sm；暗色密台可去斜体改 Inter |
| `--toiv-empty-desc-fs` | **12px** / leading 1.5–1.6 | `text-xs`；max-w **15rem**(240) 面板 / **460px** 舞台 |
| `--toiv-empty-inline-fs` | **11px** | ToIV aux / muted 一行 |
| `--toiv-empty-pad-stage` | **40px 24px** | `--space-10` / `--space-6` |
| `--toiv-empty-pad-section` | **24px 16px** | `--space-6` / `--space-4` |
| `--toiv-empty-pad-inline` | **12px 8px** | |
| `--toiv-empty-gap` | **12px**（stage）/ **8px**（section） | |
| `--toiv-empty-cta-mt` | **8px** | action 槽 |
| `--toiv-empty-illust` | **禁营销大插画** | Linear：小单色线稿 + 一句 + 一 CTA；Runway：prompt 卡+chip 模板（仅云发现） |
| `--toiv-empty-adult-geometry` | **unchanged** | 成人只滤可见条目/文案，不改空态框尺寸 |

#### Spinner / Glow（并入 motion 表消费）

| Token | 值 | 用途 / 来源对齐 |
|---|---|---|
| `--toiv-spinner-sm` | **16px** | 行内 / 按钮前置（ArcReel Loader2 惯例） |
| `--toiv-spinner-md` | **24px** | Toonflow 节点 loading；R7 ResultCard |
| `--toiv-spinner-lg` | **24–32px** | CineGen `w-6`=24；面板中心勿超 32 |
| `--toiv-spinner-period` | **1s** linear | Toonflow `nodeLoading` / ToIV `spin` |
| `--toiv-spinner-hold-min` | **800ms** | 对齐 R7 重试后最短保持 |
| `--toiv-glow-blur` | **24px** | dramaclaw `--ui-glow-accent`；R2 NSFW |
| `--toiv-glow-alpha` | **0.25–0.28** | accent 0.25；成人 0.28；勿超 0.4 |
| `--toiv-glow-accent` | `0 0 24px rgb(91 160 255 / 0.25)` | `#5ba0ff` |
| `--toiv-glow-adult` | `0 0 24px rgb(79 140 255 / 0.28)` | `#4f8cff`；**仅色相/alpha，几何同** |
| `--toiv-glow-ring` | `0 0 0 1px rgb(... / 0.45)` | 选中 ring；焦点环另用 3px soft |

#### reduced-motion

| Token | 值 | 策略 |
|---|---|---|
| `--toiv-motion-reduced` | **on** | CSS：`animation/transition-duration → 0.01ms`；skeleton 去扫光留灰底；spinner 停转；JS：`matchMedia('(prefers-reduced-motion: reduce)')`（dramaclaw `useReducedMotion`） |
| `--toiv-motion-reduced-keep` | opacity 即时切换、进度**宽**仍可跳变 | 禁依赖动画传达唯一状态 |

---

## ① 深度调研与像素级拆解

### Linear（A · 公开规格 · 微动效标尺）

- 时长阶梯 **100 / 160 / 400ms**；签名缓动 `cubic-bezier(.25,.46,.45,.94)`；微交互主档 **160ms**。
- 骨架：行形 1:1 占位，扫光约 **1.5s**，不激进；空态小单色线稿 + 一句 + 一 CTA，禁营销长文。
- 哲学：动效低于「等待感」阈值；内容在静帧内变，不 bounce。**ToIV 不切换缓动默认**，只取「快、短、骨架优先于 spinner」。

### Toonflow-app（A · 节点加载）

- `nodeSkeleton`：loading 区 min-h **84**、图标 **24**、`nodeLoading` **1s** linear；handle 显隐 **120ms** ease-out。
- 全路径有 `prefers-reduced-motion: reduce → animation/transition: none`。
- 空态偏节点内文案，无独立营销 empty 页——创作台空态跟 dramaclaw/ToIV 三档。

### dramaclaw（A · 空态 + 骨架 + toast + glow 主源）

- Skeleton：`animate-pulse rounded-md bg-muted`；组合 BusyList（Episode 8 卡 16/10、Task 5 行、Sidebar 6 行、Detail 标题+方格）。
- Empty：图标环 **48** + icon **20**；标题 **14/600**；描述 **12** max **15rem**；TaskCenter 仅图标+一行 muted。
- Toast：top-center、**2200ms**、同时 **1** 条、圆角 sm、blur 玻璃底。
- Motion token：**150 / 220 / 320** + ease-out-quint；`--ui-glow-accent: 0 0 24px accent/0.25`。
- 媒体占位 shimmer **2.2s** + breathe **2.4s**；进度细轨 **3px**（与 R7/R8 同气质）。
- reduced-motion：全局压平 + hook。

### ToIV 现网 / BeefTV 吸收层（A · 可落地基线）

- `LoadingBlock`：line h**12** / 末行 **62%**；grid **16:9**；shimmer **1.6s**、暗色光泽 **10%**、背景 size **200%**。
- `Empty` 三档 stage/section/inline；stage pad 大、icon **28**；section icon **20**；inline **11px** 一行。
- 动效层已有 stagger 30ms、view crossfade 200ms、ripple 600ms；`--duration-fast/base/slow` 现为 150/200/320——**本轮建议 base 钉 220** 对齐 dramaclaw/R8。

### LumenX（A · glow 配方）

- duration **150 / 250 / 400**；ease 同 `0.22,1,0.36,1`。
- glow：`0 0 0 1px` ring + `0 0 24px -6px` 外光；ToIV 收成 **单层 24px blur**（与 R2 一致），色换 `#5ba0ff` / 成人 `#4f8cff`。
- reduced-motion 同压平策略。

### Runway（浅 · 模式）

- 空态：prompt 卡 + skill/template chips（「What should we build…」）；长生成用进度/预估，短等待可用 skeleton。
- 无开源像素；**不抄**渐变营销洗底进密台默认空态。

---

## ② 照抄与融合方案

| 项 | 1:1 照抄 | 融合 / 改写 | 不抄 |
|---|---|---|---|
| 时长阶梯 | dramaclaw 150/220/320 + ease-out-quint | Linear 100–160 作微档对照 | Linear 400ms 作默认面板入场 |
| 骨架 | ToIV line12 + shimmer1.6s 暗色10% | dramaclaw BusyList 形状库 | 浅色 40% 白光泽、frame-only 空骨架 |
| 空态 | dramaclaw 48 环 + 三档 ToIV | Runway chips 仅「发现/模板」次入口 | 大插画、长营销文、彩色 3D |
| Spinner | Toonflow 24 / 1s | 行内 16；>2s 换骨架或进度 | 全页大转圈替代骨架 |
| Glow | R2 24px / 0.25–0.28 | LumenX 双层收成单层 | blur≥40 顶栏、成人加粗几何 |
| Toast | dramaclaw 2200 / 1 条 | ArcReel 5s×3 仅批量操作备档 | 底部营销 toast 墙 |
| reduced-motion | dramaclaw CSS+hook | skeleton 静态灰底 | 忽略 OS 偏好 |

---

## ③ 落地蓝图（跨端 token 消费）

1. 在 Design Token 层新增 `--toiv-motion-*` / `--toiv-skeleton-*` / `--toiv-empty-*`（上表）；把现网 `--duration-base: 200ms` **升为 220ms** 或映射别名，避免 R8 进出场与空态入场分叉。
2. `LoadingBlock` 继续做唯一骨架入口；列表页用 BusyList 形状（行/侧栏/网格）对齐真实几何，禁「只有转圈」。
3. `Empty` 三档保持；密台 stage 可去掉 Fraunces 斜体，改 Inter 20/500，图标色跟 accent（成人模式图标色可跟 `#4f8cff`，**尺寸不变**）。
4. 光晕只挂在：双闸 NSFW、焦点/选中、primary quiet——与 R2/R5 选中 glow 同 blur 24。
5. Toast 默认 2200ms / top / 1 条；错误可延长但不改几何。
6. 全局 `@media (prefers-reduced-motion: reduce)` + JS hook；进度条宽度跳变仍可用。

---

## ④ 双闸与连贯性校验

| 检查 | 口径 |
|---|---|
| 成人 vs 普通几何 | 空态 pad/图标环/骨架行高/spinner **完全一致**；仅滤内容与可选文字色/glow 色相 |
| 与 R2 | NSFW glow 继续 `0 0 24px #4f8cff/0.28`；空态图标若染色用同一色，不另开 blur |
| 与 R7 | 进度 3px、progress-fill 420ms、dot-pulse 1.6s 与 skeleton-shimmer 1.6s 同族；失败重试 spinner hold 800ms |
| 与 R8 | 进出场 220ms + 同 ease；player seek 3px 气质 |
| 连贯性 | 任何「加载」：<300ms 可无指示；0.3–2s 骨架；>2s 骨架或细进度；>10s 必须进度/可取消（NN/G + Runway 长生成模式） |
| Blocker | 无硬 blocker。待跨端确认：① `--duration-base` 200→220 是否一刀切；② stage 空态是否去斜体；③ Toast 2200 vs 5000 |

---

## B 仓重写摘要（本轮）

| 仓 | 发现 | 对 ToIV |
|---|---|---|
| ArcReel | toast 顶中最多 3 / 5s；Loader2+spin；reduced-motion 块 | 密台取短 toast；spin 尺寸跟 16/24 |
| aid-studio | `CreateFlowSkeleton` 步骤 pill + preview block | 形状对齐真实壳，可作 create 骨架参考 |
| printfilm | 浅色 empty 插画+lime CTA；card `is-skeleton` | **不抄浅色/lime**；只学「空态有 CTA」 |
| CineGen | 全页 `Loader2 w-6` | 仅模块中心 spinner≤24–32，优先骨架 |
| BigBanana | 无独立暗色 empty/skeleton UI | 跳过 |
