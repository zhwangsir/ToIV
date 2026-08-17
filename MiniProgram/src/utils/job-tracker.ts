/**
 * 作业进度 SSE 跟踪层 FSM（MP29）
 * - 状态机：active（connecting/streaming）→ terminal（done/error）/ fallback（回退轮询）/ aborted
 * - 看门狗：connecting 60s 无 open 计一次失败走退避；streaming 60s 无事件软重连（立即重建，不计失败）
 * - 退避重连：网络类失败按 base*2^(n-1) 指数退避，超 maxReconnects 上抛 onFallback 交回轮询；
 *   open 成功即清零失败计数（连接恢复）；401/403 立即终止回退（凭据失效重连无意义）
 * - 重连快照窗：重连 open 后 500ms 内，与断线前最后一帧同负载的事件去重（防进度回跳/重复质量提示）
 * - 连接器可注入（测试用假连接器逐连接手动 open/emit/fail）；缺省走 streamJobEvents
 * 纯逻辑层：定时器之外无运行时依赖，node 环境可直接单测
 */
import { ApiError } from '@/api/client';
import { streamJobEvents, type JobEventsHandle } from '@/api/index';
import type { JobItem, JobSseEvent } from '@/types/api';
import type { JobSseCredentials } from './job-sse-registry';

export interface JobTrackProgress {
  value: number;
  max: number;
  /** value/max 百分比（0-100 钳制，四舍五入） */
  pct: number;
}

export interface JobTrackHandlers {
  onProgress?: (progress: JobTrackProgress) => void;
  /** 终态：产物相对路径数组（done.images 非字符串项已过滤） */
  onDone?: (urls: string[]) => void;
  /** 终态：error.message 透传，缺省兜底「生成出错」 */
  onError?: (message: string) => void;
  /** 非终态：质量评估低分预警，载荷原样上抛 */
  onQualityWarning?: (warning: Record<string, unknown>) => void;
  /** 跟踪层放弃（401/403 或重连超上限）：调用方回退既有轮询 */
  onFallback?: () => void;
}

export interface JobTrackHandle {
  /** 停止跟踪：中断底层连接，之后事件/断线/看门狗全部静默 */
  abort(): void;
}

export interface JobSseConnectArgs {
  onOpen: () => void;
  onEvent: (event: JobSseEvent) => void;
}

/** 连接器：与 streamJobEvents 同形（promptId/creds 由跟踪层闭包注入） */
export type JobSseConnector = (args: JobSseConnectArgs) => JobEventsHandle;

export interface JobTrackOptions {
  /** 看门狗：无 open/无事件容忍时长（缺省 60s） */
  watchdogMs?: number;
  /** 退避基准：第 n 次重连延迟 base*2^(n-1)（缺省 1s） */
  reconnectBaseMs?: number;
  /** 最大连续重连次数，超限 onFallback（缺省 5） */
  maxReconnects?: number;
  /** 重连快照窗时长（缺省 500ms） */
  snapshotWindowMs?: number;
  /** 连接器注入（测试）；缺省 streamJobEvents */
  connect?: JobSseConnector;
}

type Phase = 'active' | 'terminal' | 'fallback' | 'aborted';
type WatchdogMode = 'connecting' | 'streaming';

interface ConnState {
  handle: JobEventsHandle;
  /** FSM 主动中止（软重连/看门狗/abort）：其 reject 静默 */
  intentional: boolean;
}

function signatureOf(event: JobSseEvent): string {
  try {
    return `${event.type}:${JSON.stringify(event.data)}`;
  } catch {
    return `${event.type}:<unserializable>`;
  }
}

export function trackJobSse(
  promptId: string,
  creds: JobSseCredentials,
  handlers: JobTrackHandlers,
  options: JobTrackOptions = {},
): JobTrackHandle {
  const watchdogMs = options.watchdogMs ?? 60_000;
  const reconnectBaseMs = options.reconnectBaseMs ?? 1_000;
  const maxReconnects = options.maxReconnects ?? 5;
  const snapshotWindowMs = options.snapshotWindowMs ?? 500;
  const connect: JobSseConnector =
    options.connect ??
    (({ onOpen, onEvent }) => streamJobEvents(promptId, creds, onEvent, onOpen));

  let phase: Phase = 'active';
  let failures = 0;
  let current: ConnState | null = null;
  let lastEventSig: string | null = null;
  let inSnapshotWindow = false;

  let watchdogTimer: ReturnType<typeof setTimeout> | null = null;
  let backoffTimer: ReturnType<typeof setTimeout> | null = null;
  let snapshotTimer: ReturnType<typeof setTimeout> | null = null;

  function clearWatchdog(): void {
    if (watchdogTimer !== null) {
      clearTimeout(watchdogTimer);
      watchdogTimer = null;
    }
  }

  function clearBackoff(): void {
    if (backoffTimer !== null) {
      clearTimeout(backoffTimer);
      backoffTimer = null;
    }
  }

  function clearSnapshot(): void {
    if (snapshotTimer !== null) {
      clearTimeout(snapshotTimer);
      snapshotTimer = null;
    }
    inSnapshotWindow = false;
  }

  function clearAllTimers(): void {
    clearWatchdog();
    clearBackoff();
    clearSnapshot();
  }

  function abortCurrent(): void {
    const conn = current;
    if (!conn) return;
    conn.intentional = true;
    try {
      conn.handle.abort();
    } catch {
      // 中止底层请求的异常不影响状态机
    }
  }

  function armWatchdog(mode: WatchdogMode): void {
    clearWatchdog();
    watchdogTimer = setTimeout(() => {
      watchdogTimer = null;
      if (phase !== 'active') return;
      abortCurrent();
      if (mode === 'streaming') {
        // 软重连：流挂死立即重建，不计失败、不退避
        startConnection();
        return;
      }
      // connecting 挂死：计一次失败，走退避/回退
      handleFailure();
    }, watchdogMs);
  }

  function handleFailure(): void {
    if (phase !== 'active') return;
    failures += 1;
    if (failures > maxReconnects) {
      phase = 'fallback';
      clearAllTimers();
      handlers.onFallback?.();
      return;
    }
    const delay = reconnectBaseMs * 2 ** (failures - 1);
    clearBackoff();
    backoffTimer = setTimeout(() => {
      backoffTimer = null;
      if (phase !== 'active') return;
      startConnection();
    }, delay);
  }

  function dispatch(event: JobSseEvent): void {
    switch (event.type) {
      case 'progress': {
        const max = typeof event.data.max === 'number' ? event.data.max : NaN;
        if (!Number.isFinite(max) || max <= 0) return; // 缺 max / max<=0 的畸形帧不上抛
        const value =
          typeof event.data.value === 'number' && Number.isFinite(event.data.value)
            ? event.data.value
            : 0;
        const pct = Math.max(0, Math.min(100, Math.round((value / max) * 100)));
        handlers.onProgress?.({ value, max, pct });
        return;
      }
      case 'done': {
        const raw = event.data.images;
        const urls = Array.isArray(raw)
          ? raw.filter((item): item is string => typeof item === 'string')
          : [];
        phase = 'terminal';
        clearAllTimers();
        handlers.onDone?.(urls);
        return;
      }
      case 'error': {
        const message =
          typeof event.data.message === 'string' && event.data.message !== ''
            ? event.data.message
            : '生成出错';
        phase = 'terminal';
        clearAllTimers();
        handlers.onError?.(message);
        return;
      }
      case 'quality_warning': {
        handlers.onQualityWarning?.(event.data);
        return;
      }
    }
  }

  function startConnection(): void {
    if (phase !== 'active') return;
    const connState: ConnState = { handle: null as unknown as JobEventsHandle, intentional: false };
    const handle = connect({
      onOpen: () => {
        if (phase !== 'active' || current !== connState) return;
        failures = 0; // 连接恢复：退避计数清零
        // 重连快照窗：断线前收过事件才开启（首连无回放源）
        if (lastEventSig !== null) {
          clearSnapshot();
          inSnapshotWindow = true;
          snapshotTimer = setTimeout(() => {
            snapshotTimer = null;
            inSnapshotWindow = false;
          }, snapshotWindowMs);
        }
        armWatchdog('streaming');
      },
      onEvent: (event) => {
        if (phase !== 'active' || current !== connState) return;
        armWatchdog('streaming'); // 事件到达刷新看门狗
        const sig = signatureOf(event);
        if (inSnapshotWindow && sig === lastEventSig) return; // 窗内回放去重
        lastEventSig = sig;
        dispatch(event);
      },
    });
    connState.handle = handle;
    current = connState;
    armWatchdog('connecting');
    handle.promise.then(
      () => {
        // 流正常结束：终态后关流静默；未达终态的意外关流按断线处理
        if (current !== connState || connState.intentional) return;
        if (phase === 'terminal') return;
        if (phase !== 'active') return;
        handleFailure();
      },
      (err: unknown) => {
        if (current !== connState || connState.intentional) return;
        if (phase !== 'active') return;
        if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
          // 凭据失效/无权限：重连无意义，立即回退轮询
          phase = 'fallback';
          clearAllTimers();
          handlers.onFallback?.();
          return;
        }
        handleFailure();
      },
    );
  }

  startConnection();

  return {
    abort() {
      if (phase === 'aborted') return;
      phase = 'aborted';
      clearAllTimers();
      abortCurrent();
    },
  };
}

// ── 作业列表 × 跟踪集 → 起停计划（jobs.vue 每次列表刷新后调用）──

export interface JobSseSyncPlan {
  /** 活跃 + 有会话凭据 + 未跟踪 → 应起流 */
  toStart: string[];
  /** 跟踪中的作业转终态或从列表消失 → 应停流 */
  toStop: string[];
}

const ACTIVE_JOB_STATUSES = new Set(['queued', 'running']);
const TERMINAL_JOB_STATUSES = new Set(['done', 'error']);

export function planJobSseSync(
  jobs: Array<Pick<JobItem, 'prompt_id' | 'status'>>,
  tracked: ReadonlySet<string>,
  hasCredentials: (promptId: string) => boolean,
): JobSseSyncPlan {
  const statusByPromptId = new Map(jobs.map((job) => [job.prompt_id, job.status]));
  const toStart: string[] = [];
  for (const job of jobs) {
    if (!ACTIVE_JOB_STATUSES.has(job.status)) continue;
    if (tracked.has(job.prompt_id)) continue;
    if (!hasCredentials(job.prompt_id)) continue;
    toStart.push(job.prompt_id);
  }
  const toStop: string[] = [];
  for (const promptId of tracked) {
    const status = statusByPromptId.get(promptId);
    if (status === undefined || TERMINAL_JOB_STATUSES.has(status)) toStop.push(promptId);
  }
  return { toStart, toStop };
}
