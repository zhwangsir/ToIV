import { fetch as expoFetch } from 'expo/fetch';

import { setToken } from '../api';
import { streamJobEvents } from '../job-events';
import type { JobProgress, JobQualityWarning } from '../job-events';

/**
 * 作业事件 SSE 消费层测试（M29.2）
 * 契约来源（已读 apps/api/app/routes/jobs.py L380 源码验证）：
 * - GET /api/jobs/{prompt_id}/events?client_id=&worker=（EventSourceResponse）
 * - 事件：progress {value,max} / done {images:urls} / error {message} / quality_warning
 * - 401（未登录）/403（跨租户）属立即终止语义；注释行 `: ping` 保活由解析层忽略
 * FSM 语义（移植 Web trackJob FSM 2.0 简化版）：
 * - 60s 无业务事件看门狗软重连（streaming 阶段不计失败；connecting 挂死计失败）
 * - 重连 500ms 快照窗去重（窗口内与断线前末帧相同负载的 progress/quality_warning 丢弃）
 * - 连续连接失败超限 → 'fallback'（调用方回退既有轮询）；业务 done/error 即终态
 */

jest.mock('expo-secure-store', () => {
  const store = new Map<string, string>();
  return {
    getItemAsync: jest.fn(async (k: string) => store.get(k) ?? null),
    setItemAsync: jest.fn(async (k: string, v: string) => void store.set(k, v)),
    deleteItemAsync: jest.fn(async (k: string) => void store.delete(k)),
  };
});

// API 基址固定，避免依赖 expo-constants 真值
jest.mock('../config', () => ({
  resolveApiBase: () => 'https://api.test',
}));

// expo/fetch 为原生流式实现，jest 环境替换为可控 mock（与 api.test.ts SSE 通道同款）
jest.mock('expo/fetch', () => ({
  fetch: jest.fn(),
}));

const mockExpoFetch = expoFetch as jest.Mock;
const encoder = new TextEncoder();

const CREDS = { promptId: 'p1', clientId: 'c1', worker: 'http://w1:8188' };

/** 构造完整帧文本流（enqueue 后即 close，模拟短帧序列） */
function sseResponse(frames: { event: string; data: string }[]) {
  const text = frames.map((f) => `event: ${f.event}\r\ndata: ${f.data}\r\n\r\n`).join('');
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(text));
        controller.close();
      },
    }),
    json: async () => ({}),
  };
}

/** 可控流：保持打开，测试手动推帧；abort/cancel 即结束（贴近长连接生产形状） */
function controllableResponse() {
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      ctrl = c;
    },
  });
  return {
    push(text: string) {
      ctrl.enqueue(encoder.encode(text));
    },
    response: {
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: stream,
      json: async () => ({}),
    },
  };
}

function frame(event: string, data: string): string {
  return `event: ${event}\r\ndata: ${data}\r\n\r\n`;
}

describe('streamJobEvents（M29.2 作业 SSE 消费层）', () => {
  beforeEach(async () => {
    mockExpoFetch.mockReset();
    jest.useFakeTimers();
    await setToken('tk-m29');
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('URL/请求头契约：client_id/worker/token query + Authorization + Accept', async () => {
    mockExpoFetch.mockResolvedValueOnce(sseResponse([{ event: 'done', data: '{"images":[]}' }]));
    const end = await streamJobEvents(CREDS, {});
    expect(end).toBe('done');
    const [url, init] = mockExpoFetch.mock.calls[0] as [
      string,
      { method: string; headers: Record<string, string> },
    ];
    expect(url).toBe(
      'https://api.test/api/jobs/p1/events?client_id=c1&worker=http%3A%2F%2Fw1%3A8188&token=tk-m29',
    );
    expect(init.method).toBe('GET');
    expect(init.headers.Accept).toBe('text/event-stream');
    expect(init.headers.Authorization).toBe('Bearer tk-m29');
  });

  it('progress 事件分派 value/max → pct；max<=0 不派发', async () => {
    mockExpoFetch.mockResolvedValueOnce(
      sseResponse([
        { event: 'progress', data: '{"value":0,"max":0}' },
        { event: 'progress', data: '{"value":3,"max":4}' },
        { event: 'done', data: '{"images":["/o/a.png"]}' },
      ]),
    );
    const progress: JobProgress[] = [];
    const end = await streamJobEvents(CREDS, { onProgress: (p) => progress.push(p) });
    expect(end).toBe('done');
    expect(progress).toEqual([{ value: 3, max: 4, pct: 75 }]);
  });

  it('done 事件：onDone 收产物 urls 并终态 resolve', async () => {
    mockExpoFetch.mockResolvedValueOnce(
      sseResponse([{ event: 'done', data: '{"images":["/o/a.png","/o/b.png"]}' }]),
    );
    const done: string[][] = [];
    const end = await streamJobEvents(CREDS, { onDone: (urls) => done.push(urls) });
    expect(end).toBe('done');
    expect(done).toEqual([['/o/a.png', '/o/b.png']]);
  });

  it('error 事件：onError 透传后端 message 并终态 resolve', async () => {
    mockExpoFetch.mockResolvedValueOnce(
      sseResponse([{ event: 'error', data: '{"message":"显存不足"}' }]),
    );
    const errors: string[] = [];
    const end = await streamJobEvents(CREDS, { onError: (m) => errors.push(m) });
    expect(end).toBe('error');
    expect(errors).toEqual(['显存不足']);
  });

  it('quality_warning 事件：onQualityWarning 透传载荷（不阻塞后续 done）', async () => {
    const warning: JobQualityWarning = {
      total: 0.5,
      quality_score: 50,
      aesthetic: 0.5,
      technical: 0.5,
      prompt_alignment: 0.5,
      issues: ['画面模糊'],
      suggested_prompt: null,
      degraded: false,
    };
    mockExpoFetch.mockResolvedValueOnce(
      sseResponse([
        { event: 'quality_warning', data: JSON.stringify(warning) },
        { event: 'done', data: '{"images":["/o/v.mp4"]}' },
      ]),
    );
    const warnings: JobQualityWarning[] = [];
    const end = await streamJobEvents(CREDS, { onQualityWarning: (w) => warnings.push(w) });
    expect(end).toBe('done');
    expect(warnings).toEqual([warning]);
  });

  it('单帧坏 JSON 跳过不中断，后续事件正常分派', async () => {
    mockExpoFetch.mockResolvedValueOnce(
      sseResponse([
        { event: 'progress', data: '{broken' },
        { event: 'progress', data: '{"value":1,"max":2}' },
        { event: 'done', data: '{"images":[]}' },
      ]),
    );
    const progress: JobProgress[] = [];
    const end = await streamJobEvents(CREDS, { onProgress: (p) => progress.push(p) });
    expect(end).toBe('done');
    expect(progress).toEqual([{ value: 1, max: 2, pct: 50 }]);
  });

  it.each([401, 403])('HTTP %i：onAuthError + 立即终止 resolve auth，不重连', async (status) => {
    mockExpoFetch.mockResolvedValueOnce({
      ok: false,
      status,
      headers: { get: () => null },
      body: null,
      json: async () => ({}),
    });
    const onAuthError = jest.fn();
    const end = await streamJobEvents(CREDS, { onAuthError });
    expect(end).toBe('auth');
    expect(onAuthError).toHaveBeenCalledTimes(1);
    expect(mockExpoFetch).toHaveBeenCalledTimes(1);
  });

  it('HTTP 500 连续失败超限 → fallback（指数外固定退避，默认上限 3 次）', async () => {
    mockExpoFetch.mockResolvedValue({
      ok: false,
      status: 500,
      headers: { get: () => null },
      body: null,
      json: async () => ({}),
    });
    const promise = streamJobEvents(CREDS, {});
    // 第 1 次失败 → 退避 1s → 第 2 次 → 退避 1s → 第 3 次 → 超限
    await jest.advanceTimersByTimeAsync(0);
    await jest.advanceTimersByTimeAsync(1_000);
    await jest.advanceTimersByTimeAsync(1_000);
    await expect(promise).resolves.toBe('fallback');
    expect(mockExpoFetch).toHaveBeenCalledTimes(3);
  });

  it('看门狗：streaming 阶段 60s 无事件 → 软重连（不计失败，持续保活）', async () => {
    mockExpoFetch
      .mockResolvedValueOnce(controllableResponse().response)
      .mockResolvedValueOnce(controllableResponse().response)
      .mockResolvedValueOnce(controllableResponse().response);
    const controller = new AbortController();
    const promise = streamJobEvents(CREDS, {}, { signal: controller.signal });
    await jest.advanceTimersByTimeAsync(0); // 第 1 连建立（streaming）
    expect(mockExpoFetch).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(60_000); // 看门狗触发 → 软重连
    expect(mockExpoFetch).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(60_000); // 再次软重连
    expect(mockExpoFetch).toHaveBeenCalledTimes(3);
    // 软重连不计失败 → 仍不 fallback；外部 abort 收尾
    controller.abort();
    await expect(promise).resolves.toBe('aborted');
  });

  it('看门狗：connecting 阶段挂死 → 计连接失败（超限 fallback）', async () => {
    // fetch 永不 resolve，仅 abort 时 reject（模拟连接挂死）
    mockExpoFetch.mockImplementation(
      (_url: string, init: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const promise = streamJobEvents(CREDS, {});
    await jest.advanceTimersByTimeAsync(0); // 第 1 次连接发起（connecting）
    await jest.advanceTimersByTimeAsync(60_000); // 看门狗 → 计失败 1 → 退避 1s
    await jest.advanceTimersByTimeAsync(1_000); // 第 2 次连接
    await jest.advanceTimersByTimeAsync(60_000); // 计失败 2 → 退避 1s
    await jest.advanceTimersByTimeAsync(1_000); // 第 3 次连接
    await jest.advanceTimersByTimeAsync(60_000); // 计失败 3 → 超限
    await expect(promise).resolves.toBe('fallback');
    expect(mockExpoFetch).toHaveBeenCalledTimes(3);
  });

  it('快照窗去重：重连 500ms 内相同负载丢弃，新负载透传，窗口外相同负载恢复透传', async () => {
    const s1 = controllableResponse();
    const s2 = controllableResponse();
    mockExpoFetch.mockResolvedValueOnce(s1.response).mockResolvedValueOnce(s2.response);
    const progress: JobProgress[] = [];
    const warnings: JobQualityWarning[] = [];
    const warning: JobQualityWarning = {
      total: 0.4,
      quality_score: 40,
      aesthetic: 0.4,
      technical: 0.4,
      prompt_alignment: 0.4,
      issues: [],
      suggested_prompt: null,
      degraded: false,
    };
    const promise = streamJobEvents(CREDS, {
      onProgress: (p) => progress.push(p),
      onQualityWarning: (w) => warnings.push(w),
    });
    await jest.advanceTimersByTimeAsync(0); // 第 1 连建立
    s1.push(frame('progress', '{"value":1,"max":10}'));
    s1.push(frame('quality_warning', JSON.stringify(warning)));
    await jest.advanceTimersByTimeAsync(0);
    expect(progress).toEqual([{ value: 1, max: 10, pct: 10 }]);
    expect(warnings).toHaveLength(1);

    await jest.advanceTimersByTimeAsync(60_000); // 看门狗软重连 → 第 2 连（臂快照窗 500ms）
    await jest.advanceTimersByTimeAsync(0);
    s2.push(frame('progress', '{"value":1,"max":10}')); // 窗内同负载 → 丢弃
    s2.push(frame('quality_warning', JSON.stringify(warning))); // 窗内同负载 → 丢弃
    s2.push(frame('progress', '{"value":2,"max":10}')); // 新负载 → 透传
    await jest.advanceTimersByTimeAsync(0);
    expect(progress).toEqual([
      { value: 1, max: 10, pct: 10 },
      { value: 2, max: 10, pct: 20 },
    ]);
    expect(warnings).toHaveLength(1);

    await jest.advanceTimersByTimeAsync(600); // 过窗
    s2.push(frame('progress', '{"value":2,"max":10}')); // 窗口外同负载 → 恢复透传
    s2.push(frame('done', '{"images":["/o/a.png"]}'));
    await jest.advanceTimersByTimeAsync(0);
    expect(progress).toHaveLength(3);
    await expect(promise).resolves.toBe('done');
  });

  it('开始前已 aborted：静默 resolve aborted，不发请求', async () => {
    const controller = new AbortController();
    controller.abort();
    const end = await streamJobEvents(CREDS, {}, { signal: controller.signal });
    expect(end).toBe('aborted');
    expect(mockExpoFetch).not.toHaveBeenCalled();
  });

  it('流中途外部 abort：静默 resolve aborted，不重连', async () => {
    mockExpoFetch.mockResolvedValueOnce(controllableResponse().response);
    const controller = new AbortController();
    const promise = streamJobEvents(CREDS, {}, { signal: controller.signal });
    await jest.advanceTimersByTimeAsync(0); // 连接建立
    controller.abort();
    await expect(promise).resolves.toBe('aborted');
    expect(mockExpoFetch).toHaveBeenCalledTimes(1);
  });
});
