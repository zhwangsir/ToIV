/**
 * 作业事件 SSE 消费层（M29.2，契约已读 apps/api/app/routes/jobs.py L380 源码验证）
 * - 端点：GET /api/jobs/{prompt_id}/events?client_id=&worker=（sse_starlette EventSourceResponse）
 * - 事件帧：`event: progress|done|error|quality_warning`，data 为 JSON；
 *   done 载荷 {images:urls}（产物相对路径数组），error 载荷 {message}；
 *   保活为注释行（`: ping`），parseSseStream 天然忽略
 * - 载体：expo/fetch ReadableStream（RN 无原生 EventSource），复用 sse.ts 跨块 UTF-8 解码；
 *   token 走 query + Authorization 头双通道（对齐 watchAgentRunEvents）
 * - FSM（移植 Web trackJob 2.0 简化语义，apps/web/lib/trackJob.ts）：
 *   · 401/403 → 立即终止 'auth'（expo/fetch 拿得到状态码，无需 Web 的探针迂回）
 *   · 看门狗：60s 无业务事件判假死主动重连；streaming 阶段软重连不计失败，
 *     connecting 挂死按连接失败计入退避
 *   · 重连 500ms 快照窗：窗口内与断线前末帧相同负载的 progress/quality_warning 判回放重复丢弃
 *   · 连续连接失败超限（默认 3）→ 'fallback'（调用方回退既有 2s 轮询兜底，行为不回退）
 *   · 业务 done/error 即终态；外部 signal 中止 → 静默 'aborted'
 */
import { fetch as expoFetch } from 'expo/fetch';

import { getToken } from './api';
import { resolveApiBase } from './config';
import { parseSseStream } from './sse';

/** SSE 透传的采样进度（value/max 来自 ComfyUI，pct 为派生百分比 0-100 整数） */
export interface JobProgress {
  value: number;
  max: number;
  pct: number;
}

/** 视频质量评估警告（jobs.py _maybe_quality_warning，done 前推送、不阻塞 done） */
export interface JobQualityWarning {
  total: number;
  quality_score: number;
  aesthetic: number;
  technical: number;
  prompt_alignment: number;
  issues: string[];
  suggested_prompt: string | null;
  degraded: boolean;
}

export interface StreamJobEventsHandlers {
  /** 采样进度（仅 max>0 时回调） */
  onProgress?: (p: JobProgress) => void;
  /** 质量警告（done 之前到达，温和提示不阻断） */
  onQualityWarning?: (w: JobQualityWarning) => void;
  /** 终态成功：产物相对路径数组 */
  onDone?: (urls: string[]) => void;
  /** 终态业务失败：后端人话 message */
  onError?: (message: string) => void;
  /** 401/403 立即终止：凭据失效/跨租户无权，调用方回退轮询 */
  onAuthError?: () => void;
}

/** 流结局：done/error 业务终态；aborted 调用方中止；auth 鉴权终止；fallback 回退轮询 */
export type JobStreamEnd = 'done' | 'error' | 'aborted' | 'auth' | 'fallback';

export interface StreamJobEventsOptions {
  signal?: AbortSignal;
  /** 看门狗阈值（默认 60s）：无任何业务事件判假死主动重连 */
  watchdogMs?: number;
  /** 连续连接失败上限（默认 3），超限回退轮询 */
  maxReconnects?: number;
  /** 重连快照窗（默认 500ms）回放去重 */
  snapshotWindowMs?: number;
  /** 连接失败固定退避（默认 1s；软重连立即重建不等待） */
  reconnectDelayMs?: number;
}

/** 可中止的固定退避 */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function streamJobEvents(
  creds: { promptId: string; clientId: string; worker: string },
  handlers: StreamJobEventsHandlers,
  options: StreamJobEventsOptions = {},
): Promise<JobStreamEnd> {
  const { signal } = options;
  const watchdogMs = options.watchdogMs ?? 60_000;
  const maxReconnects = options.maxReconnects ?? 3;
  const snapshotWindowMs = options.snapshotWindowMs ?? 500;
  const reconnectDelayMs = options.reconnectDelayMs ?? 1_000;

  const token = await getToken();
  const qs = `?client_id=${encodeURIComponent(creds.clientId)}&worker=${encodeURIComponent(creds.worker)}${token ? `&token=${encodeURIComponent(token)}` : ''}`;
  const url = `${resolveApiBase()}/api/jobs/${encodeURIComponent(creds.promptId)}/events${qs}`;
  const headers: Record<string, string> = { Accept: 'text/event-stream' };
  if (token) headers.Authorization = `Bearer ${token}`;

  let settled = false;
  let end: JobStreamEnd = 'aborted';
  /** 冷启动分级标记：曾连接成功后失败一律按网络抖动处理（对齐 Web everConnected） */
  let everConnected = false;
  let consecutiveFailures = 0;
  /** 快照窗截止时刻（Date.now()）；0 = 不在窗口期 */
  let snapshotUntil = 0;
  /** 断线前最后派发的 progress / quality_warning 原始负载（回放去重基准） */
  let lastProgressSig: string | null = null;
  let lastWarningSig: string | null = null;
  let phase: 'connecting' | 'streaming' = 'connecting';
  let watchdogFired = false;
  let watchdogTimer: ReturnType<typeof setTimeout> | null = null;
  let connAbort: AbortController | null = null;

  const clearWatchdog = (): void => {
    if (watchdogTimer) {
      clearTimeout(watchdogTimer);
      watchdogTimer = null;
    }
  };
  /** 任何业务事件到达 = 连接存活，刷新计时 */
  const armWatchdog = (): void => {
    clearWatchdog();
    watchdogTimer = setTimeout(() => {
      watchdogFired = true;
      connAbort?.abort(); // 中止当前连接，由主循环按 soft/hard 语义重建
    }, watchdogMs);
  };

  /** 事件分派：快照窗去重 → 各类型回调；坏帧跳过不中断；done/error 收流终态 */
  const dispatch = (event: string, data: string): void => {
    if (event !== 'progress' && event !== 'quality_warning' && event !== 'done' && event !== 'error')
      return;
    armWatchdog();
    try {
      if (event === 'progress') {
        if (Date.now() < snapshotUntil && data === lastProgressSig) return; // 回放重复
        const d = JSON.parse(data) as { value?: unknown; max?: unknown };
        if (typeof d.max === 'number' && d.max > 0) {
          lastProgressSig = data;
          const value = typeof d.value === 'number' ? d.value : 0;
          handlers.onProgress?.({
            value,
            max: d.max,
            pct: Math.min(100, Math.round((value / d.max) * 100)),
          });
        }
        return;
      }
      if (event === 'quality_warning') {
        if (Date.now() < snapshotUntil && data === lastWarningSig) return; // 回放重复
        const w = JSON.parse(data) as JobQualityWarning;
        lastWarningSig = data;
        handlers.onQualityWarning?.(w);
        return;
      }
      if (event === 'done') {
        const d = JSON.parse(data) as { images?: unknown };
        const urls = Array.isArray(d.images) ? (d.images as string[]) : [];
        settled = true;
        end = 'done';
        connAbort?.abort(); // 主动收流（后端推完即关流，abort 幂等防御）
        handlers.onDone?.(urls);
        return;
      }
      // error：业务失败帧（后端 JSON {message}）→ 终态，不重连
      let message = '生成出错';
      try {
        const m = (JSON.parse(data) as { message?: unknown }).message;
        if (typeof m === 'string' && m) message = m;
      } catch {
        /* 保留默认人话 */
      }
      settled = true;
      end = 'error';
      connAbort?.abort();
      handlers.onError?.(message);
    } catch {
      /* 防御：单帧坏数据不中断整条流 */
    }
  };

  while (!settled) {
    if (signal?.aborted) break; // end 初始即 'aborted'
    phase = 'connecting';
    watchdogFired = false;
    const conn = new AbortController();
    connAbort = conn;
    const onOuterAbort = (): void => conn.abort();
    signal?.addEventListener('abort', onOuterAbort, { once: true });
    armWatchdog(); // connecting 挂死也由看门狗兜底（计连接失败）

    try {
      const res = await expoFetch(url, { method: 'GET', headers, signal: conn.signal });
      if (!res.ok) {
        // 401/403：立即终止语义（凭据失效/跨租户无权），不重连不降级空转
        if (res.status === 401 || res.status === 403) {
          settled = true;
          end = 'auth';
          handlers.onAuthError?.();
          break;
        }
        throw new Error(`HTTP ${res.status}`);
      }
      if (!res.body) throw new Error('no stream body');
      // 连接成功：失败计数清零；重连臂快照窗去重
      consecutiveFailures = 0;
      phase = 'streaming';
      if (everConnected) snapshotUntil = Date.now() + snapshotWindowMs;
      everConnected = true;
      await parseSseStream(res.body.getReader(), dispatch, conn.signal);
      if (!settled) throw new Error('stream ended'); // 未终态断流 → 断线重连
    } catch {
      if (settled) break;
      if (signal?.aborted) {
        settled = true;
        end = 'aborted';
        break;
      }
      // 看门狗软重连（streaming 假死）不计失败、立即重建；connecting 挂死计失败
      const soft = watchdogFired && phase === 'streaming';
      watchdogFired = false;
      if (!soft) {
        consecutiveFailures += 1;
        if (consecutiveFailures >= maxReconnects) {
          settled = true;
          end = 'fallback';
          break;
        }
        await delay(reconnectDelayMs, signal);
      }
    } finally {
      clearWatchdog();
      signal?.removeEventListener('abort', onOuterAbort);
      connAbort = null;
    }
  }
  clearWatchdog();
  return end;
}
