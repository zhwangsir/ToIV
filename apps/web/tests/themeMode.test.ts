/**
 * 主题系统 v7(2026-08-16,模式 × 色板 × 自定义)单测(node:test):
 * ① deriveAccentVars 纯函数:hover/soft/glow/text-on-accent 派生值精确断言
 * ② applyMode/applyCustom 系:假 window/document/getComputedStyle 注入直测
 *    (dataset + localStorage + inline 变量三通道;模式切换重派生;清除路径)
 * ③ ThemePicker 静态渲染:模式段控 / 色板行 / 自定义区结构;暗色门控源码断言
 * ④ layout.tsx 防 FOUC 脚本源码断言:三 key 白名单校验 + 内联派生存在
 * ⑤ globals.css 源码断言:dark 块位于 data-theme 块之后、四色板暗色变体、
 *    pure-black 块、状态色/阴影/玻璃/装饰层暗色变体存在
 * ⑥ drama-workbench.css 源码断言:暗色 .wb-root 覆盖块(ink 恒黑 + darkroom 更沉一档)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  applyCustom,
  applyCustomDom,
  applyMode,
  applyModeDataset,
  applyTheme,
  CUSTOM_ACCENT_PRESETS,
  CUSTOM_STORAGE_KEY,
  deriveAccentVars,
  getCurrentMode,
  getCustom,
  MODE_STORAGE_KEY,
  THEME_STORAGE_KEY,
} from "../lib/theme";
import { ThemePicker } from "../components/ui/ThemePicker";

const h = React.createElement;
const testDir = dirname(fileURLToPath(import.meta.url));
const webRoot = join(testDir, "..");

function readSrc(rel: string): string {
  return readFileSync(join(webRoot, rel), "utf-8");
}

/* ── ① deriveAccentVars 纯函数 ── */

test("deriveAccentVars 亮色:hover 加深 10% / soft 混亮画布 11% / glow 30% alpha / 亮度阈值压深字", () => {
  const d = deriveAccentVars("#4C86D9", "light");
  assert.ok(d);
  assert.equal(d.accent, "#4C86D9");
  assert.equal(d.accentHover, "#4479c3"); // [76,134,217] × 0.9 → [68,121,195]
  assert.equal(d.accentSoft, "#e7edf5"); // accent 11% + #FAFAF9 89%
  assert.equal(d.accentGlow, "rgba(76, 134, 217, 0.30)");
  assert.equal(d.textOnAccent, "#17181A"); // 朴素亮度 0.5006 > 0.5
});

test("deriveAccentVars 暗色:hover 向白提 12% / soft 混暗画布默认 #101114", () => {
  const d = deriveAccentVars("#4C86D9", "dark");
  assert.ok(d);
  assert.equal(d.accentHover, "#6195de"); // 向 [255,255,255] 混 12%
  assert.equal(d.accentSoft, "#171e2a"); // accent 11% + [16,17,20] 89%
  assert.equal(d.textOnAccent, "#17181A");
});

test("deriveAccentVars 显式 bg 参数覆盖模式默认画布", () => {
  const d = deriveAccentVars("#000000", "light", "#FFFFFF");
  assert.ok(d);
  assert.equal(d.accentHover, "#000000");
  assert.equal(d.accentSoft, "#e3e3e3"); // 255 × 0.89 ≈ 227
  assert.equal(d.textOnAccent, "#FFFFFF"); // 纯黑 accent 压白字
});

test("deriveAccentVars text-on-accent 亮度阈值边界(#808080 深字 / #7F7F7F 白字)", () => {
  assert.equal(deriveAccentVars("#808080")?.textOnAccent, "#17181A");
  assert.equal(deriveAccentVars("#7F7F7F")?.textOnAccent, "#FFFFFF");
});

test("deriveAccentVars 非法输入返回 null", () => {
  assert.equal(deriveAccentVars("red"), null);
  assert.equal(deriveAccentVars("#12345"), null); // 长度不足
  assert.equal(deriveAccentVars("#GGGGGG"), null);
  assert.equal(deriveAccentVars(""), null);
});

/* ── ② apply 系(假 DOM 注入;模块函数运行时才读全局,import 顺序无要求) ── */

const store = new Map<string, string>();
const inlineVars = new Map<string, string>();
const dataset: Record<string, string> = {};
let fakeBg = "#FAFAF9";

const g = globalThis as {
  window?: unknown;
  document?: unknown;
  getComputedStyle?: unknown;
};
g.window = {
  localStorage: {
    getItem: (k: string): string | null => store.get(k) ?? null,
    setItem: (k: string, v: string): void => void store.set(k, v),
    removeItem: (k: string): void => void store.delete(k),
  },
};
g.document = {
  documentElement: {
    dataset,
    style: {
      setProperty: (k: string, v: string): void => void inlineVars.set(k, v),
      removeProperty: (k: string): void => void inlineVars.delete(k),
    },
  },
  querySelector: (): null => null,
  createElement: (): Record<string, string> => ({ name: "", content: "" }),
  head: { appendChild: (): void => {} },
};
g.getComputedStyle = () => ({
  getPropertyValue: (k: string): string => (k === "--bg-canvas" ? fakeBg : ""),
});

function resetFake(): void {
  store.clear();
  inlineVars.clear();
  for (const k of Object.keys(dataset)) delete dataset[k];
  fakeBg = "#FAFAF9";
}

test("applyMode:写 localStorage + dataset;light 不写属性(缺省即亮)", () => {
  resetFake();
  applyMode("dark");
  assert.equal(store.get(MODE_STORAGE_KEY), "dark");
  assert.equal(dataset.mode, "dark");
  assert.equal(getCurrentMode(), "dark");
  applyMode("light");
  assert.equal(store.get(MODE_STORAGE_KEY), "light");
  assert.equal(dataset.mode, undefined);
  assert.equal(getCurrentMode(), "light");
});

test("applyCustom:非法 accent 剥离,pureBlack 写 dataset,inline 五变量按亮色画布派生", () => {
  resetFake();
  applyCustom({ accent: "#4C86D9", pureBlack: true });
  assert.equal(store.get(CUSTOM_STORAGE_KEY), '{"accent":"#4C86D9","pureBlack":true}');
  assert.equal(dataset.pureBlack, "1");
  assert.equal(inlineVars.get("--accent"), "#4C86D9");
  assert.equal(inlineVars.get("--accent-hover"), "#4479c3");
  assert.equal(inlineVars.get("--accent-soft"), "#e7edf5");
  assert.equal(inlineVars.get("--accent-glow"), "rgba(76, 134, 217, 0.30)");
  assert.equal(inlineVars.get("--text-on-accent"), "#17181A");

  resetFake();
  applyCustom({ accent: "123456", pureBlack: true }); // 无 # 前缀,非法
  assert.equal(store.get(CUSTOM_STORAGE_KEY), '{"pureBlack":true}');
  assert.equal(inlineVars.has("--accent"), false);
  assert.equal(dataset.pureBlack, "1");
});

test("模式切换后自定义 accent 按新画布重派生(先 dataset 后 inline 的顺序契约)", () => {
  resetFake();
  applyCustom({ accent: "#4C86D9" });
  assert.equal(inlineVars.get("--accent-soft"), "#e7edf5");
  fakeBg = "#101114"; // 模拟暗色 CSS 生效后的画布计算值
  applyMode("dark");
  assert.equal(dataset.mode, "dark");
  assert.equal(inlineVars.get("--accent"), "#4C86D9"); // 自定义覆盖仍在
  assert.equal(inlineVars.get("--accent-hover"), "#6195de");
  assert.equal(inlineVars.get("--accent-soft"), "#171e2a");
});

test("applyCustom 清空:移除 localStorage key + 清除 inline 五变量 + 删 dataset.pureBlack", () => {
  resetFake();
  applyCustom({ accent: "#4C86D9", pureBlack: true });
  applyCustom({});
  assert.equal(store.has(CUSTOM_STORAGE_KEY), false);
  for (const k of ["--accent", "--accent-hover", "--accent-soft", "--accent-glow", "--text-on-accent"]) {
    assert.equal(inlineVars.has(k), false, `${k} 应被移除`);
  }
  assert.equal(dataset.pureBlack, undefined);
});

test("applyModeDataset/applyCustomDom 只写 DOM 不写 localStorage(跨页同步路径)", () => {
  resetFake();
  applyModeDataset("dark");
  assert.equal(dataset.mode, "dark");
  assert.equal(store.has(MODE_STORAGE_KEY), false);
  applyCustomDom({ accent: "#4C86D9" });
  assert.equal(inlineVars.get("--accent"), "#4C86D9");
  assert.equal(store.has(CUSTOM_STORAGE_KEY), false);
});

test("getCustom:损坏 JSON 回落 {},非法字段逐项剥离", () => {
  resetFake();
  store.set(CUSTOM_STORAGE_KEY, "{bad json");
  assert.deepEqual(getCustom(), {});
  store.set(CUSTOM_STORAGE_KEY, '{"accent":"#abc","pureBlack":"yes"}');
  assert.deepEqual(getCustom(), {}); // accent 非 6 位、pureBlack 非布尔,全部剥离
  store.set(CUSTOM_STORAGE_KEY, '{"accent":"#aBc123","pureBlack":true}');
  assert.deepEqual(getCustom(), { accent: "#aBc123", pureBlack: true });
});

test("既有 applyTheme 行为不破坏(回归):写 localStorage + dataset.theme", () => {
  resetFake();
  applyTheme("mint");
  assert.equal(store.get(THEME_STORAGE_KEY), "mint");
  assert.equal(dataset.theme, "mint");
  applyTheme("paper"); // 默认板回落 :root,删属性
  assert.equal(dataset.theme, undefined);
});

/* ── ③ ThemePicker 渲染(SSR 首帧:light + 无自定义) ── */

test("ThemePicker 静态渲染:模式段控 / 色板行 / 自定义区三层结构齐全", () => {
  const html = renderToStaticMarkup(h(ThemePicker));
  // 计数一律锚定 class=" 属性前缀:组件内 styled-jsx 的 CSS 文本含同名类名,裸计数会被污染
  // 模式段控:复用全局 .at-seg,两枚 radio
  assert.match(html, /theme-mode-seg/);
  assert.equal((html.match(/class="at-seg-btn theme-mode-btn/g) ?? []).length, 2);
  assert.match(html, /亮色/);
  assert.match(html, /暗色/);
  // 三个 radiogroup:模式 / 色板 / 自定义强调色
  assert.equal((html.match(/role="radiogroup"/g) ?? []).length, 3);
  // 色板行:5 个 swatch(SSR 默认 paper 激活)
  assert.equal((html.match(/class="theme-swatch-dot"/g) ?? []).length, 5);
  assert.match(html, /class="theme-swatch is-active"/);
  // 自定义区:预设丸数量与 PRESETS 一致 + 自由取色 input
  assert.equal(
    (html.match(/class="theme-custom-dot"/g) ?? []).length,
    CUSTOM_ACCENT_PRESETS.length,
  );
  assert.match(html, /<input[^>]*type="color"/);
  // SSR 首帧 light + 无自定义:纯黑开关与恢复默认不渲染(断 class 属性,非 CSS 文本)
  assert.doesNotMatch(html, /class="theme-custom-row theme-custom-pureblack"/);
  assert.doesNotMatch(html, /class="theme-custom-reset"/);
});

test("ThemePicker 源码断言:三 key 跨页同步接入 + 纯黑开关暗色门控", () => {
  const src = readSrc("components/ui/ThemePicker.tsx");
  assert.equal((src.match(/useCrossTabSync\(/g) ?? []).length, 3);
  assert.ok(src.includes("MODE_STORAGE_KEY"));
  assert.ok(src.includes("CUSTOM_STORAGE_KEY"));
  assert.ok(src.includes('mode === "dark" &&'));
});

/* ── ④ layout.tsx 防 FOUC 脚本源码断言 ── */

test("layout.tsx 内联脚本:三 key 白名单校验 + 自定义 accent 内联派生存在", () => {
  const src = readSrc("app/layout.tsx");
  assert.ok(src.includes('localStorage.getItem("toiv_theme")'));
  assert.ok(src.includes('localStorage.getItem("toiv_mode")'));
  assert.ok(src.includes('localStorage.getItem("toiv_theme_custom")'));
  // 白名单:主题四板 / 模式仅 dark / accent #rrggbb / pureBlack 布尔 true
  assert.ok(src.includes('t==="wood"||t==="mono"||t==="mint"||t==="apricot"'));
  assert.ok(src.includes('m==="dark"'));
  assert.ok(src.includes("/^#[0-9a-fA-F]{6}$/"));
  assert.ok(src.includes("o.pureBlack===true"));
  // dataset 三件套 + inline 派生(hover/soft/glow/text-on-accent)
  assert.ok(src.includes('d.dataset.mode="dark"'));
  assert.ok(src.includes('d.dataset.pureBlack="1"'));
  assert.ok(src.includes('st.setProperty("--accent-hover"'));
  assert.ok(src.includes('st.setProperty("--accent-soft"'));
  assert.ok(src.includes('st.setProperty("--accent-glow"'));
  assert.ok(src.includes('st.setProperty("--text-on-accent"'));
  // 静态 themeColor 保持浅色默认
  assert.ok(src.includes('themeColor: "#FAFAF9"'));
});

/* ── ⑤ globals.css 源码断言 ── */

test("globals.css:[data-mode=dark] 基础块位于全部 data-theme 块之后且含完整暗色阶梯", () => {
  const css = readSrc("app/globals.css");
  const iApricot = css.indexOf('[data-theme="apricot"] {');
  const iDark = css.indexOf('[data-mode="dark"] {');
  assert.ok(iApricot > 0, "apricot 色板块缺失");
  assert.ok(iDark > iApricot, "dark 基础块必须置于 data-theme 块之后(同优先级靠顺序赢)");
  const darkBlock = css.slice(iDark, css.indexOf("\n}", iDark));
  assert.match(darkBlock, /color-scheme: dark;/);
  assert.match(darkBlock, /--bg-canvas: #101114;/);
  assert.match(darkBlock, /--text-primary: #F4F4F3;/);
  assert.match(darkBlock, /--accent: #F5F5F4;/); // paper 暗色变体:近白 accent
  assert.match(darkBlock, /--text-on-accent: #17181A;/);
  // 状态色 / 玻璃 / 叠加 / 阴影暗色变体
  for (const k of ["--ok:", "--warn:", "--err:", "--ok-soft:", "--warn-soft:", "--err-soft:"]) {
    assert.ok(darkBlock.includes(k), `暗色块缺 ${k}`);
  }
  for (const k of ["--glass-bg:", "--overlay-strong:", "--shadow-sm:", "--shadow-float:"]) {
    assert.ok(darkBlock.includes(k), `暗色块缺 ${k}`);
  }
});

test("globals.css:四色板暗色 accent 变体 + paper 走基础块 + 绝对锚点 token", () => {
  const css = readSrc("app/globals.css");
  for (const t of ["mono", "wood", "mint", "apricot"]) {
    const marker = `[data-mode="dark"][data-theme="${t}"] {`;
    const i = css.indexOf(marker);
    assert.ok(i > 0, `缺 ${t} 暗色变体块`);
    const block = css.slice(i, css.indexOf("\n}", i));
    assert.match(block, /--accent: /, `${t} 变体缺 --accent`);
    assert.match(block, /--text-on-accent: /, `${t} 变体缺 --text-on-accent`);
  }
  assert.match(css, /--abs-black: #000000;/);
  assert.match(css, /--abs-white: #FFFFFF;/);
});

test("globals.css:pure-black 块压纯黑画布 + 噪点/压角暗色装饰变体", () => {
  const css = readSrc("app/globals.css");
  const i = css.indexOf('[data-mode="dark"][data-pure-black="1"] {');
  assert.ok(i > 0, "缺 pure-black 块");
  const block = css.slice(i, css.indexOf("\n}", i));
  assert.match(block, /--bg-canvas: #000000;/);
  assert.ok(css.includes('[data-mode="dark"] body::before'), "缺噪点暗色变体");
  assert.ok(css.includes('[data-mode="dark"] body::after'), "缺压角暗色变体");
});

/* ── ⑥ drama-workbench.css 源码断言 ── */

test("drama-workbench.css:暗色 light 区 ink 恒黑修正 + darkroom 比全局更沉一档", () => {
  const css = readSrc("app/styles/drama-workbench.css");
  const iLight = css.indexOf("[data-mode=\"dark\"] .wb-root {");
  assert.ok(iLight > 0, "缺暗色 .wb-root 覆盖块");
  const lightBlock = css.slice(iLight, css.indexOf("\n}", iLight));
  assert.match(lightBlock, /--wb-ink: var\(--abs-black\);/);

  const iDark = css.indexOf('[data-mode="dark"] .wb-root[data-zone="darkroom"] {');
  assert.ok(iDark > 0, "缺暗色 darkroom 覆盖块");
  const darkBlock = css.slice(iDark, css.indexOf("\n}", iDark));
  assert.match(darkBlock, /--wb-canvas: color-mix\(in oklab, var\(--bg-canvas\) 58%, var\(--abs-black\)\);/);
  assert.match(darkBlock, /--wb-accent: var\(--warn\);/);
  assert.match(darkBlock, /--wb-text: color-mix\(in oklab, var\(--abs-white\)/);
});
