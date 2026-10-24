> ⚠️ **历史快照 · 非现行事实**（DOC_TRUTH_SWEEP 2026-10-23 Asia/Shanghai）。
> 现行集群真源 → [`docs/ops/CLUSTER_TRUTH.md`](ops/CLUSTER_TRUTH.md)。

---
name: ToIV Web
# 由 scripts/gen_design_md.py 从 apps/web/app/globals.css :root 生成;勿手改 token 值
tokens:
  abs:
    --abs-black: "#000000"
    --abs-white: "#FFFFFF"
  font:
    --font-sans: "var(--font-inter), 'Inter', 'PingFang SC', -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', Roboto, 'HarmonyOS Sans SC', sans-serif"
    --font-mono: "var(--font-jetbrains), 'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace"
    --font-display: "var(--font-sans)"
    --font-regular: "400"
    --font-medium: "500"
    --font-semibold: "600"
    --font-bold: "700"
  bg:
    --bg-canvas: "#FFFFFF"
    --bg-surface-1: "#FFFFFF"
    --bg-surface-2: "#F7F7F8"
    --bg-surface-3: "#ECECEE"
  border:
    --border-subtle: "rgba(17, 17, 17, 0.13)"
    --border-strong: "rgba(17, 17, 17, 0.24)"
  text:
    --text-primary: "#0A0A0A"
    --text-secondary: "#525252"
    --text-muted: "#66666B"
    --text-3: "var(--text-secondary)"
    --text-on-accent: "#FFFFFF"
    --text-title: "20px"
    --text-section: "15px"
    --text-body: "13px"
    --text-aux: "11px"
    --text-label: "11px"
    --text-display-sm: "24px"
    --text-display-md: "32px"
    --text-display-lg: "40px"
  accent:
    --accent: "#242426"
    --accent-hover: "#333538"
    --accent-soft: "rgba(36, 36, 38, 0.08)"
    --accent-halo: "rgba(36, 36, 38, 0.20)"
    --accent-glow: "var(--text-primary)"
    --accent-glow-soft: "rgba(36, 36, 38, 0.08)"
    --accent-glow-deep: "var(--accent)"
    --accent-glow-shadow: "0 2px 12px rgba(0, 0, 0, 0.18)"
  ok:
    --ok: "#0C6B34"
    --ok-soft: "rgba(15, 123, 60, 0.10)"
  warn:
    --warn: "#8A4A06"
    --warn-soft: "rgba(138, 74, 6, 0.10)"
  err:
    --err: "#B41919"
    --err-soft: "rgba(180, 25, 25, 0.10)"
  run:
    --run: "var(--accent)"
    --run-soft: "var(--accent-soft)"
  chart:
    --chart-1: "#0E7490"
    --chart-2: "#7C3AED"
    --chart-3: "#B45309"
    --chart-4: "#15803D"
    --chart-5: "#DC2626"
  film:
    --film-frame-w: "172px"
    --film-frame-h: "120px"
    --film-rail-bg: "var(--bg-surface-1)"
    --film-perf-color: "var(--border-strong)"
  overlay:
    --overlay-strong: "rgba(24, 20, 16, 0.45)"
    --overlay-light: "rgba(24, 20, 16, 0.55)"
    --overlay-stage: "rgba(24, 20, 16, 0.85)"
  backdrop:
    --backdrop-blur: "blur(12px)"
  glass:
    --glass-bg: "rgba(255, 255, 255, 0.80)"
    --glass-border: "rgba(17, 17, 17, 0.13)"
    --glass-blur: "blur(20px) saturate(1.4)"
    --glass-highlight: "inset 0 1px 0 rgba(255, 255, 255, 0.65)"
  leading:
    --leading-display: "1.15"
    --leading-base: "22px"
    --leading-md: "var(--leading-base)"
    --leading-xl: "26px"
    --leading-loose: "1.7"
  space:
    --space-1: "4px"
    --space-2: "8px"
    --space-3: "12px"
    --space-4: "16px"
    --space-5: "20px"
    --space-6: "24px"
    --space-7: "28px"
    --space-8: "32px"
    --space-10: "40px"
    --space-12: "48px"
  radius:
    --radius-badge: "8px"
    --radius-control: "12px"
    --radius-panel: "16px"
    --radius-full: "9999px"
  shadow:
    --shadow-sm: "0 1px 2px rgba(0, 0, 0, 0.05)"
    --shadow-xs: "0 1px 1.5px rgba(0, 0, 0, 0.04)"
    --shadow-md: "0 1px 2px rgba(0, 0, 0, 0.05), 0 2px 6px rgba(0, 0, 0, 0.06)"
    --shadow-lg: "0 2px 5px rgba(0, 0, 0, 0.05), 0 10px 26px rgba(0, 0, 0, 0.10)"
    --shadow-xl: "0 3px 10px rgba(0, 0, 0, 0.09), 0 24px 60px rgba(0, 0, 0, 0.14)"
    --shadow-pop: "0 4px 20px rgba(0, 0, 0, 0.10), 0 0 0 1px var(--border-subtle)"
    --shadow-lift: "0 8px 30px rgba(0, 0, 0, 0.12), 0 0 0 1px var(--border-subtle)"
    --shadow-float: "0 12px 40px rgba(0, 0, 0, 0.14), 0 0 0 1px var(--border-subtle)"
  duration:
    --duration-fast: "150ms"
    --duration-base: "200ms"
    --duration-slow: "320ms"
    --duration-loop: "1.2s"
    --duration-pulse: "1.6s"
  ease:
    --ease-standard: "ease-out"
    --ease-emphasized: "cubic-bezier(0.16, 1, 0.3, 1)"
    --ease-spring: "linear(0, 0.009, 0.035 1.1%, 0.141 2.4%, 0.723 6.4%, 1.005 10.7%, 1.128 14.4%, 1.185 18.9%, 1.154 24.4%, 1.023 32.7%, 0.989 42.3%, 1.001 56.8%, 1)"
  bottomnav:
    --bottomnav-h: "0px"
  layout:
    --layout-measure: "680px"
    --layout-content: "1180px"
    --layout-wide: "1520px"
    --layout-header-gap: "var(--space-3)"
    --layout-toolbar-gap: "var(--space-3)"
  content:
    --content-max: "var(--layout-content)"
    --content-wide: "var(--layout-wide)"
  grid:
    --grid-gutter-sm: "12px"
    --grid-gutter: "16px"
    --grid-gutter-lg: "20px"
  media:
    --media-ar-video: "16 / 9"
    --media-ar-image: "1 / 1"
    --media-ar-thumb: "4 / 3"
  page:
    --page-gutter: "clamp(12px, 2vw, 24px)"
  section:
    --section-gap: "16px"
    --section-gap-lg: "20px"
  z:
    --z-dropdown: "50"
    --z-sticky: "100"
    --z-drawer: "200"
    --z-modal: "300"
    --z-toast: "400"
  focus:
    --focus-ring: "1px solid var(--accent-glow)"
  touch:
    --touch-target: "44px"
  bp:
    --bp-sm: "576px"
    --bp-md: "768px"
    --bp-lg: "1024px"
    --bp-xl: "1440px"
---

# ToIV Web 设计令牌契约（DESIGN.md）

> 格式对齐 [google-labs-code/design.md](https://github.com/google-labs-code/design.md)（Apache-2.0，格式规范对齐，不并码）。
> **真源**：`apps/web/app/globals.css` 的 `:root` 块。本文件 token 由生成器从真源提取（注释行即声明），**改 token 先改 globals.css，再重新生成本文件**；防漂移由 `apps/web/tests/designTokens.test.ts` 机器校验。

## 概览

ToIV Web 是暗调优先的本地 AIGC 创作平台：ink 黑主文、纸白表面、单强调 accent（近黑中性，交互靠明度层级而非彩色）、ok/warn/err 三态语义色。RH 市场域经 `.rh-dark` 作用域有自己的暗色覆盖层。动画一律走 `--duration*`/`--ease*` 令牌，杜绝散落毫秒数。

## 颜色

- **bg-canvas/surface-1/2/3**：三层表面递进；卡片永远 surface-2 以上，禁止手写 `#f7f7f8` 之类字面量。
- **text-primary/secondary/muted**：三级文字明度；`--text-3` 是 secondary 的历史别名，新代码用 `--text-secondary`。
- **accent/accent-hover/accent-soft**：交互主色是近黑中性——ToIV 的彩色只属于内容（生成的图/视频），UI 本身保持无彩。
- **ok/warn/err（+`*-soft`）**：状态语义色；软底 `*-soft` 用于徽标/横幅底色。
- **glass/backdrop/overlay**：弹层与毛玻璃；z 序走 `--z*`，禁止魔法数字 z-index。
- **film/chart**：视频时间线与图表专用色板，别挪用到表单控件。

## 字体与排版

- `--font-sans`（含中文回退 PingFang SC/HarmonyOS Sans SC）与 `--font-mono`（JetBrains Mono 系）；`--leading*` 五级行高、`--space*` 十级间距——布局尺寸只允许 space 令牌或其倍数。

## 形状/阴影/动效

- `--radius*` 四级圆角；`--shadow*` 八级投影（弹层级用 `--shadow-lg` 以上）；`--duration*`+`--ease*` 是动效唯一出处，`prefers-reduced-motion` 豁免规则见 assistant.css 既有先例。

## 使用铁律（P-2b 全集）

1. **新样式零 hex**：styled-jsx/组件样式块一律 `var(--token)`；确实需要新颜色 = 先在 globals.css 加 token 再引用（一次性生成器重跑）。
2. **engineStudio 区**：自 `.apps-studio {` 起到文件尾**禁 hex 且勿臆造 token**（先 grep globals.css 确认存在）。
3. **appsRh 区**：`object-fit: cover` 的断言区次序受 `tests/appsRh.test.ts` 懒惰正则约束，改 apps.css 前先跑该测试。
4. **新增 lib/api 导出必补 `tests/mocks/studioApi.ts` 替身**。
5. **多组件文件一律 `<style jsx global>` + 前缀命名**（`av-`/`rh-`/`apps-studio-` 等域前缀）。

## 机器校验

`apps/web/tests/designTokens.test.ts`：
- DESIGN.md 声明的每个 token 必须存在于 globals.css；
- 核心组（abs/bg/border/text/accent/ok/warn/err/run）双向覆盖（globals.css 有而 DESIGN.md 未声明 = 漂移，测试红）；
- engineStudio 区零 hex 复查。
