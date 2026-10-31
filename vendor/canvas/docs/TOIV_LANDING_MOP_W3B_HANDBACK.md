# ToIV · P1-3 门面 mop Handback（W3-B）

- **日期**：2026-10-28（Asia/Shanghai）
- **分支**：`work/p0-fusion-20261016`
- **tip**：`0a426713`（**未 commit / 未 push / 未 deploy**）
- **截图性质**：**FIXTURE · 非现网硬刷** · 1280×800 + 390×844
- **口径**：BeefTV 密台门；accent `#4A7FC1`；无玻璃 / 波形回潮

---

## 做了什么

1. **删除未引用** `apps/web/public/site/assets/waveform.svg`（DOM / 源码无引用；docs 历史提及保留）
2. **压 AI/产品海报感 kicker**
   - `public/site/index.html`：kicker「短剧工作台」→「工具入口」；title/description/footer「工作台」
   - `LandingPage.tsx`：eyebrow 去 accent 色点 +「工具入口」；副文案去「短剧」堆叠
   - `landing.css`：eyebrow 去 pill 边框（更像工具注脚，不像徽章）
3. **审计**：1280 / 390 fixture — `waveform` 无；`backdrop-filter` 无；CTA `rgb(74, 127, 193)`

---

## 独立批判（≤3）

| # | 视口 | 题 |
|---|---|---|
| 1 | 1280 | 底栏三卡（分镜台/成片轨/素材池）仍偏**功能目录墙**，与「工具入口」密台语气略冲；可后波收成单行索引或删 |
| 2 | 390 | 首屏被 desk-preview 占满，三卡几乎不可见；窄屏未重排信息优先级 |
| 3 | 双视口 | kicker「工具入口」与 H1「进工作室」语义重叠，可再压一层（删 kicker 或并入 lead） |

**非问题（本波确认）**：无玻璃回潮；无 waveform 回链；accent 仍 `#4A7FC1`。

---

## Fixture / 截图

| 文件 | 绝对路径 |
|---|---|
| Fixture 1280 | `/Users/wangzhenyu/Desktop/ALLProject/ToIV/apps/canvas/docs/shots/fixture-w3b-landing-1280.html` |
| Fixture 390 | `/Users/wangzhenyu/Desktop/ALLProject/ToIV/apps/canvas/docs/shots/fixture-w3b-landing-390.html` |
| PNG 1280 | `/Users/wangzhenyu/Desktop/ALLProject/ToIV/apps/canvas/docs/shots/w3b-landing-1280.png` |
| PNG 390 | `/Users/wangzhenyu/Desktop/ALLProject/ToIV/apps/canvas/docs/shots/w3b-landing-390.png` |

**CTA 采样**：`rgb(74, 127, 193)`（`#4A7FC1`）

---

## 改动文件面

- `apps/web/public/site/assets/waveform.svg`（删）
- `apps/web/public/site/index.html`
- `apps/web/components/landing/LandingPage.tsx`
- `apps/web/app/styles/landing.css`
- `apps/canvas/docs/TOIV_LANDING_MOP_W3B_HANDBACK.md`
- `apps/canvas/docs/shots/fixture-w3b-landing-1280.html`
- `apps/canvas/docs/shots/fixture-w3b-landing-390.html`
- `apps/canvas/docs/shots/w3b-landing-1280.png`
- `apps/canvas/docs/shots/w3b-landing-390.png`

---

## 验收对照

- [x] 未引用 waveform.svg 已删
- [x] kicker 压 AI/目录感
- [x] 1280+390 独立批判 ≤3
- [x] 无玻璃/波形回潮；accent `#4A7FC1`
- [x] tip `0a426713`；未 commit

## 残点

| 项 | 说明 |
|---|---|
| 登录落地页双轨 | `LandingPage`（apps/web）与 `public/site` 门面文案已对齐语气；视觉壳仍两套 |
| 批判 #1–#3 | 未在本波改结构，仅记录 |
