/**
 * UI 设计调整(2026-08-16 真实浏览器审计驱动,Team D)单测(node:test):
 * ① renderInlineMarkdown:全角引号加粗 / `* *操作` 不吞星 / 正常加粗 / 斜体 /
 *   未闭合原文保留 / 边界规则(开定界符后随空白、闭定界符前空白均不成立)
 * ② AssistantView 滚动复位:门户空态不沉底,isEmpty 分支 scrollTop=0(源码断言)
 * ③ GenerateView:段控组「模式」/ 下拉「引擎」不再同名重复(源码断言)
 * ④ ThemePicker 同页总线:apply* 广播 toiv:theme-changed,两订阅实例状态一致
 *   (机制功能测试:假 window 事件总线)+ 订阅源码断言;跨页 storage 通道不动
 * ⑤ BottomNav 桌面退场:sheet/overlay 断点类 + ≥1024px display:none +
 *   闭合态 visibility:hidden 移出 tab 序(源码断言)
 * ⑥ app/error.tsx:路由级错误边界结构(err-* 面板 + 重试 + 返回首页,源码断言)
 * ⑦ 暗色微调:--text-muted 提亮 #9A9EA6(AA)+ global-error 镜像;视频徽章恒白字+
 *   描边;账户卡说明行;自由取色圈与预设色丸同盒(源码断言)
 * ⑧ 作品库工具条:类型/分级/排序组间 hairline 分隔(源码断言)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ThemeChangedDetail } from "../lib/theme";

const h = React.createElement;
const testDir = dirname(fileURLToPath(import.meta.url));
const webRoot = join(testDir, "..");

function readSrc(rel: string): string {
  return readFileSync(join(webRoot, rel), "utf-8");
}

/* ── 假 DOM(导入组件模块前装好;localStorage/document/getComputedStyle 三通道,
      外加同页事件总线 addEventListener/dispatchEvent 供 ④ 使用) ── */
const store = new Map<string, string>();
const inlineVars = new Map<string, string>();
const dataset: Record<string, string> = {};
type Handler = (e: Event) => void;
const bus = new Map<string, Set<Handler>>();

const g = globalThis as {
  window?: unknown;
  localStorage?: unknown;
  document?: unknown;
  getComputedStyle?: unknown;
  addEventListener?: unknown;
  removeEventListener?: unknown;
  dispatchEvent?: unknown;
};
const fakeLocalStorage = {
  getItem: (k: string): string | null => store.get(k) ?? null,
  setItem: (k: string, v: string): void => void store.set(k, v),
  removeItem: (k: string): void => void store.delete(k),
  clear: (): void => store.clear(),
};
g.window ??= globalThis;
g.localStorage = fakeLocalStorage;
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
  getPropertyValue: (k: string): string => (k === "--bg-canvas" ? "#FAFAF9" : ""),
});
g.addEventListener = (type: string, fn: Handler): void => {
  const set = bus.get(type) ?? new Set<Handler>();
  set.add(fn);
  bus.set(type, set);
};
g.removeEventListener = (type: string, fn: Handler): void => {
  bus.get(type)?.delete(fn);
};
g.dispatchEvent = (e: Event): boolean => {
  for (const fn of bus.get(e.type) ?? []) fn(e);
  return true;
};

const { renderInlineMarkdown } = await import("../components/assistant/AssistantView");
const { applyCustom, applyMode, THEME_CHANGED_EVENT } = await import("../lib/theme");

/** renderInlineMarkdown 输出 → 静态 HTML(Fragment 包裹,与气泡渲染同形态)。 */
function md(text: string): string {
  return renderToStaticMarkup(h(React.Fragment, null, ...renderInlineMarkdown(text)));
}

/* ── ① 助手气泡行内 markdown ── */

test("markdown:全角引号加粗整体成立,字面 ** 不泄漏", () => {
  // 审计原始 fixture:全角引号(U+201C/201D)不得截断加粗;ASCII 引号变体走 React &quot; 转义同样成立
  const html = md("目前**没有直接针对视频文件的“视频超分”工具**,请知悉");
  assert.equal((html.match(/<strong>/g) ?? []).length, 1);
  assert.ok(html.includes('<strong>没有直接针对视频文件的“视频超分”工具</strong>'), html);
  assert.ok(!html.includes("**"), "加粗标记不得原样泄漏");

  const ascii = md('目前**没有直接针对视频文件的"视频超分"工具**,请知悉');
  assert.ok(ascii.includes("<strong>没有直接针对视频文件的&quot;视频超分&quot;工具</strong>"), ascii);
});

test("markdown:`* *操作:…` 开定界符后随空白不成立,星号不被吞掉", () => {
  const html = md("* *操作: 先检查服务状态*");
  assert.ok(html.startsWith("* "), `前导星号+空格应保留原文: ${html}`);
  assert.ok(html.includes("<em>操作: 先检查服务状态</em>"), html);
});

test("markdown:正常加粗 / 斜体 / 加粗内嵌单星斜体", () => {
  const bold = md("前文 **重点内容** 后文");
  assert.ok(bold.includes("<strong>重点内容</strong>"), bold);
  assert.ok(!bold.includes("**"));

  const italic = md("提示:*斜体词* 尾");
  assert.ok(italic.includes("<em>斜体词</em>"), italic);

  const nested = md("**操作: *详见* 文档**");
  assert.ok(nested.includes("<strong>操作: <em>详见</em> 文档</strong>"), nested);
});

test("markdown:未闭合/内侧空白一律按原文保留,不产生残缺标签", () => {
  const unclosed = md("这是 **没有闭合的标记");
  assert.ok(!unclosed.includes("<strong>"), unclosed);
  assert.ok(unclosed.includes("**没有闭合的标记"), "未闭合标记应原文保留");

  assert.ok(!md("** 空白开头**").includes("<strong>"), "开定界符后随空白不成立");
  assert.ok(!md("**尾部空白 **").includes("<strong>"), "闭定界符前是空白不成立");
});

test("markdown:仅助手气泡走渲染器,用户消息纯文本直出(源码断言)", () => {
  const src = readSrc("components/assistant/AssistantView.tsx");
  assert.ok(
    src.includes('msg.role === "assistant" ? renderInlineMarkdown(msg.content) : msg.content'),
    "用户消息不得经 markdown(避免 2*3*5 误斜体)",
  );
});

/* ── ② 首页滚动复位 ── */

test("AssistantView 滚动:门户空态 scrollTop 归零,会话态才沉底(源码断言)", () => {
  const src = readSrc("components/assistant/AssistantView.tsx");
  assert.ok(src.includes("if (isEmpty) {"), "缺 isEmpty 门户分支");
  assert.ok(src.includes("el.scrollTop = 0;"), "门户首页必须顶对齐");
  assert.ok(src.includes("el.scrollTop = el.scrollHeight;"), "会话态保留沉底");
  assert.ok(src.includes("[messages, busy, isEmpty]"), "effect 依赖须含 isEmpty");
});

/* ── ③ GenerateView 段控「模式」/ 下拉「引擎」 ── */

test("GenerateView:段控组标题「模式」,下拉保持「引擎」,不再双引擎(源码断言)", () => {
  const src = readSrc("components/generate/GenerateView.tsx");
  assert.ok(
    src.includes('<h3 className="params-section-title">模式</h3>'),
    "文生/图生段控组应挂「模式」标题",
  );
  assert.ok(
    !src.includes('<h3 className="params-section-title">引擎</h3>'),
    "「引擎」小节标题与下拉标签重复,应移除",
  );
  assert.ok(src.includes('<Field label="引擎">'), "下拉保持「引擎」标签");
  // 段控只在两组引擎并存时显示,标题随段控一并门控
  assert.ok(src.includes("showGroupTabs &&"), "模式小节须随 showGroupTabs 门控");
});

/* ── ④ ThemePicker 同页总线 ── */

test("同页总线:apply* 广播 toiv:theme-changed,两个订阅实例状态一致", () => {
  store.clear();
  // 模拟同页两个 ThemePicker 实例:各自维护本地选中态,订阅同一事件
  const makeInstance = () => {
    const state: { mode?: string; custom?: unknown } = {};
    const onChanged = (e: Event) => {
      const d = (e as CustomEvent<ThemeChangedDetail>).detail;
      if (!d) return;
      if (d.mode) state.mode = d.mode;
      if (d.custom) state.custom = d.custom;
    };
    window.addEventListener(THEME_CHANGED_EVENT, onChanged);
    return state;
  };
  const instA = makeInstance();
  const instB = makeInstance();

  // v8:只剩模式 + 纯黑子档两个维度
  applyMode("dark");
  applyCustom({ pureBlack: true });

  for (const [name, inst] of [["实例A", instA], ["实例B", instB]] as const) {
    assert.equal(inst.mode, "dark", `${name} 模式未同步`);
    assert.deepEqual(inst.custom, { pureBlack: true }, `${name} 纯黑子档未同步`);
  }

  // 关闭纯黑:广播空对象(清洗后契约)
  applyCustom({});
  assert.deepEqual(instA.custom, {}, "广播值必须是清洗后的 custom");
});

test("同页总线:ThemePicker 订阅 THEME_CHANGED_EVENT;跨页 storage 通道保留(源码断言)", () => {
  const picker = readSrc("components/ui/ThemePicker.tsx");
  assert.ok(picker.includes("THEME_CHANGED_EVENT"), "ThemePicker 未导入总线事件");
  assert.ok(
    picker.includes("window.addEventListener(THEME_CHANGED_EVENT"),
    "ThemePicker 未订阅同页总线",
  );
  assert.equal(
    (picker.match(/useCrossTabSync\(/g) ?? []).length,
    2, // v8:色板通道退役,只剩 mode + custom 两通道
    "跨标签页 storage 同步两通道不得删",
  );

  const theme = readSrc("lib/theme.ts");
  assert.ok(theme.includes('THEME_CHANGED_EVENT = "toiv:theme-changed"'));
  // v8:applyTheme/applyCustom accent 退役,只剩 applyMode + applyCustom(pureBlack) 两条广播
  assert.ok(theme.includes("broadcastThemeChanged({ mode })"), "applyMode 缺广播");
  assert.ok(theme.includes("broadcastThemeChanged({ custom: c })"), "applyCustom 缺广播");
});

/* ── ⑤ BottomNav 桌面退场 ── */

test("BottomNav:sheet/overlay 带断点门控类,桌面 ≥1024px 整体 display:none(源码断言)", () => {
  const tsx = readSrc("components/nav/BottomNav.tsx");
  assert.ok(tsx.includes("bottom-nav-overlay"), "overlay 缺断点门控类");
  assert.ok(tsx.includes("bottom-nav-sheet"), "sheet 缺断点门控类");
  assert.ok(tsx.includes("aria-hidden={!moreOpen}"), "sheet 闭合态须 aria-hidden");

  const css = readSrc("app/globals.css");
  const iMedia = css.indexOf("@media (min-width: 1024px)");
  assert.ok(iMedia > 0, "缺 ≥1024px 桌面断点块");
  const block = css.slice(iMedia, css.indexOf("\n}", iMedia));
  assert.ok(block.includes(".bottom-nav-overlay") && block.includes(".bottom-nav-sheet"), block);
  assert.ok(block.includes("display: none"), "桌面端 sheet/overlay 必须 display:none");
});

test("BottomNav:sheet 闭合态 visibility:hidden 移出 tab 序,滑出动画播完再隐藏(源码断言)", () => {
  const css = readSrc("app/globals.css");
  const iSheet = css.indexOf(".sheet {");
  const sheetBlock = css.slice(iSheet, css.indexOf("\n}", iSheet));
  assert.ok(sheetBlock.includes("visibility: hidden;"), "闭合 sheet 须 visibility:hidden");
  assert.ok(
    sheetBlock.includes("visibility 0s linear var(--duration-base)"),
    "visibility 须延迟到滑出动画结束后切换",
  );
  const iOpen = css.indexOf(".sheet.is-open {");
  const openBlock = css.slice(iOpen, css.indexOf("\n}", iOpen));
  assert.ok(openBlock.includes("visibility: visible;"), "打开态恢复可见");
  assert.ok(openBlock.includes("transition-delay: 0s;"), "打开态立即响应");
});

/* ── ⑥ 路由级 error.tsx ── */

test("app/error.tsx:路由级错误边界(err-* 面板 + 重试 + 返回首页,源码断言)", () => {
  const src = readSrc("app/error.tsx");
  assert.ok(src.includes('"use client"'), "error.tsx 必须是客户端组件");
  assert.ok(src.includes("reset"), "须接 Next reset 注入");
  assert.ok(src.includes('className="err-boundary"'), "复用 err-boundary 视觉基座");
  assert.ok(src.includes('role="alert"'), "缺 alert 语义");
  assert.ok(src.includes("onClick={reset}"), "缺重试按钮");
  assert.ok(src.includes('window.location.href = "/"'), "缺返回首页");
  assert.ok(src.includes("Sentry.captureException"), "缺 Sentry 上报(与 global-error 同约定)");
});

/* ── ⑦ 暗色微调 ── */

test("暗色 --text-muted 提亮一档 #9A9EA6(AA),global-error 内联镜像同步(源码断言)", () => {
  const css = readSrc("app/globals.css");
  const iDark = css.indexOf('[data-mode="dark"] {');
  const darkBlock = css.slice(iDark, css.indexOf("\n}", iDark));
  assert.ok(darkBlock.includes("--text-muted: #9A9EA6;"), "暗色 muted 未提亮");
  assert.ok(!css.includes("#8B8E95"), "旧 muted 值不得残留");

  const ge = readSrc("app/global-error.tsx");
  assert.ok(ge.includes('"#9A9EA6"'), "global-error 暗色 muted 镜像未同步");
  assert.ok(!ge.includes("#8B8E95"), "global-error 旧值残留");
});

test("作品库视频徽章:恒白字 + hairline 描边,不随 --text-on-accent 暗色翻深(源码断言)", () => {
  const css = readSrc("app/styles/library.css");
  const i = css.indexOf(".lib-video-badge {");
  const block = css.slice(i, css.indexOf("\n}", i));
  assert.ok(block.includes("color: var(--abs-white);"), "徽章文字须恒白");
  assert.ok(block.includes("border: 1px solid var(--border-strong);"), "徽章须描边");
  assert.ok(!block.includes("var(--text-on-accent)"), "暗色翻深的 token 不得用于恒深 scrim 上");
});

test("设置页账户卡:补说明行填充大片空白(源码断言)", () => {
  const view = readSrc("components/settings/SettingsView.tsx");
  assert.ok(view.includes("settings-account-desc"), "账户卡缺说明行");
  const css = readSrc("app/styles/settings.css");
  assert.ok(css.includes(".settings-account-desc"), "说明行样式缺失");
});

test("参数浮板分节:params-section/params-section-title 必须有 CSS 定义(源码断言)", () => {
  // 2026-08-16 审计发现:GenerateView 用 params-section/params-section-title 组织
  // 「模式/引擎」「参考输入」「生成参数」小节,但 stage.css 无任何定义 → 多个
  // ui-field 无间距挤在一起、section 之间无分隔。此测试防回归:类名一旦被重命名
  // 或样式被误删,立即失败。
  const css = readSrc("app/styles/stage.css");
  const i = css.indexOf(".params-section {");
  assert.ok(i > -1, "stage.css 缺 .params-section 定义");
  const block = css.slice(i, css.indexOf("\n}", i));
  assert.ok(block.includes("display: flex;"), "params-section 须 flex 列布局");
  assert.ok(block.includes("gap: var(--space-3)"), "params-section 须有 12px 间距");
  assert.ok(css.includes(".params-section + .params-section"), "缺分节 hairline 规则");
  const j = css.indexOf(".params-section-title {");
  assert.ok(j > -1, "stage.css 缺 .params-section-title 定义");
  const titleBlock = css.slice(j, css.indexOf("\n}", j));
  assert.ok(titleBlock.includes("margin: 0"), "小节标题须清默认 margin");
});

test("loading-spinner:globals.css 必须定义(OptimizeButton/ReverseButton/AvatarTalkView 复用)", () => {
  // 2026-08-16 审计发现:三个组件注释声称「复用全局 .loading-spinner」,
  // 但 globals.css 从未定义 → loading 图标不旋转。此测试防回归。
  const css = readSrc("app/globals.css");
  const i = css.indexOf(".loading-spinner {");
  assert.ok(i > -1, "globals.css 缺 .loading-spinner 定义");
  assert.ok(css.includes(".loading-spinner > *"), "缺子元素 spin 动画规则");
});

/* ── ⑧ 作品库工具条组间分隔 ── */

test("作品库工具条:类型/分级/排序/批量组间 hairline 分隔(源码断言)", () => {
  const view = readSrc("components/library/LibraryView.tsx");
  // 2026-08-16 视图批 1:四组结构(类型过滤 | 内容门控 | 排序与视图 | 批量管理),
  // 组间交界须三条分隔(批量管理前补一条)
  assert.equal(
    (view.match(/lib-toolbar-divider/g) ?? []).length,
    3,
    "类型过滤 / 内容分级 / 排序与视图 / 批量管理 四处交界须三条分隔",
  );
  const css = readSrc("app/styles/library.css");
  const i = css.indexOf(".lib-toolbar-divider {");
  const block = css.slice(i, css.indexOf("\n}", i));
  assert.ok(block.includes("width: 1px;") && block.includes("var(--border-subtle)"), block);
});
