import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

import { setApiBaseOverride } from '@/api/config';
import { setNsfwIntent, setToken } from '@/api/client';
import {
  ATTACHED_DOCS_MAX,
  imageStorageKey,
  toolActivityLabel,
  useAssistantStore,
} from '@/stores/assistant';
import type { AgentSessionDetail, AgentSessionSummary, DocItem } from '@/types/api';
import { getString } from '@/utils/storage';
import {
  allRequests,
  enqueueChunkedResponse,
  enqueueResponse,
  installMockUni,
  lastUpload,
  setUploadResult,
  uploadCallCount,
} from './helpers/mock-uni';

const encoder = new TextEncoder();

/** 一帧 msg 事件 SSE 文本 */
function msgFrame(payload: unknown): string {
  return `event: msg\ndata: ${JSON.stringify(payload)}\n\n`;
}
const DONE = 'event: done\ndata: {}\n\n';

beforeEach(() => {
  installMockUni();
  setActivePinia(createPinia());
  setToken(null);
  setApiBaseOverride(null);
  setNsfwIntent(false);
});

describe('send 流程', () => {
  it('落 user 气泡 + 流式占位；上行含历史+本轮；完成后 sessionId 回填', async () => {
    const store = useAssistantStore();
    // 旧会话上下文
    store.sessionId = 's0';
    store.messages = [
      { id: 'a', role: 'user', text: '上文', backendId: 1, media: [], docs: [], image: null, toolActivity: null, error: null, streaming: false },
      { id: 'b', role: 'assistant', text: '回复', backendId: 2, media: [], docs: [], image: null, toolActivity: null, error: null, streaming: false },
      // 纯媒体占位（空文本）不应上行
      { id: 'c', role: 'assistant', text: '', backendId: 3, media: [{ type: 'image', urls: ['/x.png'] }], docs: [], image: null, toolActivity: null, error: null, streaming: false },
    ];
    enqueueChunkedResponse({
      statusCode: 200,
      header: { 'X-Agent-Session-Id': 's0' },
      chunks: [msgFrame({ type: 'text', content: '好的' }), DONE],
    });
    enqueueResponse(200, []); // 完成后静默刷新会话列表

    store.send('再画一张');
    expect(store.sending).toBe(true);
    expect(store.messages).toHaveLength(5);
    expect(store.messages[3].role).toBe('user');
    expect(store.messages[4].streaming).toBe(true);

    await new Promise((r) => setTimeout(r, 30));
    const chat = allRequests().find((r) => r.url.includes('/api/agent/chat'));
    expect(chat?.data).toEqual({
      messages: [
        { role: 'user', content: '上文' },
        { role: 'assistant', content: '回复' },
        { role: 'user', content: '再画一张' },
      ],
      session_id: 's0',
    });
    expect(store.messages[4].text).toBe('好的');
    expect(store.messages[4].streaming).toBe(false);
    expect(store.sending).toBe(false);
    expect(store.sessionId).toBe('s0');
  });

  it('上行载荷：纯媒体占位（空文本）消息不上行', async () => {
    const store = useAssistantStore();
    store.messages = [
      { id: 'c', role: 'assistant', text: '', backendId: null, media: [{ type: 'image', urls: ['/x.png'] }], docs: [], image: null, toolActivity: null, error: null, streaming: false },
    ];
    enqueueChunkedResponse({ statusCode: 200, chunks: [DONE] });
    enqueueResponse(200, []);
    store.send('继续');
    await new Promise((r) => setTimeout(r, 30));
    const chat = allRequests().find((r) => r.url.includes('/api/agent/chat'));
    expect(chat?.data).toEqual({ messages: [{ role: 'user', content: '继续' }] });
  });

  it('流式事件：text 追加 / tool 活动条 / 媒体落块 / error 内联', async () => {
    const store = useAssistantStore();
    enqueueChunkedResponse({
      statusCode: 200,
      chunks: [
        msgFrame({ type: 'tool', name: 'generate_image' }),
        msgFrame({ type: 'image', urls: ['/files/a.png'], worker: 'w1' }),
        msgFrame({ type: 'text', content: '画好了' }),
        msgFrame({ type: 'error', content: '第二次生成失败' }),
        DONE,
      ],
    });
    enqueueResponse(200, []);
    store.send('画猫');
    await new Promise((r) => setTimeout(r, 30));
    const msg = store.messages[1];
    expect(msg.text).toBe('画好了');
    expect(msg.media).toEqual([{ type: 'image', urls: ['/files/a.png'] }]);
    expect(msg.error).toBe('第二次生成失败');
    expect(msg.toolActivity).toBeNull(); // 收尾清空
    expect(msg.streaming).toBe(false);
  });

  it('请求失败：错误内联到气泡，sending 复位', async () => {
    const store = useAssistantStore();
    enqueueChunkedResponse({ statusCode: 500, chunks: [] });
    store.send('hi');
    await new Promise((r) => setTimeout(r, 30));
    expect(store.messages[1].error).toBe('服务暂时不可用，请稍后重试');
    expect(store.messages[1].streaming).toBe(false);
    expect(store.sending).toBe(false);
  });

  it('停止生成：部分内容保留、无错误语义；空内容气泡移除', async () => {
    const store = useAssistantStore();
    enqueueChunkedResponse({
      statusCode: 200,
      chunks: [encoder.encode(`${msgFrame({ type: 'text', content: '半句' })}${DONE}`)],
    });
    store.send('hi');
    store.stop(); // 首块到达前停止 → 空内容气泡移除
    await new Promise((r) => setTimeout(r, 30));
    expect(store.messages).toHaveLength(1); // 仅剩 user 气泡
    expect(store.sending).toBe(false);
  });

  it('sending 中忽略重复发送', async () => {
    const store = useAssistantStore();
    enqueueChunkedResponse({ statusCode: 200, chunks: [DONE] });
    enqueueResponse(200, []);
    store.send('第一条');
    store.send('第二条');
    await new Promise((r) => setTimeout(r, 30));
    expect(store.messages.filter((m) => m.role === 'user')).toHaveLength(1);
  });
});

describe('会话管理', () => {
  it('newChat 清空上下文并中断流', async () => {
    const store = useAssistantStore();
    enqueueChunkedResponse({ statusCode: 200, chunks: [DONE] });
    store.send('hi');
    store.newChat();
    await new Promise((r) => setTimeout(r, 30));
    expect(store.messages).toEqual([]);
    expect(store.sessionId).toBeNull();
    expect(store.sending).toBe(false);
  });

  it('openSession：历史回放映射，tool 媒体并入前一条 assistant 气泡', async () => {
    const detail: AgentSessionDetail = {
      id: 's1',
      title: '画猫',
      nsfw: false,
      created_at: '2026-08-14T00:00:00',
      updated_at: '2026-08-14T01:00:00',
      message_count: 4,
      messages: [
        { id: 1, role: 'user', content: '画只猫', tool_calls: null, media: [], created_at: '' },
        { id: 2, role: 'assistant', content: '好的', tool_calls: null, media: [], created_at: '' },
        {
          id: 3,
          role: 'tool',
          content: '{}',
          tool_calls: null,
          media: [{ type: 'image', urls: ['/files/cat.png'] }],
          created_at: '',
        },
        { id: 4, role: 'tool', content: '{}', tool_calls: null, media: [], created_at: '' }, // 无媒体跳过
      ],
    };
    const store = useAssistantStore();
    enqueueResponse(200, detail);
    await store.openSession('s1');
    expect(store.sessionId).toBe('s1');
    expect(store.messages).toHaveLength(2);
    expect(store.messages[0].role).toBe('user');
    expect(store.messages[1].text).toBe('好的');
    expect(store.messages[1].media).toEqual([{ type: 'image', urls: ['/files/cat.png'] }]);
    expect(store.historyLoading).toBe(false);
  });

  it('removeSession：列表移除；删当前会话等价 newChat', async () => {
    const store = useAssistantStore();
    store.sessions = [
      {
        id: 's1',
        title: 'a',
        nsfw: false,
        created_at: '',
        updated_at: '',
        message_count: 0,
      },
    ];
    store.sessionId = 's1';
    store.messages = [
      { id: 'x', role: 'user', text: 'hi', backendId: null, media: [], docs: [], image: null, toolActivity: null, error: null, streaming: false },
    ];
    enqueueResponse(200, { ok: true });
    await store.removeSession('s1');
    expect(store.sessions).toEqual([]);
    expect(store.sessionId).toBeNull();
    expect(store.messages).toEqual([]);
  });

  it('refreshSessions 失败：错误语义入 sessionsError', async () => {
    const store = useAssistantStore();
    enqueueResponse(500, {});
    await store.refreshSessions();
    expect(store.sessionsError).toBe('服务暂时不可用，请稍后重试');
    expect(store.sessionsLoading).toBe(false);
  });
});

describe('toolActivityLabel', () => {
  it('已知工具映射人话，未知兜底原名', () => {
    expect(toolActivityLabel('generate_image')).toBe('正在生成图片…');
    expect(toolActivityLabel('generate_3d')).toBe('正在生成 3D 模型…');
    expect(toolActivityLabel('mystery_tool')).toBe('正在执行 mystery_tool…');
  });
});

// ── 文档挂载（MP20，语义对齐 Web lastDocIdsRef/retry 与 Mobile attachedDocs 快照）──

function makeDoc(id: string, filename = `${id}.pdf`): DocItem {
  return {
    id,
    filename,
    kind: 'pdf',
    size: 2048,
    chunk_count: 3,
    status: 'ready',
    created_at: '2026-08-14T00:00:00',
  };
}

describe('文档挂载（MP20）', () => {
  it('loadDocs 成功填充列表；失败入 docListError 不阻塞对话', async () => {
    const store = useAssistantStore();
    enqueueResponse(200, [makeDoc('d1'), makeDoc('d2')]);
    await store.loadDocs();
    expect(store.docList.map((d) => d.id)).toEqual(['d1', 'd2']);
    expect(store.docListLoading).toBe(false);

    enqueueResponse(500, {});
    await store.loadDocs();
    expect(store.docListError).toBe('服务暂时不可用，请稍后重试');
    expect(store.docListLoading).toBe(false);
  });

  it('toggleAttachDoc：挂载/再点卸载；上限 8 先验', () => {
    const store = useAssistantStore();
    const doc = makeDoc('d1');
    store.toggleAttachDoc(doc);
    expect(store.attachedDocs.map((d) => d.id)).toEqual(['d1']);
    store.toggleAttachDoc(doc); // 再点=卸载
    expect(store.attachedDocs).toEqual([]);

    for (let i = 0; i < ATTACHED_DOCS_MAX + 2; i += 1) {
      store.toggleAttachDoc(makeDoc(`dx${i}`));
    }
    expect(store.attachedDocs).toHaveLength(ATTACHED_DOCS_MAX);
  });

  it('detachDoc：按 id 移除挂载', () => {
    const store = useAssistantStore();
    store.attachedDocs = [makeDoc('d1'), makeDoc('d2')];
    store.detachDoc('d1');
    expect(store.attachedDocs.map((d) => d.id)).toEqual(['d2']);
  });

  it('send：document_ids 上行 + chips 清空 + user 气泡 docs 留痕', async () => {
    const store = useAssistantStore();
    store.attachedDocs = [makeDoc('d1', '需求文档.pdf'), makeDoc('d2', '接口约定.md')];
    enqueueChunkedResponse({ statusCode: 200, chunks: [DONE] });
    enqueueResponse(200, []);

    store.send('按这两份文档总结');
    expect(store.attachedDocs).toEqual([]); // chips 随发送清空
    const userMsg = store.messages[0];
    expect(userMsg.role).toBe('user');
    expect(userMsg.docs).toEqual([
      { id: 'd1', filename: '需求文档.pdf' },
      { id: 'd2', filename: '接口约定.md' },
    ]);

    await new Promise((r) => setTimeout(r, 30));
    const chat = allRequests().find((r) => r.url.includes('/api/agent/chat'));
    expect(chat?.data).toEqual({
      messages: [{ role: 'user', content: '按这两份文档总结' }],
      document_ids: ['d1', 'd2'],
    });
  });

  it('send：无挂载时上行不带 document_ids 字段，user 气泡 docs 为空', async () => {
    const store = useAssistantStore();
    enqueueChunkedResponse({ statusCode: 200, chunks: [DONE] });
    enqueueResponse(200, []);
    store.send('hi');
    await new Promise((r) => setTimeout(r, 30));
    const chat = allRequests().find((r) => r.url.includes('/api/agent/chat'));
    expect(chat?.data).toEqual({ messages: [{ role: 'user', content: 'hi' }] });
    expect(store.messages[0].docs).toEqual([]);
  });

  it('retry：摘末尾错误气泡重发，复用上轮 document_ids', async () => {
    const store = useAssistantStore();
    store.attachedDocs = [makeDoc('d1')];
    enqueueChunkedResponse({ statusCode: 500, chunks: [] }); // 首轮失败
    store.send('分析文档');
    await new Promise((r) => setTimeout(r, 30));
    expect(store.messages[1].error).toBe('服务暂时不可用，请稍后重试');

    enqueueChunkedResponse({
      statusCode: 200,
      chunks: [msgFrame({ type: 'text', content: '总结如下' }), DONE],
    });
    enqueueResponse(200, []);
    store.retry();
    expect(store.messages).toHaveLength(2); // 错误气泡摘除 + 新占位
    expect(store.messages[1].streaming).toBe(true);

    await new Promise((r) => setTimeout(r, 30));
    const chats = allRequests().filter((r) => r.url.includes('/api/agent/chat'));
    expect(chats).toHaveLength(2);
    expect(chats[1].data).toEqual({
      messages: [{ role: 'user', content: '分析文档' }],
      document_ids: ['d1'], // 复用上轮挂载
    });
    expect(store.messages[1].text).toBe('总结如下');
    expect(store.messages[1].error).toBeNull();
  });

  it('retry：末尾非错误气泡（正常完成）不重试', async () => {
    const store = useAssistantStore();
    enqueueChunkedResponse({
      statusCode: 200,
      chunks: [msgFrame({ type: 'text', content: 'done' }), DONE],
    });
    enqueueResponse(200, []);
    store.send('hi');
    await new Promise((r) => setTimeout(r, 30));
    const before = allRequests().filter((r) => r.url.includes('/api/agent/chat')).length;
    store.retry();
    await new Promise((r) => setTimeout(r, 30));
    const after = allRequests().filter((r) => r.url.includes('/api/agent/chat')).length;
    expect(after).toBe(before); // 未发起新请求
  });

  it('uploadAndAttach：201 后插列表头 + 自动挂载；失败 docUploading 复位并抛错', async () => {
    const store = useAssistantStore();
    store.docList = [makeDoc('d0')];
    setUploadResult(201, makeDoc('d9', '新文档.pdf'));
    await store.uploadAndAttach('/tmp/新文档.pdf');
    expect(store.docList.map((d) => d.id)).toEqual(['d9', 'd0']);
    expect(store.attachedDocs.map((d) => d.id)).toEqual(['d9']);
    expect(store.docUploading).toBe(false);

    setUploadResult(413, { detail: 'too large' });
    await expect(store.uploadAndAttach('/tmp/big.pdf')).rejects.toThrow();
    expect(store.docUploading).toBe(false);
    expect(store.docList.map((d) => d.id)).toEqual(['d9', 'd0']); // 列表未被污染
  });

  it('removeDoc：列表与挂载同步移除', async () => {
    const store = useAssistantStore();
    store.docList = [makeDoc('d1'), makeDoc('d2')];
    store.attachedDocs = [makeDoc('d1'), makeDoc('d2')];
    enqueueResponse(200, { ok: true });
    await store.removeDoc('d1');
    expect(store.docList.map((d) => d.id)).toEqual(['d2']);
    expect(store.attachedDocs.map((d) => d.id)).toEqual(['d2']);
    const req = allRequests().find((r) => r.url.includes('/api/docs/d1'));
    expect(req?.method).toBe('DELETE');
  });

  it('newChat：清空挂载与上轮文档快照（retry 不再带 document_ids）', async () => {
    const store = useAssistantStore();
    store.attachedDocs = [makeDoc('d1')];
    enqueueChunkedResponse({ statusCode: 500, chunks: [] });
    store.send('hi');
    await new Promise((r) => setTimeout(r, 30));

    store.newChat();
    expect(store.attachedDocs).toEqual([]);

    // newChat 后手动铺一条错误气泡走 retry：上轮快照已清，不带 document_ids
    store.messages = [
      { id: 'u', role: 'user', text: 'hi', backendId: null, media: [], docs: [], image: null, toolActivity: null, error: null, streaming: false },
      { id: 'a', role: 'assistant', text: '', backendId: null, media: [], docs: [], toolActivity: null, error: '失败', streaming: false },
    ];
    enqueueChunkedResponse({ statusCode: 200, chunks: [DONE] });
    enqueueResponse(200, []);
    store.retry();
    await new Promise((r) => setTimeout(r, 30));
    const chats = allRequests().filter((r) => r.url.includes('/api/agent/chat'));
    expect(chats[chats.length - 1].data).toEqual({
      messages: [{ role: 'user', content: 'hi' }],
    });
  });
});

// ── 分叉会话（MP24，契约读 apps/api routes/agent.py fork_agent_session 源码确认）──

function makeSummary(id: string, title = `会话${id}`, messageCount = 4): AgentSessionSummary {
  return {
    id,
    title,
    nsfw: false,
    created_at: '2026-08-14T00:00:00',
    updated_at: '2026-08-14T01:00:00',
    message_count: messageCount,
  };
}

function makeDetail(id: string, messageCount: number): AgentSessionDetail {
  const rows = Array.from({ length: messageCount }, (_, i) => ({
    id: i + 1,
    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    content: `消息${i + 1}`,
    tool_calls: null,
    media: [],
    created_at: '',
  }));
  return { ...makeSummary(id, `会话${id}`, messageCount), messages: rows };
}

describe('分叉会话（MP24）', () => {
  it('forkSession 全量：空 body 上行，新会话插列表头并打开回放', async () => {
    const store = useAssistantStore();
    store.sessions = [makeSummary('s1')];
    enqueueResponse(200, makeSummary('s2', '会话s1', 4)); // POST /fork
    enqueueResponse(200, makeDetail('s2', 4)); // openSession GET

    await store.forkSession('s1');

    const forkReq = allRequests().find((r) => r.url.includes('/fork'));
    expect(forkReq?.method).toBe('POST');
    expect(forkReq?.url).toContain('/api/agent/sessions/s1/fork');
    expect(forkReq?.data).toBeUndefined();
    expect(store.sessions.map((s) => s.id)).toEqual(['s2', 's1']); // 新会话即时可见
    expect(store.sessionId).toBe('s2');
    expect(store.messages).toHaveLength(4);
    expect(store.historyLoading).toBe(false);
  });

  it('forkSession 截断：atMessageId 上行 {at_message_id}', async () => {
    const store = useAssistantStore();
    enqueueResponse(200, makeSummary('s3', '会话s1', 2));
    enqueueResponse(200, makeDetail('s3', 2));

    await store.forkSession('s1', 2);

    const forkReq = allRequests().find((r) => r.url.includes('/fork'));
    expect(forkReq?.data).toEqual({ at_message_id: 2 });
    expect(store.sessionId).toBe('s3');
    expect(store.messages).toHaveLength(2);
  });

  it('forkSession 失败：人话抛错由页面 toast，列表不污染', async () => {
    const store = useAssistantStore();
    store.sessions = [makeSummary('s1')];
    enqueueResponse(404, { detail: '消息不存在' });
    await expect(store.forkSession('s1', 999)).rejects.toThrow('资源不存在或已被清理');
    expect(store.sessions.map((s) => s.id)).toEqual(['s1']);
  });

  it('sending 中拒绝分叉（不发起请求）', async () => {
    const store = useAssistantStore();
    enqueueChunkedResponse({ statusCode: 200, chunks: [DONE] });
    enqueueResponse(200, []);
    store.send('hi');
    expect(store.sending).toBe(true);
    await store.forkSession('s1');
    expect(allRequests().filter((r) => r.url.includes('/fork'))).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 30));
  });
});

describe('openSession backendId 映射（MP24）', () => {
  it('user/assistant 行落 backendId；tool 媒体并入时气泡 backendId 取 tool 行 id', async () => {
    const detail: AgentSessionDetail = {
      ...makeSummary('s1', '画猫', 4),
      messages: [
        { id: 11, role: 'user', content: '画只猫', tool_calls: null, media: [], created_at: '' },
        { id: 12, role: 'assistant', content: '好的', tool_calls: null, media: [], created_at: '' },
        {
          id: 13,
          role: 'tool',
          content: '{}',
          tool_calls: null,
          media: [{ type: 'image', urls: ['/files/cat.png'] }],
          created_at: '',
        },
        { id: 14, role: 'assistant', content: '收尾', tool_calls: null, media: [], created_at: '' },
      ],
    };
    const store = useAssistantStore();
    enqueueResponse(200, detail);
    await store.openSession('s1');
    expect(store.messages.map((m) => m.backendId)).toEqual([11, 13, 14]);
    // 本地新建消息无后端 id（消息级分叉仅回放消息可用）
    expect(store.messages.every((m) => m.backendId !== null)).toBe(true);
  });
});

// ── 输入草稿持久化（MP24：assistant_draft:{sid} / 新会话 __new__，防抖 300ms）──
describe('输入草稿持久化（MP24）', () => {
  it('saveDraft 防抖落盘 / loadDraft 读取 / clearDraft 移除', async () => {
    const store = useAssistantStore();
    store.saveDraft('草稿甲', 's1');
    expect(store.loadDraft('s1')).toBe(''); // 防抖窗口内未落盘
    await new Promise((r) => setTimeout(r, 400));
    expect(store.loadDraft('s1')).toBe('草稿甲');
    store.clearDraft('s1');
    expect(store.loadDraft('s1')).toBe('');
  });

  it('按会话隔离：s1/s2/新会话（null → __new__）互不污染', async () => {
    const store = useAssistantStore();
    store.saveDraft('甲会话', 's1');
    store.saveDraft('乙会话', 's2');
    store.saveDraft('新会话', null);
    await new Promise((r) => setTimeout(r, 400));
    expect(store.loadDraft('s1')).toBe('甲会话');
    expect(store.loadDraft('s2')).toBe('乙会话');
    expect(store.loadDraft(null)).toBe('新会话');
    store.clearDraft('s1');
    expect(store.loadDraft('s1')).toBe('');
    expect(store.loadDraft('s2')).toBe('乙会话'); // 清 s1 不动 s2
    expect(store.loadDraft(null)).toBe('新会话');
  });

  it('空文本写入等价清除；flushDraft 立即落盘', async () => {
    const store = useAssistantStore();
    store.saveDraft('待清', 's1');
    store.flushDraft(); // 切换会话前防丢：立即落盘不等防抖
    expect(store.loadDraft('s1')).toBe('待清');
    store.saveDraft('', 's1');
    store.flushDraft();
    expect(store.loadDraft('s1')).toBe('');
  });

  it('clearDraft 取消待写防抖（旧文本不回魂）', async () => {
    const store = useAssistantStore();
    store.saveDraft('旧草稿', 's1');
    store.clearDraft('s1'); // 防抖未 firing 前清除
    await new Promise((r) => setTimeout(r, 400));
    expect(store.loadDraft('s1')).toBe('');
  });

  it('send 立即清空当前会话草稿键（默认取 sessionId）', async () => {
    const store = useAssistantStore();
    store.sessionId = 's1';
    store.saveDraft('待发内容', 's1');
    store.flushDraft();
    expect(store.loadDraft('s1')).toBe('待发内容');

    enqueueChunkedResponse({ statusCode: 200, chunks: [DONE] });
    enqueueResponse(200, []);
    store.send('待发内容');
    expect(store.loadDraft('s1')).toBe(''); // 发送即清，不等流式完成
    await new Promise((r) => setTimeout(r, 30));
  });

  it('saveDraft 省略 sid 取当前会话', async () => {
    const store = useAssistantStore();
    store.sessionId = 's9';
    store.saveDraft('当前会话草稿');
    store.flushDraft();
    expect(store.loadDraft('s9')).toBe('当前会话草稿');
    expect(store.loadDraft(null)).toBe(''); // 未落 __new__
  });
});

// ── 对话助手附图（MP30：选图 → uploadImage(img2img) → chip → image={filename,worker} 上行）──
describe('对话助手附图（MP30）', () => {
  const READY_A = { previewUri: '/tmp/a.png', status: 'ready', filename: 'a.png', worker: 'w1' };

  /** attach 并成功上传一张图（返回时 chip ready） */
  async function attachReady(store: ReturnType<typeof useAssistantStore>, path = '/tmp/a.png') {
    setUploadResult(200, { filename: 'a.png', worker: 'w1' });
    await store.attachAndUploadImage(path);
  }

  it('attachAndUploadImage：uploading → ready，uploadFile kind=img2img，ready 句柄落草稿键', async () => {
    const store = useAssistantStore();
    setUploadResult(200, { filename: 'a.png', worker: 'w1' });
    const p = store.attachAndUploadImage('/tmp/a.png');
    // mock uploadFile 同步成功，ready 落帧在微任务：同步窗口内仍是 uploading
    expect(store.attachedImage).toEqual({
      previewUri: '/tmp/a.png',
      status: 'uploading',
      filename: '',
      worker: '',
    });
    await p;
    expect(store.attachedImage).toEqual(READY_A);
    expect(lastUpload().url).toContain('/api/upload');
    expect(lastUpload().url).toContain('kind=img2img');
    expect(lastUpload().filePath).toBe('/tmp/a.png');
    expect(getString(imageStorageKey(null))).toBe(
      JSON.stringify({ filename: 'a.png', worker: 'w1', previewUri: '/tmp/a.png' }),
    );
  });

  it('替换语义：ready chip 再选直接覆盖（不确认）；新图 ready 后草稿键改写', async () => {
    const store = useAssistantStore();
    await attachReady(store);
    expect(store.attachedImage).toEqual(READY_A);

    setUploadResult(200, { filename: 'b.png', worker: 'w1' });
    await store.attachAndUploadImage('/tmp/b.png');
    expect(store.attachedImage).toEqual({
      previewUri: '/tmp/b.png',
      status: 'ready',
      filename: 'b.png',
      worker: 'w1',
    });
    expect(getString(imageStorageKey(null))).toContain('b.png');
  });

  it('竞态：上传中被替换，旧图迟到回调不得覆盖新 chip', async () => {
    const store = useAssistantStore();
    setUploadResult(200, { filename: 'a.png', worker: 'w1' });
    const p1 = store.attachAndUploadImage('/tmp/a.png');
    setUploadResult(200, { filename: 'b.png', worker: 'w1' });
    const p2 = store.attachAndUploadImage('/tmp/b.png'); // 替换：旧上传回调失效
    await p1;
    await p2;
    expect(store.attachedImage).toEqual({
      previewUri: '/tmp/b.png',
      status: 'ready',
      filename: 'b.png',
      worker: 'w1',
    });
    expect(getString(imageStorageKey(null))).toContain('b.png');
  });

  it('detachImage：chip 清空 + 草稿键移除', async () => {
    const store = useAssistantStore();
    await attachReady(store);
    store.detachImage();
    expect(store.attachedImage).toBeNull();
    expect(getString(imageStorageKey(null))).toBeNull();
  });

  it('上传失败：chip 清空并抛错（页面 toast）；草稿键不留', async () => {
    const store = useAssistantStore();
    setUploadResult(413, { detail: 'too large' });
    await expect(store.attachAndUploadImage('/tmp/big.png')).rejects.toThrow();
    expect(store.attachedImage).toBeNull();
    expect(getString(imageStorageKey(null))).toBeNull();
  });

  it('send 带图：请求体 image={filename,worker} + chip 清空 + user 气泡附图预览 + 草稿键清除', async () => {
    const store = useAssistantStore();
    await attachReady(store);
    enqueueChunkedResponse({ statusCode: 200, chunks: [DONE] });
    enqueueResponse(200, []);

    store.send('把这张图改成夜景');
    expect(store.attachedImage).toBeNull(); // chip 随发送清空
    expect(getString(imageStorageKey(null))).toBeNull(); // 草稿键同步清
    const userMsg = store.messages[0];
    expect(userMsg.image).toEqual({ previewUri: '/tmp/a.png' }); // 本会话气泡本地留痕

    await new Promise((r) => setTimeout(r, 30));
    const chat = allRequests().find((r) => r.url.includes('/api/agent/chat'));
    expect(chat?.data).toEqual({
      messages: [{ role: 'user', content: '把这张图改成夜景' }],
      image: { filename: 'a.png', worker: 'w1' },
    });
  });

  it('send 无图：请求体不带 image 字段，气泡 image 为 null', async () => {
    const store = useAssistantStore();
    enqueueChunkedResponse({ statusCode: 200, chunks: [DONE] });
    enqueueResponse(200, []);
    store.send('hi');
    await new Promise((r) => setTimeout(r, 30));
    const chat = allRequests().find((r) => r.url.includes('/api/agent/chat'));
    expect(chat?.data).toEqual({ messages: [{ role: 'user', content: 'hi' }] });
    expect(store.messages[0].image).toBeNull();
  });

  it('send：附图上传中禁发（store 层与页面 canSend 同律）', async () => {
    const store = useAssistantStore();
    setUploadResult(200, { filename: 'a.png', worker: 'w1' });
    const p = store.attachAndUploadImage('/tmp/a.png'); // 同步窗口内 chip 仍 uploading
    expect(store.attachedImage?.status).toBe('uploading');
    store.send('hi');
    expect(store.messages).toHaveLength(0); // 未落 user 气泡
    expect(allRequests().filter((r) => r.url.includes('/api/agent/chat'))).toHaveLength(0);
    await p;
  });

  it('retry：复用上轮 image 句柄重发', async () => {
    const store = useAssistantStore();
    await attachReady(store);
    enqueueChunkedResponse({ statusCode: 500, chunks: [] }); // 首轮失败
    store.send('改成夜景');
    await new Promise((r) => setTimeout(r, 30));
    expect(store.messages[1].error).toBe('服务暂时不可用，请稍后重试');

    enqueueChunkedResponse({
      statusCode: 200,
      chunks: [msgFrame({ type: 'text', content: '改好了' }), DONE],
    });
    enqueueResponse(200, []);
    store.retry();
    await new Promise((r) => setTimeout(r, 30));
    const chats = allRequests().filter((r) => r.url.includes('/api/agent/chat'));
    expect(chats).toHaveLength(2);
    expect(chats[1].data).toEqual({
      messages: [{ role: 'user', content: '改成夜景' }],
      image: { filename: 'a.png', worker: 'w1' }, // 复用上轮附图
    });
    expect(store.messages[1].text).toBe('改好了');
  });

  it('切会话：附图草稿按会话隔离——s2 无图，回 s1 恢复 ready 不重复上传', async () => {
    const store = useAssistantStore();
    store.sessionId = 's1';
    await attachReady(store);
    expect(uploadCallCount()).toBe(1);

    enqueueResponse(200, makeDetail('s2', 2));
    await store.openSession('s2');
    expect(store.attachedImage).toBeNull(); // s2 无附图草稿

    enqueueResponse(200, makeDetail('s1', 2));
    await store.openSession('s1');
    expect(store.attachedImage).toEqual(READY_A); // 恢复 ready 句柄直接用
    expect(uploadCallCount()).toBe(1); // 恢复不重复上传
  });

  it('newChat：未发送附图按 __new__ 草稿保留（对齐文本草稿语义）；上轮 retry 快照清空', async () => {
    const store = useAssistantStore();
    await attachReady(store); // sessionId null → __new__ 键
    store.newChat();
    expect(store.attachedImage).toEqual(READY_A); // 未发送附图不丢

    // 上轮失败轮次的 image 快照随 newChat 清空：retry 不再带 image
    store.detachImage();
    await attachReady(store);
    enqueueChunkedResponse({ statusCode: 500, chunks: [] });
    store.send('hi');
    await new Promise((r) => setTimeout(r, 30));
    store.newChat();
    expect(store.attachedImage).toBeNull(); // 发送即清草稿键，newChat 无可恢复
    store.messages = [
      { id: 'u', role: 'user', text: 'hi', backendId: null, media: [], docs: [], image: null, toolActivity: null, error: null, streaming: false },
      { id: 'a', role: 'assistant', text: '', backendId: null, media: [], docs: [], image: null, toolActivity: null, error: '失败', streaming: false },
    ];
    enqueueChunkedResponse({ statusCode: 200, chunks: [DONE] });
    enqueueResponse(200, []);
    store.retry();
    await new Promise((r) => setTimeout(r, 30));
    const chats = allRequests().filter((r) => r.url.includes('/api/agent/chat'));
    expect(chats[chats.length - 1].data).toEqual({
      messages: [{ role: 'user', content: 'hi' }],
    });
  });
});
