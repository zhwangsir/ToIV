# FULL SHELL TEARDOWN · A6 B&W + Blue Handback（黑白壳 + 蓝交互）

- **日期**：2026-10-28（Asia/Shanghai）
- **分支**：`work/p0-fusion-20261016`
- **tip**：`0a426713`（未 commit）
- **状态**：**仅工作树**（未 commit / 未 push / 未 deploy）
- **截图性质**：**FIXTURE · 非现网硬刷**
- **结构**：A3v2/A4 quieter+distill / 门厅结构保留；本刀只换色（覆盖 A5 玫红 accent）

---

## Token 对照（A5 → A6）

| Token / 角色 | A5 | A6（定稿） |
|---|---|---|
| `--toiv-bg`（暗） | `#0b0c0f` | `#0b0c0f`（不变） |
| `--toiv-surface` / elev 暗 | `#14151a` | `#14151a`（不变） |
| `--toiv-text` / muted 暗 | `#f4f6f7` / `#8b8e98` | 同左 |
| `--toiv-bg`（亮） | `#f4f4f5` | **`#f7f7f5`** |
| `--toiv-surface` elev 亮 | `#ffffff` | **`#ffffff`** |
| `--toiv-text` / muted 亮 | `#1d1d21` / `#65656c` | **`#121214` / `#6b6e76`** |
| `--toiv-border` 亮 | rgba | **`#e4e4e2`** |
| `--toiv-accent` | `#E11D48` | **`#4A7FC1`** |
| `--toiv-accent-hover` | `#FB7185` | `#6B96D0` |
| `--toiv-accent-rgb` | `225 29 72` | `74 127 193` |
| `--toiv-primary` | alias accent | alias accent（不变语义） |
| `--toiv-ok` / success | `#51bf6f` | **`#3D8B6E`** |
| `--toiv-warn` | `#efa831` | **`#C4A35A`** |
| `--toiv-danger` | `#ea4335` | **`#B85C5C`**（仅破坏，非主 CTA） |
| `--toiv-nsfw-lock` | `#8b7cff` 紫 | **`#6B7280` 灰锁** |
| `--toiv-director` / 成人光幕 | `#9f1239` 暗红 | **`#6B7280`**（默认不染红） |
| `--toiv-timeline-playhead` | `#E11D48` | **`#4A7FC1`** |
| `#E11D48` | 主 CTA | **退出**主按钮/选中/playhead；可选极淡品牌描边 |

Accent **仅** CTA / 选中边条 / playhead / focus（≤10%）；不铺内容/背景。

---

## 做了什么

1. 双端 `toiv-freezone-tokens.css` 同步 A6（canvas ↔ web 同文）
2. 亮台壳色对齐方案板（`#f7f7f5` / `#ffffff` / `#121214` / `#6b6e76` / `#e4e4e2`）
3. landing + `public/site` + waveform 主焦点 → `#4A7FC1`
4. `canvas-theme.ts` 选中/playhead/accent → 蓝；暗底对齐 `#0b0c0f`
5. 消费链硬编码清扫：desk / create CSS / content-mode / settings / empty-loading / node-graph 等
6. NSFW 锁紫 `#8b7cff` → 灰锁 `#6B7280`；成人光幕默认不染红
7. content-mode 去掉蓝 bloom glow（描边 only）
8. Fixture home+create（1280）采样 CTA/playhead = `rgb(74,127,193)`

---

## 改动文件（主面）

- `apps/canvas/web/src/styles/toiv-freezone-tokens.css`
- `apps/web/app/styles/toiv-freezone-tokens.css`
- `apps/web/app/styles/landing.css`
- `apps/web/components/landing/LandingPage.tsx`
- `apps/web/public/site/styles.css` · `assets/waveform.svg`
- `apps/canvas/web/src/lib/canvas-theme.ts`
- `apps/canvas/web/src/styles/toiv-freezone-desk.css` · `toiv-local-overrides.css` · `globals.css` · `assets-*.css`
- `apps/canvas/web/src/components/create/*.css` · `content-mode/*` · `canvas/canvas-node-graph-visual.css`
- `apps/canvas/web/src/pages/settings/*` · `components/toiv/toiv-empty-loading.css`
- `apps/canvas/web/test/node-graph-visual.browser.test.ts`（accent 期望 → `#4A7FC1`）
- `apps/canvas/docs/FULL_SHELL_TEARDOWN_A6_BW_BLUE_HANDBACK.md`
- `apps/canvas/docs/shots/a6-home.png` · `a6-create.png` · `fixture-a6-*.html`

## 截图绝对路径（FIXTURE · 非现网硬刷 · 1280）

- `/Users/wangzhenyu/Desktop/ALLProject/ToIV/apps/canvas/docs/shots/a6-home.png`
- `/Users/wangzhenyu/Desktop/ALLProject/ToIV/apps/canvas/docs/shots/a6-create.png`

验收采样：play/CTA/playhead = `rgb(74, 127, 193)`（`#4A7FC1`）；无玫红主 CTA；锁为灰。

---

## 未做 / 挂账

| 项 | 说明 |
|---|---|
| 现网硬刷 | 无本地登录会话；等用户硬刷验收 |
| commit / push / deploy | **禁** |
| 灵感墙 / Sparkles / node-glow 余量 | 若仍见旧彩可挂账另刀（本刀主路径已清） |
| 历史 a0–a5 截图 | 仍含旧蓝/旧红示意，勿当现色 |
| 外部封面图彩光 | 内容资产，非 chrome token |
| `#E11D48` 品牌极淡描边 | 默认可不染；未强制启用 |

## 阻塞
- 无会话 → 无法现网肉眼验收整壳

---

## 自检残点（诚实）

1. Token 注释仍列 retired `#E11D48` / `#8b7cff` / `#00bdcf`（非运行色）
2. 历史 a0–a5 fixture 截图未批量重渲
3. 灵感墙 / Sparkles / 内容封面若带彩光 — 非 chrome，可挂账
4. `--toiv-accent-cyan*` 名仍在，值已指向蓝 accent（旧名易误导）
5. danger `#B85C5C` 与可选品牌红近邻已拉开（A5 玫红近邻问题已消）
6. **锁紫运行色已清** → `#6B7280`

**结论：主路径 CTA/选中/playhead/focus = `#4A7FC1`；A5 玫红主焦点已覆盖；NSFW 锁紫已灰化；禁 commit。**

---

## 禁声明

**禁 commit / push / deploy。** tip 必须仍为 `0a426713`。仅本地工作树。
