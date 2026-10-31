# FULL SHELL TEARDOWN · A5 Palette Handback（影视飓风公式换肤）

- **日期**：2026-10-28（Asia/Shanghai）
- **分支**：`work/p0-fusion-20261016`
- **状态**：**仅工作树**（未 commit / 未 push / 未 deploy）
- **截图性质**：**FIXTURE · 非现网硬刷**
- **结构**：A3v2/A4 去 AI 结构保留；本刀只换色 + 残蓝清扫

---

## Token 对照（旧 → 新）

| Token / 角色 | 旧 | 新（A5） |
|---|---|---|
| `--toiv-bg` | `#0a0c12` | `#0b0c0f` |
| `--toiv-surface` / 抬升 | `#15161d` | `#14151a` |
| `--toiv-surface-raised` | `#1b1c23` | `#1a1b21` |
| `--toiv-surface-panel` | `#13141b` | `#101116` |
| `--toiv-text` | `#e8eaf0` | `#f4f6f7` |
| `--toiv-text-muted` | `#9298a6` | `#8b8e98` |
| `--toiv-border` | `#22232c` | `rgba(255,255,255,0.10)`（白≈10%） |
| `--toiv-border-strong` | `#2f3036` | `rgba(255,255,255,0.14)` |
| `--toiv-accent` | `#5ba0ff` | **`#E11D48`** |
| `--toiv-accent-hover` | `#7ab4ff` | `#FB7185` |
| `--toiv-accent-soft` | `rgba(91,160,255,.16)` | `rgba(225,29,72,.14)` |
| `--toiv-primary` | `var(--toiv-accent-cyan)` 青 | **`var(--toiv-accent)`**（禁双彩） |
| `--toiv-accent-cyan*` | `#00bdcf` 族 | **别名红 accent**（退役青主焦点） |
| `--toiv-text-on-accent` | `#111b21` | `#f4f6f7` |
| `--toiv-director` / 光幕辅 | `#4f8cff` | `#9f1239` 暗红 |
| `--toiv-switch-*-nsfw` glow | 蓝 bloom | **`none`**（仅暗红描边） |
| `--toiv-glow-accent` / primary | 蓝/青 24px bloom | **`none`**（禁红渐变 glow） |
| `--toiv-timeline-playhead` | `#5ba0ff` | `#E11D48` |
| `--toiv-node-selected-glow` | 蓝 bloom | `none`（保留 ring） |
| landing / site CTA | `#5ba0ff` | `#E11D48` |

Accent **仅** CTA / 选中条 / playhead / focus（约 10%）；禁红大面积底。

---

## 做了什么

1. 双端 `toiv-freezone-tokens.css` 同步换肤（canvas ↔ web 同文）
2. landing + `public/site` 统一红 accent / 炭灰底（结构仍 A3v2）
3. 消费链残蓝清扫：desk / create CSS、`canvas-theme.ts`、光幕 paddle/prototypes、settings 视觉、empty-loading、waveform 资产等
4. 成人光幕：蓝辅色 → **暗红描边**，glow fallback 去掉
5. Fixture：home + create，play/CTA/playhead = `rgb(225,29,72)`，shadow `none`

---

## 改动文件（主面）

- `apps/canvas/web/src/styles/toiv-freezone-tokens.css`
- `apps/web/app/styles/toiv-freezone-tokens.css`
- `apps/web/app/styles/landing.css`
- `apps/web/components/landing/LandingPage.tsx`
- `apps/web/public/site/styles.css` · `index.html` · `assets/waveform.svg`
- `apps/canvas/web/src/lib/canvas-theme.ts`
- `apps/canvas/web/src/styles/toiv-freezone-desk.css` · `toiv-local-overrides.css` · `globals.css` 等
- `apps/canvas/web/src/components/create/*.css` · `content-mode/*` · `pages/create/creation-product.css`
- `apps/canvas/docs/FULL_SHELL_TEARDOWN_A5_PALETTE_HANDBACK.md`
- `apps/canvas/docs/shots/a5-home.png` · `a5-create.png` · `fixture-a5-*.html`

## 截图绝对路径（FIXTURE · 非现网硬刷 · 1280）

- `/Users/wangzhenyu/Desktop/ALLProject/ToIV/apps/canvas/docs/shots/a5-home.png`
- `/Users/wangzhenyu/Desktop/ALLProject/ToIV/apps/canvas/docs/shots/a5-create.png`

验收采样：play/CTA/playhead = `rgb(225, 29, 72)`（`#E11D48`）；无蓝 CTA。

---

## 未做

| 项 | 说明 |
|---|---|
| 现网硬刷 | 无本地登录会话 |
| 第三方/引擎示意图本身的蓝霓虹图 | 内容资产，非 chrome token |
| NSFW 锁紫 `#8b7cff` | 锁标通道保留（非 CTA）；若需一并去双彩可另刀 |
| danger `#ea4335` 与 accent 近邻 | 错误态仍用 danger；视觉近红但语义分离 |
| commit / push / deploy | 禁 |

## 阻塞
- 无会话 → 无法现网肉眼验收整壳
- 部分历史 fixture（a0–a4）仍含旧蓝示意，未批量重渲（本刀只交 a5-*）

---

## 自检：残蓝 / 双彩还剩哪（诚实）

1. **Token 注释**仍提及旧色为「retired」字样（非运行色）  
2. **NSFW 锁紫**仍在 — 与红 accent 同屏时略有第二彩，但非 CTA  
3. **danger 红** vs **accent 玫红** — 近邻色相，极端 squint 可能糊成「一片红」  
4. **历史 a0–a4 截图**未更新，文档对照时勿当现色  
5. **外部封面图**（cyberpunk-neon 等）内容仍可带蓝光 — 非 chrome  
6. 若某处仍 `var(--toiv-accent-cyan)` 字面，值已指向红；旧名遗留易误导后续编辑  

**结论：主路径 CTA/选中/playhead/focus 已是 `#E11D48`；青/创作蓝主焦点已退役。残双彩主要在锁紫通道与内容图，非壳 CTA。**
