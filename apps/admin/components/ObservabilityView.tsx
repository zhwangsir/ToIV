"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { OrchPanel } from "./OrchPanel";
import {
  fetchComfyBackends,
  fetchFleet,
  fetchFleetDevice,
  fetchGpuSmokeLatest,
  fetchObservability,
  triggerGpuSmoke,
  type ComfyBackend,
  type CoverGateState,
  type FleetDeviceDetail,
  type FleetDeviceSummary,
  type FleetServiceStatus,
  type FleetSummary,
  type ObservabilitySnapshot,
} from "@/lib/api";
import { Badge } from "@/components/ui/Badge";
import { ErrorBar } from "@/components/ui/ErrorBar";
import { Icon } from "@/components/ui/Icon";
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

/** 设备卡(一级网格):状态点 + 名称 + x/y + 角色 + headline;在线但有 down 服务时挂「疑似假活」角标(P0 设备域)。 */
function FleetCard({
  device,
  onSelect,
}: {
  device: FleetDeviceSummary;
  onSelect: (id: string) => void;
}) {
  const suspectDown =
    device.online === true && device.services_up < device.services_total
      ? device.services_total - device.services_up
      : 0;
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
        {suspectDown > 0 && (
          <span
            className="obs-fleet-suspect"
            title={`设备在线但 ${suspectDown} 个服务端口不可达(systemd 假活/进程崩溃)`}
          >
            疑似假活
          </span>
        )}
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
      {fleet.devices.length === 0 ? (
        <p className="obs-empty-line">暂无设备 · 舰队注册表为空,请检查 fleet 配置</p>
      ) : (
        <div className="obs-fleet-grid">
          {fleet.devices.map((d) => (
            <FleetCard key={d.id} device={d} onSelect={onSelect} />
          ))}
        </div>
      )}
    </section>
  );
}

/* ───────────────────── 服务健康(P0 设备域 v1,2026-09-22) ───────────────────── */

/** 服务探测状态 → 状态点类。 */
function svcDotClass(status: FleetServiceStatus): string {
  if (status === "up") return "obs-dot is-on";
  if (status === "down") return "obs-dot is-down";
  return "obs-dot is-unknown";
}

function svcStatusLabel(status: FleetServiceStatus): string {
  if (status === "up") return "正常";
  if (status === "down") return "离线";
  return "未知";
}

/** whisper ASR 集群卡:openclaw01-04 四节点 :9310 状态(逐节点取详情,手动+首载刷新)。 */
function WhisperHealthCard({ fleet }: { fleet: FleetSummary | null }) {
  const nodes = useMemo(
    () => (fleet?.devices ?? []).filter((d) => d.id.startsWith("openclaw")),
    [fleet],
  );
  const nodeKey = nodes.map((n) => n.id).join(",");
  const [statusMap, setStatusMap] = useState<Record<string, FleetServiceStatus>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const list = nodeKey ? nodeKey.split(",") : [];
    if (list.length === 0) return;
    setLoading(true);
    setError(null);
    const results = await Promise.allSettled(
      list.map((id) => fetchFleetDevice(id)),
    );
    const next: Record<string, FleetServiceStatus> = {};
    let failures = 0;
    results.forEach((r, i) => {
      if (r.status === "fulfilled") {
        const svc = r.value.services.find((s) => s.port === 9310);
        next[list[i]] = svc?.status ?? "unknown";
      } else {
        next[list[i]] = "unknown";
        failures += 1;
      }
    });
    setStatusMap(next);
    if (failures === list.length) setError("whisper 节点详情全部加载失败");
    setLoading(false);
  }, [nodeKey]);

  // 节点集合出现后首载探测一次;此后靠手动刷新(详情接口逐节点调用,不挂 12s 轮询)
  useEffect(() => {
    if (nodeKey) void refresh();
  }, [nodeKey, refresh]);

  const upCount = nodes.filter((n) => statusMap[n.id] === "up").length;
  return (
    <div className="obs-health-card" aria-label="whisper ASR 集群">
      <div className="obs-health-head">
        whisper ASR 集群(在线 {nodes.length > 0 ? `${upCount}/${nodes.length}` : "—"})
        <button
          type="button"
          className="obs-health-refresh"
          onClick={() => void refresh()}
          disabled={loading || nodes.length === 0}
          title="重新探测四节点 :9310"
          aria-label="刷新 whisper 集群状态"
        >
          <Icon name={loading ? "loading" : "refresh"} size={13} />
        </button>
      </div>
      {error && <div className="obs-health-err">{error}</div>}
      {fleet === null && !error && (
        <p className="obs-health-note">等待舰队数据…</p>
      )}
      {fleet !== null && nodes.length === 0 && (
        <p className="obs-health-note">舰队注册表中无 openclaw 节点</p>
      )}
      {nodes.length > 0 && (
        <ul className="obs-health-list">
          {nodes.map((n) => {
            const st = statusMap[n.id] ?? "unknown";
            return (
              <li key={n.id}>
                <span className={svcDotClass(st)} aria-hidden="true" />
                <span className="obs-health-name">{n.name}</span>
                <span className="obs-health-meta">:9310 · {svcStatusLabel(st)}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** LB 后端卡:ComfyUI-LB 池健康(api 代理 /admin/backends;不可达只在本卡报错,不炸页)。 */
function LbBackendsCard() {
  const [data, setData] = useState<{ source: string; backends: ComfyBackend[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await fetchComfyBackends());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "LB 后端健康加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const backends = data?.backends ?? [];
  const healthyCount = backends.filter((b) => b.healthy === true).length;
  return (
    <div className="obs-health-card" aria-label="ComfyUI-LB 后端池">
      <div className="obs-health-head">
        LB 后端池(健康 {data ? `${healthyCount}/${backends.length}` : "—"})
        <button
          type="button"
          className="obs-health-refresh"
          onClick={() => void load()}
          disabled={loading}
          title="重新拉取 LB /admin/backends"
          aria-label="刷新 LB 后端池"
        >
          <Icon name={loading ? "loading" : "refresh"} size={13} />
        </button>
      </div>
      {error && <div className="obs-health-err">{error}</div>}
      {!error && !loading && backends.length === 0 && (
        <p className="obs-health-note">后端池为空 · 检查 LB 注册表配置</p>
      )}
      {backends.length > 0 && (
        <ul className="obs-health-list">
          {backends.map((b) => (
            <li key={b.id ?? b.url}>
              <span
                className={
                  b.healthy === true
                    ? "obs-dot is-on"
                    : b.healthy === false
                      ? "obs-dot is-down"
                      : "obs-dot is-unknown"
                }
                aria-hidden="true"
              />
              <span className="obs-health-url" title={b.url}>
                {b.url}
              </span>
              <span className="obs-health-meta">
                {b.gpu !== undefined ? `GPU${b.gpu}` : ""}
                {b.remote ? " · 远程" : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface SmokeCaseView {
  name: string;
  ok: boolean;
  durationMs: number | null;
  error: string | null;
}

interface SmokeReportView {
  ok: boolean;
  ts: number | null;
  durationMs: number | null;
  cases: SmokeCaseView[];
}

/** 冒烟报告体防御式解析(报告结构 {ts, ok, duration_ms, cases[]};字段缺失宽容)。 */
function parseSmokeReport(raw: unknown): SmokeReportView | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.ok !== "boolean") return null;
  const casesRaw = Array.isArray(r.cases) ? r.cases : [];
  return {
    ok: r.ok,
    ts: typeof r.ts === "number" ? r.ts : null,
    durationMs: typeof r.duration_ms === "number" ? r.duration_ms : null,
    cases: casesRaw.map((c) => {
      const rec = (c ?? {}) as Record<string, unknown>;
      return {
        name: typeof rec.name === "string" ? rec.name : "case",
        ok: rec.ok === true,
        durationMs: typeof rec.duration_ms === "number" ? rec.duration_ms : null,
        error: typeof rec.error === "string" ? rec.error : null,
      };
    }),
  };
}

/** GPU 冒烟卡:最近报告概要 + 手动触发(同步等待,失败时 err.report 带报告体)。 */
function GpuSmokeCard() {
  const [report, setReport] = useState<SmokeReportView | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [runMsg, setRunMsg] = useState<{ text: string; isErr: boolean } | null>(null);

  const load = useCallback(async () => {
    try {
      setReport(parseSmokeReport(await fetchGpuSmokeLatest()));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "冒烟报告加载失败");
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onTrigger = async () => {
    setBusy(true);
    setRunMsg(null);
    try {
      const parsed = parseSmokeReport(await triggerGpuSmoke());
      if (parsed) setReport(parsed);
      setRunMsg({ text: "本次冒烟通过", isErr: false });
    } catch (err) {
      // overall 失败:后端 500 + detail=报告体(lib 已挂到 err.report)
      const rep = parseSmokeReport((err as { report?: unknown })?.report);
      if (rep) {
        setReport(rep);
        const failed = rep.cases.filter((c) => !c.ok).map((c) => c.name).join("、");
        setRunMsg({ text: `本次冒烟未通过:${failed || "overall 失败"}`, isErr: true });
      } else {
        setRunMsg({
          text: err instanceof Error ? err.message : "冒烟触发失败",
          isErr: true,
        });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="obs-health-card" aria-label="GPU 冒烟">
      <div className="obs-health-head">
        GPU 冒烟
        <button
          type="button"
          className="obs-health-refresh"
          onClick={() => void load()}
          disabled={busy}
          title="重新读取最近报告"
          aria-label="刷新冒烟报告"
        >
          <Icon name="refresh" size={13} />
        </button>
      </div>
      {error && <div className="obs-health-err">{error}</div>}
      {!error && loaded && !report && (
        <p className="obs-health-note">尚无报告 · 每日定点自动跑,或手动触发一次</p>
      )}
      {report && (
        <div className="obs-health-summary">
          <Badge tone={report.ok ? "ok" : "err"}>
            {report.ok ? "通过" : "未通过"}
          </Badge>
          <span>
            {report.ts !== null
              ? new Date(report.ts * 1000).toLocaleString("zh-CN")
              : "—"}
            {report.durationMs !== null
              ? ` · 耗时 ${(report.durationMs / 1000).toFixed(1)}s`
              : ""}
          </span>
        </div>
      )}
      {report && report.cases.length > 0 && (
        <div className="obs-health-cases">
          {report.cases.map((c) => (
            <Badge
              key={c.name}
              tone={c.ok ? "ok" : "err"}
              title={c.error ?? `${c.name} · ${((c.durationMs ?? 0) / 1000).toFixed(1)}s`}
            >
              {c.name}
            </Badge>
          ))}
        </div>
      )}
      {runMsg && (
        <div className={runMsg.isErr ? "obs-health-err" : "obs-health-note"}>
          {runMsg.text}
        </div>
      )}
      <div className="obs-health-actions">
        <button
          type="button"
          className="obs-health-run"
          onClick={() => void onTrigger()}
          disabled={busy}
          title="同步执行 txt2img 小图 + LTX 短视频冒烟(约 1-3 分钟)"
        >
          <Icon name={busy ? "loading" : "zap"} size={13} />
          {busy ? "冒烟执行中…" : "立即冒烟"}
        </button>
      </div>
    </div>
  );
}

/** 封面队列闸卡(D5,2026-09-22):autorefire 深度闸状态(随观测快照透出,12s 轮询同源刷新)。
 *  字段以 cover_gate 为准;「跳过数」后端无计数器,从略并在来源行注明。 */
function CoverGateCard({
  gate,
  onRefresh,
}: {
  /** undefined=旧后端快照无此键(api 未部署);null=快照未就绪。 */
  gate: CoverGateState | null | undefined;
  onRefresh: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      await onRefresh();
    } finally {
      setBusy(false);
    }
  };

  const summary = gate?.summary;
  const batchLine = (() => {
    if (!gate) return "";
    if (!summary || summary.never_run) return "尚未跑过批次";
    if (summary.running) {
      const el = summary.elapsed_s != null ? ` · ${summary.elapsed_s}s` : "";
      return `在跑 ${summary.done ?? 0}/${summary.total ?? "—"} · ok ${summary.ok ?? 0}${el}`;
    }
    const at = summary.finished_at ?? summary.started_at ?? "";
    return `最近批 ${summary.done ?? 0}/${summary.total ?? "—"} · ok ${summary.ok ?? 0}${at ? ` · ${at}` : ""}`;
  })();

  return (
    <div className="obs-health-card" aria-label="封面队列闸">
      <div className="obs-health-head">
        封面队列闸(深度 {gate ? `${gate.queue_depth}/${gate.queue_guard}` : "—"})
        <button
          type="button"
          className="obs-health-refresh"
          onClick={() => void run()}
          disabled={busy}
          title="重新拉取观测快照"
          aria-label="刷新封面队列闸"
        >
          <Icon name={busy ? "loading" : "refresh"} size={13} />
        </button>
      </div>
      {gate === undefined && (
        <p className="obs-health-note">当前后端快照无 cover_gate 字段 · 待 api 部署后展示</p>
      )}
      {gate === null && <p className="obs-health-note">等待快照数据…</p>}
      {gate && (
        <>
          <div className="obs-health-summary">
            <Badge tone={gate.gated ? "err" : "ok"}>
              {gate.gated ? "已触发·暂停续发" : "放行"}
            </Badge>
            {gate.running && <Badge tone="run">批次在跑</Badge>}
            {!gate.autorefire_enabled && (
              <Badge tone="neutral" title="TOIV_COVER_AUTOREFIRE=0">
                autorefire 停用
              </Badge>
            )}
          </div>
          <ul className="obs-health-list">
            <li>
              <span className="obs-health-name">fleet 排队深度</span>
              <span className="obs-health-meta">
                {gate.queue_depth} / 闸值 {gate.queue_guard}
              </span>
            </li>
            <li>
              <span className="obs-health-name">待做目标</span>
              <span className="obs-health-meta">{gate.pending} 个应用</span>
            </li>
            <li>
              <span className="obs-health-name">批次</span>
              <span className="obs-health-meta" title={batchLine}>
                {batchLine}
              </span>
            </li>
            <li>
              <span className="obs-health-name">限幅</span>
              <span className="obs-health-meta">
                尝试上限 {gate.attempt_cap} 次/应用 · 批限 {gate.batch_limit}
              </span>
            </li>
          </ul>
          <p className="obs-health-note">
            来源:cover_gate(app_cover_demo 状态函数,10s 快照缓存)·「跳过数」无计数器未展示
          </p>
        </>
      )}
    </div>
  );
}

/** 「服务健康」区:whisper 集群 / LB 后端池 / GPU 冒烟 / 封面队列闸 四卡(Fleet 区下方)。 */
function ServiceHealthSection({
  fleet,
  gate,
  onRefreshGate,
}: {
  fleet: FleetSummary | null;
  gate: CoverGateState | null | undefined;
  onRefreshGate: () => Promise<void>;
}) {
  return (
    <section className="obs-card" aria-label="服务健康">
      <h2 className="obs-card-title">服务健康</h2>
      <div className="obs-health-grid">
        <WhisperHealthCard fleet={fleet} />
        <LbBackendsCard />
        <GpuSmokeCard />
        <CoverGateCard gate={gate} onRefresh={onRefreshGate} />
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
      <div className="obs-svc-wrap">
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
      </div>
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

/** KPI 数字:tabular-nums 等宽数字;key 随值变更触发重挂载(2026-09-02 W3:长入场动画已删)。 */
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
 * 观测面板(2026-09-02 W3 套版):Studio Console 单色中性数据页(仅管理员)。
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
      {/* 细工具条(2026-09-02 W3 页头移除):无标题,右侧实时小圆点 + 更新时间 */}
      {data && (
        <div className="obs-toolbar">
          <span className="obs-live">
            <span key={data.generated_at} className="obs-live-dot" aria-hidden="true" />
            <span className="obs-live-text">实时</span>
            <span className="obs-updated">
              更新于 {new Date(data.generated_at).toLocaleTimeString("zh-CN")}
            </span>
          </span>
        </div>
      )}
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
          <ServiceHealthSection
            fleet={fleet}
            gate={data ? data.cover_gate : null}
            onRefreshGate={() => load(true)}
          />
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
            {data.gpus.length === 0 ? (
              <p className="obs-empty-line">暂无 GPU 数据 · 舰队节点未上报 GPU 指标</p>
            ) : (
              <div className="obs-gpus">
                {data.gpus.map((gpu) => (
                  <GpuCard
                    key={gpu.id}
                    gpu={gpu}
                    history={data.series.vram_pct[gpu.id] ?? []}
                  />
                ))}
              </div>
            )}
          </section>
          <details className="obs-orch-details" open>
            <summary className="obs-card obs-orch-summary-toggle">
              <span className="obs-card-title">编排状态</span>
              <span className="obs-orch-summary-arrow" aria-hidden="true" />
            </summary>
            {/* 本视图整体仅管理员可见(page.tsx 门控),唤醒按钮直接放行 */}
            <OrchPanel isAdmin />
          </details>
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
          /* W3 单色:图表色板在本视图作用域收编为中性派生(globals --chart-1..5 不动) */
          --chart-1: var(--accent);
          --chart-2: var(--text-secondary);
          --chart-3: var(--text-muted);
          --chart-4: var(--border-strong);
          --chart-5: var(--text-3);
        }
        /* 细工具条(2026-09-02 W3 页头移除):仅右侧实时指示 */
        .obs-toolbar {
          display: flex;
          align-items: center;
          justify-content: flex-end;
        }
        .obs-live {
          display: inline-flex;
          align-items: center;
          gap: var(--space-2);
        }
        .obs-live-dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background: var(--ok);
          flex-shrink: 0;
        }
        .obs-live-text {
          font-size: var(--text-aux);
          color: var(--text-muted);
        }
        .obs-updated {
          font-size: var(--text-aux);
          color: var(--text-muted);
          font-variant-numeric: tabular-nums;
        }
        /* 空态单行 muted 提示(at-empty--inline 语言(empty-console-hint 已于 W2A 退役);共享 Empty 组件在本视图退役) */
        .obs-empty-line {
          margin: 0;
          padding: var(--space-4) 0;
          font-size: var(--text-aux);
          color: var(--text-muted);
          text-align: center;
        }
        .obs-body {
          display: flex;
          flex-direction: column;
          gap: var(--space-3, 12px);
          padding-bottom: var(--space-4, 16px);
        }
        /* ── KPI 条 ── */
        .obs-kpis {
          display: grid;
          grid-template-columns: repeat(4, 1fr) 1.6fr;
          gap: var(--space-3, 12px);
        }
        .obs-kpi {
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-control);
          padding: var(--space-2, 8px) var(--space-3, 12px);
          background: var(--bg-surface-1);
          transition: border-color var(--duration-fast) var(--ease-standard);
        }
        .obs-kpi:hover {
          border-color: var(--border-strong);
        }
        /* KPI 数字 mono 大号(2026-09-04 美化 W4):24px 裸值收编 display-sm 档,
           mono 字族 + tabular-nums;字重 700 → --font-bold 令牌 */
        .obs-kpi-num {
          display: block;
          font-family: var(--font-mono);
          font-size: var(--text-display-sm);
          font-weight: var(--font-bold);
          font-variant-numeric: tabular-nums;
        }
        .obs-kpi-rate .obs-kpi-num {
          font-size: var(--text-display-md);
          color: var(--text-primary);
        }
        .obs-kpi-held .obs-kpi-num {
          color: var(--warn);
        }
        .obs-kpi-running .obs-kpi-num {
          color: var(--run);
        }
        .obs-kpi-label {
          margin-top: var(--space-1);
          font-size: var(--text-aux);
          color: var(--text-muted);
        }
        /* ── 卡片/图表 ── */
        .obs-card {
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-panel);
          padding: var(--space-3, 12px);
          background: var(--bg-surface-1);
          transition: border-color var(--duration-fast) var(--ease-standard);
        }
        .obs-card:hover {
          border-color: var(--border-strong);
        }
        .obs-card-title {
          margin: 0 0 var(--space-2, 8px);
          font-size: var(--text-body);
          font-weight: var(--font-semibold);
          color: var(--text-muted);
          letter-spacing: 0.04em;
        }
        .obs-charts-row {
          display: grid;
          grid-template-columns: 2fr 1fr;
          gap: var(--space-3, 12px);
        }
        .obs-chart-empty {
          display: flex;
          align-items: center;
          justify-content: center;
          min-height: 200px;
          font-size: var(--text-aux);
          color: var(--text-muted);
          border: 1px dashed var(--border-subtle);
          border-radius: var(--radius-control);
        }
        .obs-held-reasons {
          list-style: none;
          margin: 0;
          padding: var(--space-2, 8px) var(--space-3, 12px);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-control);
          background: var(--bg-surface-1);
          display: flex;
          flex-direction: column;
          gap: var(--space-2);
          font-size: var(--text-aux);
        }
        .obs-held-reasons li {
          display: flex;
          gap: var(--space-2);
          align-items: baseline;
        }
        .obs-held-count {
          flex-shrink: 0;
          color: var(--warn);
          font-weight: var(--font-semibold);
        }
        .obs-held-reason {
          color: var(--text-muted);
          word-break: break-all;
        }
        /* ── GPU 卡 ── */
        .obs-gpus {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
          gap: var(--space-3, 12px);
        }
        .obs-gpu {
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-control);
          padding: var(--space-3, 12px);
          display: flex;
          flex-direction: column;
          gap: var(--space-2, 8px);
          transition: border-color var(--duration-fast) var(--ease-standard);
        }
        .obs-gpu:hover {
          border-color: var(--border-strong);
        }
        .obs-gpu.is-offline {
          opacity: 0.55;
        }
        .obs-gpu-head {
          display: flex;
          align-items: center;
          gap: var(--space-2);
          font-size: var(--text-body);
        }
        .obs-dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background: var(--text-muted);
          flex-shrink: 0;
        }
        .obs-dot.is-on {
          background: var(--ok);
        }
        .obs-dot.is-down {
          background: var(--err);
        }
        .obs-dot.is-unknown {
          background: var(--text-muted);
        }
        /* ── 设备舰队(一级网格) ── */
        .obs-fleet-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
          gap: var(--space-3, 12px);
        }
        .obs-fleet-card {
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-control);
          padding: var(--space-3, 12px);
          background: var(--bg-surface-1);
          display: flex;
          flex-direction: column;
          gap: var(--space-1);
          text-align: left;
          font: inherit;
          color: inherit;
          cursor: pointer;
          transition: border-color var(--duration-fast) var(--ease-standard);
        }
        .obs-fleet-card:hover {
          border-color: var(--border-strong);
        }
        .obs-fleet-card.is-offline {
          opacity: 0.6;
        }
        .obs-fleet-head {
          display: flex;
          align-items: center;
          gap: var(--space-2);
          flex-wrap: wrap;
        }
        /* 「疑似假活」角标(P0 设备域):在线但存在 down 服务(warn 语义) */
        .obs-fleet-suspect {
          display: inline-flex;
          align-items: center;
          padding: 0 var(--space-2);
          height: 18px;
          border-radius: var(--radius-badge);
          background: var(--warn-soft);
          color: var(--warn);
          font-size: var(--text-label);
          font-weight: var(--font-medium);
          white-space: nowrap;
          cursor: help;
        }
        /* ── 服务健康四卡(P0 设备域 v1 + D5 封面队列闸) ── */
        .obs-health-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
          gap: var(--space-3, 12px);
        }
        @media (max-width: 1080px) {
          .obs-health-grid {
            grid-template-columns: 1fr;
          }
        }
        .obs-health-card {
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-control);
          padding: var(--space-3, 12px);
          display: flex;
          flex-direction: column;
          gap: var(--space-2, 8px);
          min-width: 0;
        }
        .obs-health-head {
          display: flex;
          align-items: center;
          gap: var(--space-2);
          font-size: var(--text-aux);
          font-weight: var(--font-semibold);
          color: var(--text-muted);
        }
        .obs-health-refresh {
          margin-left: auto;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 24px;
          height: 24px;
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-badge);
          background: transparent;
          color: var(--text-muted);
          cursor: pointer;
          transition: border-color var(--duration-fast) var(--ease-standard),
            color var(--duration-fast) var(--ease-standard);
        }
        .obs-health-refresh:hover:not(:disabled) {
          border-color: var(--border-strong);
          color: var(--text-primary);
        }
        .obs-health-refresh:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
        .obs-health-list {
          list-style: none;
          margin: 0;
          padding: 0;
          display: flex;
          flex-direction: column;
          gap: var(--space-1);
          font-size: var(--text-aux);
        }
        .obs-health-list li {
          display: flex;
          align-items: center;
          gap: var(--space-2);
          min-width: 0;
        }
        .obs-health-name {
          font-weight: var(--font-semibold);
          color: var(--text-primary);
        }
        .obs-health-url {
          font-family: var(--font-mono);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .obs-health-meta {
          margin-left: auto;
          flex-shrink: 0;
          color: var(--text-muted);
          font-variant-numeric: tabular-nums;
          white-space: nowrap;
        }
        .obs-health-note {
          margin: 0;
          font-size: var(--text-aux);
          color: var(--text-muted);
        }
        .obs-health-err {
          margin: 0;
          font-size: var(--text-aux);
          color: var(--err);
          word-break: break-all;
        }
        .obs-health-summary {
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          gap: var(--space-2);
          font-size: var(--text-aux);
          color: var(--text-muted);
          font-variant-numeric: tabular-nums;
        }
        .obs-health-cases {
          display: flex;
          flex-wrap: wrap;
          gap: var(--space-2);
        }
        .obs-health-actions {
          display: flex;
          align-items: center;
          gap: var(--space-2);
          margin-top: auto;
        }
        .obs-health-run {
          display: inline-flex;
          align-items: center;
          gap: var(--space-1);
          min-height: 28px;
          padding: 0 var(--space-3);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-control);
          background: var(--bg-surface-1);
          color: var(--text-primary);
          font: inherit;
          font-size: var(--text-aux);
          cursor: pointer;
          transition: border-color var(--duration-fast) var(--ease-standard);
        }
        .obs-health-run:hover:not(:disabled) {
          border-color: var(--border-strong);
        }
        .obs-health-run:disabled {
          opacity: 0.6;
          cursor: not-allowed;
        }
        .obs-fleet-name {
          font-size: var(--text-body);
          font-weight: var(--font-semibold);
        }
        .obs-fleet-xy {
          margin-left: auto;
          font-size: var(--text-aux);
          color: var(--text-muted);
          font-variant-numeric: tabular-nums;
        }
        .obs-fleet-role {
          font-size: var(--text-aux);
          color: var(--text-muted);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .obs-fleet-headline {
          font-size: var(--text-aux);
          color: var(--accent);
          /* fleet 卡数值 mono(2026-09-04 美化 W4) */
          font-family: var(--font-mono);
          font-variant-numeric: tabular-nums;
        }
        /* ── 二级详情页 ── */
        .obs-detail-head {
          display: flex;
          align-items: center;
          gap: var(--space-3);
          flex-wrap: wrap;
        }
        .obs-back {
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-control);
          background: var(--bg-surface-1);
          padding: var(--space-1) var(--space-3);
          /* §10 触达 ≥44px(移动端点按) */
          min-height: 44px;
          display: inline-flex;
          align-items: center;
          font: inherit;
          font-size: var(--text-body);
          color: inherit;
          cursor: pointer;
          transition: border-color var(--duration-fast) var(--ease-standard);
        }
        .obs-back:hover {
          border-color: var(--border-strong);
        }
        /* 细顶条:返回钮 + 设备名同行,标题收敛为正文档(2026-09-02 W3) */
        .obs-detail-title {
          margin: 0;
          font-size: var(--text-body);
          font-weight: var(--font-semibold);
        }
        .obs-detail-headline {
          font-size: var(--text-aux);
          color: var(--accent);
        }
        .obs-detail-meta {
          display: flex;
          flex-wrap: wrap;
          gap: var(--space-2) var(--space-4);
          font-size: var(--text-aux);
          color: var(--text-muted);
          font-variant-numeric: tabular-nums;
        }
        /* 窄屏表格横向滚动,不挤压列 */
        .obs-svc-wrap {
          overflow-x: auto;
        }
        .obs-svc-table {
          width: 100%;
          min-width: 480px;
          border-collapse: collapse;
          font-size: var(--text-aux);
        }
        .obs-svc-table th {
          text-align: left;
          font-weight: var(--font-semibold);
          color: var(--text-muted);
          padding: var(--space-1) var(--space-2);
          border-bottom: 1px solid var(--border-subtle);
        }
        .obs-svc-table td {
          padding: var(--space-1) var(--space-2);
          border-bottom: 1px dashed var(--border-subtle);
          font-variant-numeric: tabular-nums;
        }
        .obs-svc-table tr.is-degraded td {
          color: var(--text-muted);
        }
        .obs-svc-name {
          font-weight: var(--font-semibold);
        }
        .obs-svc-note {
          color: var(--text-muted);
        }
        .obs-usage-row {
          display: flex;
          flex-wrap: wrap;
          gap: var(--space-3, 12px);
          justify-content: space-around;
        }
        .obs-usage {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: var(--space-1);
        }
        .obs-usage-title {
          font-size: var(--text-aux);
          font-weight: var(--font-semibold);
          color: var(--text-muted);
        }
        .obs-nas-down {
          justify-content: center;
          color: var(--err);
          font-size: var(--text-body);
          font-weight: var(--font-semibold);
          min-width: 140px;
        }
        .obs-sys-cpu {
          margin-top: var(--space-3, 12px);
          font-size: var(--text-aux);
          color: var(--text-muted);
          font-variant-numeric: tabular-nums;
        }
        .obs-sys-gpus {
          margin-top: var(--space-3, 12px);
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
          gap: var(--space-3, 12px);
        }
        .obs-sys-gpu {
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-control);
          padding: var(--space-3, 12px);
          display: flex;
          flex-direction: column;
          gap: var(--space-2);
        }
        .obs-gpu-id {
          font-weight: var(--font-semibold);
        }
        .obs-gpu-host {
          color: var(--text-muted);
          font-size: var(--text-aux);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .obs-gpu-queue {
          margin-left: auto;
          font-size: var(--text-aux);
          color: var(--run);
          flex-shrink: 0;
          font-variant-numeric: tabular-nums;
        }
        .obs-vram-row {
          display: flex;
          align-items: center;
          gap: var(--space-3);
        }
        .obs-vram-bar {
          flex: 1;
          height: 8px;
          border-radius: var(--radius-badge);
          background: var(--bg-surface-2);
          overflow: hidden;
        }
        .obs-vram-fill {
          height: 100%;
          border-radius: var(--radius-badge);
          transition: width var(--duration-base) var(--ease-standard),
            background var(--duration-base) var(--ease-standard);
        }
        /* 容量语义保留,去彩色渐变(2026-09-02 W3):正常=accent 实心,偏高/危险=语义色 */
        .obs-vram-fill.is-ok {
          background: var(--accent);
        }
        .obs-vram-fill.is-warm {
          background: var(--warn);
        }
        .obs-vram-fill.is-hot {
          background: var(--err);
        }
        .obs-vram-fill.is-off {
          background: var(--text-muted);
        }
        .obs-vram-text {
          margin-top: var(--space-1);
          font-size: var(--text-aux);
          color: var(--text-muted);
          font-variant-numeric: tabular-nums;
        }
        .obs-instances {
          list-style: none;
          margin: 0;
          padding: var(--space-2, 8px) 0 0;
          border-top: 1px dashed var(--border-subtle);
          display: flex;
          flex-direction: column;
          gap: var(--space-1);
          font-size: var(--text-aux);
        }
        .obs-instances li {
          display: flex;
          gap: var(--space-2);
          align-items: baseline;
        }
        .obs-instances li.is-offline {
          color: var(--text-muted);
        }
        .obs-inst-name {
          font-weight: var(--font-semibold);
        }
        .obs-inst-vram {
          color: var(--text-muted);
          font-variant-numeric: tabular-nums;
        }
        .obs-inst-queue {
          margin-left: auto;
          color: var(--run);
        }
        .obs-skel {
          border-radius: var(--radius-control);
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
          .obs-kpi,
          .obs-card,
          .obs-gpu,
          .obs-fleet-card,
          .obs-back,
          .obs-vram-fill,
          .obs-health-refresh,
          .obs-health-run {
            transition: none !important;
          }
        }
      `}</style>
  );
}
