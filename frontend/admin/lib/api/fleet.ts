import { apiFetch, authHeaders, raiseApiError } from "./http";

/** 手动触发一次 GPU 冒烟(同步等待;overall 失败时抛错并在 err.report 带报告体)。 */
export async function triggerGpuSmoke(): Promise<Record<string, unknown>> {
  // longRequest(180s):冒烟同步跑 txt2img+LTX 两路,默认 30s 几乎必超(2026-09-22 P0 设备域实测口径)
  const res = await apiFetch(`/api/system/gpu-smoke`, {
    method: "POST",
    headers: authHeaders(),
  }, { longRequest: true });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const err = new Error(`GPU 冒烟失败 (${res.status})`) as Error & { report?: unknown };
    err.report = (body as { detail?: unknown }).detail ?? body;
    throw err;
  }
  return body;
}

/** 最近一次 GPU 冒烟报告(无报告返回 null)。 */
export async function fetchGpuSmokeLatest(): Promise<Record<string, unknown> | null> {
  const res = await apiFetch(`/api/system/gpu-smoke/latest`, { headers: authHeaders() });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`冒烟报告加载失败 (${res.status})`);
  return res.json();
}

/** LB 后端池条目(/admin/backends 代理)。 */
export interface ComfyBackend {
  id?: string;
  url: string;
  gpu?: number;
  weight?: number;
  remote?: boolean;
  healthy?: boolean;
}

/** ComfyUI-LB 后端池健康(api 代理 LB /admin/backends)。 */
export async function fetchComfyBackends(): Promise<{ source: string; backends: ComfyBackend[] }> {
  const res = await apiFetch(`/api/system/comfy-backends`, { headers: authHeaders() });
  if (!res.ok) await raiseApiError(res, "LB 后端健康加载失败");
  return res.json();
}

export interface ObservabilityInstance {
  name: string;
  url: string;
  online: boolean;
  vram_total_gb: number | null;
  vram_used_gb: number | null;
  vram_used_pct: number | null;
  queue_running: number;
  queue_pending: number;
}

export interface ObservabilityGpu {
  id: string;
  host: string;
  online: boolean;
  vram_total_gb: number | null;
  vram_used_gb: number | null;
  vram_used_pct: number | null;
  queue_running: number;
  queue_pending: number;
  instances: ObservabilityInstance[];
}

/** 队列/VRAM 时序(进程内环形缓冲,重启清零;各数组与 timestamps 等长对齐)。 */
export interface ObservabilitySeries {
  timestamps: string[];
  queued: number[];
  held: number[];
  running: number[];
  /** 每卡 VRAM 占用百分比历史;离线卡该次采样为 null */
  vram_pct: Record<string, (number | null)[]>;
}

/** 24h 逐小时成功/失败桶(hour = 整点 ISO,升序零填充)。 */
export interface ObservabilityHourlyBucket {
  hour: string;
  done: number;
  error: number;
}

export interface ObservabilitySnapshot {
  generated_at: string;
  cache_ttl_sec: number;
  queue: { queued: number; held: number; running: number; other: number };
  success_24h: {
    window_hours: number;
    done: number;
    error: number;
    total: number;
    rate: number | null;
  };
  held: { total: number; reasons: { reason: string; count: number }[] };
  gpus: ObservabilityGpu[];
  series: ObservabilitySeries;
  hourly: ObservabilityHourlyBucket[];
  /** 封面 autorefire 深度闸(D5,2026-09-22 起随快照透出;旧后端无此键,视图须容缺)。 */
  cover_gate?: CoverGateState;
}

/** 封面队列闸状态(app_cover_demo 现有状态函数拼装;「跳过数」无计数器故无该字段)。 */
export interface CoverGateState {
  autorefire_enabled: boolean;
  running: boolean;
  queue_depth: number;
  queue_guard: number;
  gated: boolean;
  pending: number;
  attempt_cap: number;
  batch_limit: number;
  summary: {
    running: boolean;
    never_run?: boolean;
    started_at?: string;
    finished_at?: string;
    done?: number;
    ok?: number;
    total?: number;
    elapsed_s?: number;
  };
}

/** 观测面板聚合快照(队列分桶/24h 成功率/GPU VRAM)。仅管理员;非 2xx 抛错由视图展示。 */
export async function fetchObservability(
  signal?: AbortSignal,
): Promise<ObservabilitySnapshot> {
  const res = await apiFetch(`/api/observability`, {
    headers: authHeaders(),
    signal,
  });
  if (!res.ok) await raiseApiError(res, "加载观测数据失败");
  return res.json();
}

/** 服务探测状态:up / down / unknown(声明式占位,探测路径不明)。 */
export type FleetServiceStatus = "up" | "down" | "unknown";

export interface FleetService {
  name: string;
  port: number;
  status: FleetServiceStatus;
  latency_ms: number | null;
  note?: string;
  extra: Record<string, unknown>;
}

export interface FleetDeviceSummary {
  id: string;
  name: string;
  role: string;
  /** true 在线 / false 离线 / null 未知(灰点) */
  online: boolean | null;
  services_up: number;
  services_total: number;
  headline: string;
}

export interface FleetSummary {
  generated_at: string;
  cache_ttl_sec: number;
  devices: FleetDeviceSummary[];
}

/** workstation sysmetrics(:9403)全量指标;NAS 详情只含 nas 段。 */
export interface FleetSysmetrics {
  cpu?: {
    percent: number | null;
    load1: number | null;
    load5: number | null;
    load15: number | null;
    cores: number | null;
  } | null;
  memory?: {
    total_gb: number;
    used_gb: number;
    available_gb: number;
    used_pct: number | null;
  } | null;
  disk_root?: {
    total_gb: number;
    used_gb: number;
    free_gb: number;
    used_pct: number | null;
  } | null;
  nas?: {
    mountpoint: string;
    mounted: boolean;
    total_gb: number | null;
    used_gb: number | null;
    free_gb: number | null;
  } | null;
  gpus?: {
    index: number;
    name: string;
    vram_used_mb: number;
    vram_total_mb: number;
    vram_used_pct: number | null;
    temp_c: number;
  }[] | null;
}

export interface FleetDeviceDetail extends FleetDeviceSummary {
  meta: { lan_ip: string | null; ts_ip: string | null; hardware: string | null };
  services: FleetService[];
  sys: FleetSysmetrics | null;
  generated_at: string;
  series: {
    timestamps: string[];
    online: (number | null)[];
    latency: Record<string, (number | null)[]>;
  };
}

/** 设备舰队摘要(仅管理员)。 */
export async function fetchFleet(signal?: AbortSignal): Promise<FleetSummary> {
  const res = await apiFetch(`/api/fleet`, {
    headers: authHeaders(),
    signal,
  });
  if (!res.ok) await raiseApiError(res, "加载设备舰队失败");
  return res.json();
}

/** 单设备详情(服务清单 + sysmetrics + 时序)。 */
export async function fetchFleetDevice(
  deviceId: string,
  signal?: AbortSignal,
): Promise<FleetDeviceDetail> {
  const res = await apiFetch(`/api/fleet/${encodeURIComponent(deviceId)}`, {
    headers: authHeaders(),
    signal,
  });
  if (!res.ok) await raiseApiError(res, "加载设备详情失败");
  return res.json();
}

/** 冷层服务状态机状态(与后端 service_orchestrator.STATES 一致)。 */
export type OrchServiceStatus = "running" | "waking" | "sleeping" | "stopped" | "error";

export interface OrchService {
  name: string;
  systemd_unit: string;
  host: string;
  port: number;
  health_path: string;
  tier: string;
  safe_idle: boolean;
  idle_timeout_sec: number;
  status: OrchServiceStatus;
  /** 距上次请求的秒数;从未打点为 null */
  idle_sec: number | null;
  last_request_at: string | null;
  wake_count: number;
  stop_count: number;
  last_error: string;
  status_changed_at: string;
}

export interface OrchServicesPayload {
  generated_at: string;
  services: OrchService[];
}

/** 冷层服务清单(仅管理员)。 */
export async function fetchOrchServices(signal?: AbortSignal): Promise<OrchServicesPayload> {
  const res = await apiFetch(`/api/orch/services`, {
    headers: authHeaders(),
    signal,
  });
  if (!res.ok) await raiseApiError(res, "加载编排服务失败");
  return res.json();
}

/** 手动唤醒冷服务(登录用户即可):sleeping/stopped/error → waking → running。 */
export async function wakeOrchService(name: string): Promise<OrchService> {
  const res = await apiFetch(`/api/orch/services/${encodeURIComponent(name)}/wake`, {
    method: "POST",
    headers: authHeaders(),
  });
  if (!res.ok) await raiseApiError(res, "唤醒服务失败");
  return res.json();
}
