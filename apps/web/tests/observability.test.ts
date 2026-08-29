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
  fleetDotClass,
  formatGb,
  formatMs,
  formatRate,
  ObservabilityView,
  pickLatencySeries,
  vramTone,
} from "../components/observability/ObservabilityView";
import {
  fetchFleet,
  fetchFleetDevice,
  fetchObservability,
  makeFleetDeviceDetail,
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
  // 批 D:品牌渐变色值收编为图表 token(--chart-1/--chart-2,亮暗双模式)
  assert.match(
    src,
    /linear-gradient\(90deg, var\(--chart-1\), var\(--chart-2\)\)/,
    "VRAM 条品牌渐变应走 chart token",
  );
  // 批 D:硬编码 hex/rgba 与失效伪 token(--border/--surface-*)清零
  assert.doesNotMatch(src, /#[0-9a-fA-F]{6}\b/, "不应再有硬编码 hex 色值");
  assert.doesNotMatch(src, /rgba?\(\d/, "不应再有 rgba 字面量");
  assert.doesNotMatch(src, /var\(--border,/, "失效伪 token --border 应清除");
  assert.doesNotMatch(src, /var\(--surface-1,/, "失效伪 token --surface-1 应清除");
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

/* ── ⑥ 设备舰队:纯函数 ── */
test("fleetDotClass:在线绿 / 离线红 / 未知灰", () => {
  assert.equal(fleetDotClass(true), "obs-dot is-on");
  assert.equal(fleetDotClass(false), "obs-dot is-down");
  assert.equal(fleetDotClass(null), "obs-dot is-unknown");
});

test("formatMs:null 占位 / 取整毫秒", () => {
  assert.equal(formatMs(null), "—");
  assert.equal(formatMs(12.5), "13ms");
  assert.equal(formatMs(0), "0ms");
});

test("pickLatencySeries:滤掉无数据服务,按最近延迟降序截断", () => {
  const detail = makeFleetDeviceDetail();
  const picked = pickLatencySeries(detail);
  // LongCat 近两条 null 但首条 20 有数据 → 保留且排最前
  assert.equal(picked.length, 2);
  assert.equal(picked[0].name, "LongCat");
  assert.deepEqual(picked[1].values, [10, 11, 12.5]);
  // 全空服务被过滤
  const empty = {
    ...detail,
    series: { ...detail.series, latency: { A: [null, null, null] } },
  };
  assert.equal(pickLatencySeries(empty).length, 0);
});

/* ── ⑥b 舰队区块源码断言 ── */
test("ObservabilityView:舰队区 + 二级详情页(视图内切换,不加路由)", () => {
  const src = readSrc("components/observability/ObservabilityView.tsx");
  assert.match(src, /fetchFleet/, "一级摘要请求");
  assert.match(src, /fetchFleetDevice/, "详情请求");
  assert.match(src, /obs-fleet-grid/, "设备卡网格");
  assert.match(src, /FleetSection/, "舰队区组件");
  assert.match(src, /DeviceDetailView/, "详情页组件");
  assert.match(src, /‹ 返回观测面板/, "返回按钮");
  assert.match(src, /obs-svc-table/, "服务清单表");
  assert.match(src, /onSelect=\{setSelected\}/, "点击卡片进详情(状态切换)");
  assert.match(src, /onBack=\{\(\) => setSelected\(null\)\}/, "返回即清选中态");
  assert.match(src, /aria-label="设备舰队"/, "舰队区语义标签");
});

/* ── ⑥c api.ts 契约:fleet 端点 ── */
test("api.ts:fetchFleet / fetchFleetDevice 路径与鉴权头", () => {
  const src = readSrc("lib/api.ts");
  assert.match(src, /export async function fetchFleet\(/);
  assert.match(src, /apiFetch\(`\/api\/fleet`, \{/);
  assert.match(src, /export async function fetchFleetDevice\(/);
  assert.match(src, /apiFetch\(`\/api\/fleet\/\$\{encodeURIComponent\(deviceId\)\}`, \{/);
  assert.match(src, /export interface FleetDeviceDetail extends FleetDeviceSummary/);
  assert.match(src, /series: \{\n\s+timestamps: string\[\];\n\s+online: \(number \| null\)\[\];\n\s+latency: Record<string, \(number \| null\)\[\]>;/);
});

/* ── ⑥d mock 替身形状 ── */
test("mocks/studioApi:fetchFleet / fetchFleetDevice 替身形状完整", async () => {
  const summary = await fetchFleet();
  assert.equal(summary.devices.length, 2);
  const pc01 = summary.devices.find((d) => d.id === "pc01");
  assert.equal(pc01?.online, false, "应含离线设备(降级展示路径)");
  assert.equal(pc01?.services_up, 0);
  const detail = await fetchFleetDevice("workstation");
  assert.equal(detail.meta.lan_ip, "192.168.71.127");
  assert.equal(detail.services.length, 2);
  assert.equal(detail.sys?.nas?.mounted, true);
  assert.equal(detail.sys?.gpus?.length, 2);
  // 时序等长对齐
  assert.equal(detail.series.timestamps.length, detail.series.online.length);
  for (const values of Object.values(detail.series.latency)) {
    assert.equal(values.length, detail.series.timestamps.length);
  }
});

/* ── ⑥e 浅色主题:图表网格线 CSS 变量化(生产为浅色主题) ── */
test("charts.tsx:网格/十字线走 CSS 变量,浅色默认深灰细线", () => {
  const src = readSrc("components/ui/charts.tsx");
  assert.match(src, /var\(--uichart-grid, rgba\(15,23,42,\.10\)\)/, "浅色默认网格线");
  assert.match(src, /\[data-mode="dark"\] \.uichart/, "暗色覆盖块");
  assert.match(src, /var\(--uichart-crosshair/, "十字线同步变量化");
});
