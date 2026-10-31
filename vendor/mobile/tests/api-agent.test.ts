import { beforeEach, describe, expect, it } from 'vitest';

import {
  agentChatStream,
  deleteAgentSession,
  forkAgentSession,
  getAgentSession,
  listAgentSessions,
  STREAM_TIMEOUT_MS,
} from '@/api';
import { setApiBaseOverride } from '@/api/config';
import { LONG_TIMEOUT_MS, setNsfwIntent, setToken } from '@/api/client';
import type { AgentEvent, AgentSessionDetail, AgentSessionSummary } from '@/types/api';
import {
  enqueueChunkedResponse,
  enqueueResponse,
  installMockUni,
  lastRequest,
  setChunkedError,
} from './helpers/mock-uni';

beforeEach(() => {
  installMockUni();
  setToken(null);
  setApiBaseOverride(null);
  setNsfwIntent(false);
});

describe('agentChatStream 请求构造', () => {
  it('POST /api/agent/chat：messages 原样、SSE 头、token 同源注入', async () => {
    setToken('t1');
    enqueueChunkedResponse({ statusCode: 200, chunks: ['event: done\ndata: {}\n\n'] });
    const { promise } = agentChatStream(
      { messages: [{ role: 'user', content: '画只猫' }] },
      () => undefined,
    );
    await promise;
    const req = lastRequest();
    expect(req.method).toBe('POST');
    expect(req.url).toContain('/api/agent/chat');
    expect(req.data).toEqual({ messages: [{ role: 'user', content: '画只猫' }] });
    expect(req.header.Accept).toBe('text/event-stream');
    expect(req.header['Content-Type']).toBe('application/json');
    expect(req.header.Authorization).toBe('Bearer t1');
  });

  it('续聊携带 session_id；NSFW 意图注入 X-NSFW', async () => {
    setNsfwIntent(true);
    enqueueChunkedResponse({ statusCode: 200, chunks: ['event: done\ndata: {}\n\n'] });
    const { promise } = agentChatStream(
      { messages: [{ role: 'user', content: '再来一张' }], sessionId: 's9' },
      () => undefined,
    );
    await promise;
    expect(lastRequest().data).toEqual({
      messages: [{ role: 'user', content: '再来一张' }],
      session_id: 's9',
    });
    expect(lastRequest().header['X-NSFW']).toBe('1');
  });

  it('MP30：附图上行 image={filename,worker}，可与 document_ids 同发', async () => {
    enqueueChunkedResponse({ statusCode: 200, chunks: ['event: done\ndata: {}\n\n'] });
    const { promise } = agentChatStream(
      {
        messages: [{ role: 'user', content: '把这张图改成夜景' }],
        documentIds: ['d1'],
        image: { filename: 'cat.png', worker: 'w1' },
      },
      () => undefined,
    );
    await promise;
    expect(lastRequest().data).toEqual({
      messages: [{ role: 'user', content: '把这张图改成夜景' }],
      document_ids: ['d1'],
      image: { filename: 'cat.png', worker: 'w1' },
    });
  });

  it('MP30：无附图时请求体不带 image 字段', async () => {
    enqueueChunkedResponse({ statusCode: 200, chunks: ['event: done\ndata: {}\n\n'] });
    const { promise } = agentChatStream({ messages: [{ role: 'user', content: 'hi' }] }, () => undefined);
    await promise;
    expect(lastRequest().data).toEqual({ messages: [{ role: 'user', content: 'hi' }] });
  });
});

describe('agentChatStream 事件流', () => {
  it('msg 帧逐事件解析上抛，done 帧不上抛', async () => {
    enqueueChunkedResponse({
      statusCode: 200,
      chunks: [
        'event: msg\ndata: {"type":"text","content":"正在"}\n\n',
        'event: msg\ndata: {"type":"image","urls":["/files/a.png"],"worker":"w1"}\n\n',
        'event: done\ndata: {}\n\n',
      ],
    });
    const events: AgentEvent[] = [];
    const { promise } = agentChatStream(
      { messages: [{ role: 'user', content: 'hi' }] },
      (e) => events.push(e),
    );
    await promise;
    expect(events).toEqual([
      { type: 'text', content: '正在' },
      { type: 'image', urls: ['/files/a.png'], worker: 'w1' },
    ]);
  });

  it('帧跨块切割（含多字节字符）完整重组', async () => {
    const encoder = new TextEncoder();
    const full = encoder.encode('event: msg\ndata: {"type":"text","content":"你好呀"}\n\nevent: done\ndata: {}\n\n');
    enqueueChunkedResponse({
      statusCode: 200,
      chunks: [full.subarray(0, 21), full.subarray(21)],
    });
    const events: AgentEvent[] = [];
    const { promise } = agentChatStream(
      { messages: [{ role: 'user', content: 'hi' }] },
      (e) => events.push(e),
    );
    await promise;
    expect(events).toEqual([{ type: 'text', content: '你好呀' }]);
  });

  it('未知事件名忽略、畸形 JSON 帧跳过，流不中断', async () => {
    enqueueChunkedResponse({
      statusCode: 200,
      chunks: [
        'event: ping\ndata: {}\n\nevent: msg\ndata: {坏掉的\n\nevent: msg\ndata: {"type":"text","content":"ok"}\n\nevent: done\ndata: {}\n\n',
      ],
    });
    const events: AgentEvent[] = [];
    const { promise } = agentChatStream(
      { messages: [{ role: 'user', content: 'hi' }] },
      (e) => events.push(e),
    );
    await promise;
    expect(events).toEqual([{ type: 'text', content: 'ok' }]);
  });

  it('error 事件原样上抛（UI 展示后端错误语义）', async () => {
    enqueueChunkedResponse({
      statusCode: 200,
      chunks: ['event: msg\ndata: {"type":"error","content":"生成失败：队列已满"}\n\nevent: done\ndata: {}\n\n'],
    });
    const events: AgentEvent[] = [];
    const { promise } = agentChatStream(
      { messages: [{ role: 'user', content: 'hi' }] },
      (e) => events.push(e),
    );
    await promise;
    expect(events).toEqual([{ type: 'error', content: '生成失败：队列已满' }]);
  });

  it('X-Agent-Session-Id 响应头大小写不敏感解析', async () => {
    enqueueChunkedResponse({
      statusCode: 200,
      header: { 'X-Agent-Session-Id': 's1' },
      chunks: ['event: done\ndata: {}\n\n'],
    });
    const { promise } = agentChatStream(
      { messages: [{ role: 'user', content: 'hi' }] },
      () => undefined,
    );
    await expect(promise).resolves.toEqual({ sessionId: 's1' });
  });

  it('缺 session 头兜底为 null', async () => {
    enqueueChunkedResponse({ statusCode: 200, chunks: ['event: done\ndata: {}\n\n'] });
    const { promise } = agentChatStream(
      { messages: [{ role: 'user', content: 'hi' }] },
      () => undefined,
    );
    await expect(promise).resolves.toEqual({ sessionId: null });
  });
});

describe('agentChatStream 异常路径', () => {
  it('非 2xx：按人话体系 reject（401 → 登录过期）', async () => {
    enqueueChunkedResponse({ statusCode: 401, chunks: [] });
    const { promise } = agentChatStream(
      { messages: [{ role: 'user', content: 'hi' }] },
      () => undefined,
    );
    await expect(promise).rejects.toMatchObject({
      status: 401,
      message: '登录已过期，请重新登录',
    });
  });

  it('abort：以「已停止生成」reject，后续块不再派发', async () => {
    enqueueChunkedResponse({
      statusCode: 200,
      chunks: [
        'event: msg\ndata: {"type":"text","content":"一"}\n\n',
        'event: msg\ndata: {"type":"text","content":"二"}\n\n',
      ],
    });
    const events: AgentEvent[] = [];
    const handle = agentChatStream(
      { messages: [{ role: 'user', content: 'hi' }] },
      (e) => {
        events.push(e);
        handle.abort(); // 收到首事件即停止
      },
    );
    await expect(handle.promise).rejects.toMatchObject({ message: '已停止生成' });
    expect(events).toEqual([{ type: 'text', content: '一' }]);
  });

  it('网络失败：reject 网络连接失败', async () => {
    setChunkedError('request:fail ssl hand shake error');
    const { promise } = agentChatStream(
      { messages: [{ role: 'user', content: 'hi' }] },
      () => undefined,
    );
    await expect(promise).rejects.toMatchObject({ message: '网络连接失败，请检查网络' });
  });

  it('超时：reject 请求超时', async () => {
    setChunkedError('request:fail timeout');
    const { promise } = agentChatStream(
      { messages: [{ role: 'user', content: 'hi' }] },
      () => undefined,
    );
    await expect(promise).rejects.toMatchObject({ message: '请求超时，请检查网络后重试' });
  });

  it('SSE 整段超时用 10 分钟，不是 JSON 长任务 180s', async () => {
    enqueueChunkedResponse({ statusCode: 200, chunks: ['event: done\ndata: {}\n\n'] });
    const { promise } = agentChatStream(
      { messages: [{ role: 'user', content: 'hi' }] },
      () => undefined,
    );
    await promise;
    expect(lastRequest().timeout).toBe(STREAM_TIMEOUT_MS);
    expect(STREAM_TIMEOUT_MS).toBe(600_000);
    expect(STREAM_TIMEOUT_MS).not.toBe(LONG_TIMEOUT_MS);
  });
});

describe('会话管理端点', () => {
  const summary: AgentSessionSummary = {
    id: 's1',
    title: '画猫',
    nsfw: false,
    created_at: '2026-08-14T00:00:00',
    updated_at: '2026-08-14T01:00:00',
    message_count: 4,
  };

  it('listAgentSessions：GET /api/agent/sessions', async () => {
    enqueueResponse(200, [summary]);
    const list = await listAgentSessions();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe('s1');
    expect(lastRequest().method).toBe('GET');
    expect(lastRequest().url).toContain('/api/agent/sessions');
  });

  it('getAgentSession：路径 id 编码', async () => {
    const detail: AgentSessionDetail = { ...summary, messages: [] };
    enqueueResponse(200, detail);
    const got = await getAgentSession('s/1');
    expect(got.messages).toEqual([]);
    expect(lastRequest().url).toContain('/api/agent/sessions/s%2F1');
  });

  it('deleteAgentSession：DELETE /api/agent/sessions/{sid}', async () => {
    enqueueResponse(200, { ok: true });
    await deleteAgentSession('s1');
    expect(lastRequest().method).toBe('DELETE');
    expect(lastRequest().url).toContain('/api/agent/sessions/s1');
  });

  it('他人会话 404：按人话体系 reject', async () => {
    enqueueResponse(404, { detail: '会话不存在' });
    await expect(getAgentSession('sx')).rejects.toMatchObject({
      status: 404,
      message: '资源不存在或已被清理',
    });
  });
});

// ── 分叉会话（MP24，契约读 apps/api routes/agent.py fork_agent_session 源码确认）──
describe('forkAgentSession', () => {
  const forked: AgentSessionSummary = {
    id: 's2',
    title: '画猫',
    nsfw: false,
    created_at: '2026-08-15T00:00:00',
    updated_at: '2026-08-15T00:00:00',
    message_count: 2,
  };

  it('全量 fork：POST /fork 空 body（不带 Content-Type）', async () => {
    enqueueResponse(200, forked);
    const got = await forkAgentSession('s1');
    expect(got).toEqual(forked);
    const req = lastRequest();
    expect(req.method).toBe('POST');
    expect(req.url).toContain('/api/agent/sessions/s1/fork');
    expect(req.data).toBeUndefined();
    expect(req.header['Content-Type']).toBeUndefined();
  });

  it('截断 fork：body 带 {at_message_id}，sid 路径编码', async () => {
    enqueueResponse(200, forked);
    await forkAgentSession('s/1', 7);
    const req = lastRequest();
    expect(req.url).toContain('/api/agent/sessions/s%2F1/fork');
    expect(req.data).toEqual({ at_message_id: 7 });
    expect(req.header['Content-Type']).toBe('application/json');
  });

  it('at_message_id 不在会话内 404：按人话体系 reject', async () => {
    enqueueResponse(404, { detail: '消息不存在' });
    await expect(forkAgentSession('s1', 999)).rejects.toMatchObject({
      status: 404,
      message: '资源不存在或已被清理',
    });
  });
});
