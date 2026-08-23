/**
 * 观测面板(2026-08-23)单测(node:test,无 DOM):
 * ① 纯函数:formatRate / vramTone / formatGb 分档与边界
 * ② ObservabilityView 初始渲染(SSR 首帧):页头标题 + 加载骨架(useEffect 不跑 → loading)
 * ③ 挂载源码断言:page.tsx 视图注册(importer/VALID_VIEWS/VIEW_META/渲染分支/管理员门控)
 * ④ api.ts 契约:fetchObservability 路径 /api/observability + authHeaders
 * ⑤ mocks/studioApi.ts 替身可调用且快照形状完整(链接期)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  ObservabilityView,
  formatGb,
  formatRate,
  vramTone,
} from "../components/observability/ObservabilityView";
import {
  fetchObservability,
  makeObservabilitySnapshot,
} from "./mocks/studioApi";

const h = React.createElement;
const testDir = dirname(fileURLToPath(import.meta.url));
const webRoot = join(testDir, "..");

function readSrc(rel: string): string {
  return readFileSync(join(webRoot, rel), "utf-8");
}

/* ── ① 纯函数 ── */
test("formatRate:null 占位 / 百分比 1 位小数", () => {
  assert.equal(formatRate(null), "—");
  assert.equal(formatRate(1), "100.0%");
  assert.equal(formatRate(0.75), "75.0%");
  assert.equal(formatRate(0), "0.0%");
});

test("vramTone:离线/正常/偏高/危险分档", () => {
  assert.equal(vramTone(null), "is-off");
  assert.equal(vramTone(0), "is-ok");
  assert.equal(vramTone(69.9), "is-ok");
  assert.equal(vramTone(70), "is-warm");
  assert.equal(vramTone(89.9), "is-warm");
  assert.equal(vramTone(90), "is-hot");
  assert.equal(vramTone(100), "is-hot");
});

test("formatGb:null 占位 / 整数去小数 / 非整数 1 位", () => {
  assert.equal(formatGb(null), "—");
  assert.equal(formatGb(95), "95");
  assert.equal(formatGb(10.9), "10.9");
  assert.equal(formatGb(0), "0");
});

/* ── ② 初始渲染(SSR 首帧 = loading 骨架) ── */
test("ObservabilityView:页头标题 + 加载骨架渲染", () => {
  const html = renderToStaticMarkup(h(ObservabilityView));
  assert.match(html, /观测面板/);
  assert.match(html, /OBSERVABILITY/);
  assert.match(html, /aria-label="观测数据加载中"/);
});

/* ── ③ page.tsx 挂载源码断言 ── */
test("page.tsx:观测视图注册完整(importer/VALID_VIEWS/meta/渲染/管理员门控)", () => {
  const src = readSrc("app/page.tsx");
  assert.match(src, /\| "observability"/, "View 联合类型应含 observability");
  assert.match(
    src,
    /observability: \(\) => import\("@\/components\/observability\/ObservabilityView"\)/,
    "viewImporters 应注册懒加载",
  );
  assert.match(src, /"observability",\n/, "VALID_VIEWS 应含 observability");
  assert.match(src, /observability: \{ label: "观测" \}/, "VIEW_META 应有中文名");
  assert.ok(
    src.includes('{view === "observability" && isAdmin && <ObservabilityView />}'),
    "渲染分支应带 isAdmin 门控",
  );
  assert.match(
    src,
    /view === "observability" && account !== null && account !== "admin"/,
    "非管理员直输 URL 应弹回融合页",
  );
});

/* ── ④ api.ts 契约 ── */
test("api.ts:fetchObservability 走 /api/observability 且带 authHeaders", () => {
  const src = readSrc("lib/api.ts");
  assert.match(src, /export async function fetchObservability/);
  assert.match(src, /apiFetch\(`\/api\/observability`, \{/);
  assert.match(src, /headers: authHeaders\(\),/);
});

/* ── ⑤ mock 替身链接期形状 ── */
test("mocks/studioApi:fetchObservability 替身返回完整快照", async () => {
  const snap = await fetchObservability();
  assert.equal(snap.queue.queued, 1);
  assert.equal(snap.queue.held, 2);
  assert.equal(snap.success_24h.rate, 0.75);
  assert.equal(snap.gpus.length, 2);
  const dead = snap.gpus[1].instances.find((i) => !i.online);
  assert.ok(dead, "应含离线实例(降级展示路径)");
  assert.equal(dead.vram_used_gb, null);
  assert.equal(makeObservabilitySnapshot().held.reasons[0].count, 2);
});
