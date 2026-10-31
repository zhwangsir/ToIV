# FULL SHELL TEARDOWN · A2 Handback

- **日期**：2026-10-28（Asia/Shanghai）
- **分支**：`work/p0-fusion-20261016`
- **状态**：**仅工作树**（未 commit / 未 push / 未 deploy）
- **截图性质**：**FIXTURE · 非现网硬刷**
- **对照**：现网反例 3 `/studio/create` 杂色 + UI 内调试文案

---

## 做了什么

### 1) R12 timeline zoom 读 CSS var（钉死）
- `creation-studio-preview-timeline.tsx`：`--toiv-timeline-zoom-base-pps` / min / max / step / `--toiv-timeline-ruler-min-tick-px` 经 `readCssNumber` + **`useLayoutEffect` 挂载后重读**；zoom 随 CSS min/max clamp
- 静态验收：`zoomBasePps=96`（来自 token，非 TS 魔法数单独演算）

### 2) aceternityMotion → 220
- `lib/aceternity-motion.ts`：新增 `tween.panel`（**0.22s** + ease-out-quint）；创作台主路径注释钉 220
- `creation-workspace.tsx`：mode indicator / suggest 由 spring → `tween.panel`
- `pages/create/index.tsx`：浮动提示条硬编码 spring(360/32) → `tween.panel`

### 3) 残色 / 双彩
- 媒体池 tag：青 → accent 软底 + 次级字色
- timeline **audio clip**：去青，改中性 muted（video clip 仍 `#5ba0ff` 软通道）
- 四阶段 chip 激活：与六阶段一致，accent ring
- play：token/CSS fallback **32px**、`rgb(91,160,255)`（非青）

### 4) 内部/调试文案扫尾
- Inspector：去掉英文「Inspector」徽标；参数分区去「中舞台/左栏」教学腔；内容模式只留状态 +「模式说明」链
- 媒体池 / 队列：去掉「切到顶栏…」调试腔；锁文案产品化（不写 NSFW lock 术语堆砌）
- rail 脚注（A0）保持清除

## 未做
| 项 | 说明 |
|---|---|
| 401 / 项目列表会话 | 非本岗；未假装已通 |
| A3 未登录 marketing | 另刀 |
| create 全量 spring 清扫（canvas 画布 emotion 等） | 非创作台主路径，未扩 |
| 现网硬刷 | 无本地 ToIV Next 会话 |

## 静态指标（fixture）
- play：`rgb(91,160,255)` · 32×32
- 光幕：28px
- zoomBasePps：96（CSS var）
- audio border：muted color-mix（非 `#00bdcf`）
- 「04 生成」激活：accent ring

## 改动文件
- `apps/canvas/web/src/lib/aceternity-motion.ts`
- `apps/canvas/web/src/pages/create/creation-workspace.tsx`
- `apps/canvas/web/src/pages/create/index.tsx`
- `apps/canvas/web/src/components/create/creation-studio-preview-timeline.tsx`
- `apps/canvas/web/src/components/create/creation-studio-preview-timeline.css`
- `apps/canvas/web/src/components/create/creation-studio-inspector.tsx`
- `apps/canvas/web/src/components/create/creation-studio-media-pool.tsx`
- `apps/canvas/web/src/components/create/creation-studio-media-pool.css`
- `apps/canvas/web/src/components/create/creation-studio-queue-dock.tsx`
- `apps/canvas/web/src/styles/toiv-freezone-tokens.css`
- `apps/web/app/styles/toiv-freezone-tokens.css`（同步）
- `apps/canvas/web/src/styles/toiv-local-overrides.css`
- `apps/canvas/docs/FULL_SHELL_TEARDOWN_A2_HANDBACK.md`（新）
- `apps/canvas/docs/shots/a2-create.png` / `a2-timeline.png`（+ fixtures）

## 截图绝对路径（FIXTURE · 非现网硬刷）
- `/Users/wangzhenyu/Desktop/ALLProject/ToIV/apps/canvas/docs/shots/a2-create.png`
- `/Users/wangzhenyu/Desktop/ALLProject/ToIV/apps/canvas/docs/shots/a2-timeline.png`

## 阻塞
- 无登录会话 → 无法现网硬刷 `/studio/create`
- 项目列表 401 仍非本岗

## 是否建议开 A3
**建议开 A3（P2）**：未登录 `LandingPage` + `landing.css` 与产品壳家族可辨、但不污染登录后 token；收敛青粉波形/青 pill 与登录门双彩（对照反例 1/2），范围仅未登录面。
