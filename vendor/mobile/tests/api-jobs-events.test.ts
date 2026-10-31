import { beforeEach, describe, expect, it } from 'vitest';

import { streamJobEvents } from '@/api';
import { setToken } from '@/api/client';
import { setApiBaseOverride } from '@/api/config';
import type { JobSseEvent } from '@/types/api';
import {
  enqueueChunkedResponse,
  installMockUni,
  lastRequest,
  setChunkedError,
} from './helpers/mock-uni';

beforeEach(() => {
  installMockUni();
  setToken(null);
  setApiBaseOverride(null);
});

describe('streamJobEvents（GET /api/jobs/{prompt_id}/events，MP29）', () => {
  it('请求构造：GET + client_id/worker query 编码 + SSE 头 + Bearer 同源注入', async () => {
    setToken('t1');
    enqueueChunkedResponse({ statusCode: 200, chunks: [] });
    const { promise } = streamJobEvents('p/1', { clientId: 'c 1', worker: 'w/1' }, () => undefined);
    await promise;
    const req = lastRequest();
    expect(req.method).toBe('GET');
    expect(req.url).toContain('/api/jobs/p%2F1/events');
    expect(req.url).toContain('client_id=c%201');
    expect(req.url).toContain('worker=w%2F1');
    expect(req.header.Accept).toBe('text/event-stream');
    expect(req.header.Authorization).toBe('Bearer t1');
  });

  it('无 token 时不带 Authorization 头', async () => {
    enqueueChunkedResponse({ statusCode: 200, chunks: [] });
    const { promise } = streamJobEvents('p1', { clientId: 'c1', worker: 'w1' }, () => undefined);
    await promise;
    expect(lastRequest().header.Authorization).toBeUndefined();
  });

  it('progress/done/error/quality_warning 四类事件逐帧分派', async () => {
    enqueueChunkedResponse({
      statusCode: 200,
      chunks: [
        'event: progress\ndata: {"value":3,"max":10}\n\n',
        'event: quality_warning\ndata: {"quality_score":41,"issues":["画面模糊"]}\n\n',
        'event: done\ndata: {"images":["outputs/a.png"]}\n\n',
      ],
    });
    const events: JobSseEvent[] = [];
    const { promise } = streamJobEvents('p1', { clientId: 'c1', worker: 'w1' }, (e) =>
      events.push(e),
    );
    await promise;
    expect(events).toEqual([
      { type: 'progress', data: { value: 3, max: 10 } },
      { type: 'quality_warning', data: { quality_score: 41, issues: ['画面模糊'] } },
      { type: 'done', data: { images: ['outputs/a.png'] } },
    ]);
  });

  it('error 事件载荷原样上抛（message 字段）', async () => {
    enqueueChunkedResponse({
      statusCode: 200,
      chunks: ['event: error\ndata: {"message":"CUDA OOM"}\n\n'],
    });
    const events: JobSseEvent[] = [];
    const { promise } = streamJobEvents('p1', { clientId: 'c1', worker: 'w1' }, (e) =>
      events.push(e),
    );
    await promise;
    expect(events).toEqual([{ type: 'error', data: { message: 'CUDA OOM' } }]);
  });

  it('未知事件名容错忽略', async () => {
    enqueueChunkedResponse({
      statusCode: 200,
      chunks: [
        'event: ping\ndata: {}\n\n',
        'event: progress\ndata: {"value":1,"max":4}\n\n',
      ],
    });
    const events: JobSseEvent[] = [];
    const { promise } = streamJobEvents('p1', { clientId: 'c1', worker: 'w1' }, (e) =>
      events.push(e),
    );
    await promise;
    expect(events).toEqual([{ type: 'progress', data: { value: 1, max: 4 } }]);
  });

  it('畸形 JSON / 非对象载荷跳过，流不中断', async () => {
    enqueueChunkedResponse({
      statusCode: 200,
      chunks: [
        'event: progress\ndata: {坏掉的\n\n',
        'event: progress\ndata: [1,2]\n\n',
        'event: done\ndata: {"images":[]}\n\n',
      ],
    });
    const events: JobSseEvent[] = [];
    const { promise } = streamJobEvents('p1', { clientId: 'c1', worker: 'w1' }, (e) =>
      events.push(e),
    );
    await promise;
    expect(events).toEqual([{ type: 'done', data: { images: [] } }]);
  });

  it('跨块分帧：事件被切成两块推送仍可解析（UTF-8 跨块）', async () => {
    const encoder = new TextEncoder();
    const full = 'event: progress\ndata: {"value":5,"max":8,"note":"雨夜"}\n\n';
    const bytes = encoder.encode(full);
    // 在多字节字符中间切开，验证自研 UTF-8 增量解码跨块挂起
    const cut = bytes.length - 8;
    enqueueChunkedResponse({
      statusCode: 200,
      chunks: [bytes.slice(0, cut), bytes.slice(cut)],
    });
    const events: JobSseEvent[] = [];
    const { promise } = streamJobEvents('p1', { clientId: 'c1', worker: 'w1' }, (e) =>
      events.push(e),
    );
    await promise;
    expect(events).toEqual([{ type: 'progress', data: { value: 5, max: 8, note: '雨夜' } }]);
  });

  it('401 立即按人话体系 reject（跟踪层据此回退轮询，不重连）', async () => {
    enqueueChunkedResponse({ statusCode: 401, chunks: [] });
    const { promise } = streamJobEvents('p1', { clientId: 'c1', worker: 'w1' }, () => undefined);
    await expect(promise).rejects.toMatchObject({ status: 401, message: '登录已过期，请重新登录' });
  });

  it('403 按人话体系 reject', async () => {
    enqueueChunkedResponse({ statusCode: 403, chunks: [] });
    const { promise } = streamJobEvents('p1', { clientId: 'c1', worker: 'w1' }, () => undefined);
    await expect(promise).rejects.toMatchObject({ status: 403, message: '没有权限执行此操作' });
  });

  it('abort 以「已停止监听」reject', async () => {
    enqueueChunkedResponse({
      statusCode: 200,
      chunks: ['event: progress\ndata: {"value":1,"max":2}\n\n'],
    });
    const handle = streamJobEvents(
      'p1',
      { clientId: 'c1', worker: 'w1' },
      () => handle.abort(),
    );
    await expect(handle.promise).rejects.toMatchObject({ message: '已停止监听' });
  });

  it('网络失败 reject', async () => {
    setChunkedError('request:fail ssl hand shake error');
    const { promise } = streamJobEvents('p1', { clientId: 'c1', worker: 'w1' }, () => undefined);
    await expect(promise).rejects.toMatchObject({ message: '网络连接失败，请检查网络' });
  });

  it('超时 reject', async () => {
    setChunkedError('request:fail timeout');
    const { promise } = streamJobEvents('p1', { clientId: 'c1', worker: 'w1' }, () => undefined);
    await expect(promise).rejects.toMatchObject({ message: '请求超时，请检查网络后重试' });
  });

  it('onOpen 在 2xx 响应头到达时触发，非 2xx 不触发', async () => {
    let opened = 0;
    enqueueChunkedResponse({ statusCode: 200, chunks: [] });
    const ok = streamJobEvents('p1', { clientId: 'c1', worker: 'w1' }, () => undefined, () => {
      opened += 1;
    });
    await ok.promise;
    expect(opened).toBe(1);

    enqueueChunkedResponse({ statusCode: 403, chunks: [] });
    const bad = streamJobEvents('p1', { clientId: 'c1', worker: 'w1' }, () => undefined, () => {
      opened += 1;
    });
    await expect(bad.promise).rejects.toMatchObject({ status: 403 });
    expect(opened).toBe(1);
  });
});
