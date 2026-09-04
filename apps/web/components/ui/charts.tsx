"use client";

/**
 * 零依赖手写 SVG 图表库(2026-08-24 观测面板重做引入)。
 * LineChart / BarChart(堆叠) / DonutChart / Sparkline 四件套,纯 SVG + CSS
 * transition(600ms ease);prefers-reduced-motion 时全局关闭过渡。
 * 数据更新由 React 重渲染接管,几何属性变化走 CSS 过渡,不清空重绘(不闪屏)。
 * 几何计算全部导出为纯函数(smoothPath/scaleLinear/niceCeil/donutSlicePath/
 * barLayout/sparkPoints),node:test 直接单测。
 */
import { useId, useMemo, useState } from "react";

/** 图表系列色(设计规范):引用 globals.css --chart-1..5(cyan → violet → amber → green → rose),
 * 亮/暗双模式由 token 承载;SVG fill/stroke 属性与 style 内联均可消费 var()
 * (CHART_GRID 同款手法,2026-08-24 舰队视图已实证)。 */
export const CHART_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
] as const;

/** 语义色:ok/warn/hot/off → 全局状态/文字 token(不再硬编码 hex,2026-08-30 批 D) */
export const CHART_SEMANTIC = {
  ok: "var(--ok)",
  warn: "var(--warn)",
  hot: "var(--err)",
  off: "var(--text-muted)",
} as const;

/** 网格/十字线颜色走 CSS 变量:浅色主题(默认)深灰细线,[data-mode="dark"] 白细线;
 * 生产当前为浅色主题,硬编码白线会隐形(2026-08-24 舰队视图落地时修)。 */
export const CHART_GRID = "var(--uichart-grid, rgba(15,23,42,.10))";

/* ─────────────────────────── 纯函数(可单测) ─────────────────────────── */

export interface Pt {
  x: number;
  y: number;
}

const r2 = (v: number) => Math.round(v * 100) / 100;

/** Catmull-Rom → 三次贝塞尔平滑 path;单点退化为 M(画点交给调用方)。 */
export function smoothPath(pts: Pt[]): string {
  if (pts.length === 0) return "";
  if (pts.length === 1) return `M ${r2(pts[0].x)} ${r2(pts[0].y)}`;
  let d = `M ${r2(pts[0].x)} ${r2(pts[0].y)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${r2(c1x)} ${r2(c1y)}, ${r2(c2x)} ${r2(c2y)}, ${r2(p2.x)} ${r2(p2.y)}`;
  }
  return d;
}

/** 线性比例尺:domain → range(零跨度兜底 1 防除零)。 */
export function scaleLinear(
  domain: [number, number],
  range: [number, number],
): (v: number) => number {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0 || 1;
  return (v: number) => r0 + ((v - d0) / span) * (r1 - r0);
}

/** 坐标轴上限取整:1/2/5×10^n 阶梯,保证刻度好看(0/负数兜底 1)。 */
export function niceCeil(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(v));
  const n = v / pow;
  const nice = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return nice * pow;
}

/**
 * 环形扇区 path(甜甜圈单瓣):角度弧度制,0 = 正上方,顺时针增长。
 * 外弧 + 内弧闭合;整圆(2π)由调用方拆两瓣或直接画 circle。
 */
export function donutSlicePath(
  cx: number,
  cy: number,
  rOuter: number,
  rInner: number,
  a0: number,
  a1: number,
): string {
  const large = a1 - a0 > Math.PI ? 1 : 0;
  const p = (r: number, a: number) =>
    `${r2(cx + r * Math.sin(a))} ${r2(cy - r * Math.cos(a))}`;
  return [
    `M ${p(rOuter, a0)}`,
    `A ${r2(rOuter)} ${r2(rOuter)} 0 ${large} 1 ${p(rOuter, a1)}`,
    `L ${p(rInner, a1)}`,
    `A ${r2(rInner)} ${r2(rInner)} 0 ${large} 0 ${p(rInner, a0)}`,
    "Z",
  ].join(" ");
}

/** 柱状布局:count 根柱子均分 width,间隙占比 gapRatio。 */
export function barLayout(
  count: number,
  width: number,
  gapRatio = 0.35,
): { step: number; barWidth: number } {
  const step = count > 0 ? width / count : width;
  return { step, barWidth: step * (1 - gapRatio) };
}

/** 折线/火花线点位映射:null 值断开(分段),返回若干连续段。 */
export function sparkPoints(
  values: (number | null)[],
  x: (i: number) => number,
  y: (v: number) => number,
): Pt[][] {
  const segs: Pt[][] = [];
  let cur: Pt[] = [];
  values.forEach((v, i) => {
    if (v === null || !Number.isFinite(v)) {
      if (cur.length) segs.push(cur);
      cur = [];
    } else {
      cur.push({ x: r2(x(i)), y: r2(y(v)) });
    }
  });
  if (cur.length) segs.push(cur);
  return segs;
}

/** ISO 时间 → HH:MM(本地时区,面板场景即操作者时区)。 */
export function formatClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/* ─────────────────────────── LineChart ─────────────────────────── */

export interface LineSeries {
  name: string;
  color: string;
  values: (number | null)[];
}

interface LineChartProps {
  series: LineSeries[];
  /** x 轴标签(ISO 时间,与各 values 等长),首尾抽样展示 */
  labels: string[];
  height?: number;
  /** 固定 y 上限(如百分比 100);缺省按数据 niceCeil */
  yMax?: number;
  ariaLabel?: string;
}

const LW = 720; // viewBox 宽(响应式由外层 100% 宽度缩放)
const PAD = { l: 34, r: 10, t: 10, b: 22 };

export function LineChart({
  series,
  labels,
  height = 220,
  yMax,
  ariaLabel,
}: LineChartProps) {
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [hover, setHover] = useState<number | null>(null);

  /* 2026-09-04 美化 W1:单系列图表走琥珀点睛单色系(--accent-glow 渐变面积);
     多系列才消费 --chart-1..5 多色序列 */
  const mono = series.length === 1;
  const gradId = `uichart-mono-${useId().replace(/:/g, "")}`;
  const effColor = (s: LineSeries) => (mono ? "var(--accent-glow)" : s.color);

  const n = labels.length;
  const visible = series.filter((s) => !hidden.has(s.name));
  const innerW = LW - PAD.l - PAD.r;
  const innerH = height - PAD.t - PAD.b;

  const maxRaw = Math.max(
    0,
    ...visible.flatMap((s) => s.values.map((v) => v ?? 0)),
  );
  const top = yMax ?? niceCeil(maxRaw || 1);
  const x = scaleLinear([0, Math.max(n - 1, 1)], [PAD.l, PAD.l + innerW]);
  const y = scaleLinear([0, top], [PAD.t + innerH, PAD.t]);

  const ticks = useMemo(() => {
    const out: number[] = [];
    for (let i = 0; i <= 4; i++) out.push((top / 4) * i);
    return out;
  }, [top]);

  const toggle = (name: string) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * LW;
    const i = Math.round(((px - PAD.l) / innerW) * Math.max(n - 1, 1));
    setHover(Math.min(Math.max(i, 0), Math.max(n - 1, 0)));
  };

  return (
    <div className="uichart uichart-line">
      <div className="uichart-plot">
        <svg
          viewBox={`0 0 ${LW} ${height}`}
          width="100%"
          height={height}
          role="img"
          aria-label={ariaLabel}
          onMouseMove={n > 0 ? onMove : undefined}
          onMouseLeave={() => setHover(null)}
        >
          {ticks.map((t) => (
            <g key={t}>
              <line
                x1={PAD.l}
                x2={PAD.l + innerW}
                y1={y(t)}
                y2={y(t)}
                stroke={CHART_GRID}
                strokeWidth={1}
              />
              <text className="uichart-axis" x={PAD.l - 6} y={y(t) + 4} textAnchor="end">
                {r2(t)}
              </text>
            </g>
          ))}
          {n > 1 && (
            <>
              <text className="uichart-axis" x={PAD.l} y={height - 6} textAnchor="start">
                {formatClock(labels[0])}
              </text>
              <text className="uichart-axis" x={PAD.l + innerW} y={height - 6} textAnchor="end">
                {formatClock(labels[n - 1])}
              </text>
            </>
          )}
          {mono && (
            <defs>
              <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--accent-glow)" stopOpacity={0.16} />
                <stop offset="100%" stopColor="var(--accent-glow)" stopOpacity={0} />
              </linearGradient>
            </defs>
          )}
          {visible.map((s) => {
            const segs = sparkPoints(s.values, x, y);
            const color = effColor(s);
            return (
              <g key={s.name}>
                {mono &&
                  segs.map((seg, si) =>
                    seg.length < 2 ? null : (
                      <path
                        key={`area-${si}`}
                        d={`${smoothPath(seg)} L ${r2(seg[seg.length - 1].x)} ${r2(PAD.t + innerH)} L ${r2(seg[0].x)} ${r2(PAD.t + innerH)} Z`}
                        fill={`url(#${gradId})`}
                        stroke="none"
                      />
                    ),
                  )}
                {segs.map((seg, si) =>
                  seg.length === 1 ? (
                    <circle key={si} cx={seg[0].x} cy={seg[0].y} r={2.5} fill={color} />
                  ) : (
                    <path
                      key={si}
                      d={smoothPath(seg)}
                      fill="none"
                      stroke={color}
                      strokeWidth={2}
                      strokeLinecap="round"
                    />
                  ),
                )}
              </g>
            );
          })}
          {hover !== null && n > 0 && (
            <g className="uichart-crosshair">
              <line
                x1={x(hover)}
                x2={x(hover)}
                y1={PAD.t}
                y2={PAD.t + innerH}
                stroke="var(--uichart-crosshair, rgba(15,23,42,.30))"
                strokeDasharray="3 3"
              />
              {visible.map((s) => {
                const v = s.values[hover];
                return v === null || v === undefined ? null : (
                  <circle key={s.name} cx={x(hover)} cy={y(v)} r={3.5} fill={effColor(s)} />
                );
              })}
            </g>
          )}
        </svg>
        {hover !== null && n > 0 && (
          <div
            className="uichart-tooltip"
            style={{ left: `${(x(hover) / LW) * 100}%` }}
          >
            <div className="uichart-tooltip-time">{formatClock(labels[hover])}</div>
            {visible.map((s) => (
              <div key={s.name} className="uichart-tooltip-row">
                <span className="uichart-tooltip-dot" style={{ background: effColor(s) }} />
                <span>{s.name}</span>
                <span className="uichart-tooltip-val">{s.values[hover] ?? "—"}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="uichart-legend">
        {series.map((s) => (
          <button
            key={s.name}
            type="button"
            className={`uichart-legend-item${hidden.has(s.name) ? " is-off" : ""}`}
            onClick={() => toggle(s.name)}
          >
            <span className="uichart-tooltip-dot" style={{ background: effColor(s) }} />
            {s.name}
          </button>
        ))}
      </div>
    </div>
  );
}

/* ─────────────────────────── BarChart(堆叠) ─────────────────────────── */

export interface BarSeries {
  name: string;
  color: string;
  values: number[];
}

interface BarChartProps {
  labels: string[];
  series: BarSeries[];
  height?: number;
  ariaLabel?: string;
}

const BW = 720;

export function BarChart({ labels, series, height = 200, ariaLabel }: BarChartProps) {
  const n = labels.length;
  const innerW = BW - PAD.l - PAD.r;
  const innerH = height - PAD.t - PAD.b;
  const totals = Array.from({ length: n }, (_, i) =>
    series.reduce((acc, s) => acc + (s.values[i] ?? 0), 0),
  );
  const top = niceCeil(Math.max(0, ...totals) || 1);
  const y = scaleLinear([0, top], [PAD.t + innerH, PAD.t]);
  const { step, barWidth } = barLayout(n, innerW);
  const labelEvery = Math.max(1, Math.ceil(n / 6));

  return (
    <div className="uichart uichart-bar">
      <svg viewBox={`0 0 ${BW} ${height}`} width="100%" height={height} role="img" aria-label={ariaLabel}>
        {[0, 1, 2, 3, 4].map((i) => {
          const t = (top / 4) * i;
          return (
            <g key={i}>
              <line
                x1={PAD.l}
                x2={PAD.l + innerW}
                y1={y(t)}
                y2={y(t)}
                stroke={CHART_GRID}
              />
              <text className="uichart-axis" x={PAD.l - 6} y={y(t) + 4} textAnchor="end">
                {r2(t)}
              </text>
            </g>
          );
        })}
        {labels.map((lb, i) => {
          let acc = 0;
          const x0 = PAD.l + i * step + (step - barWidth) / 2;
          return (
            <g key={i}>
              {series.map((s) => {
                const v = s.values[i] ?? 0;
                if (v <= 0) return null;
                const y1 = y(acc + v);
                const y0 = y(acc);
                acc += v;
                return (
                  <rect
                    key={s.name}
                    className="uichart-bar-seg"
                    x={r2(x0)}
                    y={r2(y1)}
                    width={r2(barWidth)}
                    height={r2(y0 - y1)}
                    fill={s.color}
                    rx={1.5}
                  >
                    <title>{`${lb} ${s.name}: ${v}`}</title>
                  </rect>
                );
              })}
              {i % labelEvery === 0 && (
                <text
                  className="uichart-axis"
                  x={r2(x0 + barWidth / 2)}
                  y={height - 6}
                  textAnchor="middle"
                >
                  {lb}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <div className="uichart-legend">
        {series.map((s) => (
          <span key={s.name} className="uichart-legend-item is-static">
            <span className="uichart-tooltip-dot" style={{ background: s.color }} />
            {s.name}
          </span>
        ))}
      </div>
    </div>
  );
}

/* ─────────────────────────── DonutChart ─────────────────────────── */

export interface DonutSlice {
  name: string;
  value: number;
  color: string;
}

interface DonutChartProps {
  slices: DonutSlice[];
  size?: number;
  /** 中心主标签(hover 时替换为扇区名) */
  centerLabel?: string;
  ariaLabel?: string;
}

export function DonutChart({
  slices,
  size = 180,
  centerLabel,
  ariaLabel,
}: DonutChartProps) {
  const [active, setActive] = useState<number | null>(null);
  const total = slices.reduce((a, s) => a + s.value, 0);
  const cx = size / 2;
  const rOuter = size / 2 - 4;
  const rInner = rOuter * 0.62;

  let acc = 0;
  const arcs = slices.map((s) => {
    const a0 = (acc / (total || 1)) * Math.PI * 2;
    acc += s.value;
    const a1 = (acc / (total || 1)) * Math.PI * 2;
    return { ...s, a0, a1 };
  });

  const shown = active !== null ? slices[active] : null;

  return (
    <div className="uichart uichart-donut" style={{ width: size }}>
      <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} role="img" aria-label={ariaLabel}>
        {total <= 0 ? (
          <circle
            cx={cx}
            cy={cx}
            r={(rOuter + rInner) / 2}
            fill="none"
            stroke={CHART_SEMANTIC.off}
            strokeWidth={rOuter - rInner}
            opacity={0.35}
          />
        ) : (
          arcs.map((a, i) => {
            if (a.value <= 0) return null;
            // 独占整圆:起点=终点的 A 弧不渲染,退化为描边圆环
            if (a.value === total) {
              return (
                <circle
                  key={a.name}
                  className={`uichart-donut-slice${active === i ? " is-active" : ""}`}
                  cx={cx}
                  cy={cx}
                  r={(rOuter + rInner) / 2}
                  fill="none"
                  stroke={a.color}
                  strokeWidth={rOuter - rInner}
                  onMouseEnter={() => setActive(i)}
                  onMouseLeave={() => setActive(null)}
                >
                  <title>{`${a.name}: ${a.value}`}</title>
                </circle>
              );
            }
            return (
              <path
                key={a.name}
                className={`uichart-donut-slice${active === i ? " is-active" : ""}`}
                d={donutSlicePath(cx, cx, rOuter, rInner, a.a0, a.a1)}
                fill={a.color}
                onMouseEnter={() => setActive(i)}
                onMouseLeave={() => setActive(null)}
              >
                <title>{`${a.name}: ${a.value}`}</title>
              </path>
            );
          })
        )}
        <text className="uichart-donut-val" x={cx} y={cx - 2} textAnchor="middle">
          {shown ? shown.value : total}
        </text>
        <text className="uichart-donut-label" x={cx} y={cx + 16} textAnchor="middle">
          {shown ? shown.name : (centerLabel ?? "总计")}
        </text>
      </svg>
      <div className="uichart-legend">
        {slices.map((s) => (
          <span key={s.name} className="uichart-legend-item is-static">
            <span className="uichart-tooltip-dot" style={{ background: s.color }} />
            {s.name} {s.value}
          </span>
        ))}
      </div>
    </div>
  );
}

/* ─────────────────────────── Sparkline ─────────────────────────── */

interface SparklineProps {
  values: (number | null)[];
  color?: string;
  width?: number;
  height?: number;
  /** 固定上限(如百分比 100);缺省按数据 */
  yMax?: number;
  ariaLabel?: string;
}

export function Sparkline({
  values,
  /* 2026-09-04 美化 W1:火花线恒单系列,默认改琥珀点睛单色(显式语义色调用不变) */
  color = "var(--accent-glow)",
  width = 96,
  height = 28,
  yMax,
  ariaLabel,
}: SparklineProps) {
  const top = yMax ?? Math.max(1, ...values.map((v) => v ?? 0));
  const x = scaleLinear([0, Math.max(values.length - 1, 1)], [2, width - 2]);
  const y = scaleLinear([0, top], [height - 2, 2]);
  const segs = sparkPoints(values, x, y);
  const last = [...values].reverse().find((v) => v !== null);

  return (
    <svg
      className="uichart uichart-spark"
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      role="img"
      aria-label={ariaLabel}
    >
      {segs.map((seg, i) =>
        seg.length === 1 ? (
          <circle key={i} cx={seg[0].x} cy={seg[0].y} r={2} fill={color} />
        ) : (
          <path
            key={i}
            d={smoothPath(seg)}
            fill="none"
            stroke={color}
            strokeWidth={1.6}
            strokeLinecap="round"
          />
        ),
      )}
      {last !== undefined && last !== null && values.length > 1 && (
        <circle
          className="uichart-spark-end"
          cx={x(values.length - 1)}
          cy={y(last)}
          r={2.2}
          fill={color}
        />
      )}
    </svg>
  );
}

/* ─────────────────────────── 共享样式 ─────────────────────────── */

/** 图表库共享样式(任一消费视图注入一次即可)。 */
export function ChartStyles() {
  return (
    <style jsx global>{`
      .uichart {
        --uichart-grid: rgba(15, 23, 42, 0.10);
        --uichart-crosshair: rgba(15, 23, 42, 0.30);
      }
      [data-mode="dark"] .uichart {
        --uichart-grid: rgba(255, 255, 255, 0.06);
        --uichart-crosshair: rgba(255, 255, 255, 0.25);
      }
      .uichart-axis {
        font-size: 11px;
        fill: var(--text-muted, #888);
        font-variant-numeric: tabular-nums;
      }
      .uichart path,
      .uichart rect,
      .uichart circle {
        transition: all 600ms ease;
      }
      .uichart-plot {
        position: relative;
      }
      .uichart-tooltip {
        position: absolute;
        top: 8px;
        transform: translateX(-50%);
        background: rgba(10, 14, 24, 0.92);
        border: 1px solid var(--border, rgba(255, 255, 255, 0.12));
        border-radius: 8px;
        padding: 6px 10px;
        font-size: 11px;
        pointer-events: none;
        white-space: nowrap;
        z-index: 2;
      }
      .uichart-tooltip-time {
        color: var(--text-muted, #888);
        margin-bottom: 3px;
        font-variant-numeric: tabular-nums;
      }
      .uichart-tooltip-row {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .uichart-tooltip-val {
        margin-left: auto;
        font-variant-numeric: tabular-nums;
        font-weight: 600;
      }
      .uichart-tooltip-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        flex-shrink: 0;
        display: inline-block;
      }
      .uichart-legend {
        display: flex;
        flex-wrap: wrap;
        gap: 6px 14px;
        margin-top: 6px;
        font-size: 11px;
        color: var(--text-muted, #888);
      }
      .uichart-legend-item {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        background: none;
        border: none;
        padding: 2px 0;
        color: inherit;
        font: inherit;
        cursor: pointer;
      }
      .uichart-legend-item.is-static {
        cursor: default;
      }
      .uichart-legend-item.is-off {
        opacity: 0.35;
        text-decoration: line-through;
      }
      .uichart-donut {
        margin: 0 auto;
      }
      .uichart-donut-slice {
        transform-box: fill-box;
        transform-origin: center;
        cursor: pointer;
      }
      .uichart-donut-slice.is-active {
        transform: scale(1.04);
      }
      .uichart-donut-val {
        font-size: 24px;
        font-weight: 700;
        fill: var(--text-primary, #e8ecf4);
        font-variant-numeric: tabular-nums;
      }
      .uichart-donut-label {
        font-size: 11px;
        fill: var(--text-muted, #888);
      }
      @media (prefers-reduced-motion: reduce) {
        .uichart path,
        .uichart rect,
        .uichart circle,
        .uichart-donut-slice {
          transition: none !important;
        }
        .uichart-donut-slice.is-active {
          transform: none;
        }
      }
    `}</style>
  );
}
