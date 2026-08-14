/**
 * UI-D 视图组件单测(node:test + react-dom/server 静态渲染):
 * ① DramaPlayer.module.css:移动端断点 767(对齐全局 -1 约定,768 清零)
 * ② AdminView:表格移动端容器(overflow-x:auto + 767 档 min-width 表)、字重 token 收编
 * ③ DubView:错误态 ×5 接入 ErrorBar(受控 onClose)+ dub-cols 767 断点列重排
 * ④ TrainView:错误态/加载态/空态接入 ErrorBar/LoadingBlock/Empty
 * ⑤ ErrorBar className 组合(render 断言:ui-error-bar 与视图槽位类共存,
 *    ie-error/anim-error/at-error-bar 等槽位靠 className 叠加定位与间距)
 * 说明:node 无 DOM,视图组件普遍依赖 @/lib/api(loader 映射的 mock 不含其导出),
 * 故视图侧断言走 fs.readFileSync 源码断言;ErrorBar 组合行为走 renderToStaticMarkup。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ErrorBar } from "../components/ui/ErrorBar";

const h = React.createElement;
const testDir = dirname(fileURLToPath(import.meta.url));
const webRoot = join(testDir, "..");

function readSrc(rel: string): string {
  return readFileSync(join(webRoot, rel), "utf-8");
}

/* ── ① DramaPlayer 断点 ── */
test("DramaPlayer 移动端断点为 767(-1 约定),768 清零", () => {
  const css = readSrc("app/drama/[id]/DramaPlayer.module.css");
  assert.ok(css.includes("@media (max-width: 767px)"), "缺少 767px 移动端媒体查询");
  assert.ok(!css.includes("max-width: 768px"), "仍残留 768px 断点(与 1023 档间有 1px 缝隙带)");
  // 平板档维持 1023(1024-1),两档同约定
  assert.ok(css.includes("@media (max-width: 1023px)"), "缺少 1023px 平板档");
});

/* ── ② AdminView 移动容器 + 字重 token ── */
test("AdminView 表格移动端:overflow-x 容器 + 767 档表格 min-width", () => {
  const src = readSrc("components/admin/AdminView.tsx");
  assert.ok(src.includes("admin-table-wrap"), "缺少表格滚动容器类");
  assert.ok(/\.admin-table-wrap\s*\{[^}]*overflow-x:\s*auto/.test(src), "容器未开 overflow-x:auto");
  // 767 档内表格保持最小可读宽度,110-180px 固定列不被压缩
  const media767 = src.match(/@media \(max-width: 767px\)\s*\{[\s\S]*?\.admin-table\s*\{[^}]*min-width:\s*640px/);
  assert.ok(media767, "缺少 767px 媒体查询块");
  assert.ok(media767[0].includes("min-width: 640px"), "767 档缺少表格 min-width");
});

test("AdminView 字重收编 var(--font-semibold),650 清零", () => {
  const src = readSrc("components/admin/AdminView.tsx");
  assert.ok(src.includes("font-weight: var(--font-semibold)"), "头像字重未收编 token");
  assert.ok(!src.includes("font-weight: 650"), "仍残留 font-weight:650 裸值");
});

test("AdminView 错误态 ErrorBar + 重试、加载态 LoadingBlock", () => {
  const src = readSrc("components/admin/AdminView.tsx");
  assert.ok(src.includes("import { ErrorBar }"), "未导入 ErrorBar");
  assert.ok(src.includes("admin-error-row"), "缺少错误行容器类");
  assert.ok(src.includes("onClose={() => setError(null)}"), "加载错误未接受控关闭");
  assert.ok(src.includes("import { LoadingBlock }"), "未导入 LoadingBlock");
  assert.ok(!src.includes("loading-spinner admin-loading"), "加载态仍是旧 spinner");
});

/* ── ③ DubView:ErrorBar ×5 + 列重排 ── */
test("DubView 五处异步错误态全部接入 ErrorBar(受控 onClose)", () => {
  const src = readSrc("components/dub/DubView.tsx");
  assert.ok(src.includes("import { ErrorBar }"), "未导入 ErrorBar");
  for (const setter of [
    "setUploadError",
    "setSubError",
    "setTranslateError",
    "setVoiceError",
    "setLipsyncError",
  ]) {
    assert.ok(
      src.includes(`onClose={() => ${setter}(null)}`),
      `${setter} 未接入 ErrorBar 受控关闭`,
    );
  }
});

test("DubView dub-cols 双栏定义 + 767 断点降单栏", () => {
  const src = readSrc("components/dub/DubView.tsx");
  assert.ok(/\.dub-cols\s*\{[^}]*display:\s*grid/.test(src), "dub-cols 双栏栅格缺失");
  const media767 = src.match(/@media \(max-width: 767px\)\s*\{\s*\.dub-cols\s*\{[^}]*\}/);
  assert.ok(media767, "dub-cols 缺少 767 断点");
  assert.ok(media767[0].includes("grid-template-columns: 1fr"), "767 档未降为单栏");
});

/* ── ④ TrainView:六态组件接入 ── */
test("TrainView 错误态 ErrorBar(页面级 + 表单级)+ 加载 LoadingBlock + 空态 Empty", () => {
  const src = readSrc("components/train/TrainView.tsx");
  assert.ok(src.includes("import { ErrorBar }"), "未导入 ErrorBar");
  assert.ok(src.includes("onClose={() => setError(null)}"), "页面级错误未接受控关闭");
  assert.ok(src.includes("onClose={() => setSubmitError(null)}"), "表单级错误未接受控关闭");
  assert.ok(src.includes("import { LoadingBlock }"), "未导入 LoadingBlock");
  assert.ok(src.includes("import { Empty }"), "未导入 Empty");
  assert.ok(!src.includes("tv-error-box"), "仍残留旧错误盒类");
});

/* ── ⑤ ErrorBar className 组合(render 断言) ── */
test("ErrorBar 叠加视图槽位类:className 与 ui-error-bar 共存", () => {
  const html = renderToStaticMarkup(
    h(ErrorBar, { message: "上传失败", onClose: () => {}, className: "ie-error" }),
  );
  assert.match(html, /ui-error-bar/);
  assert.match(html, /ie-error/);
  assert.match(html, /role="alert"/);
  assert.match(html, /上传失败/);
});

test("ErrorBar 在舞台浮层槽位(at-error-bar 包裹范式)正常渲染", () => {
  const html = renderToStaticMarkup(
    h("div", { className: "at-error-bar" }, h(ErrorBar, { message: "连接已断开", onClose: () => {} })),
  );
  assert.match(html, /at-error-bar/);
  assert.match(html, /ui-error-bar/);
  assert.match(html, /ui-error-bar-close/);
});
