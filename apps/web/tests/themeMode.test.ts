/**
 * 主题系统 v8(2026-08-31,Studio Console 单色中性系)单测(node:test):
 * ① applyMode/applyCustom 系:假 window/document/getComputedStyle 注入直测
 *    (dataset + localStorage 双通道;纯黑子档;清空路径)
 * ② 旧版迁移:v7 的 toiv_theme 色板 key 与自定义 accent 读取时清除
 * ③ ThemePicker 静态渲染:只剩模式段控(+暗色下纯黑开关);色板/自定义强调色退役
 * ④ layout.tsx 防 FOUC 脚本源码断言:两 key + 旧 key 清除
 * ⑤ globals.css 源码断言:dark 块完整、五色板/dark accent 变体块已移除、pure-black 保留
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
  CUSTOM_STORAGE_KEY,
  getCurrentMode,
  getCustom,
  LEGACY_THEME_KEY,
  MODE_STORAGE_KEY,
} from "../lib/theme";
import { ThemePicker } from "../components/ui/ThemePicker";

const h = React.createElement;
const testDir = dirname(fileURLToPath(import.meta.url));
const webRoot = join(testDir, "..");

function readSrc(rel: string): string {
  return readFileSync(join(webRoot, rel), "utf-8");
}

/* ── ① apply 系(假 DOM 注入;模块函数运行时才读全局,import 顺序无要求) ── */

const store = new Map<string, string>();
const dataset: Record<string, string> = {};

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
  documentElement: { dataset },
  querySelector: (): null => null,
  createElement: (): Record<string, string> => ({ name: "", content: "" }),
  head: { appendChild: (): void => {} },
};
g.getComputedStyle = () => ({ getPropertyValue: (): string => "" });

function resetFake(): void {
  store.clear();
  for (const k of Object.keys(dataset)) delete dataset[k];
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

test("applyCustom:pureBlack 写 dataset + localStorage;v8 无 accent 维度", () => {
  resetFake();
  applyCustom({ pureBlack: true });
  assert.equal(store.get(CUSTOM_STORAGE_KEY), '{"pureBlack":true}');
  assert.equal(dataset.pureBlack, "1");
  applyCustom({});
  assert.equal(store.has(CUSTOM_STORAGE_KEY), false);
  assert.equal(dataset.pureBlack, undefined);
});

test("applyModeDataset/applyCustomDom 只写 DOM 不写 localStorage(跨页同步路径)", () => {
  resetFake();
  applyModeDataset("dark");
  assert.equal(dataset.mode, "dark");
  assert.equal(store.has(MODE_STORAGE_KEY), false);
  applyCustomDom({ pureBlack: true });
  assert.equal(dataset.pureBlack, "1");
  assert.equal(store.has(CUSTOM_STORAGE_KEY), false);
});

test("getCustom:损坏 JSON 回落 {};旧 accent 字段剥离后只剩 pureBlack", () => {
  resetFake();
  store.set(CUSTOM_STORAGE_KEY, "{bad json");
  assert.deepEqual(getCustom(), {});
  // v7 残留 {accent, pureBlack}:accent 被剥离,pureBlack 保留并回写清洗后的 key
  store.set(CUSTOM_STORAGE_KEY, '{"accent":"#4C86D9","pureBlack":true}');
  assert.deepEqual(getCustom(), { pureBlack: true });
  assert.equal(store.get(CUSTOM_STORAGE_KEY), '{"pureBlack":true}');
  // 只剩 accent 的旧 key:整个移除
  store.set(CUSTOM_STORAGE_KEY, '{"accent":"#4C86D9"}');
  assert.deepEqual(getCustom(), {});
  assert.equal(store.has(CUSTOM_STORAGE_KEY), false);
});

/* ── ② 旧版迁移 ── */

test("v8 迁移:toiv_theme 色板 key 读取时清除", () => {
  resetFake();
  store.set(LEGACY_THEME_KEY, "mint");
  getCurrentMode(); // 任一读路径触发迁移
  assert.equal(store.has(LEGACY_THEME_KEY), false, "旧色板 key 应清除");
});

/* ── ③ ThemePicker 渲染(SSR 首帧:light + 无自定义) ── */

test("ThemePicker v8 静态渲染:只剩模式段控;色板行/自定义强调色区退役", () => {
  const html = renderToStaticMarkup(h(ThemePicker));
  // 模式段控:复用全局 .at-seg,两枚 radio
  assert.match(html, /theme-mode-seg/);
  assert.equal((html.match(/class="at-seg-btn theme-mode-btn/g) ?? []).length, 2);
  assert.match(html, /亮色/);
  assert.match(html, /暗色/);
  // 只剩一个 radiogroup(模式);色板 swatch / 自由取色 / 预设丸全部退役
  assert.equal((html.match(/role="radiogroup"/g) ?? []).length, 1);
  assert.equal((html.match(/theme-swatch/g) ?? []).length, 0);
  assert.equal((html.match(/theme-custom-dot/g) ?? []).length, 0);
  assert.doesNotMatch(html, /type="color"/);
  // SSR 首帧 light:纯黑开关不渲染(暗色门控)
  assert.doesNotMatch(html, /纯黑背景/);
});

test("ThemePicker 源码断言:两 key 跨页同步接入 + 纯黑开关暗色门控", () => {
  const src = readSrc("components/ui/ThemePicker.tsx");
  assert.equal((src.match(/useCrossTabSync\(/g) ?? []).length, 2);
  assert.ok(src.includes("MODE_STORAGE_KEY"));
  assert.ok(src.includes("CUSTOM_STORAGE_KEY"));
  assert.ok(!src.includes("THEME_STORAGE_KEY"), "色板 key 同步应退役");
  assert.ok(src.includes('mode === "dark" &&'));
});

/* ── ④ layout.tsx 防 FOUC 脚本源码断言 ── */

test("layout.tsx 内联脚本:v8 两 key + 旧色板 key 清除,无 accent 内联派生", () => {
  const src = readSrc("app/layout.tsx");
  assert.ok(src.includes('localStorage.getItem("toiv_mode")'));
  assert.ok(src.includes('localStorage.getItem("toiv_theme_custom")'));
  assert.ok(src.includes('localStorage.removeItem("toiv_theme")'), "旧色板 key 应清除");
  assert.ok(src.includes('m==="dark"'));
  assert.ok(src.includes("o.pureBlack===true"));
  assert.ok(src.includes('d.dataset.mode="dark"'));
  assert.ok(src.includes('d.dataset.pureBlack="1"'));
  assert.ok(!src.includes('setProperty("--accent"'), "accent 内联派生应退役");
  // 静态 themeColor 保持浅色默认
  assert.ok(src.includes('themeColor: "#FAFAF9"'));
});

/* ── ⑤ globals.css 源码断言 ── */

test("globals.css v8:[data-mode=dark] 块完整;五色板与暗色 accent 变体已移除", () => {
  const css = readSrc("app/globals.css");
  // 五色板退役
  for (const t of ["wood", "mono", "mint", "apricot"]) {
    assert.ok(!css.includes(`[data-theme="${t}"]`), `${t} 色板块应移除`);
    assert.ok(!css.includes(`[data-mode="dark"][data-theme="${t}"]`), `${t} 暗色变体应移除`);
  }
  // 暗色基础块完整(单色中性系)
  const iDark = css.indexOf('[data-mode="dark"] {');
  assert.ok(iDark > 0, "dark 基础块缺失");
  const darkBlock = css.slice(iDark, css.indexOf("\n}", iDark));
  assert.match(darkBlock, /color-scheme: dark;/);
  assert.match(darkBlock, /--bg-canvas: #101114;/);
  assert.match(darkBlock, /--accent: #F5F5F4;/); // 近白 accent(黑白单色美学)
  assert.match(darkBlock, /--text-on-accent: #17181A;/);
  for (const k of ["--ok:", "--warn:", "--err:", "--glass-bg:", "--overlay-strong:", "--shadow-sm:"]) {
    assert.ok(darkBlock.includes(k), `暗色块缺 ${k}`);
  }
  // 绝对锚点 token 保留
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
