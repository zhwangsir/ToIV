# Visual System Reset · R1 Handback

日期：2026-10-26（Asia/Shanghai）  
分支：`work/p0-fusion-20261016`  
基 tip：`c452d284`  
合规：A=MIT 可照抄+NOTICE；B=仅美学自写（dramaclaw ELv2 / BeefTV SAL 禁并码）。本轮 **零 B 源码复制**。  
调研校准：已读入 `docs/ops/VISUAL_DNA_RESET_R1_20261026.md`。  
**TL 最终钉**：主 accent `#5ba0ff` · 辅青 `#00bdcf` · Beef `#4f8cff` **仅** `--toiv-glow-director`（光幕/glow 辅通道）。

---

## A. 调研融合点（Toonflow / DramaClaw / BeefTV → ToIV）

| 源 | 闸 | 取 | 舍 |
|----|----|----|----|
| **DramaClaw** Freezone `#0a0c12/#15161d`、蓝 `#5ba0ff`、青 `#00bdcf`、边/字阶 | **B** | 地板色板 + 双强调表面归属美学 | 不抄 index.css/组件；不换栈 |
| **BeefTV** 密台 IA、三层 token 工程、`#4f8cff` glow | **B** | IA/密度；`#4f8cff` **仅**光幕 glow 辅通道 | 不作主 accent；不当地板；不并 SAL 码 |
| **Toonflow-app** `--ui-radius: 8` | **A** | badge 圆角节奏 | 中灰 brand / `#3a3b3b` 地板 **不当 Freezone** |
| **Toonflow-web** 字号阶梯 | **A 节奏 / B 不当色** | 设置页密度可参考 | 灰度 brand 不当 CTA |
| **LumenX 等 A** | **A** | 本轮未并新码 | — |

**融合结论**：进站唯一 Freezone spine = `--toiv-*`；`/create` 唯一台；光幕双闸只动光幕态+列表过滤；Toonflow 中灰不当地板。

---

## B. 1:1 复刻点 vs 融合

| Token / 规格 | 值 | 标注 |
|--------------|-----|------|
| `--toiv-bg` | `#0a0c12` | **B·1:1** DC / DNA |
| `--toiv-surface` | `#15161d` | **B·1:1** |
| `--toiv-surface-raised` | `#1b1c23` | **B·1:1** modal |
| `--toiv-surface-panel` | `#13141b` | **B·1:1** |
| `--toiv-border` / strong | `#22232c` / `#2f3036` | **B·1:1** |
| `--toiv-text` / muted | `#e8eaf0` / `#6f7079` | **B·1:1** |
| `--toiv-accent`（主） | `#5ba0ff` | **TL 钉 · B·1:1** DC 画布蓝 |
| `--toiv-accent-cyan`（辅） | `#00bdcf` | **TL 钉 · B·1:1** shadcn 青 |
| `--toiv-director` / `--toiv-glow-director` | `#4f8cff` / `0 0 24px rgb(79 140 255 / .28)` | **TL 钉 · B 融合** 仅光幕 glow |
| `--toiv-danger` / ok / warn | `#ea4335` / `#51bf6f` / `#efa831` | **B·1:1** DNA |
| `--toiv-nsfw-lock` | `#8b7cff` | **repo 融合**（色+锁；≠ director） |
| `--toiv-radius-badge` | `8px` | **A** Toonflow ui-radius |
| `--toiv-radius-field/node/panel` | `12/14/16` | **B·1:1** DNA DC |
| `--toiv-shadow-inner-glow` | `inset 0 1px 0 rgba(255,255,255,.03)` | **B·1:1** DNA |
| `--toiv-shadow-panel` | `0 14px 34px … + inset` | **B·1:1** DNA |
| `--toiv-glow-accent` | `0 0 24px rgb(91 160 255 / .25)` | **B·1:1** DNA |
| `--toiv-space-1..6` | `4/8/12/16/24`（+8→32） | **A+B** 4px 栅格 |
| 光幕 h/w/fs | `30`（compact `28`）/ `108`（88–120）/ `12` | **repo · TL 锁** |

**非 1:1**：`--toiv-fs-body: 13px`（Freezone 密台融合；DNA body 14 留 `--toiv-fs-body-md`）；Beef 近黑 `#0f0f0f` 不替换 Freezone 地板。

---

## C. 落地蓝图

### 入口（禁第二壳 · 同步文件）

| 端 | 文件 | 接线 |
|----|------|------|
| canvas | `apps/canvas/web/src/styles/toiv-freezone-tokens.css` | `application.tsx` 先于 globals import |
| web | `apps/web/app/styles/toiv-freezone-tokens.css` | `layout.tsx` globals 后 import |
| 约定 | 两端 **字节同步**；改一处必 `cp` | Tailwind `@theme` 映射 `--color-toiv-*` → 同 var |

### 应用数值

| 面 | padding / 圆角 / glow | 落点 |
|----|----------------------|------|
| `.fz-desk-page` | pad `16 20 28`；canvas `--toiv-bg` | `toiv-freezone-desk.css` |
| `.fz-panel` | radius card 12；`shadow-inner-glow` | 同上 |
| `.fz-btn` | h 30 · px 12 · radius badge 8；primary 走 cyan | 同上 |
| `.fz-card` | pad 10 · radius 10 | 同上 |
| `.toiv-freezone-panel` | radius panel 16 · inner-glow | `toiv-local-overrides.css` |
| 侧栏/主台 dark product | 全部 `--toiv-*` | desk CSS |
| Landing `.landing` | CTA cyan · glow 主蓝 | `landing.css` |
| 光幕 | h token 30/28；成人 fill=`nsfw-lock`；director glow **可用未强制铺满** | `content-mode-prototypes.css` |

本轮已换：home/drama/tasks/market/settings desk、侧栏 chrome、landing、光幕尺寸 token。  
未扫完：assets 白钮等深层硬编码（下轮）。

---

## D. 双闸连贯性

| 项 | 规格 |
|----|------|
| 文案 | 「普通 / 成人」+ 盾/锁（色盲双通道） |
| 位 | 侧栏深浅色旁（顶栏右族）；禁舞台正中岛 |
| 尺 | 高 **28–32px**（30 / compact 28） |
| 行为 | 双闸 **只**动光幕态 + 列表过滤；不换路由 / 不换地板 token |
| 守卫 | `redline.ts` + 确认闸；设置仅说明/`?focus=r18`；成人闸不进主路径 |
| NSFW 色 | `--toiv-nsfw-lock`；点亮辅通道可用 `--toiv-glow-director`（≠ 主 accent） |

---

## Token 摘要（名 → 值）

| Token | 值 |
|-------|-----|
| `--toiv-bg` | `#0a0c12` |
| `--toiv-surface` | `#15161d` |
| `--toiv-surface-raised` | `#1b1c23` |
| `--toiv-border` | `#22232c` |
| `--toiv-text` | `#e8eaf0` |
| `--toiv-text-muted` | `#6f7079` |
| `--toiv-accent` | `#5ba0ff` |
| `--toiv-accent-cyan` | `#00bdcf` |
| `--toiv-director` | `#4f8cff` |
| `--toiv-danger` | `#ea4335` |
| `--toiv-nsfw-lock` | `#8b7cff` |
| `--toiv-radius-badge/field/panel` | `8 / 12 / 16` |
| `--toiv-shadow-inner-glow` | `inset 0 1px 0 rgba(255,255,255,0.03)` |
| `--toiv-glow-accent` | `0 0 24px rgb(91 160 255 / 0.25)` |
| `--toiv-glow-director` | `0 0 24px rgb(79 140 255 / 0.28)` |
| `--toiv-space-1..6` | `4 / 8 / 12 / 16 / 24` |
| `--toiv-light-curtain-h` | `30px`（compact `28px`） |

