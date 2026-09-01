/**
 * Studio Console v1(2026-08-31)新骨架组件单测(node:test + renderToStaticMarkup):
 * ① SideRail:8 主项渲染/当前项 aria-current+指示条/tooltip/⌘K 钮/admin 区分隔/窄屏隐藏
 * ② CommandPalette:打开渲染输入框+页面条目;admin 项门控;Esc/Enter/方向键;空结果态
 * ③ globals.css:app-shell grid 双列(52px rail)+ 窄屏单列回退 + app-main 顶部 chrome 带移除
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { SideRail, type RailItem } from "../components/nav/SideRail";
import { CommandPalette } from "../components/nav/CommandPalette";

const h = React.createElement;
const testDir = dirname(fileURLToPath(import.meta.url));
const webRoot = join(testDir, "..");
const readSrc = (rel: string) => readFileSync(join(webRoot, rel), "utf-8");

const ITEMS: RailItem[] = [
  { key: "home", label: "对话", icon: "chat" },
  { key: "image", label: "图片", icon: "image" },
  { key: "video", label: "视频", icon: "video" },
];

/* ── ① SideRail ── */

test("SideRail:主项渲染 + 当前项 aria-current + tooltip + ⌘K 搜索钮", () => {
  const html = renderToStaticMarkup(
    h(SideRail, { items: ITEMS, current: "video", onSelect: () => {}, onOpenPalette: () => {} }),
  );
  // 三主项 + 搜索钮
  assert.equal((html.match(/class="siderail-item/g) ?? []).length, 4);
  // 当前项指示
  assert.match(html, /siderail-item is-active/);
  assert.match(html, /aria-current="page"/);
  // tooltip 文案
  for (const label of ["对话", "图片", "视频"]) {
    assert.ok(html.includes(`role="tooltip">${label}<`), `缺 ${label} tooltip`);
  }
  // ⌘K 唤起钮
  assert.ok(html.includes("搜索与命令面板(⌘K)"), "缺 ⌘K 唤起钮");
});

test("SideRail:adminItems 独立分隔区渲染;窄屏 <1024px 隐藏", () => {
  const html = renderToStaticMarkup(
    h(SideRail, {
      items: ITEMS, current: "home", onSelect: () => {},
      adminItems: [{ key: "admin", label: "管理", icon: "shield-check" }],
      onOpenPalette: () => {},
    }),
  );
  assert.ok(html.includes("siderail-group--admin"), "admin 项缺独立分隔区");
  assert.ok(html.includes("管理"), "admin 项未渲染");
  const css = readSrc("app/styles/siderail.css");
  assert.ok(css.includes("@media (max-width: 1023px)"), "缺窄屏断点");
  assert.ok(/@media \(max-width: 1023px\)\s*\{\s*\.siderail\s*\{\s*display:\s*none/.test(css), "窄屏左栏应隐藏");
});

/* ── ② CommandPalette ── */

test("CommandPalette:open 渲染输入框+页面条目;admin 项按权限门控", () => {
  const open = renderToStaticMarkup(
    h(CommandPalette, { open: true, onClose: () => {}, onNavigate: () => {}, isAdmin: true }),
  );
  assert.ok(open.includes("cmdk-input"), "缺输入框");
  assert.ok(open.includes('role="dialog"'), "缺 dialog 语义");
  assert.ok(open.includes("创作工作室"), "缺工作室条目");
  assert.ok(open.includes("观测"), "admin 应看到观测");
  assert.ok(open.includes("新对话"), "缺新对话动作");

  const nonAdmin = renderToStaticMarkup(
    h(CommandPalette, { open: true, onClose: () => {}, onNavigate: () => {}, isAdmin: false }),
  );
  assert.ok(!nonAdmin.includes("观测"), "非 admin 不应看到观测");
  assert.ok(!nonAdmin.includes("管理"), "非 admin 不应看到管理");

  const closed = renderToStaticMarkup(
    h(CommandPalette, { open: false, onClose: () => {}, onNavigate: () => {}, isAdmin: true }),
  );
  assert.equal(closed, "", "关闭态不渲染任何内容");
});

test("CommandPalette:键盘契约源码(↑↓/Enter/Esc)+ 跨组件事件常量", () => {
  const src = readSrc("components/nav/CommandPalette.tsx");
  for (const k of ['"ArrowDown"', '"ArrowUp"', '"Enter"', '"Escape"']) {
    assert.ok(src.includes(k), `缺 ${k} 键处理`);
  }
  assert.ok(src.includes('EV_NEW_CHAT = "toiv:new-chat"'), "缺新对话事件");
  assert.ok(src.includes('EV_OPEN_SESSION = "toiv:open-session"'), "缺开会话事件");
  assert.ok(src.includes("PENDING_SESSION_KEY"), "缺跨视图暂存键");
});

/* ── ③ globals.css 壳层 ── */

test("globals.css:app-shell 双列 grid(52px rail)+ 窄屏单列回退 + 顶部 chrome 带移除", () => {
  const css = readSrc("app/globals.css");
  assert.ok(css.includes('"rail main"'), "app-shell 缺 rail/main 双列区");
  assert.ok(css.includes("grid-template-columns: 52px 1fr"), "缺 52px 栏宽");
  // 窄屏回退单列
  const narrow = css.slice(css.indexOf("@media (max-width: 1023px)"));
  assert.ok(narrow.includes("grid-template-columns: 1fr"), "窄屏应回退单列");
  // app-main 顶部 56px chrome 带退役
  const main = cssBlock(css, ".app-main");
  assert.ok(main.includes("padding-top: 0"), "app-main 顶部 chrome 带应移除");
});

/** 提取 css 中 selector 规则块(与 mobileLayout.test.ts 同手法,花括号配对)。 */
function cssBlock(css: string, selector: string): string {
  const i = css.indexOf(selector);
  assert.ok(i >= 0, `缺选择器 ${selector}`);
  const start = css.indexOf("{", i);
  return css.slice(start + 1, css.indexOf("}", start));
}
