/**
 * 观测面板(2026-08-23)单测(node:test,无 DOM):
 * ① 纯函数:formatRate / vramTone / formatGb 分档与边界
 * ② ObservabilityView 初始渲染(SSR 首帧):无页头(W3)+ 加载骨架(useEffect 不跑 → loading)
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
import {
  OrchPanel,
  orchStatusTone,
  orchStatusLabel,
  orchStatusColor,
  formatAbsTime,
  formatRelTime,
  formatIdle,
  isReclaimSoon,
  truncateError,
  orchSummary,
} from "../components/observability/OrchPanel";
import {
  makeOrchPayload,
  makeOrchService,
  orchImpl,
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
test("ObservabilityView:无页头(2026-09-02 W3)+ 骨架屏加载态", () => {
  const html = renderToStaticMarkup(h(ObservabilityView));
  // 2026-09-02 W3:PageHeader 整段退役(标题/描述/铭牌),细工具条仅数据就绪后出现
  assert.doesNotMatch(html, /page-header/, "页头应已移除");
  assert.doesNotMatch(html, /观测面板/, "大标题应已移除");
  // Studio Console v1(2026-08-31):OBSERVABILITY 拉丁 kicker 铭牌已退役
  assert.doesNotMatch(html, /OBSERVABILITY/);
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
  assert.match(src, /obs-live-dot/, "实时小圆点");
  assert.match(src, /@media \(max-width: 860px\)/, "860px 响应式断点");
  assert.match(src, /prefers-reduced-motion/, "reduced-motion 关闭动效");
  // 批 D:硬编码 hex/rgba 与失效伪 token(--border/--surface-*)清零
  assert.doesNotMatch(src, /#[0-9a-fA-F]{6}\b/, "不应再有硬编码 hex 色值");
  assert.doesNotMatch(src, /rgba?\(\d/, "不应再有 rgba 字面量");
  assert.doesNotMatch(src, /var\(--border,/, "失效伪 token --border 应清除");
  assert.doesNotMatch(src, /var\(--surface-1,/, "失效伪 token --surface-1 应清除");
  assert.match(src, /data\.series\.vram_pct/, "每卡 VRAM 历史 sparkline 数据");
  assert.match(src, /data\.hourly/, "24h 逐小时分桶数据");
});

/* ── ②b2 Studio Console W3 套版(2026-09-02):页头/渐变/彩色图表色/长动效全退役 ── */
test("ObservabilityView:W3 单色套版(新类名在 + 旧装饰清零)", () => {
  const src = readSrc("components/observability/ObservabilityView.tsx");
  // 页头退役 → 细工具条(实时小圆点 + 更新时间,无标题)
  assert.doesNotMatch(src, /PageHeader/, "PageHeader 应退役");
  assert.match(src, /obs-toolbar/, "细工具条");
  // 空态:共享 Empty(48px 图标 + 标题 + desc)退役 → 单行 muted 提示
  assert.doesNotMatch(src, /<Empty/, "共享 Empty 组件在本视图退役");
  assert.match(src, /obs-empty-line/, "空态单行 muted 提示类");
  assert.match(
    src,
    /\.obs-empty-line \{[^}]*font-size: var\(--text-aux\)[^}]*color: var\(--text-muted\)/,
    "空态提示走 aux/muted",
  );
  // 渐变清零:KPI 渐变文字 + VRAM 三档渐变条
  assert.doesNotMatch(src, /linear-gradient/, "渐变色条/渐变文字应清零");
  assert.doesNotMatch(src, /background-clip/, "渐变文字 background-clip 应清零");
  assert.match(src, /\.obs-vram-fill\.is-ok \{\s*background: var\(--accent\);/, "VRAM 正常档=accent 实心");
  // 图表色板:观测作用域覆盖为中性派生,globals --chart-1..5 不动
  assert.match(src, /\.obs-view \{[^}]*--chart-1: var\(--accent\)/, "chart-1 收编为 accent");
  assert.match(src, /\.obs-view \{[^}]*--chart-2: var\(--text-secondary\)/, "chart-2 收编为灰阶");
  // hover 无 accent 发光,只留 border-strong
  assert.doesNotMatch(src, /color-mix\(in oklab, var\(--accent\)/, "accent hover 发光应退役");
  assert.match(src, /border-color: var\(--border-strong\)/, "hover 收敛为 border-strong");
  // 动效:>200ms 入场/脉冲全删,过渡走 fast/base token
  assert.doesNotMatch(src, /600ms/, "长动效应清零");
  assert.doesNotMatch(src, /@keyframes/, "关键帧动画应清零");
  assert.doesNotMatch(src, /translateY/, "hover 位移动效应清零");
  // 二级详情大标题收敛为 13px/600 细顶条
  assert.match(
    src,
    /\.obs-detail-title \{\s*margin: 0;\s*font-size: var\(--text-body\);\s*font-weight: var\(--font-semibold\);/,
    "详情标题收敛为 body 档 + semibold 令牌(2026-09-04 美化 W4:600 裸值收编)",
  );
  // 硬编码字阶清零(13/12/11 → token)
  assert.doesNotMatch(src, /font-size: 1[123]px/, "硬编码 13/12/11px 应清零");
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

/* ── ⑦ 编排状态区(OrchPanel) ── */
test("orchStatusTone:状态映射正确", () => {
  assert.equal(orchStatusTone("running"), "ok");
  assert.equal(orchStatusTone("waking"), "warn");
  assert.equal(orchStatusTone("sleeping"), "neutral");
  assert.equal(orchStatusTone("stopped"), "neutral");
  assert.equal(orchStatusTone("error"), "err");
});

test("orchStatusLabel:中文标签", () => {
  assert.equal(orchStatusLabel("running"), "运行中");
  assert.equal(orchStatusLabel("waking"), "唤醒中");
  assert.equal(orchStatusLabel("sleeping"), "休眠");
  assert.equal(orchStatusLabel("stopped"), "已停止");
  assert.equal(orchStatusLabel("error"), "错误");
});

test("formatRelTime:相对时间分档", () => {
  const now = Date.now();
  const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
  assert.match(formatRelTime(iso(5_000)), /秒前/);
  assert.match(formatRelTime(iso(120_000)), /分钟前/);
  assert.match(formatRelTime(iso(7_200_000)), /小时前/);
  assert.match(formatRelTime(iso(172_800_000)), /天前/);
  assert.equal(formatRelTime(null), "—");
});

test("formatIdle:闲置时长分档", () => {
  assert.equal(formatIdle(null), "—");
  assert.equal(formatIdle(30), "30 秒");
  assert.equal(formatIdle(300), "5 分钟");
  assert.equal(formatIdle(7200), "2 小时");
  assert.equal(formatIdle(172800), "2 天");
});

test("truncateError:截断与完整", () => {
  const long = "a".repeat(100);
  assert.equal(truncateError(long).length, 65);
  assert.ok(truncateError(long).endsWith("…"));
  assert.equal(truncateError("短错误"), "短错误");
});

test("orchSummary:running/waking/total 计数", () => {
  const payload = makeOrchPayload();
  const s = orchSummary(payload.services);
  assert.equal(s.running, 1);
  assert.equal(s.waking, 1);
  assert.equal(s.total, 4);
});

/* ── ⑦b OrchPanel SSR 渲染 ── */
test("OrchPanel:初始渲染骨架屏 + 汇总占位", () => {
  const html = renderToStaticMarkup(h(OrchPanel, { isAdmin: true }));
  assert.match(html, /编排服务加载中/);
  assert.match(html, /ui-skeleton-pulse/);
  assert.match(html, /obs-orch-summary/);
});

test("OrchPanel:非 admin 渲染唤醒权限提示", () => {
  const html = renderToStaticMarkup(h(OrchPanel, { isAdmin: false }));
  // SSR 时 services 为 null,先断言骨架;权限提示在数据加载后出现,源码断言覆盖
  assert.match(html, /编排服务加载中/);
  const src = readSrc("components/observability/OrchPanel.tsx");
  assert.match(src, /唤醒需管理员/);
  assert.match(src, /lock/);
});

/* ── ⑦c OrchPanel 源码断言 ── */
test("OrchPanel:轮询 12s + 手动唤醒 + 空态/错误/加载三态", () => {
  const src = readSrc("components/observability/OrchPanel.tsx");
  assert.match(src, /12_000/, "轮询周期与观测面板一致");
  assert.match(src, /fetchOrchServices/, "GET 数据");
  assert.match(src, /wakeOrchService/, "POST 唤醒");
  // 2026-09-02 W3:共享 Empty 退役 → 单行 muted 提示(obs-empty-line)
  assert.doesNotMatch(src, /<Empty/, "共享 Empty 组件应退役");
  assert.match(src, /obs-empty-line/, "空态单行 muted 提示");
  assert.match(src, /<ErrorBar/, "错误条");
  assert.match(src, /Skeleton/, "骨架屏");
  assert.match(src, /aria-label="编排状态"/, "语义标签");
});

/* ── ⑦d ObservabilityView 接入源码断言 ── */
test("ObservabilityView:编排状态折叠区接入", () => {
  const src = readSrc("components/observability/ObservabilityView.tsx");
  assert.match(src, /OrchPanel/, "引入编排面板");
  assert.match(src, /obs-orch-details/, "折叠区 class");
  assert.match(src, /<details[^>]*open>/, "默认展开");
  assert.match(src, /编排状态/, "标题");
});

/* ── ⑦e api.ts 契约:orch 端点 ── */
test("api.ts:fetchOrchServices / wakeOrchService 路径与鉴权", () => {
  const src = readSrc("lib/api.ts");
  assert.match(src, /export async function fetchOrchServices/);
  assert.match(src, /apiFetch\(`\/api\/orch\/services`, \{/);
  assert.match(src, /export async function wakeOrchService/);
  assert.match(src, /apiFetch\(`\/api\/orch\/services\/\$\{encodeURIComponent\(name\)\}\/wake`, \{/);
  assert.match(src, /method: "POST"/);
  assert.match(src, /export interface OrchService/);
  assert.match(src, /systemd_unit: string;/);
});

/* ── ⑦f observability.css 样式断言 ── */
test("observability.css:obs-orch-* 前缀 + 状态色 token + 零 hex", () => {
  const src = readSrc("app/styles/observability.css");
  assert.match(src, /\.obs-orch-card/);
  assert.match(src, /\.obs-orch-summary/);
  assert.match(src, /\.obs-orch-details/);
  assert.match(src, /var\(--ok\)/, "running 绿走 token");
  assert.match(src, /var\(--warn\)/, "waking 黄走 token");
  assert.match(src, /var\(--err\)/, "error 红走 token");
  assert.match(src, /var\(--text-muted\)/, "sleeping/stopped 灰走 token");
  assert.doesNotMatch(src, /#[0-9a-fA-F]{3,8}\b/, "零 hex");
  assert.doesNotMatch(src, /rgba?\(\d/, "零 rgba 字面量");
  assert.match(src, /prefers-reduced-motion/, "reduced-motion 降级");
  // 2026-09-02 W3:hover 无 accent 发光,只留 border-strong
  assert.doesNotMatch(src, /color-mix\(in oklab, var\(--accent\)/, "accent hover 发光应退役");
  assert.match(src, /border-color: var\(--border-strong\)/, "hover 收敛为 border-strong");
  // 伪字号 token(--text-11/12/14 未定义)清零,走 W3 字阶
  assert.doesNotMatch(src, /var\(--text-1[124]\)/, "伪字号 token 应清除");
  assert.match(src, /var\(--text-body\)/, "正文档 token");
  assert.match(src, /var\(--text-aux\)/, "辅助档 token");
});

/* ── ⑦g mock 替身形状 ── */
test("mocks/studioApi:makeOrchPayload 四服务形状完整", async () => {
  const payload = await orchImpl.fetchOrchServices();
  assert.equal(payload.services.length, 4);
  const names = payload.services.map((s) => s.name).sort();
  assert.deepEqual(names, ["hy3dtex", "i2l", "lipsync", "trainer"]);
  const lipsync = payload.services.find((s) => s.name === "lipsync");
  assert.equal(lipsync?.status, "error");
  assert.ok(lipsync?.last_error);
  const woken = await orchImpl.wakeOrchService("i2l");
  assert.equal(woken.status, "running");
  assert.equal(woken.name, "i2l");
});

/* ── ⑦h 状态徽标配色 token 对齐(UI_STANDARD §10) ── */
test("orchStatusColor:running=--ok / waking=--warn / sleeping=--text-muted / stopped=--text-3 / error=--err", () => {
  assert.equal(orchStatusColor("running"), "var(--ok)");
  assert.equal(orchStatusColor("waking"), "var(--warn)");
  assert.equal(orchStatusColor("sleeping"), "var(--text-muted)");
  assert.equal(orchStatusColor("stopped"), "var(--text-3)");
  assert.equal(orchStatusColor("error"), "var(--err)");
  // 消费端:stopped 与 sleeping 徽标必须可区分
  assert.notEqual(orchStatusColor("stopped"), orchStatusColor("sleeping"));
});

test("formatAbsTime:null/非法占位,合法 ISO 本地化无 AM/PM", () => {
  assert.equal(formatAbsTime(null), "—");
  assert.equal(formatAbsTime("not-a-date"), "—");
  const s = formatAbsTime("2026-08-30T08:55:00+00:00");
  assert.ok(s.length > 0 && s !== "—");
  assert.doesNotMatch(s, /AM|PM/i, "hour12:false 24 小时制");
});

/* ── ⑦i 即将回收判定 ── */
test("isReclaimSoon:running + safe_idle + 闲置超阈值才高亮", () => {
  const base = makeOrchService({
    status: "running",
    safe_idle: true,
    idle_timeout_sec: 900,
    idle_sec: 901,
  });
  assert.equal(isReclaimSoon(base), true, "超阈值 1s 即高亮");
  assert.equal(isReclaimSoon({ ...base, idle_sec: 899 }), false, "未达阈值不高亮");
  assert.equal(isReclaimSoon({ ...base, idle_sec: null }), false, "从未打点不高亮");
  assert.equal(isReclaimSoon({ ...base, status: "sleeping" }), false, "非 running 不高亮");
  assert.equal(
    isReclaimSoon({ ...base, safe_idle: false }),
    false,
    "safe_idle=false 后端绝不回收,不误报",
  );
});

/* ── ⑦j OrchPanel 源码:二次确认 / 脉动 / 回收高亮 / tooltip ── */
test("OrchPanel:wake 二次确认 Modal + waking 禁用 + 回收高亮 + 最近唤醒/停止 tooltip", () => {
  const src = readSrc("components/observability/OrchPanel.tsx");
  // 二次确认:点按钮只开弹窗,确认按钮才调 onWake
  assert.match(src, /from "@\/components\/ui\/Modal"/, "引入 ui/Modal");
  assert.match(src, /确认唤醒/, "确认按钮文案");
  assert.match(src, /onClick=\{\(\) => setConfirming\(true\)\}/, "主按钮仅开确认弹窗");
  assert.match(src, /onClick=\{confirmWake\}/, "确认按钮才真正唤醒");
  assert.match(src, /preventClose=\{waking\}/, "唤醒途中禁关弹窗");
  // waking 进行中禁用(本卡 waking 本地态 + 服务端 waking 态)
  assert.match(src, /disabled=\{!canWake \|\| waking \|\| service\.status === "waking"\}/);
  // 脉动仅 waking(running 稳定态不脉动)
  assert.match(src, /dotPulse=\{service\.status === "waking"\}/);
  // 回收高亮行 + 提示文案
  assert.match(src, /obs-orch-card--reclaim/, "回收高亮 class");
  assert.match(src, /即将回收休眠/, "回收提示文案");
  assert.match(src, /isReclaimSoon\(service\)/, "回收判定消费");
  // 最近唤醒/停止时间 tooltip(徽标 + 启停计数)
  assert.match(src, /最近唤醒\/停止:/, "tooltip 文案");
  assert.match(src, /formatAbsTime\(service\.status_changed_at\)/, "tooltip 数据源");
  // 零 hex(§10)
  assert.doesNotMatch(src, /#[0-9a-fA-F]{6}\b/, "OrchPanel 零硬编码 hex");
});

/* ── ⑦k 样式:回收高亮 + --text-3 token + 伪 token 清零 ── */
test("observability.css/globals.css:回收高亮 + stopped=--text-3 + --text-1 伪 token 清零", () => {
  const css = readSrc("app/styles/observability.css");
  assert.match(css, /\.obs-orch-card--reclaim/, "回收高亮样式");
  assert.match(css, /\.obs-orch-reclaim/, "回收提示行样式");
  assert.match(css, /\.obs-orch-card--stopped \{ border-left: 3px solid var\(--text-3\); \}/);
  assert.match(css, /\.obs-orch-card--sleeping \{ border-left: 3px solid var\(--text-muted\); \}/);
  assert.match(css, /var\(--warn-soft\)/, "回收高亮走 warn-soft token");
  assert.doesNotMatch(css, /var\(--text-1\)/, "失效伪 token --text-1 应清除");
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b/, "零 hex 保持");
  // globals.css 新增 --text-3 token(带注释理由)
  const globals = readSrc("app/globals.css");
  assert.match(globals, /--text-3:\s*var\(--text-secondary\)/, "--text-3 token 存在");
});

/* ── ⑦l ObservabilityView:isAdmin 接线 + 空态 + 移动端 ── */
test("ObservabilityView:OrchPanel isAdmin 接线 + GPU/舰队空态 + 移动端断点补强", () => {
  const src = readSrc("components/observability/ObservabilityView.tsx");
  // 页面整体 admin 门控,编排面板唤醒按钮应直接放行(不再误显示「唤醒需管理员」)
  assert.match(src, /<OrchPanel isAdmin \/>/, "OrchPanel 接 isAdmin");
  // §10 空态:GPU / 舰队(2026-09-02 W3:共享 Empty 退役 → obs-empty-line 单行提示)
  assert.match(src, /data\.gpus\.length === 0/, "GPU 空态分支");
  assert.match(src, /暂无 GPU 数据/, "GPU 空态文案");
  assert.match(src, /fleet\.devices\.length === 0/, "舰队空态分支");
  assert.match(src, /暂无设备/, "舰队空态文案");
  assert.match(src, /className="obs-empty-line"/, "空态单行 muted 提示");
  // §10 移动端:服务清单表横向滚动 + 返回按钮 44px 触达
  assert.match(src, /obs-svc-wrap/, "表格滚动容器");
  assert.match(src, /min-height: 44px/, "返回按钮触达 ≥44px");
  assert.match(src, /@media \(max-width: 860px\)/, "860px 断点保留");
});
