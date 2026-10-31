# FULL SHELL TEARDOWN · A3 Handback

- **日期**：2026-10-28（Asia/Shanghai）
- **分支**：`work/p0-fusion-20261016`
- **状态**：**仅工作树**（未 commit / 未 push / 未 deploy）
- **截图性质**：**FIXTURE · 非现网硬刷**
- **对照**：现网反例 1 `/` 青粉海报波形+青 pill；反例 2 `/?view=home` 蓝链 vs 青 CTA、大片空 navy

---

## 做了什么

### 1) 登录门 `LandingPage` / `landing.css`（仅未登录）
- CTA / logo-dot / eyebrow / caret / focus / glow：**统一 accent `#5ba0ff`**（`rgb(91,160,255)`）
- 去掉 marketing 青通道作主焦点；注释钉「不与青 pill 双彩」
- 全部色值仍在 **`.landing` 作用域**；`landing.css` **仅**被 `LandingPage.tsx` import（零泄漏到 studio/canvas 产品壳）
- 不改登录后 `--toiv-*` / Freezone desk / create 文件

### 2) 官网 `public/site`（bare `/`）
- `styles.css`：`--primary` 别名 accent `#5ba0ff`（hover `#7ab4ff` / active `#4a8eef`）；`--glow-primary` 改单色蓝晕
- 背景径向：去掉青第二晕；stage rays 收敛为单色 soft blue
- logo-mark：由青→蓝渐变改为 **纯 accent 实色**
- composer / track / icon stroke：与 accent 同族，无粉青双彩

### 3) 波形 SVG（反例 1 核心）
- `waveform.svg` 渐变：`#f2a08f → #e2448f → #3db4dc`（粉→青）→ **`#4a8eef → #5ba0ff → #7ab4ff`**（单色蓝族）

### 静态验收（fixture computed style）
| 面 | 选择器 | background |
|---|---|---|
| `/?view=home` 登录门 | `.landing-form .btn-primary` | `rgb(91, 160, 255)` |
| `/` 官网 CTA | `.btn-primary` | `rgb(91, 160, 255)` |
| `/` eyebrow pill | `.eyebrow` | `rgba(91, 160, 255, 0.16)` + accent 字色 |

---

## 未做

| 项 | 说明 |
|---|---|
| 登录后 `--toiv-*` / canvas desk / create | **硬禁**；A0–A2 已钉，本刀未碰产品壳源码 |
| 现网硬刷 `/` 与 `/?view=home` | 无本地 ToIV Next 会话；仅 FIXTURE |
| commit / push / deploy | 禁 |
| shadcn aux cyan 在 token 中的保留位 | 属登录后产品通道，A3 不改 |

---

## 改动文件（本刀 A3）

- `apps/web/app/styles/landing.css`
- `apps/web/components/landing/LandingPage.tsx`（注释/DNA 说明）
- `apps/web/public/site/styles.css`
- `apps/web/public/site/assets/waveform.svg`
- `apps/canvas/docs/FULL_SHELL_TEARDOWN_A3_HANDBACK.md`（新）
- `apps/canvas/docs/shots/a3-site.png` / `a3-landing.png`
- `apps/canvas/docs/shots/fixture-a3-site.html` / `fixture-a3-landing.html`

## 截图绝对路径（FIXTURE · 非现网硬刷）

- `/Users/wangzhenyu/Desktop/ALLProject/ToIV/apps/canvas/docs/shots/a3-site.png` — bare `/` 营销海报（波形+CTA 单焦点）
- `/Users/wangzhenyu/Desktop/ALLProject/ToIV/apps/canvas/docs/shots/a3-landing.png` — `/?view=home` 登录门（CTA=`#5ba0ff`，无青 pill 双彩）

## 泄漏检查

- `landing.css` import 点：仅 `apps/web/components/landing/LandingPage.tsx`
- A3 diff 不含 `toiv-freezone-tokens` / desk / create / canvas studio 产品文件

## 阻塞

- 无本地 ToIV Next 登录/未登录会话 → 无法现网硬刷；fixture 已标 **FIXTURE · 非现网硬刷**

## A0–A3 全波本地状态

**A0–A3 全波均仅工作树落地（未 commit/push/deploy）；产品壳 DNA（暗色 Freezone · accent `#5ba0ff` · 光幕 · create desk）A0–A2 已钉且 A3 未污染；未登录 marketing 与登录门已收敛为同家族单焦点蓝。**


> **Superseded by A3v2**：见 `FULL_SHELL_TEARDOWN_A3V2_HANDBACK.md`（结构去 AI 感，非仅换色）。
