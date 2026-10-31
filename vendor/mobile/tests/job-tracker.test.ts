import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError, setToken } from '@/api/client';
import { setApiBaseOverride } from '@/api/config';
import type { JobSseEvent } from '@/types/api';
import {
  planJobSseSync,
  trackJobSse,
  type JobSseConnector,
  type JobTrackHandlers,
} from '@/utils/job-tracker';
import { clearJobSseRegistry, registerJobSseCredentials } from '@/utils/job-sse-registry';
import { enqueueChunkedResponse, installMockUni, requestCallCount } from './helpers/mock-uni';

// ── 可控假连接器：逐连接手动 open/emit/end/fail ──

interface FakeConn {
  aborted: boolean;
  open(): void;
  emit(e: JobSseEvent): void;
  end(): void;
  fail(err: unknown): void;
}

function makeConnector() {
  const conns: FakeConn[] = [];
  const connect: JobSseConnector = ({ onOpen, onEvent }) => {
    let resolve!: () => void;
    let reject!: (err: unknown) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const conn: FakeConn = {
      aborted: false,
      open: () => onOpen(),
      emit: (e) => onEvent(e),
      end: () => resolve(),
      fail: (err) => reject(err),
    };
    conns.push(conn);
    return {
      promise,
      abort: () => {
        if (conn.aborted) return;
        conn.aborted = true;
        reject(new ApiError(0, '已停止监听'));
      },
    };
  };
  return { connect, conns };
}

const CREDS = { clientId: 'c1', worker: 'w1' };

/** 冲刷 promise 微任务（fail/end 的 FSM 回调在微任务里跑） */
async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

describe('trackJobSse FSM（看门狗/退避重连/快照窗/401-403 回退）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function start(handlers: JobTrackHandlers, options: Parameters<typeof trackJobSse>[3] = {}) {
    const { connect, conns } = makeConnector();
    const handle = trackJobSse('p1', CREDS, handlers, {
      watchdogMs: 60_000,
      reconnectBaseMs: 1_000,
      maxReconnects: 5,
      ...options,
      connect,
    });
    return { handle, conns };
  }

  it('progress 事件 → onProgress 派生 pct（value/max 百分比，超 100 钳制）', () => {
    const pcts: number[] = [];
    const { conns } = start({ onProgress: (p) => pcts.push(p.pct) });
    conns[0].open();
    conns[0].emit({ type: 'progress', data: { value: 3, max: 10 } });
    conns[0].emit({ type: 'progress', data: { value: 15, max: 10 } });
    expect(pcts).toEqual([30, 100]);
  });

  it('progress 载荷 max<=0 / 缺 max 不上抛；缺 value 按 0 计', () => {
    const got: Array<{ value: number; max: number; pct: number }> = [];
    const { conns } = start({ onProgress: (p) => got.push(p) });
    conns[0].open();
    conns[0].emit({ type: 'progress', data: { value: 3, max: 0 } });
    conns[0].emit({ type: 'progress', data: { value: 3 } });
    conns[0].emit({ type: 'progress', data: { max: 10 } });
    expect(got).toEqual([{ value: 0, max: 10, pct: 0 }]);
  });

  it('done → onDone 产物 urls（非字符串项过滤），终态后流结束不再重连', async () => {
    let urls: string[] | null = null;
    const { conns } = start({ onDone: (u) => (urls = u) });
    conns[0].open();
    conns[0].emit({ type: 'done', data: { images: ['outputs/a.png', 5, 'outputs/b.png'] } });
    expect(urls).toEqual(['outputs/a.png', 'outputs/b.png']);
    conns[0].end();
    await flush();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(conns).toHaveLength(1); // 终态幂等：无重连
  });

  it('error 事件 → onError 文案；缺 message 兜底「生成出错」', () => {
    const msgs: string[] = [];
    const { conns } = start({ onError: (m) => msgs.push(m) });
    conns[0].open();
    conns[0].emit({ type: 'error', data: { message: 'CUDA OOM' } });
    expect(msgs).toEqual(['CUDA OOM']);
  });

  it('error 事件缺 message → 兜底文案', () => {
    const msgs: string[] = [];
    const { conns } = start({ onError: (m) => msgs.push(m) });
    conns[0].open();
    conns[0].emit({ type: 'error', data: {} });
    expect(msgs).toEqual(['生成出错']);
  });

  it('quality_warning 事件 → onQualityWarning 原样上抛', () => {
    const warnings: unknown[] = [];
    const { conns } = start({ onQualityWarning: (w) => warnings.push(w) });
    conns[0].open();
    conns[0].emit({ type: 'quality_warning', data: { quality_score: 41, issues: ['画面模糊'] } });
    expect(warnings).toEqual([{ quality_score: 41, issues: ['画面模糊'] }]);
  });

  it('401 立即终止并回退（onFallback 一次，不重连）', async () => {
    let fallbacks = 0;
    const { conns } = start({ onFallback: () => (fallbacks += 1) });
    conns[0].fail(new ApiError(401, '登录已过期，请重新登录'));
    await flush();
    expect(fallbacks).toBe(1);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(conns).toHaveLength(1);
    expect(fallbacks).toBe(1);
  });

  it('403 立即终止并回退', async () => {
    let fallbacks = 0;
    const { conns } = start({ onFallback: () => (fallbacks += 1) });
    conns[0].fail(new ApiError(403, '没有权限执行此操作'));
    await flush();
    expect(fallbacks).toBe(1);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(conns).toHaveLength(1);
  });

  it('网络断线 → 指数退避重连；重连成功后继续收事件', async () => {
    const pcts: number[] = [];
    const { conns } = start({ onProgress: (p) => pcts.push(p.pct) });
    conns[0].open();
    conns[0].emit({ type: 'progress', data: { value: 1, max: 10 } });
    conns[0].fail(new ApiError(0, '网络连接失败，请检查网络'));
    await flush();
    expect(conns).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000); // 第 1 档退避 1s
    expect(conns).toHaveLength(2);
    conns[1].open();
    conns[1].emit({ type: 'progress', data: { value: 5, max: 10 } });
    expect(pcts).toEqual([10, 50]);
  });

  it('连续失败超上限 → onFallback 回退轮询', async () => {
    let fallbacks = 0;
    const { conns } = start(
      { onFallback: () => (fallbacks += 1) },
      { maxReconnects: 2, reconnectBaseMs: 100 },
    );
    conns[0].fail(new ApiError(0, '网络连接失败，请检查网络'));
    await flush();
    await vi.advanceTimersByTimeAsync(100); // 退避档 1 → 第 2 连接
    expect(conns).toHaveLength(2);
    conns[1].fail(new ApiError(0, '网络连接失败，请检查网络'));
    await flush();
    await vi.advanceTimersByTimeAsync(200); // 退避档 2 → 第 3 连接
    expect(conns).toHaveLength(3);
    conns[2].fail(new ApiError(0, '网络连接失败，请检查网络'));
    await flush();
    expect(fallbacks).toBe(1);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(conns).toHaveLength(3); // 不再重连
  });

  it('看门狗：streaming 60s 无事件 → 软重连（不计失败）', async () => {
    const { conns } = start({}, { reconnectBaseMs: 1_000 });
    conns[0].open();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(conns).toHaveLength(2); // 软重连立即重建
    expect(conns[0].aborted).toBe(true);
    // 软重连未计入连续失败：新连接挂死看门狗 → 第 1 档退避（1s 而非 2s）
    await vi.advanceTimersByTimeAsync(60_000); // connecting 看门狗 → 断线处理
    await vi.advanceTimersByTimeAsync(1_000);
    expect(conns).toHaveLength(3);
  });

  it('看门狗：事件到达刷新计时（有事件不触发重连）', async () => {
    const { conns } = start({});
    conns[0].open();
    await vi.advanceTimersByTimeAsync(30_000);
    conns[0].emit({ type: 'progress', data: { value: 1, max: 10 } });
    await vi.advanceTimersByTimeAsync(30_000); // 距上次事件 30s < 60s
    expect(conns).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(30_000); // 距上次事件 60s → 软重连
    expect(conns).toHaveLength(2);
  });

  it('看门狗：connecting 阶段迟迟无 open → 计入退避重连', async () => {
    const { conns } = start({}, { reconnectBaseMs: 500 });
    await vi.advanceTimersByTimeAsync(60_000); // connecting 看门狗
    expect(conns).toHaveLength(1); // 先退避
    await vi.advanceTimersByTimeAsync(500);
    expect(conns).toHaveLength(2);
  });

  it('重连快照窗：500ms 内同负载 progress 去重，新负载透传，窗外重放恢复透传', async () => {
    const pcts: number[] = [];
    const { conns } = start({ onProgress: (p) => pcts.push(p.pct) }, { reconnectBaseMs: 100 });
    conns[0].open();
    conns[0].emit({ type: 'progress', data: { value: 3, max: 10 } });
    conns[0].fail(new ApiError(0, '网络连接失败，请检查网络'));
    await flush();
    await vi.advanceTimersByTimeAsync(100);
    conns[1].open(); // 重连 open → 快照窗开启
    conns[1].emit({ type: 'progress', data: { value: 3, max: 10 } }); // 窗内同负载 → 去重
    conns[1].emit({ type: 'progress', data: { value: 4, max: 10 } }); // 新负载 → 透传
    await vi.advanceTimersByTimeAsync(600); // 出窗
    conns[1].emit({ type: 'progress', data: { value: 3, max: 10 } }); // 窗外重放 → 透传
    expect(pcts).toEqual([30, 40, 30]);
  });

  it('重连快照窗：quality_warning 同负载窗内去重（防重复提示）', async () => {
    const warnings: unknown[] = [];
    const { conns } = start({ onQualityWarning: (w) => warnings.push(w) }, { reconnectBaseMs: 100 });
    conns[0].open();
    conns[0].emit({ type: 'quality_warning', data: { quality_score: 41 } });
    conns[0].fail(new ApiError(0, '网络连接失败，请检查网络'));
    await flush();
    await vi.advanceTimersByTimeAsync(100);
    conns[1].open();
    conns[1].emit({ type: 'quality_warning', data: { quality_score: 41 } }); // 窗内回放 → 去重
    expect(warnings).toHaveLength(1);
  });

  it('abort：之后事件/断线/看门狗全部静默', async () => {
    let calls = 0;
    const { handle, conns } = start({
      onProgress: () => (calls += 1),
      onDone: () => (calls += 1),
      onError: () => (calls += 1),
      onFallback: () => (calls += 1),
    });
    conns[0].open();
    conns[0].emit({ type: 'progress', data: { value: 1, max: 10 } });
    expect(calls).toBe(1);
    handle.abort();
    expect(conns[0].aborted).toBe(true);
    conns[0].emit({ type: 'progress', data: { value: 2, max: 10 } });
    conns[0].fail(new ApiError(0, '网络连接失败，请检查网络'));
    await flush();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(calls).toBe(1);
    expect(conns).toHaveLength(1);
  });
});

describe('planJobSseSync（作业列表 × 跟踪集 → 起停计划）', () => {
  const creds = new Set(['p-have']);

  it('活跃 + 有会话凭据 + 未跟踪 → toStart', () => {
    const plan = planJobSseSync(
      [{ prompt_id: 'p-have', status: 'running' }],
      new Set(),
      (pid) => creds.has(pid),
    );
    expect(plan.toStart).toEqual(['p-have']);
    expect(plan.toStop).toEqual([]);
  });

  it('无凭据 / 已跟踪 / 终态 不起流', () => {
    const plan = planJobSseSync(
      [
        { prompt_id: 'p-none', status: 'running' }, // 无凭据
        { prompt_id: 'p-have', status: 'queued' }, // 已跟踪
      ],
      new Set(['p-have']),
      (pid) => creds.has(pid),
    );
    expect(plan.toStart).toEqual([]);
    const done = planJobSseSync(
      [{ prompt_id: 'p-have', status: 'done' }],
      new Set(),
      (pid) => creds.has(pid),
    );
    expect(done.toStart).toEqual([]);
  });

  it('跟踪中的作业转终态或消失 → toStop', () => {
    const plan = planJobSseSync(
      [
        { prompt_id: 'p-done', status: 'done' },
        { prompt_id: 'p-live', status: 'running' },
      ],
      new Set(['p-done', 'p-gone', 'p-live']),
      () => false,
    );
    expect(plan.toStop).toEqual(['p-done', 'p-gone']);
  });
});

describe('trackJobSse × streamJobEvents 集成（mock uni enableChunked 分块）', () => {
  beforeEach(() => {
    installMockUni();
    setToken(null);
    setApiBaseOverride(null);
    clearJobSseRegistry();
  });

  it('提交后全链路：progress 两帧 pct 推进 → done 产物到达（不经回退）', async () => {
    registerJobSseCredentials({ prompt_id: 'p1', client_id: 'c1', worker: 'w1', seed: 1 });
    setToken('t1');
    enqueueChunkedResponse({
      statusCode: 200,
      chunks: [
        'event: progress\ndata: {"value":3,"max":10}\n\n',
        'event: progress\ndata: {"value":7,"max":10}\n\n',
        'event: done\ndata: {"images":["outputs/a.png"]}\n\n',
      ],
    });
    const pcts: number[] = [];
    let fallbacks = 0;
    const doneUrls = await new Promise<string[]>((resolve) => {
      trackJobSse('p1', CREDS, {
        onProgress: (p) => pcts.push(p.pct),
        onDone: (urls) => resolve(urls),
        onFallback: () => (fallbacks += 1),
      });
    });
    expect(pcts).toEqual([30, 70]);
    expect(doneUrls).toEqual(['outputs/a.png']);
    expect(fallbacks).toBe(0);
  });

  it('error 帧 → onError 文案透传', async () => {
    enqueueChunkedResponse({
      statusCode: 200,
      chunks: ['event: error\ndata: {"message":"执行失败：节点超时"}\n\n'],
    });
    const message = await new Promise<string>((resolve) => {
      trackJobSse('p1', CREDS, { onError: (m) => resolve(m) });
    });
    expect(message).toBe('执行失败：节点超时');
  });

  it('401 → onFallback（跟踪层终止，交由轮询兜底）', async () => {
    enqueueChunkedResponse({ statusCode: 401, chunks: [] });
    const before = requestCallCount();
    const fellBack = await new Promise<boolean>((resolve) => {
      trackJobSse('p1', CREDS, { onFallback: () => resolve(true) });
    });
    expect(fellBack).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(requestCallCount()).toBe(before + 1); // 无重连追加请求
  });

  it('abort 生命周期：中止后不再分派事件、不回退', async () => {
    enqueueChunkedResponse({
      statusCode: 200,
      chunks: [
        'event: progress\ndata: {"value":3,"max":10}\n\n',
        'event: done\ndata: {"images":["outputs/a.png"]}\n\n',
      ],
    });
    let calls = 0;
    const handle = trackJobSse('p1', CREDS, {
      onProgress: () => (calls += 1),
      onDone: () => (calls += 1),
      onFallback: () => (calls += 1),
    });
    handle.abort();
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toBe(0);
  });
});
