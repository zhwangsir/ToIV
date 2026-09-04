/**
 * 基座对比度门禁(2026-08-16 Team A,WCAG 2.x 相对亮度法):
 * ① globals.css 实解析:muted/secondary × canvas/surface-1/2/3 全配对(5 浅 + 暗 + 纯黑)
 *    —— muted ≥4.5(surface-2 为重点,其余一并断言)、secondary ≥4.5 全底
 * ② --text-on-accent × --accent:5 浅 + 暗 + 暗色四色板变体,全部 ≥4.5
 * ③ 状态色 ok/warn/err × 自身 soft 合成底(soft = 状态色 α 叠加在四层面板上取最坏值)≥4.5
 * ④ 基座 token 存在性源码断言:--content-max/--content-wide/--leading-loose、
 *    .single-view/.view-shell 消费 var(--content-wide)、.view-root 底 nav 让位
 * ⑤ 断点纪律:全 app css 无 1024/1280 媒体查询残留(统一 -1 约定 1023/1279)
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const testDir = dirname(fileURLToPath(import.meta.url));
const webRoot = join(testDir, "..");

function readSrc(rel: string): string {
  return readFileSync(join(webRoot, rel), "utf-8");
}

/* ── WCAG 相对亮度对比度 ── */
type Rgb = { r: number; g: number; b: number };

function srgbToLin(c: number): number {
  c /= 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function luminance({ r, g, b }: Rgb): number {
  return 0.2126 * srgbToLin(r) + 0.7152 * srgbToLin(g) + 0.0722 * srgbToLin(b);
}
function contrast(fg: Rgb, bg: Rgb): number {
  const la = luminance(fg);
  const lb = luminance(bg);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}
/** rgba(fg, alpha) 叠加在 bg 上的合成色(soft 底实际渲染色) */
function composite(fg: Rgb, alpha: number, bg: Rgb): Rgb {
  return {
    r: Math.round(fg.r * alpha + bg.r * (1 - alpha)),
    g: Math.round(fg.g * alpha + bg.g * (1 - alpha)),
    b: Math.round(fg.b * alpha + bg.b * (1 - alpha)),
  };
}

/* ── globals.css 实解析:选择器块 → token 表(后块并前块,模拟级联覆盖) ── */
function extractBlock(src: string, selector: string): Record<string, string> {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = src.match(new RegExp(esc + "\\s*\\{([^}]*)\\}"));
  const out: Record<string, string> = {};
  if (!m) return out;
  for (const dm of m[1].matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) {
    out[dm[1]] = dm[2].trim();
  }
  return out;
}

function parseColor(v: string): (Rgb & { a: number }) | null {
  const hex = v.match(/^#([0-9a-fA-F]{6})$/);
  if (hex) {
    const h = hex[1];
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
      a: 1,
    };
  }
  const rgba = v.match(/^rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)$/);
  if (rgba) {
    return { r: +rgba[1], g: +rgba[2], b: +rgba[3], a: +rgba[4] };
  }
  return null;
}

const globals = readSrc("app/globals.css");
const rootVars = extractBlock(globals, ":root");

function mergedVars(...selectors: string[]): Record<string, string> {
  return Object.assign({}, ...selectors.map((s) => extractBlock(globals, s)));
}
function colorOf(vars: Record<string, string>, token: string): Rgb & { a: number } {
  const raw = vars[token];
  assert.ok(raw, `globals.css 缺少 token --${token}`);
  const c = parseColor(raw);
  assert.ok(c, `--${token} 值 ${raw} 非可解析颜色`);
  return c!;
}

const SURFACES = ["bg-canvas", "bg-surface-1", "bg-surface-2", "bg-surface-3"] as const;

/* ── ① muted/secondary × 四底全配对 ── */
const textThemes: { name: string; selectors: string[] }[] = [
  { name: "paper", selectors: [":root"] },
  { name: "wood", selectors: [":root", '[data-theme="wood"]'] },
  { name: "mono", selectors: [":root", '[data-theme="mono"]'] },
  { name: "mint", selectors: [":root", '[data-theme="mint"]'] },
  { name: "apricot", selectors: [":root", '[data-theme="apricot"]'] },
  { name: "dark", selectors: [":root", '[data-mode="dark"]'] },
  {
    name: "dark-pure-black",
    selectors: [":root", '[data-mode="dark"]', '[data-mode="dark"][data-pure-black="1"]'],
  },
];

for (const t of textThemes) {
  const vars = mergedVars(...t.selectors);
  for (const role of ["text-muted", "text-secondary"] as const) {
    test(`${t.name} --${role} 在 canvas/surface-1/2/3 上对比度全部 ≥4.5`, () => {
      const fg = colorOf(vars, role);
      for (const s of SURFACES) {
        const bg = colorOf(vars, s);
        const ratio = contrast(fg, bg);
        assert.ok(
          ratio >= 4.5,
          `${t.name} ${role} on ${s} = ${ratio.toFixed(2)} < 4.5`,
        );
      }
    });
  }
}

/* ── ② text-on-accent × accent ── */
const accentThemes: { name: string; selectors: string[] }[] = [
  ...textThemes.slice(0, 6),
  { name: "dark-mono", selectors: [":root", '[data-mode="dark"]', '[data-mode="dark"][data-theme="mono"]'] },
  { name: "dark-wood", selectors: [":root", '[data-mode="dark"]', '[data-mode="dark"][data-theme="wood"]'] },
  { name: "dark-mint", selectors: [":root", '[data-mode="dark"]', '[data-mode="dark"][data-theme="mint"]'] },
  { name: "dark-apricot", selectors: [":root", '[data-mode="dark"]', '[data-mode="dark"][data-theme="apricot"]'] },
];

for (const t of accentThemes) {
  test(`${t.name} --text-on-accent 在 --accent 上 ≥4.5`, () => {
    const vars = mergedVars(...t.selectors);
    const ratio = contrast(colorOf(vars, "text-on-accent"), colorOf(vars, "accent"));
    assert.ok(ratio >= 4.5, `${t.name} on-accent = ${ratio.toFixed(2)} < 4.5`);
  });
}

/* ── ③ 状态色 × 自身 soft 合成底(四层面板取最坏值) ── */
for (const t of [
  { name: "light", selectors: [":root"] },
  { name: "dark", selectors: [":root", '[data-mode="dark"]'] },
]) {
  const vars = mergedVars(...t.selectors);
  for (const k of ["ok", "warn", "err"] as const) {
    test(`${t.name} --${k} 在自身 soft 合成底上(四面板最坏值)≥4.5`, () => {
      const fg = colorOf(vars, k);
      const soft = colorOf(vars, `${k}-soft`);
      const ratios = SURFACES.map((s) => contrast(fg, composite(soft, soft.a, colorOf(vars, s))));
      const min = Math.min(...ratios);
      assert.ok(
        min >= 4.5,
        `${t.name} ${k} on soft worst = ${min.toFixed(2)} < 4.5(${ratios.map((r) => r.toFixed(2)).join("/")})`,
      );
    });
  }
}

/* ── ④ 基座 token 存在性/消费断言 ── */
test("基座新 token 存在:--layout-* 版型档 / --content-* 别名 / --leading-loose", () => {
  // 2026-09-04 美化 W0:版型令牌成文,--content-max/--content-wide 改别名指向新档
  assert.match(globals, /--layout-measure:\s*680px/);
  assert.match(globals, /--layout-content:\s*1000px/);
  assert.match(globals, /--layout-wide:\s*1240px/);
  assert.match(globals, /--content-max:\s*var\(--layout-content\)/);
  assert.match(globals, /--content-wide:\s*var\(--layout-wide\)/);
  assert.match(globals, /--section-gap-lg:\s*24px/);
  assert.match(globals, /--grid-gutter:\s*16px/);
  assert.match(globals, /--grid-gutter-lg:\s*20px/);
  assert.match(globals, /--media-ar-video:\s*16 \/ 9/);
  assert.match(globals, /--leading-loose:\s*1\.7/);
});

/* ── ③b 图表色板 --chart-1..5(2026-08-30 批 D):
   5 色板 × 亮/暗双模式全量卡控(textThemes 覆盖 5 浅色板 + 暗 + 纯黑;
   浅色板不覆盖 chart token → 继承 :root,暗色继承 [data-mode="dark"] 块)。
   图表色承载数据系列(非文本图形),WCAG 非文本对比度门槛 ≥3:1。 ── */
for (const t of textThemes) {
  const vars = mergedVars(...t.selectors);
  for (const k of ["chart-1", "chart-2", "chart-3", "chart-4", "chart-5"] as const) {
    test(`${t.name} --${k} 在 canvas/surface-1/2/3 上 ≥3:1(图表非文本)`, () => {
      const fg = colorOf(vars, k);
      for (const s of SURFACES) {
        const bg = colorOf(vars, s);
        const ratio = contrast(fg, bg);
        assert.ok(
          ratio >= 3,
          `${t.name} ${k} on ${s} = ${ratio.toFixed(2)} < 3`,
        );
      }
    });
  }
}

test("页面槽 token 存在且双壳统一消费:--page-gutter(2026-08-24 密度优化)", () => {
  assert.match(globals, /--page-gutter:\s*clamp\(12px, 2vw, 24px\)/);
  const single = globals.match(/\.single-view\s*\{([^}]*)\}/);
  const shell = globals.match(/\.view-shell\s*\{([^}]*)\}/);
  assert.ok(single && /var\(--page-gutter\)/.test(single[1]), ".single-view 未消费 --page-gutter");
  assert.ok(shell && /var\(--page-gutter\)/.test(shell[1]), ".view-shell 未消费 --page-gutter");
});

test(".single-view 与 .view-shell 版心统一消费 var(--content-wide)", () => {
  const single = globals.match(/\.single-view\s*\{([^}]*)\}/);
  const shell = globals.match(/\.view-shell\s*\{([^}]*)\}/);
  assert.ok(single && /max-width:\s*var\(--content-wide\)/.test(single[1]));
  assert.ok(shell && /max-width:\s*var\(--content-wide\)/.test(shell[1]));
});

test("<1024 窄屏 .view-root 底部让位固定底 nav(--bottomnav-h + space-4)", () => {
  const narrow = globals.match(/@media \(max-width: 1023px\) \{([\s\S]*?)\n\}/);
  assert.ok(narrow, "缺少 1023 窄屏媒体查询块");
  assert.match(
    narrow![1],
    /\.view-root\s*\{[^}]*padding-bottom:\s*calc\(var\(--bottomnav-h\) \+ var\(--space-4\)\)/,
  );
});

/* ── ⑤ 断点纪律:1023/1279 落地,全 app css 无 1024/1280 媒体查询残留 ── */
function walkCss(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walkCss(p, out);
    else if (name.endsWith(".css")) out.push(p);
  }
  return out;
}

test("全 app css 无 @media max-width 1024/1280 残留", () => {
  const cssFiles = walkCss(join(webRoot, "app"));
  for (const f of cssFiles) {
    const src = readFileSync(f, "utf-8");
    assert.doesNotMatch(src, /@media\s*\(max-width:\s*(1024|1280)px\)/, `${f} 残留违规断点`);
  }
});
