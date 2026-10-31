# FULL SHELL TEARDOWN · A3v2 Handback（去 AI 感 · 结构刀）

- **日期**：2026-10-28（Asia/Shanghai）
- **分支**：`work/p0-fusion-20261016`
- **状态**：**仅工作树**（未 commit / 未 push / 未 deploy）
- **截图性质**：**FIXTURE · 非现网硬刷**
- **裁定**：A3 v1「换色≠去 AI 感」打回 → 本刀改结构

---

## 做了什么（结构）

### 1) 砍波形
- `public/site/index.html`：**删除**音轨/waveform 装饰 DOM
- 右栏改为 **静帧分镜条**（`.desk-strip` 4 cell），无音浪 SVG
- `waveform.svg` 仍留在 `assets/`（未引用）；未删文件以免无关 diff 噪音

### 2) 降英雄 / 工具口吻
- 标题：`一句话，出一部短剧` → **`进工作室。`**（28px 工具态，非 64px 海报）
- 眉标：去掉「AI xxx」pill/呼吸点 → 静音 **`短剧工作台`** kicker
- CTA：单主按钮 **`进入工作室`**，无 glow / 无上浮霓虹

### 3) 右预览 = 密台截断
- 去掉 `.stage-glow` / `.stage-rays` / demo 营销卡 / composer 光晕
- 新 `.desk-preview`：chrome 三点 + rail（分镜/成片/素材）+ 分镜格；**box-shadow: none**

### 4) 登录门（`LandingPage` / `landing.css`）
- 去掉径向 blob、玻璃 `backdrop-filter`、logo/CTA 霓虹 shadow、eyebrow 呼吸动画、slogan 光晕字影
- 文案：`今天想创作什么?` → **`进入工作室`**；眉标 **`短剧工作台`**（非 AI）
- 能力列表改为密台索引（分镜台 / 成片轨 / 素材池），非功能广告墙口吻
- **拆除** `ParticleButton` + `Ripple`（装饰粒子）
- 登录卡：实色 surface、10px 圆角、无玻璃

### 5) A0–A2 fixture 回扫
- 扫 `fixture-a1-home` / `a2-create` / `home` / `create`：**未见**「一句话 / AI 创作 / waveform / 粉青」关键词
- **未改**登录后 `--toiv-*` 硬表与 canvas desk 源码（本刀硬禁）

---

## 未做

| 项 | 说明 |
|---|---|
| 登录后 token / desk / create 产品壳 | 硬禁 |
| 删除 `waveform.svg` 文件 | DOM 已断引用；文件可后续清 |
| 现网硬刷 | 无本地 Next 会话 |
| create 目录文案「一句话生成…POP MV」等 | 属登录后 create 壳，本刀未动 |
| commit / push / deploy | 禁 |

---

## 改动文件

- `apps/web/app/styles/landing.css`（重写）
- `apps/web/components/landing/LandingPage.tsx`
- `apps/web/public/site/index.html`（重写结构）
- `apps/web/public/site/styles.css`（重写）
- `apps/canvas/docs/FULL_SHELL_TEARDOWN_A3V2_HANDBACK.md`（新）
- `apps/canvas/docs/shots/a3v2-site.png` / `a3v2-landing.png`
- `apps/canvas/docs/shots/deai-site.png` / `deai-landing.png`（同帧别名）
- `apps/canvas/docs/shots/a3-site.png` / `a3-landing.png`（覆盖为 v2）
- `apps/canvas/docs/shots/fixture-a3v2-*.html`（+ 同步 a3 fixtures）

## 截图绝对路径（FIXTURE · 非现网硬刷）

- `/Users/wangzhenyu/Desktop/ALLProject/ToIV/apps/canvas/docs/shots/a3v2-site.png`
- `/Users/wangzhenyu/Desktop/ALLProject/ToIV/apps/canvas/docs/shots/a3v2-landing.png`
- `/Users/wangzhenyu/Desktop/ALLProject/ToIV/apps/canvas/docs/shots/deai-site.png`
- `/Users/wangzhenyu/Desktop/ALLProject/ToIV/apps/canvas/docs/shots/deai-landing.png`

### Fixture 静态验收
| 面 | 项 | 值 |
|---|---|---|
| `/` | h1 | `进工作室。` · 无 wave · desk=true |
| `/` | CTA | `rgb(91,160,255)` · shadow `none` |
| 登录门 | slogan / eyebrow | `进入工作室` / `短剧工作台` |
| 登录门 | card | solid `#15161d` · blur `none` · r=10px |

---

## 阻塞
- 无本地 ToIV Next → 无法现网硬刷
- 产品壳（home/create/desk）AI 感残留需另刀（本刀禁碰）

---

## 自检：AI 感还剩哪（诚实）

1. **`waveform.svg` 资产仍在盘上**（未引用）— 若有人重新链上会回潮  
2. **登录后产品壳未动**：create 市场卡「一句话生成…」、`toiv-soft-glow` 指针光晕、节点 selected glow、queue `backdrop-filter` 仍在 — **用户进工作室后仍可能感到轻 AI/霓虹**  
3. **官网三卡「分镜台/成片轨/素材池」**仍偏「功能目录」— 已压字号与装饰，但结构仍是营销页骨架，不是真桌面  
4. **登录门左栏三行索引**仍带产品导览感（优于旧广告墙，但非零）  
5. **accent `#5ba0ff` CTA** 在近黑底上仍醒目 — DNA 要求保留；克制了 glow，但「彩色主按钮」本身偏产品营销常见件  
6. **A0–A2 现网产品截图未重刷** — fixture 关键词扫过，但真实 desk UI 未在本刀去 AI  

**结论：未登录门已从「AI SaaS 海报」收成「进工作室」；AI 感未归零，主残在登录后壳与未删资产。**
