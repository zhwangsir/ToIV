"use client";

import { useCallback, useEffect, useState } from "react";

import {
  fetchObservability,
  type ObservabilitySnapshot,
} from "@/lib/api";
import { ErrorBar } from "@/components/ui/ErrorBar";
import { PageHeader } from "@/components/ui/PageHeader";
import { Skeleton } from "@/components/ui/Skeleton";
import {
  BarChart,
  CHART_COLORS,
  CHART_SEMANTIC,
  ChartStyles,
  DonutChart,
  formatClock,
  LineChart,
  Sparkline,
} from "@/components/ui/charts";

/** 轮询周期 12s(后端快照 10s 缓存,轮询基本全命中,不会打爆 /system_stats)。 */
const POLL_MS = 12_000;

/** 成功率展示:无样本( null )显示占位,避免 "NaN%"。 */
export function formatRate(rate: number | null): string {
  return rate === null ? "—" : `${(rate * 100).toFixed(1)}%`;
}

/** VRAM 占用分档色:≥90 危险 / ≥70 偏高 / 其余正常 / 离线灰。 */
export function vramTone(pct: number | null): "is-hot" | "is-warm" | "is-ok" | "is-off" {
  if (pct === null) return "is-off";
  if (pct >= 90) return "is-hot";
  if (pct >= 70) return "is-warm";
  return "is-ok";
}

/** GB 展示:整数去小数,否则保留 1 位。 */
export function formatGb(gb: number | null): string {
  if (gb === null) return "—";
  return Number.isInteger(gb) ? `${gb}` : gb.toFixed(1);
}

/** KPI 数字:key 变更触发 600ms 淡入上移(reduced-motion 下由全局 CSS 关闭)。 */
function KpiNumber({ value, className }: { value: string; className?: string }) {
  return (
    <span key={value} className={`obs-kpi-num${className ? ` ${className}` : ""}`}>
      {value}
    </span>
  );
}

function KpiStrip({ data }: { data: ObservabilitySnapshot }) {
  const tiles = [
    { key: "queued", label: "排队中", value: data.queue.queued },
    { key: "held", label: "资源等待", value: data.queue.held },
    { key: "running", label: "运行中", value: data.queue.running },
    { key: "other", label: "其他活跃", value: data.queue.other },
  ];
  return (
    <section className="obs-kpis" aria-label="关键指标">
      {tiles.map((t) => (
        <div key={t.key} className={`obs-kpi obs-kpi-${t.key}`}>
          <KpiNumber value={String(t.value)} className="obs-kpi-value" />
          <div className="obs-kpi-label">{t.label}</div>
        </div>
      ))}
      <div className="obs-kpi obs-kpi-rate">
        <KpiNumber value={formatRate(data.success_24h.rate)} className="obs-kpi-value" />
        <div className="obs-kpi-label">
          24h 成功率 · 成功 {data.success_24h.done} / 失败 {data.success_24h.error}
        </div>
      </div>
    </section>
  );
}

function QueueTrendCard({ data }: { data: ObservabilitySnapshot }) {
  const s = data.series;
  return (
    <section className="obs-card obs-chart" aria-label="队列时序">
      <h2 className="obs-card-title">队列时序(近 2h)</h2>
      {s.timestamps.length >= 2 ? (
        <LineChart
          ariaLabel="队列时序折线图"
          labels={s.timestamps}
          series={[
            { name: "排队", color: CHART_COLORS[0], values: s.queued },
            { name: "等待", color: CHART_COLORS[2], values: s.held },
            { name: "运行", color: CHART_COLORS[1], values: s.running },
          ]}
          height={200}
        />
      ) : (
        <div className="obs-chart-empty">
          时序采样积累中(每 {data.cache_ttl_sec}s 一条,重启后从零开始)
        </div>
      )}
    </section>
  );
}

function SuccessDonutCard({ data }: { data: ObservabilitySnapshot }) {
  const active = data.queue.queued + data.queue.held + data.queue.running;
  return (
    <section className="obs-card obs-chart" aria-label="成功率占比">
      <h2 className="obs-card-title">24h 作业构成</h2>
      <DonutChart
        ariaLabel="成功/失败/进行中占比"
        centerLabel="作业数"
        slices={[
          { name: "成功", value: data.success_24h.done, color: CHART_SEMANTIC.ok },
          { name: "失败", value: data.success_24h.error, color: CHART_SEMANTIC.hot },
          { name: "进行中", value: active, color: CHART_COLORS[0] },
        ]}
      />
    </section>
  );
}

function HourlyCard({ data }: { data: ObservabilitySnapshot }) {
  return (
    <section className="obs-card obs-chart" aria-label="逐小时成功失败">
      <h2 className="obs-card-title">24h 逐小时成功 / 失败</h2>
      <BarChart
        ariaLabel="逐小时成功失败堆叠柱状图"
        labels={data.hourly.map((b) => formatClock(b.hour))}
        series={[
          { name: "成功", color: CHART_SEMANTIC.ok, values: data.hourly.map((b) => b.done) },
          { name: "失败", color: CHART_SEMANTIC.hot, values: data.hourly.map((b) => b.error) },
        ]}
        height={180}
      />
    </section>
  );
}

function GpuCard({
  gpu,
  history,
}: {
  gpu: ObservabilitySnapshot["gpus"][number];
  history: (number | null)[];
}) {
  const pct = gpu.vram_used_pct;
  const tone = vramTone(pct);
  return (
    <div className={`obs-gpu${gpu.online ? "" : " is-offline"}`}>
      <div className="obs-gpu-head">
        <span className={`obs-dot${gpu.online ? " is-on" : ""}`} aria-hidden="true" />
        <span className="obs-gpu-id">{gpu.id}</span>
        <span className="obs-gpu-host">{gpu.host}</span>
        {(gpu.queue_running > 0 || gpu.queue_pending > 0) && (
          <span className="obs-gpu-queue">
            跑 {gpu.queue_running} / 排 {gpu.queue_pending}
          </span>
        )}
      </div>
      <div className="obs-vram">
        <div className="obs-vram-row">
          <div className="obs-vram-bar" role="progressbar" aria-valuenow={pct ?? 0}>
            <div
              className={`obs-vram-fill ${tone}`}
              style={{ width: `${pct ?? 0}%` }}
            />
          </div>
          <Sparkline
            values={history}
            color={
              tone === "is-hot"
                ? CHART_SEMANTIC.hot
                : tone === "is-warm"
                  ? CHART_SEMANTIC.warn
                  : CHART_COLORS[0]
            }
            yMax={100}
            ariaLabel={`${gpu.id} VRAM 历史`}
          />
        </div>
        <div className="obs-vram-text">
          {gpu.online
            ? `${formatGb(gpu.vram_used_gb)} / ${formatGb(gpu.vram_total_gb)} GB (${pct ?? 0}%)`
            : "离线"}
        </div>
      </div>
      <ul className="obs-instances">
        {gpu.instances.map((inst) => (
          <li key={inst.url} className={inst.online ? "" : "is-offline"}>
            <span className="obs-inst-name">{inst.name}</span>
            <span className="obs-inst-vram">
              {inst.online
                ? `${formatGb(inst.vram_used_gb)}/${formatGb(inst.vram_total_gb)} GB`
                : "不可达"}
            </span>
            {inst.online && (inst.queue_running > 0 || inst.queue_pending > 0) && (
              <span className="obs-inst-queue">
                跑{inst.queue_running} 排{inst.queue_pending}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** 首屏骨架屏:KPI 条 + 图表块 + GPU 卡,占位避免布局跳动。 */
function ObsSkeleton() {
  return (
    <div className="obs-body" aria-hidden="true">
      <div className="obs-kpis">
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} height={64} className="obs-skel" />
        ))}
      </div>
      <div className="obs-charts-row">
        <Skeleton height={240} className="obs-skel" />
        <Skeleton height={240} className="obs-skel" />
      </div>
      <Skeleton height={220} className="obs-skel" />
      <div className="obs-gpus">
        {Array.from({ length: 3 }, (_, i) => (
          <Skeleton key={i} height={150} className="obs-skel" />
        ))}
      </div>
    </div>
  );
}

/**
 * 观测面板(2026-08-24 重做):深色科技风数据大屏(仅管理员)。
 * 层级:KPI 数字 > 趋势图(队列时序/构成 donut/逐小时堆叠柱)> GPU 细节。
 * 数据来自 GET /api/observability 聚合快照(含 series 时序 + hourly 分桶),12s 轮询;
 * 静默刷新不清空旧数据,图表/CSS 过渡接管重绘,不闪屏。
 */
export function ObservabilityView() {
  const [data, setData] = useState<ObservabilitySnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (silent: boolean) => {
    if (!silent) setLoading(true);
    try {
      const snap = await fetchObservability();
      setData(snap);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载观测数据失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(false);
    const timer = setInterval(() => load(true), POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  return (
    <div className="obs-view view-shell">
      <ChartStyles />
      <PageHeader
        kicker="OBSERVABILITY"
        title="观测面板"
        desc="队列 · 成功率 · GPU 负载 实时聚合(12s 自动刷新)"
        actions={
          data ? (
            <span className="obs-live">
              <span key={data.generated_at} className="obs-live-dot" aria-hidden="true" />
              <span className="obs-live-text">实时</span>
              <span className="obs-updated">
                更新于 {new Date(data.generated_at).toLocaleTimeString("zh-CN")}
              </span>
            </span>
          ) : undefined
        }
      />
      {error && <ErrorBar message={error} onClose={() => setError(null)} />}
      {loading && !data ? (
        <div role="status" aria-label="观测数据加载中">
          <ObsSkeleton />
        </div>
      ) : data ? (
        <div className="obs-body">
          <KpiStrip data={data} />
          {data.held.reasons.length > 0 && (
            <ul className="obs-held-reasons">
              {data.held.reasons.map((r) => (
                <li key={r.reason}>
                  <span className="obs-held-count">{r.count} 个作业</span>
                  <span className="obs-held-reason">{r.reason}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="obs-charts-row">
            <QueueTrendCard data={data} />
            <SuccessDonutCard data={data} />
          </div>
          <HourlyCard data={data} />
          <section className="obs-card" aria-label="GPU 负载">
            <h2 className="obs-card-title">GPU 负载(VRAM)</h2>
            <div className="obs-gpus">
              {data.gpus.map((gpu) => (
                <GpuCard
                  key={gpu.id}
                  gpu={gpu}
                  history={data.series.vram_pct[gpu.id] ?? []}
                />
              ))}
            </div>
          </section>
        </div>
      ) : null}
      {/* obs-* 规则用 global:styled-jsx 的 jsxId 只打在主组件自身 JSX 上,
          同文件子组件(KpiStrip/各 Card)的元素拿不到作用域类,整段样式静默失效
          (2026-08-24 生产实测:KPI 条 display:block 无网格)。obs- 前缀已防碰撞。 */}
      <style jsx global>{`
        .obs-view {
          display: flex;
          flex-direction: column;
          height: 100%;
          overflow-y: auto;
        }
        .obs-live {
          display: inline-flex;
          align-items: center;
          gap: 8px;
        }
        .obs-live-dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background: #34d399;
          animation: obs-live-pulse 1.2s ease-out 1;
          box-shadow: 0 0 0 0 rgba(52, 211, 153, 0.5);
        }
        @keyframes obs-live-pulse {
          0% { box-shadow: 0 0 0 0 rgba(52, 211, 153, 0.55); }
          100% { box-shadow: 0 0 0 10px rgba(52, 211, 153, 0); }
        }
        .obs-live-text {
          font-size: 12px;
          color: #34d399;
          font-weight: 600;
        }
        .obs-updated {
          font-size: 12px;
          color: var(--text-muted, #888);
          font-variant-numeric: tabular-nums;
        }
        .obs-body {
          display: flex;
          flex-direction: column;
          gap: var(--space-4, 16px);
          padding-bottom: var(--space-6, 24px);
        }
        /* ── KPI 条 ── */
        .obs-kpis {
          display: grid;
          grid-template-columns: repeat(4, 1fr) 1.6fr;
          gap: var(--space-3, 12px);
        }
        .obs-kpi {
          border: 1px solid var(--border, rgba(255, 255, 255, 0.08));
          border-radius: var(--radius-md, 10px);
          padding: var(--space-3, 12px) var(--space-4, 16px);
          background: var(--surface-1, rgba(255, 255, 255, 0.02));
          transition: border-color 600ms ease;
        }
        .obs-kpi:hover {
          border-color: rgba(34, 211, 238, 0.35);
        }
        .obs-kpi-num {
          display: block;
          font-size: 24px;
          font-weight: 700;
          font-variant-numeric: tabular-nums;
          animation: obs-kpi-in 600ms ease;
        }
        .obs-kpi-rate .obs-kpi-num {
          font-size: 30px;
          background: linear-gradient(90deg, #22d3ee, #a78bfa);
          -webkit-background-clip: text;
          background-clip: text;
          color: transparent;
        }
        .obs-kpi-held .obs-kpi-num {
          color: #fbbf24;
        }
        .obs-kpi-running .obs-kpi-num {
          color: #22d3ee;
        }
        @keyframes obs-kpi-in {
          from { opacity: 0.2; transform: translateY(4px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .obs-kpi-label {
          margin-top: 2px;
          font-size: 12px;
          color: var(--text-muted, #888);
        }
        /* ── 卡片/图表 ── */
        .obs-card {
          border: 1px solid var(--border, rgba(255, 255, 255, 0.08));
          border-radius: var(--radius-lg, 14px);
          padding: var(--space-4, 16px);
          background: var(--surface-1, rgba(255, 255, 255, 0.02));
          transition: border-color 600ms ease;
        }
        .obs-card:hover {
          border-color: rgba(167, 139, 250, 0.3);
        }
        .obs-card-title {
          margin: 0 0 var(--space-3, 12px);
          font-size: 13px;
          font-weight: 600;
          color: var(--text-muted, #888);
          letter-spacing: 0.04em;
        }
        .obs-charts-row {
          display: grid;
          grid-template-columns: 2fr 1fr;
          gap: var(--space-4, 16px);
        }
        .obs-chart-empty {
          display: flex;
          align-items: center;
          justify-content: center;
          min-height: 200px;
          font-size: 12px;
          color: var(--text-muted, #888);
          border: 1px dashed var(--border, rgba(255, 255, 255, 0.08));
          border-radius: var(--radius-md, 10px);
        }
        .obs-held-reasons {
          list-style: none;
          margin: 0;
          padding: var(--space-3, 12px) var(--space-4, 16px);
          border: 1px solid var(--border, rgba(255, 255, 255, 0.08));
          border-radius: var(--radius-md, 10px);
          background: var(--surface-1, rgba(255, 255, 255, 0.02));
          display: flex;
          flex-direction: column;
          gap: 6px;
          font-size: 12px;
        }
        .obs-held-reasons li {
          display: flex;
          gap: 8px;
          align-items: baseline;
        }
        .obs-held-count {
          flex-shrink: 0;
          color: #fbbf24;
          font-weight: 600;
        }
        .obs-held-reason {
          color: var(--text-muted, #888);
          word-break: break-all;
        }
        /* ── GPU 卡 ── */
        .obs-gpus {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
          gap: var(--space-3, 12px);
        }
        .obs-gpu {
          border: 1px solid var(--border, rgba(255, 255, 255, 0.08));
          border-radius: var(--radius-md, 10px);
          padding: var(--space-3, 12px);
          display: flex;
          flex-direction: column;
          gap: var(--space-2, 8px);
          transition: border-color 600ms ease;
        }
        .obs-gpu:hover {
          border-color: rgba(34, 211, 238, 0.35);
        }
        .obs-gpu.is-offline {
          opacity: 0.55;
        }
        .obs-gpu-head {
          display: flex;
          align-items: center;
          gap: 8px;
          font-size: 13px;
        }
        .obs-dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background: #64748b;
          flex-shrink: 0;
        }
        .obs-dot.is-on {
          background: #34d399;
        }
        .obs-gpu-id {
          font-weight: 700;
        }
        .obs-gpu-host {
          color: var(--text-muted, #888);
          font-size: 12px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .obs-gpu-queue {
          margin-left: auto;
          font-size: 12px;
          color: #22d3ee;
          flex-shrink: 0;
          font-variant-numeric: tabular-nums;
        }
        .obs-vram-row {
          display: flex;
          align-items: center;
          gap: 10px;
        }
        .obs-vram-bar {
          flex: 1;
          height: 8px;
          border-radius: 4px;
          background: var(--surface-2, rgba(255, 255, 255, 0.06));
          overflow: hidden;
        }
        .obs-vram-fill {
          height: 100%;
          border-radius: 4px;
          transition: width 600ms ease, background 600ms ease;
        }
        .obs-vram-fill.is-ok {
          background: linear-gradient(90deg, #22d3ee, #a78bfa);
        }
        .obs-vram-fill.is-warm {
          background: linear-gradient(90deg, #fbbf24, #f59e0b);
        }
        .obs-vram-fill.is-hot {
          background: linear-gradient(90deg, #f87171, #ef4444);
        }
        .obs-vram-fill.is-off {
          background: #64748b;
        }
        .obs-vram-text {
          margin-top: 4px;
          font-size: 12px;
          color: var(--text-muted, #888);
          font-variant-numeric: tabular-nums;
        }
        .obs-instances {
          list-style: none;
          margin: 0;
          padding: var(--space-2, 8px) 0 0;
          border-top: 1px dashed var(--border, rgba(255, 255, 255, 0.08));
          display: flex;
          flex-direction: column;
          gap: 4px;
          font-size: 12px;
        }
        .obs-instances li {
          display: flex;
          gap: 8px;
          align-items: baseline;
        }
        .obs-instances li.is-offline {
          color: var(--text-muted, #888);
        }
        .obs-inst-name {
          font-weight: 600;
        }
        .obs-inst-vram {
          color: var(--text-muted, #888);
          font-variant-numeric: tabular-nums;
        }
        .obs-inst-queue {
          margin-left: auto;
          color: #22d3ee;
        }
        .obs-skel {
          border-radius: var(--radius-md, 10px);
        }
        /* ── 响应式:<860px 单列 ── */
        @media (max-width: 860px) {
          .obs-kpis {
            grid-template-columns: repeat(2, 1fr);
          }
          .obs-kpi-rate {
            grid-column: 1 / -1;
          }
          .obs-charts-row {
            grid-template-columns: 1fr;
          }
        }
        @media (prefers-reduced-motion: reduce) {
          .obs-kpi-num,
          .obs-live-dot {
            animation: none !important;
          }
          .obs-kpi,
          .obs-card,
          .obs-gpu,
          .obs-vram-fill {
            transition: none !important;
          }
        }
      `}</style>
    </div>
  );
}
