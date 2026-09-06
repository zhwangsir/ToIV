/**
 * 主题系统 v9(2026-09-07,预设主题 + 明暗 + 自定义强调色)单测(node:test):
 * ① applyMode/applyCustom 系:假 window/document/getComputedStyle 注入直测
 *    (dataset + localStorage 双通道;纯黑子档;清空路径)
 * ② applyTheme 预设主题:dataset.theme + toiv_theme 持久化;minimal 为缺省(移除属性/key)
 * ③ applyAccent 自定义强调色:dataset.accentCustom + 内联 --accent-user/--accent-user-on
 *    + toiv_accent_custom;非法 hex 拒绝;清除回主题默认
 * ④ 旧版迁移:v7 旧色板名(mint 等)读取时清除;旧 toiv_theme_custom.accent 迁移到新键
 * ⑤ ThemePicker 静态渲染:四预设色卡 + 模式段控 + 自定义强调色(color input + 色板)
 * ⑥ layout.tsx 防 FOUC 脚本源码断言:四 key + dataset/内联 var 写入
 * ⑦ globals.css 源码断言:paper/cinema/graphite 主题块、pure-black 暗基底门控、
 *    accent-custom color-mix 派生块、噪点暗基底变体
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  ACCENT_STORAGE_KEY,
  accentOnColor,
  applyAccent,
  applyAccentDom,
  applyCustom,
  applyCustomDom,
  applyMode,
  applyModeDataset,
  applyTheme,
  applyThemeDataset,
  CUSTOM_STORAGE_KEY,
  getCurrentMode,
  getCurrentTheme,
  getCustom,
  getCustomAccent,
  MODE_STORAGE_KEY,
  THEME_PRESETS,
  THEME_STORAGE_KEY,
} from "../lib/theme";
import { ThemePicker } from "../components/ui/ThemePicker";

const h = React.createElement;
const testDir = dirname(fileURLToPath(import.meta.url));
const webRoot = join(testDir, "..");

function readSrc(rel: string): string {
  return readFileSync(join(webRoot, rel), "utf-8");
}

/* ── 假 DOM 注入(模块函数运行时才读全局,import 顺序无要求) ── */

const store = new Map<string, string>();
const dataset: Record<string, string> = {};
const inlineStyle = new Map<string, string>();

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
      setProperty: (k: string, v: string): void => void inlineStyle.set(k, v),
      removeProperty: (k: string): void => void inlineStyle.delete(k),
    },
  },
  querySelector: (): null => null,
  createElement: (): Record<string, string> => ({ name: "", content: "" }),
  head: { appendChild: (): void => {} },
};
g.getComputedStyle = () => ({ getPropertyValue: (): string => "" });

function resetFake(): void {
  store.clear();
  inlineStyle.clear();
  for (const k of Object.keys(dataset)) delete dataset[k];
}

/* ── ① 模式/纯黑(v8 契约保留) ── */

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

test("applyCustom:pureBlack 写 dataset + localStorage", () => {
  resetFake();
  applyCustom({ pureBlack: true });
  assert.equal(store.get(CUSTOM_STORAGE_KEY), '{"pureBlack":true}');
  assert.equal(dataset.pureBlack, "1");
  applyCustom({});
  assert.equal(store.has(CUSTOM_STORAGE_KEY), false);
  assert.equal(dataset.pureBlack, undefined);
});

test("applyModeDataset/applyCustomDom/applyThemeDataset/applyAccentDom 只写 DOM 不写 localStorage(跨页同步路径)", () => {
  resetFake();
  applyModeDataset("dark");
  assert.equal(dataset.mode, "dark");
  assert.equal(store.has(MODE_STORAGE_KEY), false);
  applyCustomDom({ pureBlack: true });
  assert.equal(dataset.pureBlack, "1");
  assert.equal(store.has(CUSTOM_STORAGE_KEY), false);
  applyThemeDataset("cinema");
  assert.equal(dataset.theme, "cinema");
  assert.equal(store.has(THEME_STORAGE_KEY), false);
  applyAccentDom("#8B5CF6");
  assert.equal(dataset.accentCustom, "1");
  assert.equal(store.has(ACCENT_STORAGE_KEY), false);
});

test("getCustom:损坏 JSON 回落 {};旧 accent 字段迁移到 toiv_accent_custom 后剥离", () => {
  resetFake();
  store.set(CUSTOM_STORAGE_KEY, "{bad json");
  assert.deepEqual(getCustom(), {});
  // v7 残留 {accent, pureBlack}:accent 迁移到新键,pureBlack 保留并回写清洗后的 key
  store.set(CUSTOM_STORAGE_KEY, '{"accent":"#4C86D9","pureBlack":true}');
  assert.deepEqual(getCustom(), { pureBlack: true });
  assert.equal(store.get(CUSTOM_STORAGE_KEY), '{"pureBlack":true}');
  assert.equal(store.get(ACCENT_STORAGE_KEY), "#4C86D9", "旧 accent 应迁移到 toiv_accent_custom");
  // 只剩 accent 的旧 key:迁移后整个移除
  resetFake();
  store.set(CUSTOM_STORAGE_KEY, '{"accent":"#4C86D9"}');
  assert.deepEqual(getCustom(), {});
  assert.equal(store.has(CUSTOM_STORAGE_KEY), false);
  assert.equal(store.get(ACCENT_STORAGE_KEY), "#4C86D9");
  // 新键已有值时不覆盖用户新设置
  resetFake();
  store.set(ACCENT_STORAGE_KEY, "#8B5CF6");
  store.set(CUSTOM_STORAGE_KEY, '{"accent":"#4C86D9"}');
  getCustom();
  assert.equal(store.get(ACCENT_STORAGE_KEY), "#8B5CF6", "已有新键不被旧值覆盖");
});

/* ── ② 预设主题 ── */

test("applyTheme:四预设写 localStorage + dataset;minimal 为缺省(移除 key/属性)", () => {
  resetFake();
  assert.deepEqual(
    THEME_PRESETS.map((p) => p.id),
    ["minimal", "cinema", "paper", "graphite"],
    "预设清单应为 minimal/cinema/paper/graphite",
  );
  applyTheme("cinema");
  assert.equal(store.get(THEME_STORAGE_KEY), "cinema");
  assert.equal(dataset.theme, "cinema");
  assert.equal(getCurrentTheme(), "cinema");
  applyTheme("minimal");
  assert.equal(store.has(THEME_STORAGE_KEY), false, "minimal 应移除 key(缺省)");
  assert.equal(dataset.theme, undefined, "minimal 应移除 data-theme 属性");
  assert.equal(getCurrentTheme(), "minimal");
});

test("getCurrentTheme:v7 旧色板名等非法值读取时清除并回落 minimal", () => {
  resetFake();
  store.set(THEME_STORAGE_KEY, "mint");
  assert.equal(getCurrentTheme(), "minimal");
  assert.equal(store.has(THEME_STORAGE_KEY), false, "旧色板 key 应清除");
});

/* ── ③ 自定义强调色 ── */

test("applyAccent:写 localStorage + dataset.accentCustom + 内联 --accent-user/--accent-user-on", () => {
  resetFake();
  applyAccent("#8B5CF6");
  assert.equal(store.get(ACCENT_STORAGE_KEY), "#8B5CF6");
  assert.equal(dataset.accentCustom, "1");
  assert.equal(inlineStyle.get("--accent-user"), "#8B5CF6");
  assert.equal(inlineStyle.get("--accent-user-on"), "#FFFFFF", "紫底上文字应为白");
  assert.equal(getCustomAccent(), "#8B5CF6");
  // 亮色 accent:文字取近黑
  applyAccent("#C9F24F");
  assert.equal(inlineStyle.get("--accent-user-on"), "#17181A", "荧光绿底上文字应为近黑");
  // 清除:回主题默认
  applyAccent(null);
  assert.equal(store.has(ACCENT_STORAGE_KEY), false);
  assert.equal(dataset.accentCustom, undefined);
  assert.equal(inlineStyle.has("--accent-user"), false);
  assert.equal(inlineStyle.has("--accent-user-on"), false);
  assert.equal(getCustomAccent(), null);
});

test("applyAccent/getCustomAccent:非法 hex 拒绝(不写 key)并清除脏值", () => {
  resetFake();
  applyAccent("red");
  assert.equal(store.has(ACCENT_STORAGE_KEY), false);
  assert.equal(dataset.accentCustom, undefined);
  store.set(ACCENT_STORAGE_KEY, "#12345"); // 5 位脏值
  assert.equal(getCustomAccent(), null);
  assert.equal(store.has(ACCENT_STORAGE_KEY), false, "脏值应清除");
});

test("accentOnColor:亮度阈值两侧取近黑/白", () => {
  assert.equal(accentOnColor("#C9F24F"), "#17181A");
  assert.equal(accentOnColor("#FFFFFF"), "#17181A");
  assert.equal(accentOnColor("#17181A"), "#FFFFFF");
  assert.equal(accentOnColor("#8B5CF6"), "#FFFFFF");
});

/* ── ④ ThemePicker 渲染(SSR 首帧:minimal + light + 无自定义) ── */

test("ThemePicker v9 静态渲染:四预设色卡 + 模式段控 + 自定义强调色区", () => {
  const html = renderToStaticMarkup(h(ThemePicker));
  // 四张预设色卡(radio + 名称)
  assert.equal((html.match(/class="theme-preset-card/g) ?? []).length, 4);
  for (const name of ["极简白", "影院", "纸墨", "石墨"]) {
    assert.ok(html.includes(name), `缺预设卡「${name}」`);
  }
  assert.ok(html.includes('aria-label="预设主题"'));
  // 模式段控(minimal 亮基底 → 显示):两枚 radio
  assert.match(html, /theme-mode-seg/);
  assert.equal((html.match(/class="at-seg-btn theme-mode-btn/g) ?? []).length, 2);
  // 自定义强调色:color input + 快捷色板
  assert.ok(html.includes('type="color"'), "缺自由取色 input");
  assert.ok((html.match(/theme-accent-swatch/g) ?? []).length >= 6, "缺快捷色板");
  // SSR 首帧 minimal+light+无自定义:纯黑开关与清除按钮不渲染
  assert.doesNotMatch(html, /纯黑背景/);
  assert.doesNotMatch(html, /清除自定义/);
});

test("ThemePicker 源码断言:四 key 跨页同步接入 + 暗基底主题门控模式行", () => {
  const src = readSrc("components/ui/ThemePicker.tsx");
  assert.equal((src.match(/useCrossTabSync\(/g) ?? []).length, 4);
  for (const k of ["THEME_STORAGE_KEY", "MODE_STORAGE_KEY", "CUSTOM_STORAGE_KEY", "ACCENT_STORAGE_KEY"]) {
    assert.ok(src.includes(k), `缺 ${k} 通道`);
  }
  assert.ok(src.includes("darkBased"), "暗基底主题(cinema/graphite)应隐藏明暗切换");
  assert.ok(src.includes('mode === "dark" &&'), "纯黑开关应暗色门控");
});

/* ── ⑤ layout.tsx 防 FOUC 脚本源码断言 ── */

test("layout.tsx 内联脚本:v9 四 key + dataset/内联 var 写入 + 旧值迁移", () => {
  const src = readSrc("app/layout.tsx");
  assert.ok(src.includes('localStorage.getItem("toiv_theme")'), "缺预设主题 key");
  assert.ok(src.includes('localStorage.getItem("toiv_mode")'));
  assert.ok(src.includes('localStorage.getItem("toiv_theme_custom")'));
  assert.ok(src.includes('localStorage.getItem("toiv_accent_custom")'), "缺自定义强调色 key");
  assert.ok(src.includes('d.dataset.theme=t'), "缺 data-theme 写入");
  assert.ok(src.includes('d.dataset.mode="dark"'));
  assert.ok(src.includes('d.dataset.pureBlack="1"'));
  assert.ok(src.includes('d.dataset.accentCustom="1"'), "缺 data-accent-custom 写入");
  assert.ok(src.includes('setProperty("--accent-user",a)'), "缺内联 --accent-user");
  assert.ok(src.includes('setProperty("--accent-user-on"'), "缺内联 on-accent 推导");
  assert.ok(src.includes("o.pureBlack===true"));
  // v7 旧色板名清除 + 旧 accent 迁移
  assert.ok(src.includes('localStorage.removeItem("toiv_theme")'), "非法预设值应清除");
  assert.ok(src.includes('localStorage.setItem("toiv_accent_custom",o.accent)'), "旧 accent 应迁移");
  // 静态 themeColor 保持浅色默认
  assert.ok(src.includes('themeColor: "#FAFAF9"'));
});

/* ── ⑥ globals.css 源码断言 ── */

test("globals.css v9:paper/cinema/graphite 主题块完整;minimal 为缺省 :root", () => {
  const css = readSrc("app/globals.css");
  // paper:暖纸底 + 墨色 accent(朱色退役,单色纪律)
  const iPaper = css.indexOf('[data-theme="paper"] {');
  assert.ok(iPaper > 0, "缺 paper 主题块");
  const paper = css.slice(iPaper, css.indexOf("\n}", iPaper));
  assert.match(paper, /--bg-canvas: #F5EFE3;/);
  assert.match(paper, /--text-primary: #2B2318;/);
  assert.match(paper, /--accent: #2B2318;/);
  // cinema:RH 荧光绿深黑视觉提升为主题(apps.css RH 块色值的唯一事实源)
  const iCinema = css.indexOf('[data-theme="cinema"] {');
  assert.ok(iCinema > 0, "缺 cinema 主题块");
  const cinema = css.slice(iCinema, css.indexOf("\n}", iCinema));
  assert.match(cinema, /color-scheme: dark;/);
  assert.match(cinema, /--bg-canvas: #0B0D10;/);
  assert.match(cinema, /--accent: #C9F24F;/);
  assert.match(cinema, /--accent-glow: #C9F24F;/, "cinema 点睛触点应为荧光绿");
  assert.match(cinema, /--text-on-accent: #161905;/);
  // graphite:暗色中性深化版,纯白 accent
  const iGraphite = css.indexOf('[data-theme="graphite"] {');
  assert.ok(iGraphite > 0, "缺 graphite 主题块");
  const graphite = css.slice(iGraphite, css.indexOf("\n}", iGraphite));
  assert.match(graphite, /--accent: #FFFFFF;/);
  assert.match(graphite, /--accent-glow: var\(--text-primary\)/, "graphite 点睛触点应中性");
  // v7 旧五色板不复活
  for (const t of ["wood", "mono", "mint", "apricot"]) {
    assert.ok(!css.includes(`[data-theme="${t}"]`), `${t} 色板块不得复活`);
  }
});

test("globals.css:[data-mode=dark] 基础块完整(minimal 暗档 + 亮基底主题共用)", () => {
  const css = readSrc("app/globals.css");
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
  // 绝对锚点 token 保留(accent-custom 派生依赖 --abs-white)
  assert.match(css, /--abs-black: #000000;/);
  assert.match(css, /--abs-white: #FFFFFF;/);
  // 全局暗角已裁决删除,暗角只属舞台容器
  assert.ok(!/body::after\s*\{/.test(css), "全局 body::after 暗角规则应已删除");
  const stage = readSrc("app/styles/stage.css");
  assert.ok(stage.includes(".stage-main::after"), "舞台暗角 .stage-main::after 缺失");
});

test("globals.css:pure-black 门控排除暗基底主题;accent-custom 块 color-mix 派生", () => {
  const css = readSrc("app/globals.css");
  const i = css.indexOf(
    '[data-mode="dark"]:not([data-theme="cinema"]):not([data-theme="graphite"])[data-pure-black="1"] {',
  );
  assert.ok(i > 0, "pure-black 块应排除 cinema/graphite 暗基底主题");
  const block = css.slice(i, css.indexOf("\n}", i));
  assert.match(block, /--bg-canvas: #000000;/);
  // 自定义强调色块:内联 --accent-user 经 color-mix 派生 hover/soft/halo/glow
  const iAc = css.indexOf(":root[data-accent-custom] {");
  assert.ok(iAc > 0, "缺 accent-custom 块");
  const ac = css.slice(iAc, css.indexOf("\n}", iAc));
  assert.match(ac, /--accent: var\(--accent-user\);/);
  assert.match(ac, /--accent-hover: color-mix\(in srgb, var\(--accent-user\)/);
  assert.match(ac, /--accent-soft: color-mix\(in srgb, var\(--accent-user\)/);
  assert.match(ac, /--accent-glow: var\(--accent-user\);/);
  assert.match(ac, /--text-on-accent: var\(--accent-user-on\);/);
  // 噪点暗基底变体:cinema/graphite 同反相
  assert.ok(css.includes('[data-theme="cinema"] body::before'), "缺 cinema 噪点变体");
  assert.ok(css.includes('[data-theme="graphite"] body::before'), "缺 graphite 噪点变体");
});
