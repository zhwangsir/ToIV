/**
 * UI-B 视图组件单测(node:test + react-dom/server 静态渲染):
 * ① ModelsView:响应式两档类名/媒体查询、ErrorBar/LoadingBlock 接入断言
 * ② Ripple 在 PromptBar(生成主按钮)与 GenerateView(参数 FAB)的包裹断言
 * ③ ResourcesView:ErrorBoundary 内层包裹(key=tab 自动复位)断言
 * ④ FusionView:bento 卡入场态(is-mounted/--delay)+ fusion.css focus-visible 断言
 * ⑤ LibraryView:空态结构类名 + library.css display/字重/scrim 色 token 收编断言
 * ⑥ stage.css:z-index 裸值清零(语义档)、display/字重/时长 token 收编断言
 * 说明:node 无 DOM,断言分两类——
 *   - 渲染断言(renderToStaticMarkup,组件经 tests/loader.mjs 转译加载 .tsx)
 *   - 源码断言(fs.readFileSync,验证组件/CSS 文件中保留了 UI-A 规范要求的结构)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { PromptBar } from "../components/generate/PromptBar";
import { Ripple } from "../components/ui/Ripple";

const h = React.createElement;
const testDir = dirname(fileURLToPath(import.meta.url));
const webRoot = join(testDir, "..");

function readSrc(rel: string): string {
  return readFileSync(join(webRoot, rel), "utf-8");
}

/* ── ① ModelsView ── */
test("ModelsView 响应式类名存在 + 1023/767 两档媒体查询", () => {
  const src = readSrc("components/models/ModelsView.tsx");
  assert.ok(src.includes('"mv-market-grid"'), "市场网格类名缺失");
  assert.ok(src.includes('"mv-model-row"'), "模型行类名缺失");
  assert.ok(src.includes('"mv-groups"'), "分组容器类名缺失");
  assert.ok(src.includes("@media (max-width: 1023px)"), "缺少 1023px 响应式档(市场栅格降级)");
  assert.ok(src.includes("@media (max-width: 767px)"), "缺少 767px 响应式档(分组单列化/触控目标)");
});

test("ModelsView 错误态接入 ErrorBar(受控 onClose)", () => {
  const src = readSrc("components/models/ModelsView.tsx");
  assert.ok(src.includes("import { ErrorBar }"), "未导入 ErrorBar");
  assert.ok(src.includes("onClose={() => setLocalError(null)}"), "本地错误未接受控关闭");
  assert.ok(src.includes("onClose={() => setMarketError(null)}"), "市场错误未接受控关闭");
});

test("ModelsView 加载态接入 LoadingBlock(line + grid 双变体)", () => {
  const src = readSrc("components/models/ModelsView.tsx");
  assert.ok(src.includes("import { LoadingBlock }"), "未导入 LoadingBlock");
  assert.ok(src.includes('variant="line"'), "本地加载缺少 line 骨架");
  assert.ok(src.includes('variant="grid"'), "市场加载缺少 grid 骨架");
});

/* ── ② Ripple 包裹 ── */
test("PromptBar 生成主按钮被 Ripple 包裹(render 断言)", () => {
  // engine=null:跳过 OptimizeButton/ReverseButton(ReverseButton 需 ToastProvider,
  // 与 Ripple 包裹断言无关);生成按钮与引擎无关恒渲染
  const html = renderToStaticMarkup(
    h(PromptBar, {
      value: "test",
      onChange: () => {},
      engine: null,
      engines: [],
      onEngineChange: () => {},
      sizeParams: [],
      values: {},
      onValueChange: () => {},
      optimizeKind: "image",
      onOptimized: () => {},
      canSubmit: true,
      isRunning: false,
      submitting: false,
      submitError: null,
      onGenerate: () => {},
      onCancel: () => {},
    }),
  );
  assert.match(html, /ui-ripple/, "PromptBar 未渲染 Ripple 宿主");
  assert.match(html, /promptbar-submit/, "PromptBar 未渲染生成主按钮");
});

test("Ripple radius=full + className 变体渲染(参数 FAB 范式)", () => {
  const html = renderToStaticMarkup(
    h(Ripple, {
      radius: "full",
      className: "generate-params-fab",
      children: h("button", { className: "generate-params-fab-btn", "aria-label": "x" }, "×"),
    }),
  );
  assert.match(html, /ui-ripple--full/);
  assert.match(html, /generate-params-fab/);
  assert.match(html, /generate-params-fab-btn/);
});

test("GenerateView 参数 FAB 被 Ripple radius=full 包裹(源码断言)", () => {
  const src = readSrc("components/generate/GenerateView.tsx");
  assert.ok(src.includes('import { Ripple }'), "GenerateView 未导入 Ripple");
  assert.ok(src.includes('radius="full"'), "FAB 未使用 radius=full");
  assert.ok(src.includes('className="generate-params-fab"'), "FAB 类名未挂在 Ripple 宿主");
  assert.ok(src.includes('className="generate-params-fab-btn"'), "FAB 内层按钮类名缺失");
});

/* ── ③ ResourcesView ErrorBoundary ── */
test("ResourcesView 内容区被 ErrorBoundary 包裹(key=tab 自动复位)", () => {
  const src = readSrc("components/resources/ResourcesView.tsx");
  assert.ok(src.includes("import { ErrorBoundary }"), "ResourcesView 未导入 ErrorBoundary");
  assert.ok(src.includes("key={tab}"), "ErrorBoundary 未绑定 tab key(切换不重置)");
  assert.ok(src.includes("viewName"), "ErrorBoundary 未传 viewName");
});

/* ── ④ FusionView 入场 + focus-visible ── */
test("FusionView bento 卡入场态 + fusion.css hover/focus-visible 同档", () => {
  const src = readSrc("components/fusion/FusionView.tsx");
  assert.ok(src.includes("is-mounted"), "缺少 is-mounted 入场类名");
  assert.ok(src.includes("--delay"), "缺少 --delay 入场错峰样式");

  const css = readSrc("app/styles/fusion.css");
  assert.ok(css.includes(":focus-visible"), "fusion.css 缺少 focus-visible 态");
  assert.ok(css.includes(":hover"), "fusion.css 缺少 hover 态");
  assert.ok(css.includes("--duration-fast"), "fusion.css 动效未走 token");
  assert.ok(!/font-weight:\s*\d+;/.test(css), "fusion.css 字重硬编码未收编");
});

/* ── ⑤ LibraryView 空态 / 操作条 / scrim token ── */
test("LibraryView 空态结构类名 + library.css token 收编", () => {
  const src = readSrc("components/library/LibraryView.tsx");
  assert.ok(src.includes('"lib-empty-display"'), "空态标题类名缺失");
  assert.ok(src.includes('"lib-empty-icon"'), "空态图标类名缺失");
  assert.ok(src.includes('"lib-actions"'), "hover 快捷操作组类名缺失");
  assert.ok(src.includes('"lib-card-title"'), "卡片提示词标题类名缺失");

  // library.css:32px → var(--text-display-md);650 → var(--font-semibold);#FFFFFF → var(--text-on-accent)
  const css = readSrc("app/styles/library.css");
  assert.ok(!css.includes("font-size: 32px"), "空态 32px 硬编码未收编");
  assert.ok(!css.includes("font-weight: 650"), "650 字重硬编码未收编");
  assert.ok(!css.includes("color: #FFFFFF"), "scrim #FFFFFF 硬编码未收编");
  assert.ok(css.includes("var(--text-display-md)"), "空态 display token 未接入");
  assert.ok(css.includes("var(--font-semibold)"), "semibold 字重 token 未接入");
  assert.ok(css.includes("var(--text-on-accent)"), "scrim 文字色 token 未接入");
});

/* ── ⑥ stage.css:z-index / display token / 字重收编 ── */
test("stage.css z-index 裸值收编为语义档位、display/字重 token 化", () => {
  const css = readSrc("app/styles/stage.css");
  // 裸值已清零(仅保留 --z-stage-* 语义变量)
  assert.ok(!/z-index:\s*\d+;/.test(css), "stage.css 仍存在 z-index 裸值");
  assert.ok(css.includes("--z-stage-scrim"), "缺少 --z-stage-scrim 语义档");
  assert.ok(css.includes("--z-stage-status"), "缺少 --z-stage-status 语义档");
  assert.ok(css.includes("--z-stage-dock"), "缺少 --z-stage-dock 语义档");
  assert.ok(css.includes("--z-stage-sheet"), "缺少 --z-stage-sheet 语义档");
  // 40px → var(--text-display-lg);650 → var(--font-semibold);1.2s → var(--duration-loop)
  assert.ok(!css.includes("font-size: 40px"), "40px display 硬编码未收编");
  assert.ok(!css.includes("font-weight: 650"), "650 字重硬编码未收编");
  // 2026-08-16 视图批 1:空态主标题 display 档降为标题档(var(--text-title));
  // display 档仅剩移动档覆盖(@media ≤767px,Team D 移动区)
  assert.ok(css.includes("var(--text-title)"), "空态标题档 token 未接入");
  assert.ok(css.includes("var(--font-semibold)"), "semibold 字重 token 未接入");
  assert.ok(css.includes("var(--duration-loop)"), "loop 时长 token 未接入");
});
