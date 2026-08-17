/**
 * 对话助手纯函数层（M19.2）：UI 状态模型与后端契约的映射
 * - ChatItem：列表项载体（user 气泡 / assistant 气泡；assistant 承载流式累积的文本+工具过程+产物）
 * - reduceAgentEvent：单条 SSE 事件归并进 assistant 气泡（纯函数便于逐事件单测）
 * - historyForApi：ChatItem[] → POST /api/agent/chat messages（时间正序、仅 user/assistant 文本、≤40 条对齐后端上限）
 * - mapSessionMessages：GET /api/agent/sessions/{sid} messages → ChatItem[] 回放
 *   （tool 消息仅在有 media 时保留为产物气泡——过程消息回放省略，对齐 Web 会话回放的简洁语义）
 */
import type { AgentChatMessage, AgentEvent, AgentSessionMessage } from '@/types/api';

/** 产物媒体（type 对齐 AgentEvent 的 image/video/audio/model3d） */
export interface ChatMedia {
  type: string;
  urls: string[];
}

/** 挂载文档引用（M20）：发送时随 user 气泡留痕；后端消息不回放文档引用，仅本地轮次展示 */
export interface ChatDocRef {
  id: string;
  filename: string;
}

/**
 * 本轮附图引用（M30）：发送成功后转移到 user 气泡本地展示（本地 uri 缩略图）
 * 后端用户消息落库不含 attachment，会话回放历史气泡无图（契约现状），仅会话内本轮展示
 */
export interface ChatImageRef {
  previewUri: string;
  name: string;
}

export interface ChatItem {
  /** 本地列表 key（新消息 `local-<n>`；回放 `srv-<id>`） */
  id: string;
  /** 服务端消息 id（仅回放消息有值；M24「从此分叉」at_message_id 契约入参） */
  srvId?: number;
  role: 'user' | 'assistant';
  /** 文本内容（assistant 流式逐段累积，多段以 \n 分隔） */
  text: string;
  /** 工具产物（图片直显；video/audio/model3d 类型卡，对齐小程序 MP5 防破图语义） */
  media: ChatMedia[];
  /** 本轮挂载的文档（user 气泡下方 chips 留痕；发送后输入区 chips 清空转移至此） */
  docs?: ChatDocRef[];
  /** 本轮附图（M30，仅 user 气泡）：发送后输入区 chip 清空转移至此（本地 uri 展示） */
  image?: ChatImageRef;
  /** 本轮调用过的工具名（过程展示，如「正在调用 generate_image」） */
  tools: string[];
  /** error 事件 / 请求失败：人话进 text，标红展示 */
  error?: boolean;
  /** 流式进行中（tool 事件到达但本轮未闭合；done/异常/中止后清除） */
  streaming?: boolean;
}

/** 后端 messages 上限（routes/agent.py ChatRequest messages max_length=40） */
export const AGENT_HISTORY_LIMIT = 40;

/**
 * 单条 AgentEvent 归并进 assistant 气泡（不可变更新）
 * - text：多段以 \n 分隔追加（runner 每个 text 事件是一轮 LLM 的完整 content，非逐 token）
 * - tool：工具名入 tools（去重展示交给 UI，这里原样追加保留调用次序）
 * - image/video/audio/model3d：urls 非空才入 media
 * - error：标 error + 人话进 text（不落库的事件，仅本轮 UI 态）
 */
export function reduceAgentEvent(item: ChatItem, ev: AgentEvent): ChatItem {
  switch (ev.type) {
    case 'text': {
      const content = ev.content ?? '';
      if (!content) return item;
      return { ...item, text: item.text ? `${item.text}\n${content}` : content };
    }
    case 'tool': {
      const name = ev.name ?? '';
      if (!name) return item;
      return { ...item, tools: [...item.tools, name] };
    }
    case 'image':
    case 'video':
    case 'audio':
    case 'model3d': {
      if (!ev.urls || ev.urls.length === 0) return item;
      return { ...item, media: [...item.media, { type: ev.type, urls: ev.urls }] };
    }
    case 'error':
      return { ...item, error: true, text: ev.content ?? '出错了，请重试' };
    default:
      return item;
  }
}

/**
 * ChatItem[]（新→旧，inverted 列表序）→ API messages（旧→新 时间正序）
 * - 仅取 user/assistant 非空文本（tool 过程消息不进 LLM 上下文——无 tool_call_id 会破坏协议）
 * - error 项剔除（未落库、非模型可见）；截断到最近 40 条对齐后端上限
 */
export function historyForApi(items: ChatItem[]): AgentChatMessage[] {
  const chronological = [...items].reverse();
  const msgs: AgentChatMessage[] = [];
  for (const it of chronological) {
    if (it.error) continue;
    const content = it.text.trim();
    if (!content) continue;
    msgs.push({ role: it.role, content: it.text });
  }
  return msgs.slice(-AGENT_HISTORY_LIMIT);
}

/**
 * 会话详情 messages → ChatItem[] 回放（新→旧 inverted 列表序）
 * - user/assistant → 对应气泡（assistant 带 media 一并展示）
 * - tool：仅 media 非空时保留为 assistant 产物气泡（文本为空、media 来自 runner 落库的工具产物）
 */
export function mapSessionMessages(messages: AgentSessionMessage[]): ChatItem[] {
  const items: ChatItem[] = [];
  for (const m of messages) {
    if (m.role === 'user') {
      items.push({ id: `srv-${m.id}`, srvId: m.id, role: 'user', text: m.content, media: [], tools: [] });
    } else if (m.role === 'assistant') {
      items.push({
        id: `srv-${m.id}`,
        srvId: m.id,
        role: 'assistant',
        text: m.content,
        media: m.media ?? [],
        tools: [],
      });
    } else if (m.role === 'tool' && (m.media ?? []).length > 0) {
      items.push({ id: `srv-${m.id}`, srvId: m.id, role: 'assistant', text: '', media: m.media, tools: [] });
    }
  }
  return items.reverse();
}

/** 本地消息 id 生成（会话内自增即可，回放项走 srv- 前缀不冲突） */
let localSeq = 0;
export function nextLocalId(): string {
  localSeq += 1;
  return `local-${Date.now()}-${localSeq}`;
}
