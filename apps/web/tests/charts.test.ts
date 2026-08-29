/**
 * 图表库(charts.tsx)单测(node:test + react-dom/server 静态渲染):
 * ① smoothPath:空/单点/多点 Catmull-Rom 贝塞尔段数与端点
 * ② scaleLinear:线性映射 + 零跨度兜底
 * ③ niceCeil:1/2/5 阶梯取整(含小数/0/负)
 * ④ donutSlicePath:扇区 path 结构与起止点几何
 * ⑤ barLayout:均分步进与间隙比
 * ⑥ sparkPoints:null 断段映射
 * ⑦ formatClock:ISO → HH:MM
 * ⑧ 组件 SSR:LineChart/BarChart/DonutChart/Sparkline 渲染 svg + 图例 + 空态
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  BarChart,
  barLayout,
  CHART_COLORS,
  CHART_SEMANTIC,
  DonutChart,
  donutSlicePath,
  formatClock,
  LineChart,
  niceCeil,
  scaleLinear,
  smoothPath,
  Sparkline,
  sparkPoints,
} from "../components/ui/charts";

const h = React.createElement;

/* ── ① smoothPath ── */
test("smoothPath:空数组空串;单点仅 M;多点 M + (n-1) 个 C 段", () => {
  assert.equal(smoothPath([]), "");
  assert.equal(smoothPath([{ x: 1, y: 2 }]), "M 1 2");
  const pts = [
    { x: 0, y: 10 },
    { x: 10, y: 5 },
    { x: 20, y: 8 },
    { x: 30, y: 2 },
  ];
  const d = smoothPath(pts);
  assert.match(d, /^M 0 10 /);
  assert.equal((d.match(/ C /g) ?? []).length, 3, "4 点应有 3 段贝塞尔");
  assert.match(d, /30 2$/, "末段终点应为最后一点");
});

/* ── ② scaleLinear ── */
test("scaleLinear:线性映射与零跨度兜底", () => {
  const s = scaleLinear([0, 100], [200, 20]);
  assert.equal(s(0), 200);
  assert.equal(s(100), 20);
  assert.equal(s(50), 110);
  const flat = scaleLinear([5, 5], [0, 10]);
  assert.equal(flat(5), 0, "零跨度兜底不 NaN");
});

/* ── ③ niceCeil ── */
test("niceCeil:1/2/5 阶梯", () => {
  assert.equal(niceCeil(0), 1);
  assert.equal(niceCeil(-3), 1);
  assert.equal(niceCeil(1), 1);
  assert.equal(niceCeil(1.1), 2);
  assert.equal(niceCeil(3), 5);
  assert.equal(niceCeil(7), 10);
  assert.equal(niceCeil(12), 20);
  assert.equal(niceCeil(46), 50);
  assert.equal(niceCeil(0.4), 0.5);
});

/* ── ④ donutSlicePath ── */
test("donutSlicePath:四分之一扇区起止点几何", () => {
  // cx=cy=50,rOuter=48,rInner=30,0→90°(正上方 → 正右方)
  const d = donutSlicePath(50, 50, 48, 30, 0, Math.PI / 2);
  assert.match(d, /^M 50 2 /, "起点在正上方外弧");
  assert.match(d, /A 48 48 0 0 1 98 50/, "外弧终点在正右方");
  assert.match(d, /L 80 50/, "内弧终点在正右方");
  assert.match(d, /A 30 30 0 0 0 50 20 Z$/, "内弧回到正上方闭合");
});

/* ── ⑤ barLayout ── */
test("barLayout:24 柱均分,间隙比 0.35", () => {
  const { step, barWidth } = barLayout(24, 672);
  assert.equal(step, 28);
  assert.ok(Math.abs(barWidth - 28 * 0.65) < 1e-9);
  assert.equal(barLayout(0, 100).step, 100, "空数据兜底不 NaN");
});

/* ── ⑥ sparkPoints ── */
test("sparkPoints:null 值断段", () => {
  const x = (i: number) => i * 10;
  const y = (v: number) => 100 - v;
  const segs = sparkPoints([1, null, 2, 3, null], x, y);
  assert.equal(segs.length, 2);
  assert.deepEqual(segs[0], [{ x: 0, y: 99 }]);
  assert.deepEqual(segs[1], [
    { x: 20, y: 98 },
    { x: 30, y: 97 },
  ]);
  assert.deepEqual(sparkPoints([null, null], x, y), []);
});

/* ── ⑦ formatClock ── */
test("formatClock:ISO → HH:MM;非法输入空串", () => {
  const out = formatClock("2026-08-23T09:05:00+00:00");
  assert.match(out, /^\d{2}:\d{2}$/);
  assert.equal(formatClock("not-a-date"), "");
});

/* ── ⑧ 组件 SSR ── */
test("LineChart:渲染 svg/网格/图例;系列色与名称落位", () => {
  const html = renderToStaticMarkup(
    h(LineChart, {
      labels: ["2026-08-23T08:00:00+00:00", "2026-08-23T09:00:00+00:00"],
      series: [
        { name: "排队", color: CHART_COLORS[0], values: [1, 2] },
        { name: "运行", color: CHART_COLORS[1], values: [3, null] },
      ],
    }),
  );
  assert.match(html, /<svg/);
  assert.match(html, /uichart-legend/);
  assert.match(html, /排队/);
  assert.match(html, /运行/);
  // 批 D:系列色引用 --chart-N token(globals.css 亮/暗双模式承载色值)
  assert.match(html, /stroke="var\(--chart-1\)"/, "系列色应引用 --chart-1 token");
  // null 断点:第二系列单点退化为 circle
  assert.match(html, /<circle/);
});

/* ── ⑧b 色板 token 化(2026-08-30 批 D):无硬编码 hex,语义色映射全局状态 token ── */
test("CHART_COLORS:5 色板全部引用 --chart-N token,无硬编码 hex", () => {
  assert.equal(CHART_COLORS.length, 5, "色板固定 5 色(--chart-1..5)");
  for (const c of CHART_COLORS) {
    assert.match(c, /^var\(--chart-\d\)$/, `系列色应为 token 引用: ${c}`);
  }
});

test("CHART_SEMANTIC:ok/warn/hot/off 映射全局状态/文字 token", () => {
  assert.equal(CHART_SEMANTIC.ok, "var(--ok)");
  assert.equal(CHART_SEMANTIC.warn, "var(--warn)");
  assert.equal(CHART_SEMANTIC.hot, "var(--err)");
  assert.equal(CHART_SEMANTIC.off, "var(--text-muted)");
});

test("BarChart:堆叠柱渲染,零值不画 rect,稀疏标签", () => {
  const labels = Array.from({ length: 24 }, (_, i) => `${String(i).padStart(2, "0")}:00`);
  const done = Array.from({ length: 24 }, () => 0);
  done[23] = 3;
  const err = Array.from({ length: 24 }, () => 0);
  err[23] = 1;
  const html = renderToStaticMarkup(
    h(BarChart, {
      labels,
      series: [
        { name: "成功", color: "#34d399", values: done },
        { name: "失败", color: "#f87171", values: err },
      ],
    }),
  );
  assert.match(html, /<svg/);
  // 仅末桶有值:2 个 rect(成功+失败)
  assert.equal((html.match(/<rect/g) ?? []).length, 2);
  assert.match(html, /成功/);
});

test("DonutChart:占比扇区 + 中心总计;空数据灰环占位", () => {
  const html = renderToStaticMarkup(
    h(DonutChart, {
      slices: [
        { name: "成功", value: 3, color: "#34d399" },
        { name: "失败", value: 1, color: "#f87171" },
      ],
      centerLabel: "作业数",
    }),
  );
  assert.match(html, /uichart-donut-slice/);
  assert.match(html, /uichart-donut-val/);
  assert.match(html, />4</, "中心应显示总计 4");
  assert.match(html, /作业数/);

  const empty = renderToStaticMarkup(
    h(DonutChart, { slices: [{ name: "成功", value: 0, color: "#34d399" }] }),
  );
  assert.doesNotMatch(empty, /uichart-donut-slice\"/, "空数据无扇区");
  assert.match(empty, />0</);
});

test("DonutChart:单扇区独占整圆退化为描边圆环", () => {
  const html = renderToStaticMarkup(
    h(DonutChart, { slices: [{ name: "成功", value: 5, color: "#34d399" }] }),
  );
  assert.match(html, /<circle[^>]*stroke:#34d399|<circle[^>]*stroke="#34d399"/);
});

test("Sparkline:无轴极简渲染 + 末点圆点", () => {
  const html = renderToStaticMarkup(
    h(Sparkline, { values: [10, 20, 15, 30], yMax: 100 }),
  );
  assert.match(html, /<svg/);
  assert.match(html, /<path/);
  assert.match(html, /uichart-spark-end/);
  assert.doesNotMatch(html, /uichart-axis/, "Sparkline 无坐标轴");
});
