# VISUAL Walkthrough Diff R12 · 2026-10-26

> 对照 R1–R11 硬表 vs ToIV 工作树实查（尺寸 / 动效 / 双闸 UX）。  
> **不写业务码 · 未 commit · 未 push**。  
> tip: `6b0a2d15` · 时区 Asia/Shanghai · 走查时刻 `2026-10-26 15:01:27 CST`  
> 证据面：`apps/canvas/web/src/styles/toiv-freezone-tokens.css`（与 `apps/web/…` **558/558 键值一致**）+ create/content-mode/toiv/settings/canvas 组件 CSS/TSX · R1–R10 简报 · canvas/docs/*HANDBACK* · R11 `STRANGLER_CONVERGE_R11_HANDBACK.md`。

## 0. 钉死口径（本轮裁判）

| 钉 | 值 |
|---|---|
| accent | `#5ba0ff` |
| 成人 glow | `#4f8cff` |
| 文案 | 「普通｜成人」 |
| 创作台 | 左 280 / 右常驻 320 / 详情 420 / PiP |
| 任务抽屉 | 736 |
| progress | **真** progress（信任服务端数值） |
| motion base | **220** ms · toast **2200** ms |
| Dialog | 1120 × min(82vh, **760**) cap |
| 引擎 | 独立导航（设置 IA） |
| 成人 | **不改几何** |

## 1. 一页总表（硬表 × 现网）

| 项 | 硬表目标 | 现网实际 | 差距 | 优先级 | 归口 |
|---|---|---|---|---|---|
| DNA accent | `#5ba0ff` | `--toiv-accent: #5ba0ff`（tokens + create/queue/timeline 消费） | OK | — | 跨端 |
| DNA 成人 glow / 字色 | glow `#4f8cff`；成人字色跟光幕 | `--toiv-switch-fg-active-nsfw/#glow-nsfw` = `#4f8cff`；`--toiv-director` 同通道 | OK | — | 跨端 |
| DNA bg/surface/border/text | Freezone 暗色密台 | `#0a0c12` / `#15161d` / `#22232c` / `#e8eaf0` | OK | — | 跨端 |
| DNA 字号/圆角/间距 | fs 10–30；r 8–20；space 4–32 | tokens 已钉且 create/media/settings 引用 | OK | — | 跨端 |
| 双闸文案 | 「普通｜成人」 | `COPY_MODE_NORMAL/ADULT` = 普通/成人；paddle 顶栏右 | OK | — | 跨端 |
| 双闸尺寸 | h28 / minW108 / pill / glow24px | `.cm-light-curtain-rail` → `var(--toiv-switch-*)` | OK | — | 跨端 |
| 双闸 UX（灰化+锁+标签） | 普通态 NSFW 灰化锁标；成人不改几何 | media `is-nsfw-locked` + veil + lock；`*-adult-geometry: unchanged` 多处 | OK（主路径） | — | 跨端 |
| 创作台左栏 | 280（塌 56） | `grid-template` → `--toiv-create-left-default: 280px` | OK | — | 跨端 |
| 创作台右栏 | 常驻 320；详情 420 | `--toiv-create-right-default: 320`；`.is-shot-selected` → 420 | OK | — | 跨端 |
| 分镜卡 16:9 / gap16 / r12 | 同左 | `aspect-ratio` + `gap` + `--toiv-shot-card-radius: 12` | OK | — | 跨端 |
| 分镜双轨 PiP | 草图 2:3 叠 16:9；`pip-w 32%` | CSS `.toiv-storyboard-*-pip` + storyboard-flow 文案；drama 面也有说明 | OK（create 壳） | — | 跨端 |
| 节点圆角/端口/线宽/选中 glow | r12–14；port 8；线 2/2.5；glow≈24 | tokens + `canvas-node-graph-visual.css` 已挂 `application.tsx` | OK（尺寸） | — | 跨端 |
| 节点像素验收 | 无限画布像素门禁 | handback：无浏览器像素门禁 | **未做像素验收** | P2 | 跨端 |
| 媒体网格 | min 220–240 / gap16 / chip28 / batch60 | CSS minmax + `PAGE=60` + IO | OK | — | 跨端 |
| 媒体左栏远端分页 | 全库 canonical 分页可复用 | handback：左栏仍本地 store；`/assets?focus=` 深链可能未消费 | 左栏未接远端分页 / focus 深链弱 | P2 | 跨端 |
| 任务行高 / 进度条 | 92 / 3px `#5ba0ff` | `min-height: var(--toiv-job-row-min-h,92)`；progress fill accent；`progressPct` 只信服务端 | OK | — | 跨端 |
| 任务重试 / 抽屉 | hit32 / 抽屉 736 | retry token 32；drawer `min(var(--toiv-job-drawer-w,736),…)` | OK | — | 跨端 |
| 时间线坞/轨/头/seek | 坞260；视轨56；头2px；seek3px；进出220ms | CSS 全 `var(--toiv-timeline-*)` / `--toiv-player-seek-h` | OK（硬尺寸） | — | 跨端 |
| 时间线 zoom base | `--toiv-timeline-zoom-base-pps: 96` | TSX **硬编码** `const pxPerSec = 96 * zoom`（注释指向 token，未读 CSS） | JS 未读 CSS var | **P1** | 跨端 |
| 时间线能力缺口 | 拖片长 / 字幕轨 / 独立 PlayerChrome / 可拖坞高 | handback 明确未完成 | 功能未齐（非尺寸钉） | P1 | 跨端 |
| 动效 CSS | fast150 / base**220** / slow320；toast2200 | `--toiv-motion-*` + `--toiv-duration-*`；antd `duration: 2.2` | OK（token+antd） | — | 跨端 |
| 动效 JS（aceternity） | 应跟 base 220 | `aceternityMotion` 仍 #99 映射（panel 0.32；注释写≈250ms）；create 壳多用 spring | **JS 动效双轨未收敛** | **P1** | 跨端 |
| 空态/骨架 | empty pad/icon；skeleton r8 / 1.6s | `toiv-empty-*` / `toiv-skeleton-*` 组件+CSS | OK | — | 跨端 |
| 设置 Dialog | 1120 × min(82vh,760) | `settings-visual.css` 用 `--toiv-settings-dialog-*` | OK | — | 跨端 |
| 设置导航行高 / 编辑抽屉 | nav40；抽屉420；引擎独立 | nav-item-h40；edit drawer 420；`local-compute-pane`「引擎」独立段 | OK | — | 跨端 |
| 设置窄轨 icon-nav | `--toiv-settings-nav-w-icon: 56` | token 有；壳仍 Segmented，无独立窄轨布局 | token 未落地布局 | P2 | 跨端 |
| 设置渠道 CRUD 抽屉 | 编辑抽屉覆盖渠道 | handback：渠道 CRUD 仍 Collapse/Modal | 未进 420 抽屉 | P2 | 跨端 |
| canvas↔web token 同步 | 双端一致 | 558 keys / **0 miss / 0 value diff** | OK | — | 跨端 |
| R11 Strangler | 孤面收敛 create；禁 iframe 第二壳 | tip `f0d789a3`；handback：市场/短剧/任务未收敛 | **本轮浅扫/非必须**（无视觉硬表） | P2 | 跨端·路由 |
| 原型旁路（film-rail / phase-ring） | 非主路径 | 源码保留、未挂载 | OK（故意） | — | 跨端 |

### P0 / P1 / P2 计数（未达标）

| 级 | 条数 | 说明 |
|---|---|---|
| **P0** | **0** | 钉死尺寸/双闸/真 progress/成人几何：主路径均已吃到 token |
| **P1** | **3** | ① timeline zoom JS 硬编码 96 ② timeline 能力缺口（拖片/字幕/PlayerChrome/可拖坞）③ aceternity JS 动效未跟 `--toiv-motion-base:220` |
| **P2** | **5** | 节点像素门禁；媒体左栏远端分页/focus；设置 icon-nav56；渠道 CRUD 抽屉；R11 市场/短剧/任务浅扫 |

## 2. 前 8 条最急 diff（给跨端排期）

1. **P1 · timeline zoom** — `creation-studio-preview-timeline.tsx` `96 * zoom` → 读 `--toiv-timeline-zoom-base-pps`（或共享常量单一源）。  
2. **P1 · JS 动效双轨** — `lib/aceternity-motion.ts` / create 壳 spring 与 `--toiv-motion-base:220` / ease-out 对齐（或明确「仅 CSS token 为裁判、JS 降级」）。  
3. **P1 · 时间线能力** — 拖改片长、字幕轨、独立 PlayerChrome、可拖坞高（R8 handback 未完）。  
4. **P2 · 设置窄轨** — `nav-w-icon:56` 落独立 icon-rail，勿只留 token。  
5. **P2 · 渠道 CRUD** — 迁入 `--toiv-settings-drawer-w:420` 编辑抽屉。  
6. **P2 · 媒体左栏** — canonical 分页复用；`/assets?focus=` 消费。  
7. **P2 · 节点像素验收** — 截一帧对照 R5 硬表（无门禁则不算关闭）。  
8. **P2 · R11 浅扫** — 市场/短剧/任务是否再 strangler 进 `/create`：等 TL 下一刀，非本轮视觉硬表。

## 3. Blocker

- **无硬 blocker**：P0=0；双闸/DNA/三栏/分镜/队列/时间线硬尺寸/设置 Dialog 主路径已落地。  
- **软 blocker**：create 面仍混用 aceternity spring → 观感「未完全 Freezone 220ms」；timeline zoom 硬编码 → 改 token 不生效。  
- **范围外**：R11 路由收敛、后端模型上架 —— 不归本走查尺寸表。

## 4. 已达标速记（勿当空白）

DNA 色 · 双闸普通/成人 · 左280/右320/详情420 · PiP CSS · 分镜 16:9 gap16 r12 · 节点 port8 线2/2.5 · 媒体 220–240/chip28/batch60 · 任务 92/3px/retry32/抽屉736/真 progress · 时间线 260/56/2px/seek3px/进出220 · motion CSS 150/220/320 + toast 2.2s · 设置 1120×760cap / 抽屉420 / 引擎独立 · 成人不改几何 · canvas↔web token 全同步。

## 5. R11 注记

`apps/canvas/docs/STRANGLER_CONVERGE_R11_HANDBACK.md`：禁 iframe 第二壳；部分孤面已并 create。市场/短剧/任务未收敛。**本轮浅扫 / 非必须**——无 `--toiv-*` 硬尺寸表可 diff。

## 6. 证据索引

- Tokens: `apps/canvas/web/src/styles/toiv-freezone-tokens.css` ↔ `apps/web/app/styles/toiv-freezone-tokens.css`  
- Switch: `components/content-mode/light-curtain-paddle.tsx` + `content-mode-prototypes.css`  
- Shell/Shot: `creation-studio-three-pane.{tsx,css}` · `creation-studio-storyboard-flow.tsx`  
- Node: `canvas-node-graph-visual.css`（`application.tsx` import）  
- Media: `creation-studio-media-pool.{tsx,css}`  
- Queue: `creation-studio-queue-dock.{tsx,css}`  
- Timeline: `creation-studio-preview-timeline.{tsx,css}`  
- Motion/Empty: `components/toiv/*` · `lib/aceternity-motion.ts` · `layout/app-providers.tsx`  
- Settings: `pages/settings/settings-visual.css` · `settings-model-inventory.tsx` · `local-compute-pane.tsx`  
- Briefs: `docs/ops/VISUAL_*_R{1..10}_20261026.md`  
- Handbacks: `apps/canvas/docs/*HANDBACK*.md`

— 模型调研 · R12 走查 · `2026-10-26 15:01:27 CST`
