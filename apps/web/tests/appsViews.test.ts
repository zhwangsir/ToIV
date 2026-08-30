/**
 * 应用市场(M3)视图单测(node:test + react-dom/server 静态渲染 + 源码断言):
 * ① AppMarketView:加载态 grid 骨架渲染;三区/fork 门控/NSFW 过滤/三态接线源码断言
 * ② AppRunnerView:加载态 line 骨架渲染;ParamField 复用/trackJob/runApp/下载源码断言
 * ③ page.tsx 入口注册(importer/VALID_VIEWS/VIEW_META/灵动岛/BottomNav 更多/渲染分支)
 * ④ Icon.tsx store 图标;apps.css token 纪律(零 hex、断点 -1 约定、触达 44px)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { AppMarketView } from "../components/apps/AppMarketView";
import { AppRunnerView } from "../components/apps/AppRunnerView";
import { ToastProvider } from "../components/ui/Toast";

const h = React.createElement;
const testDir = dirname(fileURLToPath(import.meta.url));
const webRoot = join(testDir, "..");

function readSrc(rel: string): string {
  return readFileSync(join(webRoot, rel), "utf-8");
}

/* ── ① AppMarketView ── */

test("AppMarketView 初始加载态渲染 grid 骨架(ui-loading--grid)", () => {
  const html = renderToStaticMarkup(h(ToastProvider, null, h(AppMarketView)));
  assert.match(html, /ui-loading--grid/, "市场加载态应为卡片网格骨架");
});

test("AppMarketView 三区(内置/公共/我的)+ fork 门控 + 打开按钮(源码)", () => {
  const src = readSrc("components/apps/AppMarketView.tsx");
  assert.ok(src.includes("内置应用"), "缺内置区");
  assert.ok(src.includes("公共应用"), "缺公共区");
  assert.ok(src.includes("我的应用"), "缺我的区");
  assert.ok(src.includes("splitAppSections"), "三区划分应复用 lib/apps helper");
  // fork 门控:非内置且非本人才显示
  assert.ok(src.includes("!a.is_builtin && !a.is_mine"), "fork 按钮门控缺失");
  assert.ok(src.includes("forkApp"), "未接 forkApp");
  // 卡片要素:类别徽标 + 用量计数 + 打开
  assert.ok(src.includes("apps-tag"), "缺类别徽标");
  assert.ok(src.includes("apps-usage"), "缺用量计数");
  assert.ok(src.includes("打开"), "缺「打开」按钮");
});

test("AppMarketView 三态接线:Empty/ErrorBar/LoadingBlock + NSFW 客户端过滤(源码)", () => {
  const src = readSrc("components/apps/AppMarketView.tsx");
  assert.ok(src.includes('import { Empty }'), "未导入 Empty(空态)");
  assert.ok(src.includes('import { ErrorBar }'), "未导入 ErrorBar(错误态)");
  assert.ok(src.includes('import { LoadingBlock }'), "未导入 LoadingBlock(加载态)");
  assert.ok(src.includes("useR18Mode"), "NSFW 过滤应读 R18 模式");
  assert.ok(src.includes("filterApps"), "过滤应复用 lib/apps filterApps(含 NSFW 门控)");
  assert.ok(src.includes('import "@/app/styles/apps.css"'), "未引入 apps.css");
  // 检索工具栏:搜索 + 分类 chips
  assert.ok(src.includes('role="search"'), "缺搜索工具栏语义");
  assert.ok(src.includes("CATEGORY_CHIPS"), "缺分类 chips");
});

/* ── ② AppRunnerView ── */

test("AppRunnerView 初始加载态渲染 line 骨架(ui-loading--line)", () => {
  const html = renderToStaticMarkup(
    h(ToastProvider, null, h(AppRunnerView, { appId: "a1", onBack: () => {} })),
  );
  assert.match(html, /ui-loading--line/, "运行页加载态应为行骨架");
});

test("AppRunnerView 复用 ParamField 渲染 params_schema(不私造 AppParamField)", () => {
  const src = readSrc("components/apps/AppRunnerView.tsx");
  assert.ok(
    src.includes('import { ParamField } from "@/components/generate/ParamField"'),
    "应直接复用 generate/ParamField",
  );
  assert.ok(src.includes("<ParamField"), "params_schema 应经 ParamField 渲染");
  assert.ok(!/function AppParamField|const AppParamField/.test(src), "不应私造 AppParamField");
});

test("AppRunnerView 提交链:buildRunValues 载荷 → runApp → trackJob(禁用原因提示)", () => {
  const src = readSrc("components/apps/AppRunnerView.tsx");
  assert.ok(src.includes("buildRunValues"), "提交载荷应经 buildRunValues 归一");
  assert.ok(src.includes("runApp(app.id"), "应调 runApp(POST /run)");
  assert.ok(src.includes("trackJob("), "应复用 lib/trackJob 跟踪作业");
  assert.ok(src.includes("requiredParamLabel"), "必填缺口应卡控提交");
  assert.ok(src.includes("disabledReason"), "禁用原因提示缺失");
  assert.ok(src.includes('backLabel="返回市场"'), "缺返回市场入口");
});

test("AppRunnerView 失败复位:trackJob 终态后表单不卡「正在提交」(P1 回归)", () => {
  const src = readSrc("components/apps/AppRunnerView.tsx");
  const runBody = src.slice(src.indexOf("async function run()"), src.indexOf("if (loading)"));
  // 提交与跟踪两段式:runApp 完成后 submitting 即复位,跟踪期只由 running 卡控
  assert.ok(runBody.includes("setSubmitting(false);\n    setRunning(true);"), "提交成功后应立即复位 submitting 再进入跟踪");
  assert.ok(!runBody.includes("finally {\n      setSubmitting(false);"), "trackJob 终态不应依赖跨 await 的 finally 才复位 submitting");
  // 跟踪段收尾:无论 resolve/reject(含非 Error 抛出)都复位 running/progress,表单可再改可再提交
  assert.ok(
    runBody.includes("} finally {\n      setRunning(false);\n      setProgress(null);"),
    "跟踪段 finally 应复位 running/progress",
  );
});

test("AppRunnerView 结果区:按 output_kind 渲染 + 下载按钮(源码)", () => {
  const src = readSrc("components/apps/AppRunnerView.tsx");
  assert.ok(src.includes("mediaKindOf(p, app.output_kind)"), "产物应按 output_kind 分流渲染");
  assert.ok(src.includes("<video"), "缺视频产物分支");
  assert.ok(src.includes("<audio"), "缺音频产物分支");
  assert.ok(src.includes("<img"), "缺图片产物分支");
  assert.ok(src.includes("download"), "缺下载按钮");
});

/* ── ③ page.tsx 入口注册 ── */

test("page.tsx 注册 apps 视图:importer/VALID_VIEWS/VIEW_META/渲染分支", () => {
  const src = readSrc("app/page.tsx");
  assert.ok(
    src.includes('apps: () => import("@/components/apps/AppMarketView")'),
    "viewImporters 缺 apps 懒加载",
  );
  assert.match(src, /"apps"/, "VALID_VIEWS / View 联合类型缺 apps");
  assert.ok(src.includes('apps:       { label: "应用市场" }'), "VIEW_META 缺中文名");
  assert.ok(src.includes('{view === "apps" && <AppMarketView />}'), "缺渲染分支");
});

test("page.tsx 导航入口:灵动岛 + BottomNav 更多均含应用市场(store 图标)", () => {
  const src = readSrc("app/page.tsx");
  const entries = src.match(/\{ key: "apps", label: "应用市场", icon: "store" \}/g) ?? [];
  assert.equal(entries.length, 2, "灵动岛 ISLAND_ITEMS 与 BOTTOM_NAV_MORE_ITEMS 应各一条 apps 入口");
});

/* ── ④ Icon / apps.css ── */

test("Icon.tsx:store 图标已注册(lucide Store)", () => {
  const src = readSrc("components/ui/Icon.tsx");
  assert.match(src, /\bStore,/, "lucide-react 应导入 Store");
  assert.match(src, /store: Store,/, "ICON_MAP 缺 store 键");
});

test("apps.css:类名齐全 + token 纪律(零 hex / 无违规断点 / 触达 44px)", () => {
  const css = readSrc("app/styles/apps.css");
  for (const cls of [
    ".apps-market",
    ".apps-toolbar",
    ".apps-chip",
    ".apps-grid",
    ".apps-card",
    ".apps-usage",
    ".apps-runner",
    ".apps-runner-form",
    ".apps-disabled-reason",
    ".apps-results",
    ".apps-result-card",
  ]) {
    assert.ok(css.includes(cls), `apps.css 缺 ${cls} 定义`);
  }
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(css), "apps.css 存在硬编码 hex 色值");
  assert.doesNotMatch(css, /@media\s*\(max-width:\s*(1024|1280)px\)/, "断点须 -1 约定");
  assert.ok(css.includes("var(--touch-target)"), "移动端卡片操作钮须 ≥44px");
  assert.ok(css.includes("var(--duration-fast)"), "动效应走 token(≤320ms)");
});
