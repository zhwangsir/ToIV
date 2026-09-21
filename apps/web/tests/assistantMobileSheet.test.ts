/**
 * 助手 A4 移动端(2026-09-22 批 5,docs/ASSISTANT_UI_REDESIGN_PLAN_20260922.md §三 A4)
 * 源码断言(node:test):
 * ① 全屏 sheet:AssistantOverlay 拖拽把手 + 下滑关闭(SHEET_CLOSE_PX 阈值/跟手位移/
 *   松手清内联弹回);assistant-view.css 尾部 ≤767 sheet 覆盖块(顶部安全边距/
 *   仅顶圆角/av-sheet-in 降临/把手 display+touch-action/命中域外扩)+ reduced-motion 末位豁免
 * ② 桌面 popup 不变式:assistant.css 基座零改动(居中卡 inset/scale 弹窗降临保留),
 *   把手基座规则恒 display:none(桌面 DOM 多一个不可见节点,形态零变化)
 * ③ ⌘K 移动端入口:BottomNav onOpenSearch 抽屉首位「搜索」项(search 图标,
 *   先收抽屉再开),page.tsx 复用同一 setPaletteOpen(true) 通道(不新造 state)
 * ④ composer 工具行断点特化:≤767 触达 var(--touch-target)(值 44px 不变)+
 *   文档次要项折叠(av-composer-docs);popup 会话钮等结构断言不破
 * ⑤ CSS 纪律:A4 追加段零 hex;所耗 token 全部在 globals.css 有定义
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const testDir = dirname(fileURLToPath(import.meta.url));
const webRoot = join(testDir, "..");

function readSrc(rel: string): string {
  return readFileSync(join(webRoot, rel), "utf-8");
}

/** 提取 @media 块文本(花括号配对,支持嵌套规则;与 mobileLayout.test.ts 同款)。 */
function mediaBlock(css: string, query: string): string {
  const i = css.indexOf(`@media ${query}`);
  assert.ok(i >= 0, `缺 ${query} 断点块`);
  const start = css.indexOf("{", i);
  let depth = 0;
  for (let j = start; j < css.length; j++) {
    if (css[j] === "{") depth++;
    else if (css[j] === "}") {
      depth--;
      if (depth === 0) return css.slice(start + 1, j);
    }
  }
  throw new Error(`断点块未闭合: ${query}`);
}

/** 提取某段文本内指定规则声明体(selector 须带「 {」后缀防前缀误配)。 */
function ruleBody(scope: string, selectorBrace: string): string {
  const i = scope.indexOf(selectorBrace);
  assert.ok(i >= 0, `缺规则 ${selectorBrace}`);
  const start = scope.indexOf("{", i);
  const end = scope.indexOf("}", start);
  return scope.slice(start + 1, end);
}

const overlaySrc = readSrc("components/assistant/AssistantOverlay.tsx");
const composerSrc = readSrc("components/assistant/Composer.tsx");
const navSrc = readSrc("components/nav/BottomNav.tsx");
const pageSrc = readSrc("app/page.tsx");
const viewCss = readSrc("app/styles/assistant-view.css");
const overlayCss = readSrc("app/styles/assistant.css");
const globalsCss = readSrc("app/globals.css");

/* A4 追加段(sheet 注释标记者起至文件尾):sheet 基座/keyframes/媒体块/reduced-motion 全在其中 */
const a4Section = viewCss.slice(viewCss.indexOf("/* ───── A4 移动端 sheet"));
assert.ok(a4Section.length > 0, "A4 sheet 追加段缺失");
const sheetMedia = mediaBlock(a4Section, "(max-width: 767px)");
const reducedTail = mediaBlock(a4Section, "(prefers-reduced-motion: reduce)");

/* ── ① 全屏 sheet:结构 + 下滑关闭 ── */

test("AssistantOverlay:sheet 把手渲染于面板内关闭按钮之前 + 下滑关闭手势", () => {
  assert.ok(overlaySrc.includes("av-overlay-sheet-handle"), "把手节点缺失");
  const panelIdx = overlaySrc.indexOf('className="av-overlay-panel"');
  const handleIdx = overlaySrc.indexOf("av-overlay-sheet-handle");
  const closeIdx = overlaySrc.indexOf("av-overlay-close");
  assert.ok(panelIdx >= 0 && handleIdx > panelIdx, "把手须在面板内");
  assert.ok(handleIdx < closeIdx, "把手须在关闭按钮之前(顶部把手区)");
  // 手势:跟手位移 → 松手清内联(交还 CSS transition 弹回)→ 过阈收起
  assert.ok(overlaySrc.includes("const SHEET_CLOSE_PX = 96"), "下滑关闭阈值常量缺失");
  assert.ok(overlaySrc.includes("onTouchStart={onSheetTouchStart}"), "touchstart 未接");
  assert.ok(overlaySrc.includes("onTouchMove={onSheetTouchMove}"), "touchmove 未接");
  assert.ok(overlaySrc.includes("onTouchEnd={onSheetTouchEnd}"), "touchend 未接");
  assert.ok(overlaySrc.includes("onTouchCancel={onSheetTouchEnd}"), "touchcancel 未兜底");
  assert.ok(
    overlaySrc.includes("panelRef.current.style.transform = `translateY(${dy}px)`"),
    "拖拽跟手位移缺失",
  );
  assert.ok(
    overlaySrc.includes('panelRef.current.style.transform = ""'),
    "松手未清内联位移(弹回依赖关态 transition)",
  );
  assert.ok(overlaySrc.includes("if (dy > SHEET_CLOSE_PX) onClose()"), "过阈未触发关闭");
  // Esc/遮罩关闭通道保留
  assert.ok(overlaySrc.includes('e.key === "Escape"'), "Esc 关闭缺失");
  assert.ok(overlaySrc.includes("av-overlay-backdrop"), "遮罩关闭缺失");
});

test("sheet 媒体块(≤767):顶部安全边距 + 仅顶圆角 + sheet 降临动画 + 把手可见", () => {
  const panel = ruleBody(sheetMedia, ".av-overlay-panel {");
  assert.ok(panel.includes("env(safe-area-inset-top"), "顶部未留安全边距");
  assert.ok(
    panel.includes("border-radius: var(--radius-panel) var(--radius-panel) 0 0"),
    "圆角须仅顶部(对齐全局 .sheet)",
  );
  assert.ok(
    panel.includes("transform: translateY(var(--space-8))"),
    "关态应下沉+淡出(替代桌面 scale)",
  );
  const open = ruleBody(sheetMedia, ".av-overlay.is-open .av-overlay-panel {");
  assert.ok(
    open.includes("animation: av-sheet-in var(--duration-base) var(--ease-standard)"),
    "sheet 降临动画缺失",
  );
  assert.ok(viewCss.includes("@keyframes av-sheet-in"), "av-sheet-in keyframes 缺失");
  const handle = ruleBody(sheetMedia, ".av-overlay-sheet-handle {");
  assert.ok(handle.includes("display: block"), "窄屏把手未显示");
  assert.ok(handle.includes("touch-action: none"), "把手未禁触摸滚动(下滑手势被抢)");
  assert.ok(
    sheetMedia.includes(".av-overlay-sheet-handle::before {"),
    "把手命中域外扩缺失(视觉 36×4,触达需外扩)",
  );
  // reduced-motion 豁免置 sheet 媒体块之后(同特异性后至优先)
  assert.ok(reducedTail.includes(".av-overlay.is-open .av-overlay-panel {"), "reduced-motion 未覆盖 sheet");
  assert.ok(reducedTail.includes("animation: none"), "reduced-motion 未停 sheet 动画");
  assert.ok(
    viewCss.lastIndexOf("@media (prefers-reduced-motion: reduce)") >
      viewCss.lastIndexOf("@media (max-width: 767px)"),
    "reduced-motion 豁免块须置 sheet 媒体块之后",
  );
});

/* ── ② 桌面 popup 不变式 ── */

test("桌面 popup 零改动:assistant.css 基座(居中卡/scale 弹窗)未动 + 把手桌面恒隐藏", () => {
  const panel = ruleBody(overlayCss, ".av-overlay-panel {");
  assert.ok(panel.includes("inset: var(--space-4)"), "桌面居中卡 inset 基座被动");
  assert.ok(panel.includes("transform: scale(0.96)"), "桌面关闭落点 scale(.96) 被动");
  assert.ok(
    overlayCss.includes("animation: av-panel-in 400ms cubic-bezier(0.22, 1, 0.36, 1)"),
    "桌面弹窗降临动画被动",
  );
  // 把手基座规则(媒体块外)恒 display:none——桌面形态零变化
  const handleBase = ruleBody(viewCss, ".av-overlay-sheet-handle {");
  assert.ok(handleBase.includes("display: none"), "把手基座须桌面恒隐藏");
  // popup 形态内容未动:variant/关闭按钮/Suspense 启动态
  assert.ok(overlaySrc.includes(`variant="popup"`), "popup 形态传递缺失");
  assert.ok(overlaySrc.includes("fallback={<AssistantBoot />}"), "启动态 fallback 缺失");
});

/* ── ③ ⌘K 移动端入口 ── */

test("BottomNav:onOpenSearch 抽屉首位「搜索」项(search 图标,先收抽屉再开)", () => {
  assert.ok(navSrc.includes("onOpenSearch?: () => void"), "onOpenSearch prop 缺失");
  assert.ok(navSrc.includes('className="more-nav-item bottom-nav-search"'), "搜索项 class 缺失");
  assert.ok(navSrc.includes('name="search"'), "搜索项未用 search 图标");
  assert.ok(navSrc.includes("<span>搜索</span>"), "搜索项文案缺失");
  // 抽屉首位:先于 moreItems 渲染
  assert.ok(
    navSrc.indexOf("bottom-nav-search") < navSrc.indexOf("moreItems.map"),
    "搜索项须位于「更多」抽屉首位",
  );
  // 先收抽屉再开面板(避免抽屉遮罩叠在面板之上)
  const btn = navSrc.slice(navSrc.indexOf("bottom-nav-search"));
  assert.ok(
    btn.indexOf("setMoreOpen(false)") < btn.indexOf("onOpenSearch();"),
    "须先收「更多」抽屉再开命令面板",
  );
});

test("page.tsx:BottomNav 接 onOpenSearch → 同一 setPaletteOpen(true) 通道", () => {
  assert.ok(
    pageSrc.includes("onOpenSearch={() => setPaletteOpen(true)}"),
    "移动搜索入口未复用 ⌘K 打开通道",
  );
  // ⌘K 键盘通道与 SideRail 入口保留(桌面零变化)
  assert.ok(pageSrc.includes("setPaletteOpen((v) => !v)"), "⌘K 键盘开关缺失");
  assert.ok(pageSrc.includes("onOpenPalette={() => setPaletteOpen(true)}"), "SideRail 搜索入口缺失");
});

/* ── ④ composer 工具行断点特化 ── */

test("composer ≤767:触达 var(--touch-target)(44px 值不变)+ 文档次要项折叠", () => {
  // 既有移动块(首个 767 块)composer 钮触控目标 token 化
  const mobile = mediaBlock(viewCss, "(max-width: 767px)");
  const btn = ruleBody(mobile, ".av-composer-btn {");
  assert.ok(btn.includes("width: var(--touch-target)"), "composer 钮未走 --touch-target token");
  assert.ok(btn.includes("height: var(--touch-target)"), "composer 钮高度未 token 化");
  assert.ok(globalsCss.includes("--touch-target: 44px"), "--touch-target 定义缺失(44px)");
  // 文档/附件折叠:页形态文档钮带标记类,≤767 display:none(A4 sheet 媒体块内)
  assert.ok(composerSrc.includes("av-composer-docs"), "文档钮缺折叠标记类");
  const docs = ruleBody(sheetMedia, ".av-composer-docs {");
  assert.ok(docs.includes("display: none"), "窄屏文档次要项未折叠");
  // popup 会话钮结构不破(assistantPopupSessions 钉的不变式复核)
  assert.ok(composerSrc.includes("av-pop-conv-toggle"), "popup 会话钮 class 缺失");
  assert.ok(composerSrc.includes(") : !popup ? ("), "composer popup 分支结构变化");
});

/* ── ⑤ CSS 纪律 ── */

test("A4 追加段零 hex,所耗 token 全部在 globals.css 有定义", () => {
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(a4Section), "A4 追加段出现 hex 色值");
  for (const token of [
    "--space-2",
    "--space-4",
    "--space-6",
    "--space-8",
    "--radius-panel",
    "--duration-base",
    "--ease-standard",
    "--bg-surface-3",
    "--touch-target",
  ]) {
    assert.ok(globalsCss.includes(`${token}:`), `token ${token} 未在 globals.css 定义`);
  }
});
