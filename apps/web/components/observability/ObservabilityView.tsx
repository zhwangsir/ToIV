"use client";

import { useCallback, useEffect, useState } from "react";

import {
  fetchObservability,
  type ObservabilityGpu,
  type ObservabilitySnapshot,
} from "@/lib/api";
import { ErrorBar } from "@/components/ui/ErrorBar";
import { LoadingBlock } from "@/components/ui/LoadingBlock";
import { PageHeader } from "@/components/ui/PageHeader";

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

function QueueSection({ data }: { data: ObservabilitySnapshot }) {
  const tiles = [
    { key: "queued", label: "排队中", value: data.queue.queued },
    { key: "held", label: "资源等待(held)", value: data.queue.held },
    { key: "running", label: "运行中", value: data.queue.running },
    { key: "other", label: "其他活跃", value: data.queue.other },
  ];
  return (
    <section className="obs-section" aria-label="作业队列">
      <h2 className="obs-section-title">作业队列</h2>
      <div className="obs-tiles">
        {tiles.map((t) => (
          <div key={t.key} className={`obs-tile obs-tile-${t.key}`}>
            <div className="obs-tile-value">{t.value}</div>
            <div className="obs-tile-label">{t.label}</div>
          </div>
        ))}
      </div>
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
    </section>
  );
}

function SuccessSection({ data }: { data: ObservabilitySnapshot }) {
  const s = data.success_24h;
  return (
    <section className="obs-section" aria-label="近期成功率">
      <h2 className="obs-section-title">近 {s.window_hours}h 成功率</h2>
      <div className="obs-success">
        <div className="obs-success-rate">{formatRate(s.rate)}</div>
        <div className="obs-success-detail">
          <span className="obs-success-done">成功 {s.done}</span>
          <span className="obs-success-error">失败 {s.error}</span>
          <span className="obs-success-total">样本 {s.total}</span>
        </div>
      </div>
    </section>
  );
}

function GpuCard({ gpu }: { gpu: ObservabilityGpu }) {
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
        <div className="obs-vram-bar" role="progressbar" aria-valuenow={pct ?? 0}>
          <div
            className={`obs-vram-fill ${tone}`}
            style={{ width: `${pct ?? 0}%` }}
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

/**
 * 观测面板(2026-08-23):替代 SSH 看日志的一屏运维视图(仅管理员)。
 * 三区块:队列分桶计数 / 近 24h 成功率 / GPU 卡 VRAM 负载(含卡上实例清单)。
 * 数据来自 GET /api/observability 聚合快照,12s 轮询。
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
      <PageHeader
        kicker="OBSERVABILITY"
        title="观测面板"
        desc="作业队列 · 成功率 · GPU 负载 实时聚合(12s 自动刷新)"
        actions={
          data ? (
            <span className="obs-updated">
              更新于 {new Date(data.generated_at).toLocaleTimeString("zh-CN")}
            </span>
          ) : undefined
        }
      />
      {error && <ErrorBar message={error} onClose={() => setError(null)} />}
      {loading && !data ? (
        <div className="obs-loading" role="status" aria-label="观测数据加载中">
          <LoadingBlock variant="line" count={3} />
        </div>
      ) : data ? (
        <div className="obs-body">
          <div className="obs-top">
            <QueueSection data={data} />
            <SuccessSection data={data} />
          </div>
          <section className="obs-section" aria-label="GPU 负载">
            <h2 className="obs-section-title">GPU 负载(VRAM)</h2>
            <div className="obs-gpus">
              {data.gpus.map((gpu) => (
                <GpuCard key={gpu.id} gpu={gpu} />
              ))}
            </div>
          </section>
        </div>
      ) : null}
      <style jsx>{`
        .obs-view {
          display: flex;
          flex-direction: column;
          height: 100%;
          overflow-y: auto;
        }
        .obs-updated {
          font-size: 12px;
          color: var(--text-muted, #888);
        }
        .obs-body {
          display: flex;
          flex-direction: column;
          gap: var(--space-5, 20px);
          padding-bottom: var(--space-6, 24px);
        }
        .obs-top {
          display: grid;
          grid-template-columns: 2fr 1fr;
          gap: var(--space-4, 16px);
        }
        @media (max-width: 860px) {
          .obs-top {
            grid-template-columns: 1fr;
          }
        }
        .obs-section {
          border: 1px solid var(--border, rgba(255, 255, 255, 0.08));
          border-radius: var(--radius-lg, 14px);
          padding: var(--space-4, 16px);
          background: var(--surface-1, rgba(255, 255, 255, 0.02));
        }
        .obs-section-title {
          margin: 0 0 var(--space-3, 12px);
          font-size: 13px;
          font-weight: 600;
          color: var(--text-muted, #888);
          letter-spacing: 0.04em;
        }
        .obs-tiles {
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          gap: var(--space-3, 12px);
        }
        @media (max-width: 640px) {
          .obs-tiles {
            grid-template-columns: repeat(2, 1fr);
          }
        }
        .obs-tile {
          border-radius: var(--radius-md, 10px);
          padding: var(--space-3, 12px);
          background: var(--surface-2, rgba(255, 255, 255, 0.04));
          text-align: center;
        }
        .obs-tile-value {
          font-size: 26px;
          font-weight: 700;
          font-variant-numeric: tabular-nums;
        }
        .obs-tile-held .obs-tile-value {
          color: var(--warning, #e5a844);
        }
        .obs-tile-running .obs-tile-value {
          color: var(--accent, #7c9eff);
        }
        .obs-tile-label {
          margin-top: 2px;
          font-size: 12px;
          color: var(--text-muted, #888);
        }
        .obs-held-reasons {
          list-style: none;
          margin: var(--space-3, 12px) 0 0;
          padding: var(--space-2, 8px) 0 0;
          border-top: 1px dashed var(--border, rgba(255, 255, 255, 0.08));
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
          color: var(--warning, #e5a844);
          font-weight: 600;
        }
        .obs-held-reason {
          color: var(--text-muted, #888);
          word-break: break-all;
        }
        .obs-success {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: var(--space-2, 8px);
          padding: var(--space-3, 12px) 0;
        }
        .obs-success-rate {
          font-size: 40px;
          font-weight: 700;
          font-variant-numeric: tabular-nums;
        }
        .obs-success-detail {
          display: flex;
          gap: var(--space-3, 12px);
          font-size: 12px;
          color: var(--text-muted, #888);
        }
        .obs-success-done {
          color: var(--success, #5fce80);
        }
        .obs-success-error {
          color: var(--danger, #e5685f);
        }
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
          background: var(--text-muted, #888);
          flex-shrink: 0;
        }
        .obs-dot.is-on {
          background: var(--success, #5fce80);
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
          color: var(--accent, #7c9eff);
          flex-shrink: 0;
        }
        .obs-vram-bar {
          height: 8px;
          border-radius: 4px;
          background: var(--surface-2, rgba(255, 255, 255, 0.06));
          overflow: hidden;
        }
        .obs-vram-fill {
          height: 100%;
          border-radius: 4px;
          transition: width 0.6s ease;
        }
        .obs-vram-fill.is-ok {
          background: var(--success, #5fce80);
        }
        .obs-vram-fill.is-warm {
          background: var(--warning, #e5a844);
        }
        .obs-vram-fill.is-hot {
          background: var(--danger, #e5685f);
        }
        .obs-vram-fill.is-off {
          background: var(--text-muted, #888);
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
          color: var(--accent, #7c9eff);
        }
      `}</style>
    </div>
  );
}
