"use client";

import { useCallback, useEffect, useState } from "react";

import {
  fetchFleet,
  fetchFleetDevice,
  fetchObservability,
  type FleetDeviceDetail,
  type FleetDeviceSummary,
  type FleetSummary,
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

/* ─────────────────────────── 设备舰队 ─────────────────────────── */

/** 设备在线状态点:绿在线 / 红离线 / 灰未知。 */
export function fleetDotClass(online: boolean | null): string {
  if (online === null) return "obs-dot is-unknown";
  return online ? "obs-dot is-on" : "obs-dot is-down";
}

/** 延迟展示:null → —(离线/未知)。 */
export function formatMs(ms: number | null): string {
  return ms === null ? "—" : `${Math.round(ms)}ms`;
}

/** 详情页延迟折线:取有采样数据的服务,按最近延迟降序最多 max 条。 */
export function pickLatencySeries(
  detail: FleetDeviceDetail,
  max = 6,
): { name: string; values: (number | null)[] }[] {
  return Object.entries(detail.series.latency)
    .filter(([, values]) => values.some((v) => v !== null))
    .map(([name, values]) => ({
      name,
      values,
      last: [...values].reverse().find((v) => v !== null) ?? 0,
    }))
    .sort((a, b) => b.last - a.last)
    .slice(0, max)
    .map(({ name, values }) => ({ name, values }));
}

/** 设备卡(一级网格):状态点 + 名称 + x/y + 角色 + headline。 */
function FleetCard({
  device,
  onSelect,
}: {
  device: FleetDeviceSummary;
  onSelect: (id: string) => void;
}) {
  return (
    <button
      type="button"
      className={`obs-fleet-card${device.online === false ? " is-offline" : ""}`}
      onClick={() => onSelect(device.id)}
      aria-label={`查看 ${device.name} 详情`}
    >
      <div className="obs-fleet-head">
        <span className={fleetDotClass(device.online)} aria-hidden="true" />
        <span className="obs-fleet-name">{device.name}</span>
        <span className="obs-fleet-xy">
          {device.services_up}/{device.services_total}
        </span>
      </div>
      <div className="obs-fleet-role">{device.role}</div>
      <div className="obs-fleet-headline">{device.headline}</div>
    </button>
  );
}

function FleetSection({
  fleet,
  onSelect,
}: {
  fleet: FleetSummary;
  onSelect: (id: string) => void;
}) {
  const online = fleet.devices.filter((d) => d.online === true).length;
  return (
    <section className="obs-card obs-fleet" aria-label="设备舰队">
      <h2 className="obs-card-title">
        设备舰队({online}/{fleet.devices.length} 在线)
      </h2>
      <div className="obs-fleet-grid">
        {fleet.devices.map((d) => (
          <FleetCard key={d.id} device={d} onSelect={onSelect} />
        ))}
      </div>
    </section>
  );
}

/** 容量环形图(sysmetrics 单项:used vs free/available)。 */
function UsageDonut({
  title,
  usedGb,
  freeGb,
  centerLabel,
}: {
  title: string;
  usedGb: number;
  freeGb: number;
  centerLabel: string;
}) {
  return (
    <div className="obs-usage">
      <div className="obs-usage-title">{title}</div>
      <DonutChart
        ariaLabel={`${title}用量`}
        centerLabel={centerLabel}
        size={140}
        slices={[
          { name: "已用", value: Math.round(usedGb), color: CHART_COLORS[1] },
          { name: "可用", value: Math.round(freeGb), color: CHART_SEMANTIC.ok },
        ]}
      />
    </div>
  );
}

/** sysmetrics 区块:RAM/磁盘/NAS 环形 + 四卡 VRAM 条(sparkline 复用观测时序)。 */
function SysSection({
  detail,
  obsSeries,
}: {
  detail: FleetDeviceDetail;
  obsSeries: ObservabilitySnapshot["series"] | null;
}) {
  const sys = detail.sys;
  if (!sys) return null;
  const nas = sys.nas;
  return (
    <section className="obs-card" aria-label="系统指标">
      <h2 className="obs-card-title">系统指标(sysmetrics)</h2>
      <div className="obs-usage-row">
        {sys.memory && (
          <UsageDonut
            title="RAM"
            usedGb={sys.memory.used_gb}
            freeGb={sys.memory.available_gb}
            centerLabel={`${sys.memory.used_pct ?? "—"}%`}
          />
        )}
        {sys.disk_root && (
          <UsageDonut
            title="磁盘 /"
            usedGb={sys.disk_root.used_gb}
            freeGb={sys.disk_root.free_gb}
            centerLabel={`${sys.disk_root.used_pct ?? "—"}%`}
          />
        )}
        {nas && nas.mounted && nas.used_gb !== null && nas.free_gb !== null && (
          <UsageDonut
            title="NAS"
            usedGb={nas.used_gb}
            freeGb={nas.free_gb}
            centerLabel={`剩 ${formatGb(Math.round((nas.free_gb / 1024) * 10) / 10)}T`}
          />
        )}
        {nas && !nas.mounted && (
          <div className="obs-usage obs-nas-down" role="alert">
            NAS 未挂载:{nas.mountpoint}
          </div>
        )}
      </div>
      {sys.cpu && (
        <div className="obs-sys-cpu">
          CPU {sys.cpu.percent ?? "—"}% · load {sys.cpu.load1 ?? "—"} /{" "}
          {sys.cpu.load5 ?? "—"} / {sys.cpu.load15 ?? "—"} · {sys.cpu.cores ?? "—"} 核
        </div>
      )}
      {sys.gpus && sys.gpus.length > 0 && (
        <div className="obs-sys-gpus">
          {sys.gpus.map((g) => {
            const pct = g.vram_used_pct;
            const tone = vramTone(pct);
            return (
              <div key={g.index} className="obs-sys-gpu">
                <div className="obs-gpu-head">
                  <span className="obs-gpu-id">GPU{g.index}</span>
                  <span className="obs-gpu-host">{g.temp_c}°C</span>
                  <Sparkline
                    values={obsSeries?.vram_pct[`GPU${g.index}`] ?? []}
                    color={
                      tone === "is-hot"
                        ? CHART_SEMANTIC.hot
                        : tone === "is-warm"
                          ? CHART_SEMANTIC.warn
                          : CHART_COLORS[0]
                    }
                    yMax={100}
                    ariaLabel={`GPU${g.index} VRAM 历史`}
                  />
                </div>
                <div className="obs-vram-row">
                  <div
                    className="obs-vram-bar"
                    role="progressbar"
                    aria-valuenow={pct ?? 0}
                  >
                    <div
                      className={`obs-vram-fill ${tone}`}
                      style={{ width: `${pct ?? 0}%` }}
                    />
                  </div>
                </div>
                <div className="obs-vram-text">
                  {formatGb(Math.round((g.vram_used_mb / 1024) * 10) / 10)} /{" "}
                  {formatGb(Math.round(g.vram_total_mb / 1024))} GB ({pct ?? 0}%)
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

/** 服务清单表:状态点 / 名称+备注 / 端口 / 延迟。 */
function ServiceTable({ detail }: { detail: FleetDeviceDetail }) {
  return (
    <section className="obs-card" aria-label="服务清单">
      <h2 className="obs-card-title">
        服务清单({detail.services_up}/{detail.services_total} 正常)
      </h2>
      <table className="obs-svc-table">
        <thead>
          <tr>
            <th aria-label="状态" />
            <th>服务</th>
            <th>端口</th>
            <th>延迟</th>
            <th>备注</th>
          </tr>
        </thead>
        <tbody>
          {detail.services.map((s) => (
            <tr
              key={`${s.name}:${s.port}`}
              className={s.status === "up" ? "" : "is-degraded"}
            >
              <td>
                <span
                  className={
                    s.status === "up"
                      ? "obs-dot is-on"
                      : s.status === "down"
                        ? "obs-dot is-down"
                        : "obs-dot is-unknown"
                  }
                  aria-label={
                    s.status === "up"
                      ? "正常"
                      : s.status === "down"
                        ? "离线"
                        : "未知"
                  }
                />
              </td>
              <td className="obs-svc-name">{s.name}</td>
              <td className="obs-svc-port">:{s.port}</td>
              <td className="obs-svc-latency">{formatMs(s.latency_ms)}</td>
              <td className="obs-svc-note">{s.note ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/** 二级设备详情页(视图内切换,不加路由)。 */
function DeviceDetailView({
  detail,
  error,
  obsSeries,
  onBack,
}: {
  detail: FleetDeviceDetail | null;
  error: string | null;
  obsSeries: ObservabilitySnapshot["series"] | null;
  onBack: () => void;
}) {
  return (
    <div className="obs-body obs-detail">
      <div className="obs-detail-head">
        <button type="button" className="obs-back" onClick={onBack}>
          ‹ 返回观测面板
        </button>
        {detail && (
          <>
            <span className={fleetDotClass(detail.online)} aria-hidden="true" />
            <h1 className="obs-detail-title">{detail.name}</h1>
            <span className="obs-detail-headline">{detail.headline}</span>
          </>
        )}
      </div>
      {error && <ErrorBar message={error} onClose={() => undefined} />}
      {!detail && !error && <Skeleton height={320} className="obs-skel" />}
      {detail && (
        <>
          <div className="obs-detail-meta">
            <span>LAN {detail.meta.lan_ip ?? "—"}</span>
            <span>Tailscale {detail.meta.ts_ip ?? "—"}</span>
            <span>{detail.role}</span>
            <span>{detail.meta.hardware ?? ""}</span>
          </div>
          <ServiceTable detail={detail} />
          <SysSection detail={detail} obsSeries={obsSeries} />
          <section className="obs-card obs-chart" aria-label="服务延迟时序">
            <h2 className="obs-card-title">服务延迟(近 2h,ms)</h2>
            {detail.series.timestamps.length >= 2 &&
            pickLatencySeries(detail).length > 0 ? (
              <LineChart
                ariaLabel="服务延迟折线图"
                labels={detail.series.timestamps}
                series={pickLatencySeries(detail).map((s, i) => ({
                  name: s.name,
                  color: CHART_COLORS[i % CHART_COLORS.length],
                  values: s.values,
                }))}
                height={220}
              />
            ) : (
              <div className="obs-chart-empty">
                时序采样积累中(每 {POLL_MS / 1000}s 一条,重启后从零开始)
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
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
  const [fleet, setFleet] = useState<FleetSummary | null>(null);
  const [fleetError, setFleetError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<FleetDeviceDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);

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
    // 舰队探测独立成败:快照面板已渲染,舰队失败只在该区显示错误条
    try {
      setFleet(await fetchFleet());
      setFleetError(null);
    } catch (err) {
      setFleetError(err instanceof Error ? err.message : "加载设备舰队失败");
    }
  }, []);

  useEffect(() => {
    load(false);
    const timer = setInterval(() => load(true), POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  // 二级详情:选中期间独立 12s 轮询,退出即清理
  useEffect(() => {
    if (!selected) {
      setDetail(null);
      setDetailError(null);
      return;
    }
    let cancelled = false;
    const loadDetail = async () => {
      try {
        const d = await fetchFleetDevice(selected);
        if (!cancelled) {
          setDetail(d);
          setDetailError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setDetailError(err instanceof Error ? err.message : "加载设备详情失败");
        }
      }
    };
    loadDetail();
    const timer = setInterval(loadDetail, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [selected]);

  if (selected) {
    return (
      <div className="obs-view view-shell">
        <ChartStyles />
        <DeviceDetailView
          detail={detail}
          error={detailError}
          obsSeries={data?.series ?? null}
          onBack={() => setSelected(null)}
        />
        <ObsStyles />
      </div>
    );
  }

  return (
    <div className="obs-view view-shell">
      <ChartStyles />
      <PageHeader
        kicker="OBSERVABILITY"
        title="观测面板"
        desc="设备舰队 · 队列 · 成功率 · GPU 负载 实时聚合(12s 自动刷新)"
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
          {fleetError && (
            <ErrorBar message={fleetError} onClose={() => setFleetError(null)} />
          )}
          {fleet && <FleetSection fleet={fleet} onSelect={setSelected} />}
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
      <ObsStyles />
    </div>
  );
}

/** obs-* 样式(一级+二级共用)。
 * 用 jsx global:styled-jsx 的 jsxId 只打在主组件自身 JSX 上,
 * 同文件子组件(KpiStrip/各 Card/FleetSection/DeviceDetailView)的元素拿不到作用域类,
 * 整段样式静默失效(2026-08-24 生产实测:KPI 条 display:block 无网格)。obs- 前缀防碰撞。 */
function ObsStyles() {
  return (
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
        .obs-dot.is-down {
          background: #f87171;
        }
        .obs-dot.is-unknown {
          background: #64748b;
        }
        /* ── 设备舰队(一级网格) ── */
        .obs-fleet-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
          gap: var(--space-3, 12px);
        }
        .obs-fleet-card {
          border: 1px solid var(--border, rgba(255, 255, 255, 0.08));
          border-radius: var(--radius-md, 10px);
          padding: var(--space-3, 12px);
          background: var(--surface-1, rgba(255, 255, 255, 0.02));
          display: flex;
          flex-direction: column;
          gap: 4px;
          text-align: left;
          font: inherit;
          color: inherit;
          cursor: pointer;
          transition: border-color 600ms ease, transform 200ms ease;
        }
        .obs-fleet-card:hover {
          border-color: rgba(34, 211, 238, 0.45);
          transform: translateY(-1px);
        }
        .obs-fleet-card.is-offline {
          opacity: 0.6;
        }
        .obs-fleet-head {
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .obs-fleet-name {
          font-size: 13px;
          font-weight: 700;
        }
        .obs-fleet-xy {
          margin-left: auto;
          font-size: 12px;
          color: var(--text-muted, #888);
          font-variant-numeric: tabular-nums;
        }
        .obs-fleet-role {
          font-size: 11px;
          color: var(--text-muted, #888);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .obs-fleet-headline {
          font-size: 12px;
          color: #22d3ee;
          font-variant-numeric: tabular-nums;
        }
        /* ── 二级详情页 ── */
        .obs-detail-head {
          display: flex;
          align-items: center;
          gap: 10px;
          flex-wrap: wrap;
        }
        .obs-back {
          border: 1px solid var(--border, rgba(255, 255, 255, 0.08));
          border-radius: var(--radius-md, 10px);
          background: var(--surface-1, rgba(255, 255, 255, 0.02));
          padding: 6px 12px;
          font: inherit;
          font-size: 13px;
          color: inherit;
          cursor: pointer;
          transition: border-color 300ms ease;
        }
        .obs-back:hover {
          border-color: rgba(34, 211, 238, 0.45);
        }
        .obs-detail-title {
          margin: 0;
          font-size: 18px;
          font-weight: 700;
        }
        .obs-detail-headline {
          font-size: 12px;
          color: #22d3ee;
        }
        .obs-detail-meta {
          display: flex;
          flex-wrap: wrap;
          gap: 6px 18px;
          font-size: 12px;
          color: var(--text-muted, #888);
          font-variant-numeric: tabular-nums;
        }
        .obs-svc-table {
          width: 100%;
          border-collapse: collapse;
          font-size: 12px;
        }
        .obs-svc-table th {
          text-align: left;
          font-weight: 600;
          color: var(--text-muted, #888);
          padding: 4px 8px;
          border-bottom: 1px solid var(--border, rgba(255, 255, 255, 0.08));
        }
        .obs-svc-table td {
          padding: 5px 8px;
          border-bottom: 1px dashed var(--border, rgba(255, 255, 255, 0.08));
          font-variant-numeric: tabular-nums;
        }
        .obs-svc-table tr.is-degraded td {
          color: var(--text-muted, #888);
        }
        .obs-svc-name {
          font-weight: 600;
        }
        .obs-svc-note {
          color: var(--text-muted, #888);
        }
        .obs-usage-row {
          display: flex;
          flex-wrap: wrap;
          gap: var(--space-4, 16px);
          justify-content: space-around;
        }
        .obs-usage {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 4px;
        }
        .obs-usage-title {
          font-size: 12px;
          font-weight: 600;
          color: var(--text-muted, #888);
        }
        .obs-nas-down {
          justify-content: center;
          color: #f87171;
          font-size: 13px;
          font-weight: 600;
          min-width: 140px;
        }
        .obs-sys-cpu {
          margin-top: var(--space-3, 12px);
          font-size: 12px;
          color: var(--text-muted, #888);
          font-variant-numeric: tabular-nums;
        }
        .obs-sys-gpus {
          margin-top: var(--space-3, 12px);
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
          gap: var(--space-3, 12px);
        }
        .obs-sys-gpu {
          border: 1px solid var(--border, rgba(255, 255, 255, 0.08));
          border-radius: var(--radius-md, 10px);
          padding: var(--space-3, 12px);
          display: flex;
          flex-direction: column;
          gap: 6px;
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
  );
}
