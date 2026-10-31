# FULL SHELL TEARDOWN · A0 刀序计划

- **日期**：2026-10-28（Asia/Shanghai）
- **分支**：`work/p0-fusion-20261016` · tip（摸底时）`0a426713`
- **约束**：push/deploy=false；禁 commit；禁 git reset/clean；A–E 脏树只追加
- **DNA**：暗色 Freezone；`/studio/create` 唯一创作台；顶栏右「普通｜成人」光幕 h≈28；accent `#5ba0ff`；glow `#4f8cff`；bg `#0a0c12` / surface `#15161d`；B-class 自写 CSS

---

## 现网反例（硬验收对照 · TL 2026-10-28）

| # | 公网页 | 反例气质 | 登录后禁令 |
|---|---|---|---|
| 1 | `/` 海报落地 | 青粉波形 + 青 pill | **不得**再像海报/营销波形壳 |
| 2 | `/?view=home` 登录门 | 蓝链 vs 青 CTA、大片空 navy | **不得**再像登录门双彩空壳 |
| 3 | `/studio/create` | 密台壳 + 杂色（oversized 青 play、蓝 clip、青「04 生成」）+ **UI 内调试/内部文案**（NSFW lock / 双闸说明 /「主舞台留给…」）+ 项目列表 401 | A0 能清则清；其余挂 **A2** |

验收口诀：登录后主路径 **一眼密台工作台**（DramaClaw/BeefTV 气质），主焦点只有 `#5ba0ff`；青 `#00bdcf` 仅表单/shadcn 表面，不得抢 play / 步骤 chip / 主 CTA。

---

## 摸底结论（只读）

### 双壳现状
1. **`apps/web`（Next 薄壳）**：`page.tsx` 未登录 → `LandingPage`+`landing.css`；登录 → splash handoff → `/studio/`；`?classic=1` / handoff 失败 → 经典回落说明面板（非营销拼盘，已瘦）。
2. **`apps/canvas`（Freezone 产品壳）**：`UserLayout` → `AppWorkspaceShell`（`workspace-sidebar-nav` + `WorkspaceTopBar`+`LightCurtainPaddle` + outlet）。路由 `/`=工作台 home，`/create`=创作台。
3. **根因不是「没壳」**：是 **营销/登录门色板与 desk CTA 仍用青 `#00bdcf` 当主焦点**，且创作台残留 **内部教学文案**，观感像旧项目 + 双彩乱战。Token（`--toiv-*`）已钉，但 desk/rail 消费错通道。

### 侧栏死令（已落地，勿破）
一级：创作 / 短剧项目 / 任务中心 / 工具台 / 设置；新建短剧=台内动作；kpi 进高级。见 `workspace-sidebar-nav.tsx` `buildNav`。

### 光幕落点
顶栏右 `LightCurtainPaddle`（`workspace-top-bar.tsx`）。`content-mode-chip.tsx` 已 deprecated 转导出。Token `--toiv-switch-h` 现 **32**，DNA≈**28** → A0 收。

### CSS 冲突面
| 文件 | 角色 | 登录后风险 |
|---|---|---|
| `apps/web/.../landing.css` | 仅 `LandingPage` import | 低（未登录专用）；A3 再收紧家族可辨 |
| `apps/web/app/globals.css` | 多主题 + splash | 登录后只短 splash；禁泄漏营销到 canvas |
| `toiv-freezone-tokens.css`（web↔canvas 750 行一致） | DNA 硬表 | OK；desk 误用 `--fz-primary`(青) 当 CTA |
| `toiv-freezone-desk.css` | home/列表密台 | **`.fz-btn.is-primary` / phase / chip 走青** → 像反例 2 |
| `creation-studio-three-pane.css` | 创作台 | rail 图标青；pending 青 |
| `workspace-product.css` | 壳 chrome | dark 下已桥 `--toiv-*` |

### 证据
- `docs/ops/VISUAL_DNA_RESET_R1_20261026.md` / `VISUAL_WALKTHROUGH_DIFF_R12_20261026.md`
- `third_party/AI_STUDIO_REFERENCE_REPORT.md`
- `third_party/{dramaclaw,toonflow,reference-repos/glanderness--BeefTV}`

### 脏树（勿踩）
大量 A–E 未提交：`studio-export-menu.tsx`、stage/recipe/take-compare、freezone tokens、light-curtain、creation three-pane 等。**只追加 UI/壳改动，不 revert、不 reset。**

---

## 刀序

### A0 壳骨架（P0）· 本轮
**目标**：消灭「登录后像 1/2」；统一 Freezone App Shell 消费；清创作台顺手可得的调试文案与青抢戏。

| 项 | 动作 |
|---|---|
| 壳 | 确认/收敛 `AppWorkspaceShell` 为登录后唯一 chrome（不新建第二壳）；默认 `/studio/`→canvas `/` 工作台；`?classic=1` 逃生保留但默认隐藏 |
| CTA 色 | desk 主按钮/相位/chip 焦点改走 `--fz-accent`（`#5ba0ff`）；青留给表单/shadcn |
| 光幕 | `--toiv-switch-h` → 28（双端 token 同步） |
| 创作台顺手 | 删「主舞台留给…」脚注；收紧 rail/媒体池/Inspector 的双闸教学文案；rail 图标去青 |
| 营销隔离 | 确认 `landing.css` 仅未登录；不改海报内容（A3） |

**预估文件面**
- `apps/canvas/docs/FULL_SHELL_TEARDOWN_A0_PLAN.md`（本文件）
- `apps/canvas/docs/FULL_SHELL_TEARDOWN_A0_HANDBACK.md`
- `apps/canvas/web/src/styles/toiv-freezone-desk.css`
- `apps/canvas/web/src/styles/toiv-freezone-tokens.css`
- `apps/web/app/styles/toiv-freezone-tokens.css`（同步）
- `apps/canvas/web/src/components/create/creation-studio-asset-rail.tsx`
- `apps/canvas/web/src/components/create/creation-studio-three-pane.css`
- `apps/canvas/web/src/components/create/creation-studio-media-pool.tsx`
- `apps/canvas/web/src/components/create/creation-studio-inspector.tsx`
- （可选截图）`apps/canvas/docs/shots/*`

### A1 信息架构页（P0 · 下一刀）
工作台 home / 短剧 / 资产 / 任务 / 设置：对照 BeefTV director + DramaClaw 仪表盘重做布局与空态（非换皮）。入口：`pages/home/home-dashboard.tsx`、`pages/toiv/drama-page.tsx`、`tasks-page.tsx`、`market-page.tsx`、`pages/settings`。

### A2 创作台完整产品感（P1 · 可并行）
- 清尽调试/内部文案与双彩（若 A0 未尽）
- play 尺寸收敛；timeline zoom 读 CSS var；aceternityMotion→220
- 项目列表 401（鉴权/exchange）— 偏 BE/会话，记阻塞勿在 UI 假数据掩盖
- 入口：`pages/create/creation-workbench.tsx`、`components/create/*`

### A3 未登录营销（P2）
独立 landing 可留；与产品壳家族可辨但不污染登录后 token。入口：`apps/web/components/landing/LandingPage.tsx`、`landing.css`。

---

## 风险 / 阻塞
1. **脏树巨大**：任何 checkout/reset 会毁 A–E；只改上表文件。
2. **项目列表 401**：现网反例 3 的会话问题，A0 不假修 API。
3. **无浏览器登录会话**：截图可能只能静态 fixture / 本地 harness；真机硬刷仍待用户。
4. **`--fz-primary` 别名仍=青**：保留给表单；若别处误当主 CTA，A1/A2 继续扫。
5. **freezone-shell.browser.test** 仍有「创作台浅色语义」用例 — 与 DNA 暗色冲突，A2 校正测试期望，本轮不擅自大改测试以免拖死脏树。
