/**
 * 作品库回收站(2026-08-23)单测(node:test,无 DOM):
 * ① formatRetention 纯函数:分钟/小时/天+小时/整天/已到期/非法值
 * ② LibraryTrashView 初始渲染(SSR 首帧):标题 + 返回作品库 + 加载骨架
 * ③ 视图切换源码断言:LibraryView 回收站入口/条件渲染/恢复后 invalidateJobs+load
 * ④ 操作调用源码断言:restore/permanent 走 api 替身同名导出;彻底删除 Modal 二次确认
 * ⑤ api.ts 契约:fetchTrash/restoreJob/permanentDeleteJob 路径与方法
 * ⑥ mocks/studioApi.ts 替身可调用(链接期形状)
 * 说明:LibraryView 经 tests/loader.mjs 把 @/lib/api 映射到 mocks/studioApi.ts;
 * useEffect 不跑,初始渲染 loading=true,骨架与头部可见,正好覆盖②。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { formatRetention } from "../lib/libraryQuery";
import { LibraryTrashView, LibraryView } from "../components/library/LibraryView";
import { ToastProvider } from "../components/ui/Toast";
import { trashImpl } from "./mocks/studioApi";

const h = React.createElement;
const testDir = dirname(fileURLToPath(import.meta.url));
const webRoot = join(testDir, "..");

function readSrc(rel: string): string {
  return readFileSync(join(webRoot, rel), "utf-8");
}

/* ── ① formatRetention 纯函数 ── */
test("formatRetention:分钟/小时/天+小时分档,边界与非法值", () => {
  assert.equal(formatRetention(0), "已到期");
  assert.equal(formatRetention(-5), "已到期");
  assert.equal(formatRetention(Number.NaN), "已到期");
  assert.equal(formatRetention(30), "剩 1 分钟", "不足 1 分钟按 1 分钟兜底");
  assert.equal(formatRetention(59 * 60), "剩 59 分钟");
  assert.equal(formatRetention(3600), "剩 1 小时");
  assert.equal(formatRetention(23 * 3600), "剩 23 小时");
  assert.equal(formatRetention(86400), "剩 1 天", "整天不拼 0 小时");
  assert.equal(formatRetention(2 * 86400 + 3 * 3600), "剩 2 天 3 小时");
  assert.equal(formatRetention(72 * 3600), "剩 3 天", "72h 保留期满档");
});

/* ── ② LibraryTrashView 初始渲染(SSR 首帧 = loading 骨架) ── */
test("LibraryTrashView:标题/副标/返回作品库/骨架渲染", () => {
  const html = renderToStaticMarkup(
    h(
      ToastProvider,
      null,
      h(LibraryTrashView, { onBack: () => {} }),
    ),
  );
  assert.match(html, /回收站/, "缺少回收站标题");
  assert.match(html, /72 小时/, "副标未注明保留期");
  assert.match(html, /返回作品库/, "缺少返回入口");
  assert.match(html, /lib-trash-back/, "返回按钮类名缺失");
  assert.match(html, /lib-thumb-skel/, "缺少加载骨架");
});

/* ── ③ 视图切换(源码断言) ── */
test("LibraryView:回收站入口按钮 + 组件内条件渲染 + 恢复后刷新主列表", () => {
  const src = readSrc("components/library/LibraryView.tsx");
  assert.ok(src.includes("lib-trash-toggle"), "缺少回收站入口按钮");
  assert.ok(src.includes("showTrash"), "缺视图切换 state");
  assert.ok(src.includes("LibraryTrashView"), "未引用回收站视图组件");
  // 恢复成功后:失效作品库缓存 + 重拉主列表
  const i = src.indexOf("onRestored");
  assert.ok(i > 0 && src.slice(i, i + 300).includes("invalidateJobs()"), "恢复后未失效作品库缓存");
  // 工具条渲染回归:主视图仍含批量管理(回收站入口不破既有布局)
  const html = renderToStaticMarkup(
    h(
      ToastProvider,
      null,
      h(LibraryView as React.FC<{ onNavigate?: (target: string) => void }>, {
        onNavigate: () => {},
      }),
    ),
  );
  assert.match(html, /lib-trash-toggle/, "工具条缺少回收站入口");
  assert.match(html, /lib-batch-toggle/, "批量管理按钮被挤掉");
});

/* ── ④ 操作调用(源码断言) ── */
test("LibraryTrashView:恢复/彻底删除走 api 导出,彻底删除 Modal 二次确认", () => {
  const src = readSrc("components/library/LibraryView.tsx");
  const trash = src.slice(src.indexOf("export function LibraryTrashView"));
  assert.ok(trash.includes("restoreJob("), "恢复未走 restoreJob");
  assert.ok(trash.includes("permanentDeleteJob("), "彻底删除未走 permanentDeleteJob");
  assert.ok(trash.includes("confirmPurge"), "彻底删除缺二次确认态");
  assert.ok(trash.includes("此操作不可恢复"), "确认对话框缺后果文案");
  assert.ok(trash.includes("删除于"), "卡片未显示删除时间");
  assert.ok(trash.includes("formatRetention(job.restore_remaining_seconds)"), "卡片未显示剩余保留期");
});

/* ── ⑤ api.ts 契约 ── */
test("api.ts:fetchTrash/restoreJob/permanentDeleteJob 路径与方法", () => {
  const src = readSrc("lib/api.ts");
  assert.ok(src.includes("export async function fetchTrash"), "fetchTrash 未导出");
  assert.ok(src.includes("/api/jobs/trash?limit=${limit}&offset=${offset}"), "回收站列表未带分页参数");
  assert.ok(src.includes("export async function restoreJob"), "restoreJob 未导出");
  assert.ok(src.includes("`/api/jobs/${jobId}/restore`"), "恢复路径错误");
  assert.ok(src.includes("export async function permanentDeleteJob"), "permanentDeleteJob 未导出");
  assert.ok(src.includes("`/api/jobs/${jobId}/permanent`"), "彻底删除路径错误");
  // 恢复后失效作品库缓存(主列表回归)
  const restore = src.slice(src.indexOf("export async function restoreJob"));
  assert.ok(restore.slice(0, 400).includes("invalidateJobs()"), "恢复后未失效缓存");
});

/* ── ⑥ mocks 替身形状 ── */
test("mocks/studioApi:回收站替身默认可调用", async () => {
  assert.deepEqual(await trashImpl.fetchTrash(), []);
  await assert.doesNotReject(() => trashImpl.restoreJob("j1"));
  await assert.doesNotReject(() => trashImpl.permanentDeleteJob("j1"));
  assert.equal(await trashImpl.purgeTrash(), 0);
});

/* ── ⑦ 一键清空(2026-08-23,源码断言 + api 契约) ── */
test("LibraryTrashView:清空回收站走 purgeTrash + Modal 二次确认", () => {
  const src = readSrc("components/library/LibraryView.tsx");
  const trash = src.slice(src.indexOf("export function LibraryTrashView"));
  assert.ok(trash.includes("purgeTrash("), "清空未走 purgeTrash");
  assert.ok(trash.includes("confirmPurgeAll"), "清空缺二次确认态");
  assert.ok(trash.includes("lib-trash-purge-all"), "缺清空入口按钮");
  assert.ok(trash.includes("全部彻底删除"), "确认按钮文案缺失");
  assert.ok(trash.includes("此操作不可恢复"), "清空确认缺后果文案");
});

test("api.ts:purgeTrash 路径与方法", () => {
  const src = readSrc("lib/api.ts");
  assert.ok(src.includes("export async function purgeTrash"), "purgeTrash 未导出");
  assert.ok(src.includes("`/api/jobs/trash/purge`"), "清空路径错误");
  const purge = src.slice(src.indexOf("export async function purgeTrash"));
  assert.ok(purge.slice(0, 300).includes('method: "POST"'), "清空应为 POST");
});
