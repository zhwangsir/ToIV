# ToIV 全局模式切换 · 第2轮调研简报（仪式感控件）

- **日期**：2026-10-26（Asia/Shanghai）
- **执行**：模型调研帮手（视觉 Mode Switch R2）
- **状态**：未 commit / 未写业务码 / 未 push
- **承接**：`docs/ops/VISUAL_DNA_RESET_R1_20261026.md`
- **已钉死**：accent `#5ba0ff`；辅 `#00bdcf`；光幕辅 `#4f8cff`；DNA 顶栏右光幕成人双闸（SFW 默认 / NSFW 可切换，前端闸）
- **方法**：BeefTV / dramaclaw 实读组件与 DESIGN；Linear 用公开 DESIGN 规格（tastekit 2026-07）；Runway 仅公开帮助/截图模式（主题在 profile 菜单，无像素级 segmented CSS）——**未抓到的 hex/尺寸不编造**

---

## ⚡ TL / 跨端立刻可用 · 推荐形态 + 硬数字

### 推荐控件形态（一句话）

**顶栏右：2 段 quiet segmented pill（SFW | NSFW）+ 滑块 thumb；SFW 静止无 glow，NSFW 选中用光幕蓝 `#4f8cff` soft fill + `0 0 24px` glow；禁 iOS 大开关、禁整页 View Transition。**

### 关键尺寸 / glow 数字表（跨端可抄）

| Token 建议 | 值 | 用途 |
|---|---|---|
| `--toiv-switch-h` | **28px** | 轨道高（顶栏安静档；对齐 BeefTV Segmented sm=`h-7` + Linear 密集） |
| `--toiv-switch-min-w` | **108px** | 两段最小总宽（约 2×48 + pad） |
| `--toiv-switch-pad` | **2px** | 轨道内边距（TW `p-0.5`） |
| `--toiv-switch-gap` | **0** | 段间距靠 thumb 覆盖；文字段用内边距 |
| `--toiv-switch-item-px` | **10px** | 段水平内边距（介于 dramaclaw chip `10` 与 BeefTV sm `px-2.5=10`） |
| `--toiv-switch-radius-track` | **9999px** | 轨道 pill（dramaclaw 签名；顶栏双闸 1:1） |
| `--toiv-switch-radius-thumb` | **9999px** | thumb 同 pill（勿用直角 md） |
| `--toiv-switch-fs` | **12px** | 标签（dramaclaw label-md / body-sm） |
| `--toiv-switch-fw` | **500** | 字重 |
| `--toiv-switch-border` | `1px solid rgba(255,255,255,0.08)` | 轨道弱边（暗色 hairline） |
| `--toiv-switch-bg` | `#101118` 或 `rgb(16 17 24 / 0.92)` | 轨道底（dramaclaw chip） |
| `--toiv-switch-fg` | `#6f7079` | 未选文字（muted） |
| `--toiv-switch-fg-active-sfw` | `#e8eaf0` | SFW 选中字（近正文，**无彩**） |
| `--toiv-switch-fg-active-nsfw` | `#5ba0ff` 或光幕 `#4f8cff` | NSFW 选中字（一屏只开一个彩） |
| `--toiv-switch-thumb-bg-sfw` | `#15161d` / `rgba(255,255,255,0.08)` | SFW thumb 抬升面（无 glow） |
| `--toiv-switch-thumb-bg-nsfw` | `rgb(79 140 255 / 0.22)` | NSFW soft fill（对齐 dramaclaw chip-active `#23334d` 思路） |
| `--toiv-switch-ring-nsfw` | `0 0 0 1px rgb(79 140 255 / 0.45)` | NSFW 1px accent ring |
| `--toiv-switch-glow-nsfw` | **`0 0 24px rgb(79 140 255 / 0.28)`** | 光幕点亮（BeefTV glow-md 色相换成光幕蓝；blur 24 / spread 0） |
| `--toiv-switch-glow-hover` | `0 0 16px rgb(79 140 255 / 0.18)` | NSFW 未选段 hover 弱光（可选） |
| `--toiv-switch-dur` | **150ms** color / border；**200ms** thumb `left/width` 或 `transform` | BeefTV Segmented `duration-200` + dramaclaw fast 150 |
| `--toiv-switch-ease` | `cubic-bezier(0.22, 1, 0.36, 1)` | ease-out-quint（dramaclaw / BeefTV `--motion-ease-out`） |
| `--toiv-switch-disabled-opacity` | **0.4** | dramaclaw quiet button；BeefTV switch `0.45` 取严档 0.4 |
| `--toiv-switch-focus-ring` | `0 0 0 3px rgb(91 160 255 / 0.12)` | dramaclaw 输入焦点环口径 |
| `--toiv-switch-press-scale` | **无**（顶栏）/ 创作台大 segmented 可用 `0.97` | BeefTV creation-mode `:active scale(.97)` **勿搬到顶栏双闸** |

**Glow 分解（NSFW active）**

| 参数 | 值 |
|---|---|
| blur | **24px** |
| spread | **0** |
| color | `rgb(79, 140, 255)` = `#4f8cff` |
| alpha | **0.28**（静止点亮）；hover 可到 0.35，勿超 BeefTV glow-lg 的 0.4 |
| 叠加 | 另加 1px ring（上表）；**禁止**再叠 `0 0 40px` 大光晕进顶栏 |

---

## ① 深度调研与像素级拆解

### A. dramaclaw — quiet chip / button（双闸 DNA 主源）

| 控件 | 尺寸 / 形 | 态 | 动效 / glow |
|---|---|---|---|
| **chip** `.tap-chip` | pad `2×10`；pill `9999`；字 12 / muted | default：底 `#101118`、字 muted；**active** (`data-state`)：底 `#23334d`（≈ accent/0.22）、字 accent、**1px accent ring** | 选中用发光/ring，**不用重投影**；hover/变色 **150ms**；ease-out-quint |
| **button-quiet** | pad `4×11`；pill；字 label-md 12/500 | default 半透明弱边；hover 填充升 surface；**quiet-primary** 仅文字染 accent + **glow** `0 0 24px rgb(accent / 0.25)` | disabled：`opacity: 0.4` + `not-allowed`，不另置灰字 |
| 原则 | 可点非提交一律 pill | 激活用 `data-state`，不用类名开关 | 禁 bounce/elastic；画布禁 anim width/height，可动 transform/opacity |

**对双闸含义**：SFW = chip 静止态；NSFW = chip-active + quiet-primary 的 glow 仪式——**形状不变、只换能量**。

证据：`DESIGN.md` components.chip / button-quiet；文案「焦点与选中用发光，不用阴影」。

### B. BeefTV — 三类「模式切换」实件

#### B1. `SegmentedControl`（设置 / 技能预览 — quiet 分段）

| 档 | 轨道 | thumb | 项 |
|---|---|---|---|
| **sm** | `h-7`(=28) `rounded-md` `p-0.5`(=2) | `rounded-sm`；`inset-y-0.5` | `px-2.5` `text-xs` |
| **md** | `h-8`(=32) `rounded-lg` `p-0.5` | `rounded-md` | `px-3` `text-sm` |

- thumb：`bg-surface-strong`，`transition-[left,width] duration-200 ease-out`；`motion-reduce:transition-none`
- 未选：`text-muted-foreground`；hover：`bg-surface-hover` + 前景升起
- 选中：`text-foreground`（**中性抬升，非彩**）
- disabled：整轨 `opacity-60`；项 `cursor-not-allowed` + muted/40
- 键盘：radio + ←/→/Home/End

**对双闸**：几何与 thumb 滑动可 1:1；顶栏把 `rounded-md` **改成 pill**（跟 dramaclaw）；NSFW 选中再叠彩 fill+glow（BeefTV 默认 segmented **无 glow**）。

#### B2. Dock 双态开关（导演台 / 抓手·框选 — 仪式感最强）

- slot：**compact 24** / 默认 **26** / touch **32**；gap 8–10；padX 6–7；轨道竖 pad 3–4
- 轨道纯黑 `--dock-switch-track:#000`；thumb 白圆；选中图标反色黑
- 未选 opacity **0.62** → hover **0.88** → 选中 **1**；色/透明度 `motion-instant`（~80–120ms）
- thumb 位移动画：默认 **spring**（`aceternityMotion.spring.dock`）；reduced-motion → 0
- focus-visible：双环 `0 0 0 2px dock-bg + 0 0 0 4px thumb/accent`

**对双闸**：学「滑块拇指 + 双 radio」交互与密度；**不要**照抄黑底白圆高对比（顶栏成人闸要安静密台，不是 dock 工具）。顶栏用 soft surface + accent glow，代替黑白反转。

#### B3. Creation mode tabs（文/图/视频 — 大号创作台分段）

- 轨：`padding:4`；`border-radius:18`；指示器 radius **14**；钮高 **44**；字 14/600；gap 8
- hover/pressed：字色升起；`:active scale(.97)`；focus-visible 2px accent outline
- **勿搬到顶栏**：高度与字重会抢创作台焦点；仅作「创作台内模式」参考

#### B4. `Switch`（设置布尔 — 非双闸首选）

- sm：`h-5 w-8` thumb `14`；md：`h-6 w-11` thumb `16`；`duration-200 ease-out` translate
- on：`bg-foreground`；off：tertiary + inset ring；disabled opacity **0.45**
- **跳过作成人双闸**：缺双标签仪式感，且易被理解成「系统开关」而非「内容模式」

#### B5. `AnimatedThemeToggler`

- 默认 duration **400ms** + 整页 clip-path View Transition  
- **明确禁止**用于 SFW/NSFW：过慢、整页闪，打断 `/create`

### C. Linear（公开规格 — quiet chip 气质）

来源：tastekit Linear Product App DESIGN（2026-07，公开 CSS/嵌入壳；**非登录仪表盘抓包**）。

| 项 | 值 |
|---|---|
| 控件高 | 按钮/输入 **32**；sidebar 行 **28**；chip/badge 高约 **20–24** |
| 半径 | 控件 **6–8**；chip 可 pill 或 6 |
| 动效 | **100–160ms** ease-out-quad；禁 bounce |
| 选中 | 抬升面 `#232326` / brand indigo 仅 CTA·focus；**chrome 不靠大 glow** |
| 焦点环 | indigo `rgba(94,106,210,.25)` |

**对双闸**：学「矮、快、少彩」；ToIV 已钉蓝系 accent，**不要**换 Linear 紫。Glow 仍用 BeefTV/dramaclaw 蓝光，因成人闸需要「点亮」仪式，Linear 本身几乎无 glow。

### D. Runway（公开模式 — 仅气质）

- 主题切换在 **profile → Theme**（System/Light/Dark），**不是**顶栏 segmented（帮助中心 2025–2026）
- 工具内可见 **Reference/Keyframe…** 等分段与 Chat/Session 类 switch（截图流），但无公开可钉 CSS 数值
- **结论**：Runway =「创作工具内分段安静、全局主题藏菜单」；ToIV 成人双闸是**全局内容闸**，更近 BeefTV dock/segmented + dramaclaw chip，而非 Runway 主题菜单

### E. 对照总表（模式切换控件）

| 源 | 形态 | 高 | 圆角 | 动效 | glow | 适顶栏双闸 |
|---|---|---|---|---|---|---|
| dramaclaw chip | 单 pill 态变 | ~20–24（pad 推导） | full | 150ms | active ring+可选 24px | ✅ 态语言 |
| BeefTV Segmented sm | 2+ 段 + thumb | **28** | md→改 full | 200ms thumb | 无（需融） | ✅ 几何 |
| BeefTV Dock switch | 图标双态 + 白 thumb | slot 24–32 | full | spring / instant | 无（高反差） | 🔀 交互 only |
| BeefTV Creation tabs | 大分段 | **44** | 18/14 | scale 0.97 | 无 | ⛔ 顶栏 |
| BeefTV Switch | iOS 轨 | 20–24 | full | 200ms | 无 | ⛔ 形态 |
| Linear chip/control | quiet | 20–32 | 6–8 | 100–160ms | 几乎无 | 🔀 气质 |
| Runway theme | 菜单 | — | — | — | — | ⛔ |

---

## ② 照抄与融合方案（对 ToIV 顶栏右光幕成人双闸）

### 1:1 照抄

1. **dramaclaw**：pill 形；chip 静止/active 色逻辑；quiet-primary 的 **24px accent glow**；disabled 0.4；150ms 变色；ease-out-quint；`data-state` / `aria-checked` 驱动。
2. **BeefTV Segmented sm 几何**：轨高 28、pad 2、thumb 滑动 200ms、radio 键盘、`motion-reduce` 关动画。
3. **R1 已钉色**：字/环可用 `#5ba0ff`；**光幕 glow 色用 `#4f8cff`**（辅强调，与创作主 CTA 蓝可区分「闸」vs「画布选中」）。

### 融合（保留 ToIV 身份）

1. 轨道用 dramaclaw chip 底 + soft border；thumb 在 SFW 用中性抬升（Linear/BeefTV segmented），在 NSFW 换 soft `#4f8cff` fill + ring + glow。
2. 标签文案 **SFW / NSFW**（或中文「标准 / 成人」——产品定文案；视觉 token 不绑文案）。
3. 位置：顶栏**最右**光幕区；高度吃进顶栏行（建议顶栏内容区 ≥36，控件 28 垂直居中）；左右勿再堆第二个高饱和控件。
4. 状态持久：`data-gate="sfw|nsfw"` 挂在 `html` 或壳层根（对齐 R1）；列表过滤只读该属性——**本波不写业务码，只定视觉合同**。

### 明确跳过

- AnimatedThemeToggler / 整页 View Transition  
- Creation-mode 44px 大轨进顶栏  
- iOS Switch 作唯一成人闸  
- Dock 黑底白圆高反差搬进 Freezone 顶栏  
- bounce / spring 进顶栏（dock spring 可留在画布工具条，不进双闸）  
- 后端 403 / 换路由树  

---

## ③ 落地蓝图（`--toiv-switch-*` + 态表）

### 建议 CSS 变量块（跨端可贴）

```css
:root {
  /* geometry */
  --toiv-switch-h: 28px;
  --toiv-switch-min-w: 108px;
  --toiv-switch-pad: 2px;
  --toiv-switch-item-px: 10px;
  --toiv-switch-radius: 9999px;
  --toiv-switch-fs: 12px;
  --toiv-switch-fw: 500;

  /* surfaces */
  --toiv-switch-bg: #101118;
  --toiv-switch-border: rgba(255, 255, 255, 0.08);
  --toiv-switch-fg: #6f7079;
  --toiv-switch-fg-hover: #e8eaf0;
  --toiv-switch-thumb-sfw: rgba(255, 255, 255, 0.08);
  --toiv-switch-thumb-nsfw: rgb(79 140 255 / 0.22);
  --toiv-switch-fg-nsfw: #4f8cff;

  /* glow / ring — NSFW only */
  --toiv-switch-ring-nsfw: 0 0 0 1px rgb(79 140 255 / 0.45);
  --toiv-switch-glow-nsfw: 0 0 24px rgb(79 140 255 / 0.28);
  --toiv-switch-focus: 0 0 0 3px rgb(91 160 255 / 0.12);

  /* motion */
  --toiv-switch-dur-color: 150ms;
  --toiv-switch-dur-thumb: 200ms;
  --toiv-switch-ease: cubic-bezier(0.22, 1, 0.36, 1);
  --toiv-switch-disabled-opacity: 0.4;
}
```

### 态样式合同

| 态 | 轨道 | 段文字 | thumb | glow | 指针 |
|---|---|---|---|---|---|
| **SFW default（整闸）** | bg + border | 左选中近白；右 muted | 中性抬升，罩在 SFW | **无** | default |
| **SFW hover（未选 NSFW 段）** | 同 | NSFW 段 → fg-hover | 不动 | 无 | pointer |
| **NSFW active** | 同（底色板不变） | NSFW → fg-nsfw；SFW → muted | soft 蓝 fill | **ring + glow-nsfw** | default |
| **NSFW hover（未选 SFW）** | 同 | SFW → fg-hover | 可微增 glow α→0.32 | 保持 | pointer |
| **focus-visible** | + focus ring | — | — | 不替代 NSFW glow | — |
| **disabled** | opacity 0.4 | 不另改色 | 无动画 | 无 | not-allowed |
| **pressed** | 无 scale（顶栏） | — | thumb 仍 200ms | — | — |

### 与创作台连贯

- `/create` 内文/图/视频分段：可继续用更大轨（参考 BeefTV 44 或自研 36），token 前缀 `--toiv-create-mode-*`，**不要**复用 `--toiv-switch-glow-nsfw`。
- 闸点亮时：画布节点选中 glow 降级或互斥（R1 ④），保证一屏一个高饱和焦点。

---

## ④ 双闸与连贯性校验

### 仪式感（要点亮，不耍宝）

1. **形状锁定**：SFW↔NSFW 同一 pill 轨 + thumb 滑动；用户感知是「模式拨杆」，不是新按钮。
2. **能量差**：仅 NSFW 拥有彩字 + soft fill + 24px 光幕；SFW 保持 Linear/dramaclaw 级安静——默认态不喊叫。
3. **时长**：色 150ms、thumb 200ms；总感知 <250ms，低于 ThemeToggler 400ms，不抢生成预览注意力。
4. **音效/震动**：本波不做；若未来加，仅 NSFW 边沿一次极短 tick，默认关。

### 不打扰创作台

| 校验项 | 通过标准 |
|---|---|
| 路由 | 切换不离开 `/create`，不换壳 |
| 色板 | bg/surface/border/text **不变**；只变闸与列表过滤/徽章 |
| 焦点预算 | 闸亮时，主 CTA 或节点 glow 二选一高饱和 |
| 密度 | 顶栏控件高 28 ≤ 顶栏行；不引入 44px 创作分段 |
| 动效 | 无整页 transition；尊重 `prefers-reduced-motion` |
| 无障碍 | `role="radiogroup"` + 两 `role="radio"`；或 `aria-pressed` 双按钮组；标签可读「标准内容 / 成人内容」 |
| 安全产品 | 闸在前端单文件；后端不拦（红线已同步）；账本/模型可见性另线 |

### 回归清单（给跨端）

1. 截图：闸关 / 闸开 ×（空画布、选中节点、模型抽屉）共 6 张。  
2. 对比：六张底色直方图应接近；仅顶栏右与列表 NSFW 标记有色差。  
3. 键盘：Tab 到闸 → ←/→ 切换 → Esc 不关闸。  
4. reduced-motion：thumb 瞬移，无 spring。

---

## 证据路径（机读）

| 源 | 路径 |
|---|---|
| dramaclaw | `/workspace/refs/peers/dramaclaw/DESIGN.md`（chip / button-quiet / duration / glow） |
| BeefTV Segmented | `BeefTV/web/src/components/ui/base/segmented-control/segmented-control.tsx` |
| BeefTV Switch | `…/base/switch/switch.tsx` |
| BeefTV Dock switch | `…/ui/aceternity/floating-dock.tsx` + `globals.css` `.aceternity-dock-switch-*` |
| BeefTV Creation tabs | `…/pages/create/creation-product.css` |
| BeefTV glow tokens | `…/styles/globals.css` `--shadow-glow-sm/md/lg`、`--motion-*` |
| Linear | https://tastekit.dev/apps/linear/app/DESIGN.md （公开规格） |
| Runway | help.runwayml.com Theme 文；截图流仅模式级 |
| R1 | `docs/ops/VISUAL_DNA_RESET_R1_20261026.md` |

---

## Blocker / 待 TL

1. **文案**：顶栏显示 `SFW/NSFW` 还是「标准/成人」——视觉 token 已可开工，文案不影响尺寸。  
2. **NSFW 字色**：用创作蓝 `#5ba0ff` 还是光幕蓝 `#4f8cff`——本简报默认 **光幕 `#4f8cff`**（与 R1「光幕辅」一致）；若 TL 要字与环统一 `#5ba0ff`，只改 `--toiv-switch-fg-nsfw` / glow RGB。  
3. **SendToAgent**：本执行环境无该工具；需父代理 / 主会话 priority ping 技术负责人与跨端。  
4. 未改 JSON 账本、未 commit、未 push、未写业务组件。
