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

/* ── ② 初始渲染(SSR 首帧 = 骨架屏) ── */
test("ObservabilityView:页头标题 + 骨架屏加载态", () => {
  const html = renderToStaticMarkup(h(ObservabilityView));
  assert.match(html, /观测面板/);
  assert.match(html, /OBSERVABILITY/);
  assert.match(html, /aria-label="观测数据加载中"/);
  assert.match(html, /ui-skeleton-pulse/, "首屏应为骨架屏样式");
});

/* ── ②b 重改版式源码断言 ── */
test("ObservabilityView:接入图表库四件套 + 新版式区块", () => {
  const src = readSrc("components/observability/ObservabilityView.tsx");
  assert.match(src, /from "@\/components\/ui\/charts"/);
  for (const comp of ["LineChart", "BarChart", "DonutChart", "Sparkline"]) {
    assert.match(src, new RegExp(`<${comp}`), `应渲染 ${comp}`);
  }
  assert.match(src, /obs-kpis/, "KPI 条");
  assert.match(src, /obs-charts-row/, "图表区第一行");
  assert.match(src, /obs-live-dot/, "实时脉冲点");
  assert.match(src, /@media \(max-width: 860px\)/, "860px 响应式断点");
  assert.match(src, /prefers-reduced-motion/, "reduced-motion 关闭动效");
  assert.match(src, /linear-gradient\(90deg, #22d3ee, #a78bfa\)/, "VRAM 条品牌渐变");
  assert.match(src, /data\.series\.vram_pct/, "每卡 VRAM 历史 sparkline 数据");
  assert.match(src, /data\.hourly/, "24h 逐小时分桶数据");
});

/* ── ②c api.ts 契约:series/hourly 类型 ── */
test("api.ts:ObservabilitySnapshot 含 series/hourly 字段", () => {
  const src = readSrc("lib/api.ts");
  assert.match(src, /export interface ObservabilitySeries/);
  assert.match(src, /vram_pct: Record<string, \(number \| null\)\[\]>/);
  assert.match(src, /export interface ObservabilityHourlyBucket/);
  assert.match(src, /series: ObservabilitySeries;/);
  assert.match(src, /hourly: ObservabilityHourlyBucket\[\];/);
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
  // 时序/分桶字段:数组等长对齐;hourly 24 桶;离线卡 null 采样
  assert.equal(snap.series.timestamps.length, snap.series.queued.length);
  assert.equal(snap.series.vram_pct.GPU0.length, snap.series.timestamps.length);
  assert.equal(snap.hourly.length, 24);
  assert.deepEqual(
    snap.hourly[23],
    { hour: snap.hourly[23].hour, done: 3, error: 1 },
    "hourly 末桶与 success_24h 对齐",
  );
});

/* ── 回归(2026-08-24 生产实测):视图样式块必须 jsx global ──
   styled-jsx 的 jsxId 只打在主组件自身 JSX,同文件子组件(KpiStrip/各 Card)
   拿不到作用域类,scoped <style jsx> 会整段静默失效(KPI 条 display:block)。 */
test("ObservabilityView:样式块为 jsx global(子组件覆盖回归)", () => {
  const src = readSrc("components/observability/ObservabilityView.tsx");
  assert.match(src, /<style jsx global>/, "obs-* 规则必须 jsx global");
  assert.doesNotMatch(src, /<style jsx>\{`/, "禁止退回 scoped style jsx");
});
