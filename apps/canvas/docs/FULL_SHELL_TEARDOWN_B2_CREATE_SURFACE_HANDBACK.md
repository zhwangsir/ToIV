# FULL SHELL TEARDOWN · B2 Create Surface Handback（W2-B）

- **日期**：2026-10-28（Asia/Shanghai）
- **分支**：`work/p0-fusion-20261016`
- **tip**：`0a426713`（**未 commit / 未 push / 未 deploy**）
- **截图性质**：**FIXTURE · 非现网硬刷** · 1280×800
- **口径**：BeefTV 密台 + A6 `#4A7FC1` + B1 `250/67/56` + A4.1 空态保留
- **未做**：P1-2 任务中心 token、门面 waveform、线程 Sparkles quieter、DesktopShell、后端、commit

---

## 做了什么

1. **三栏 / 工具条 / Inspector 层次跟 BeefTV 密台**
   - `creation-studio-three-pane.css`：B2 块 — Inspector 分区密度、单主 CTA 权重（`ant-btn-primary` / primary btn = accent）、次级 ghost；舞台 toolbar 条 `40px` 密台节奏
   - 左轨 `is-primary`：**灰阶 inset 边条 + 墨色图标**（不再刷蓝 icon）；accent 留给唯一主 CTA
2. **节点只用 DramaClaw 数字；无第二彩壳**
   - `--toiv-node-*` 几何保留（宽/圆角/端口/边线）
   - 类型色从粉/绿/紫/黄 **收成灰阶梯子**；仅 `skill` / 选中保留 `#4A7FC1`
   - `canvas-node-graph-visual.css`：类型条 `box-shadow` glow → `none`
   - twin 同步：`apps/canvas/web/.../toiv-freezone-tokens.css` ↔ `apps/web/app/.../toiv-freezone-tokens.css`
3. **保留**
   - A4.1 安静空态（W1-B FeaturedWorks/ToivSoftGlow 已删，未回潮）
   - A6 accent / B1 壳密度 250/67/56
   - `--toiv-create-*` 三栏几何（240 / 320 / 选中 420）

---

## Fixture / 截图

| 文件 | 绝对路径 |
|---|---|
| Fixture | `/Users/wangzhenyu/Desktop/ALLProject/ToIV/apps/canvas/docs/shots/fixture-w2b-create-surface.html` |
| PNG 1280 | `/Users/wangzhenyu/Desktop/ALLProject/ToIV/apps/canvas/docs/shots/w2b-create-surface.png` |

**CTA 采样**：`rgb(74, 127, 193)`（`#4A7FC1`）

---

## 改动文件面

- `apps/canvas/web/src/styles/toiv-freezone-tokens.css`
- `apps/web/app/styles/toiv-freezone-tokens.css`
- `apps/canvas/web/src/components/canvas/canvas-node-graph-visual.css`
- `apps/canvas/web/src/components/create/creation-studio-three-pane.css`
- `apps/canvas/web/src/components/create/creation-studio-three-pane.tsx`（注释）
- `apps/canvas/web/src/components/create/creation-studio-inspector.tsx`（注释）
- `apps/canvas/docs/FULL_SHELL_TEARDOWN_B2_CREATE_SURFACE_HANDBACK.md`
- `apps/canvas/docs/shots/fixture-w2b-create-surface.html`
- `apps/canvas/docs/shots/w2b-create-surface.png`

---

## 验收对照

- [x] 三栏表面/工具条/Inspector 层次跟 BeefTV 密台
- [x] 节点卡 DramaClaw 数字 only；类型无第二彩壳
- [x] A4.1 空态 + A6 accent + B1 密度保持
- [x] fixture create @1280
- [x] tip `0a426713`；未 commit

## 残点 / 风险

| 项 | 说明 |
|---|---|
| 现网硬刷 | 仅 FIXTURE；未开登录会话肉眼 |
| `--cn-type-*` 上游若再注入彩色 | token 回退已灰；若全局又定义亮色 `--cn-type-*` 需再扫 |
| 任务中心 `--toiv-job-*` | P1-2 下波 |
| 线程 Sparkles quieter | 明确不做 |
| `creation-product.css` 历史灵感样式 | 空态已不挂 FeaturedWorks；残留 CSS 可后波清 |

**禁 commit / push / deploy。停手等审。**
