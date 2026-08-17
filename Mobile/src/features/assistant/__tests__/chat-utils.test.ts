import {
  AGENT_HISTORY_LIMIT,
  historyForApi,
  mapSessionMessages,
  nextLocalId,
  reduceAgentEvent,
} from '../chat-utils';
import type { ChatItem } from '../chat-utils';
import type { AgentSessionMessage } from '@/types/api';

function makeItem(overrides: Partial<ChatItem>): ChatItem {
  return { id: 'x', role: 'assistant', text: '', media: [], tools: [], ...overrides };
}

describe('reduceAgentEvent（M19.2 单事件归并）', () => {
  it('text：空气泡直写；已有文本多段以 \\n 分隔', () => {
    const a = reduceAgentEvent(makeItem({}), { type: 'text', content: '好的' });
    expect(a.text).toBe('好的');
    const b = reduceAgentEvent(a, { type: 'text', content: '已生成' });
    expect(b.text).toBe('好的\n已生成');
  });

  it('text：空 content 不改动（防御缺省字段）', () => {
    const it = makeItem({ text: 'keep' });
    expect(reduceAgentEvent(it, { type: 'text' })).toBe(it);
    expect(reduceAgentEvent(it, { type: 'text', content: '' })).toBe(it);
  });

  it('tool：工具名按调用次序入列；无名跳过', () => {
    const a = reduceAgentEvent(makeItem({}), { type: 'tool', name: 'generate_image' });
    expect(a.tools).toEqual(['generate_image']);
    const b = reduceAgentEvent(a, { type: 'tool', name: 'search_knowledge' });
    expect(b.tools).toEqual(['generate_image', 'search_knowledge']);
    expect(reduceAgentEvent(b, { type: 'tool' })).toBe(b);
  });

  it('image/video/audio/model3d：urls 非空才入 media', () => {
    const a = reduceAgentEvent(makeItem({}), { type: 'image', urls: ['/m/a.png'] });
    expect(a.media).toEqual([{ type: 'image', urls: ['/m/a.png'] }]);
    const b = reduceAgentEvent(a, { type: 'video', urls: ['/m/v.mp4', '/m/v2.mp4'] });
    expect(b.media).toHaveLength(2);
    expect(reduceAgentEvent(b, { type: 'audio' })).toBe(b);
    expect(reduceAgentEvent(b, { type: 'model3d', urls: [] })).toBe(b);
  });

  it('error：标红 + 人话进 text；content 缺失走默认文案', () => {
    const a = reduceAgentEvent(makeItem({}), { type: 'error', content: 'LLM 层全部不可用' });
    expect(a.error).toBe(true);
    expect(a.text).toBe('LLM 层全部不可用');
    const b = reduceAgentEvent(makeItem({}), { type: 'error' });
    expect(b.text).toBe('出错了，请重试');
  });
});

describe('historyForApi（M19.2 上下文构造）', () => {
  it('inverted 列表序（新→旧）→ 时间正序；error/空文本剔除', () => {
    const items: ChatItem[] = [
      makeItem({ id: '4', role: 'assistant', text: '' }), // 流式占位空文本
      makeItem({ id: '3', role: 'user', text: '再来一张' }),
      makeItem({ id: '2', role: 'assistant', text: '网络异常', error: true }),
      makeItem({ id: '1', role: 'user', text: '画一只猫' }),
    ];
    expect(historyForApi(items)).toEqual([
      { role: 'user', content: '画一只猫' },
      { role: 'user', content: '再来一张' },
    ]);
  });

  it('截断到最近 40 条（后端 ChatRequest messages 上限）', () => {
    // items 新→旧：m0 最新 … m49 最旧；正序后 [m49…m0]，slice(-40) 保留最近 40 条
    const items: ChatItem[] = Array.from({ length: 50 }, (_, i) =>
      makeItem({ id: String(i), role: i % 2 === 0 ? 'user' : 'assistant', text: `m${i}` }),
    );
    const msgs = historyForApi(items);
    expect(msgs).toHaveLength(AGENT_HISTORY_LIMIT);
    expect(msgs[0].content).toBe('m39'); // 正序 [m49…m0] 的第 10 位
    expect(msgs[msgs.length - 1].content).toBe('m0'); // 最新一条恒保留
  });
});

describe('mapSessionMessages（M19.2 会话回放）', () => {
  const row = (overrides: Partial<AgentSessionMessage>): AgentSessionMessage => ({
    id: 1,
    role: 'user',
    content: '',
    tool_calls: null,
    media: [],
    created_at: '2026-08-14T10:00:00',
    ...overrides,
  });

  it('user/assistant 直映；tool 仅 media 非空保留为产物气泡；输出 inverted 序', () => {
    const items = mapSessionMessages([
      row({ id: 1, role: 'user', content: '画猫' }),
      row({ id: 2, role: 'assistant', content: '好的', }),
      row({ id: 3, role: 'tool', content: 'raw result', media: [{ type: 'image', urls: ['/m/a.png'] }] }),
      row({ id: 4, role: 'tool', content: 'no media' }), // 过程消息回放省略
      row({ id: 5, role: 'assistant', content: '已完成', media: [{ type: 'image', urls: ['/m/a.png'] }] }),
    ]);
    expect(items.map((i) => i.id)).toEqual(['srv-5', 'srv-3', 'srv-2', 'srv-1']);
    expect(items[3]).toMatchObject({ role: 'user', text: '画猫' });
    expect(items[1]).toMatchObject({ role: 'assistant', text: '', media: [{ type: 'image', urls: ['/m/a.png'] }] });
    expect(items[0]).toMatchObject({ role: 'assistant', text: '已完成' });
  });

  it('media 缺省字段防御（undefined → []）', () => {
    const items = mapSessionMessages([
      row({ id: 1, role: 'assistant', content: 'x', media: undefined as unknown as [] }),
    ]);
    expect(items[0].media).toEqual([]);
  });
});

describe('nextLocalId', () => {
  it('自增唯一（同毫秒内不冲突）', () => {
    const ids = new Set([nextLocalId(), nextLocalId(), nextLocalId()]);
    expect(ids.size).toBe(3);
  });
});
