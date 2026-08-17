/**
 * 对话助手 store（MP19，非持久化：会话列表拉后端，消息随流式事件增量构建）
 * - 消息为 UI 模型：text 事件追加文本、image/video/audio/model3d 事件落媒体、
 *   tool 事件更新「正在执行」活动条、error 事件内联错误语义
 * - 发送时把历史压缩为 {role, content} 序列（空文本媒体占位消息不上行）
 * - 停止生成 = abort 底层分块请求，已产出部分内容保留
 * - 文档挂载（MP20，对齐 Web/Mobile 语义）：面板列表 docList + 挂载 chips attachedDocs；
 *   发送时 document_ids 随 chat 上行、chips 清空转移到 user 气泡留痕（后端不回放文档引用，
 *   仅本地轮次展示）；retry 摘掉末尾错误气泡重发，复用上轮挂载的 lastDocIds
 * - 分叉会话（MP24）：forkSession 全量/截断复制源会话生成新会话并打开；回放消息落
 *   backendId（tool 媒体并入时取 tool 行 id）供消息级「从此分叉」定位 at_message_id
 * - 输入草稿（MP24）：按 sessionId 持久化（assistant_draft:{sid}，新会话 __new__），
 *   防抖 300ms 写存储；send 即清当前键；切换会话前 flushDraft 防丢
 * - 用户附图（MP30）：选图即 uploadImage(kind=img2img) 得 {filename,worker}，输入栏 chip
 *   （uploading/ready，单图替换语义）；发送随 chat 上行 image 字段、chip 清空并转移到 user
 *   气泡本地留痕（后端用户消息落库不含 attachment，回放无图为契约现状）；ready 句柄按会话
 *   键持久化（assistant_image:{sid}），切换/新建会话恢复不重复上传；上传中禁发（页面
 *   canSend 与 send 防守同律）；retry 复用上轮 lastImage 快照
 */
import { defineStore } from 'pinia';

import {
  agentChatStream,
  deleteAgentSession,
  deleteDoc,
  forkAgentSession,
  getAgentSession,
  listAgentSessions,
  listDocs,
  uploadDoc,
  uploadImage,
  type AgentChatStreamHandle,
} from '@/api';
import type {
  AgentChatImage,
  AgentChatMessage,
  AgentEvent,
  AgentSessionSummary,
  DocItem,
} from '@/types/api';
import {
  attachImageState,
  buildChatImage,
  canSendWithImage,
  failImageState,
  parseImageDraft,
  readyImageState,
  serializeImageDraft,
  type AttachedImage,
} from '@/utils/assistant-image';
import { getString, remove, setString } from '@/utils/storage';

/** 媒体结果块（image/video/audio/model3d 事件或历史 tool 消息产出） */
export interface ChatMedia {
  type: string;
  urls: string[];
}

/** user 气泡文档留痕（仅 id+filename 摘要，后端不回放文档引用） */
export interface AttachedDocRef {
  id: string;
  filename: string;
}

/** user 气泡附图留痕（MP30，仅本地 previewUri；后端用户消息落库不含 attachment，回放无图） */
export interface ChatMessageImage {
  previewUri: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  /** 已确认文本（text 事件逐段追加） */
  text: string;
  /**
   * 后端消息 id（仅历史回放落；本地流式轮次为 null）
   * 消息级「从此分叉」以它为 at_message_id；tool 媒体并入气泡时取 tool 行 id（含该媒体）
   */
  backendId: number | null;
  media: ChatMedia[];
  /** 本轮挂载文档摘要（user 气泡 chips 留痕；assistant 恒空数组） */
  docs: AttachedDocRef[];
  /** 本轮用户附图本地预览（user 气泡上图；assistant/回放消息恒 null） */
  image: ChatMessageImage | null;
  /** 正在执行的工具名（streaming 中展示活动条） */
  toolActivity: string | null;
  /** 内联错误语义（error 事件或请求失败） */
  error: string | null;
  streaming: boolean;
}

/** 工具名 → 活动条人话（未知工具兜底原名，runner.py 工具注册表对齐） */
const TOOL_LABELS: Record<string, string> = {
  generate_image: '正在生成图片…',
  edit_image: '正在编辑图片…',
  generate_video: '正在生成视频…',
  generate_3d: '正在生成 3D 模型…',
  generate_audio: '正在生成音频…',
  search_knowledge: '正在查平台知识库…',
};

export function toolActivityLabel(name: string): string {
  return TOOL_LABELS[name] ?? `正在执行 ${name}…`;
}

let seq = 0;
function nextId(): string {
  seq += 1;
  return `m${seq}`;
}

function makeMessage(role: ChatMessage['role']): ChatMessage {
  return {
    id: nextId(),
    role,
    text: '',
    backendId: null,
    media: [],
    docs: [],
    image: null,
    toolActivity: null,
    error: null,
    streaming: false,
  };
}

/** 已停止生成的 reject 语义（api 层 abort 固定文案），停止不算错误 */
const STOPPED_MESSAGE = '已停止生成';

/** 单轮挂载文档上限（agent.py ChatRequest document_ids ≤8 硬上限，客户端先验） */
export const ATTACHED_DOCS_MAX = 8;

// ── 输入草稿持久化（MP24）──

/** 草稿存储键前缀（assistant_draft:{sid}；新会话未落库用 __new__） */
const DRAFT_PREFIX = 'assistant_draft:';
export const DRAFT_NEW_KEY = '__new__';
/** 防抖写存储时长（输入高频，避免逐键击写 uni storage） */
export const DRAFT_DEBOUNCE_MS = 300;

/** 草稿存储键（sid null = 新会话草稿） */
export function draftStorageKey(sid: string | null): string {
  return `${DRAFT_PREFIX}${sid ?? DRAFT_NEW_KEY}`;
}

/** 防抖状态（模块级非响应式：按存储键攒批，同键后写覆盖先写、异键不互丢） */
let draftTimer: ReturnType<typeof setTimeout> | null = null;
const draftPending = new Map<string, string>();

/** 落盘：空文本等价清除（不留空键） */
function writeDraft(key: string, text: string) {
  if (text) setString(key, text);
  else remove(key);
}

/** 待写批次全部落盘并清空 */
function drainDrafts() {
  if (draftPending.size === 0) return;
  const entries = [...draftPending.entries()];
  draftPending.clear();
  for (const [key, text] of entries) writeDraft(key, text);
}

// ── 用户附图持久化（MP30：ready 句柄随会话键落盘，对齐草稿隔离语义）──

/** 附图草稿存储键前缀（assistant_image:{sid}；新会话未落库用 __new__） */
const IMAGE_PREFIX = 'assistant_image:';

/** 附图草稿存储键（sid null = 新会话附图草稿） */
export function imageStorageKey(sid: string | null): string {
  return `${IMAGE_PREFIX}${sid ?? DRAFT_NEW_KEY}`;
}

/** 读取会话附图草稿（无/畸形 → null；恢复即 ready 不重复上传） */
function loadImageChip(sid: string | null): AttachedImage | null {
  const raw = getString(imageStorageKey(sid));
  return raw ? parseImageDraft(raw) : null;
}

interface AssistantState {
  sessions: AgentSessionSummary[];
  sessionsLoading: boolean;
  sessionsError: string;
  /** 当前会话 id（新会话为 null，首轮流式响应头回填） */
  sessionId: string | null;
  messages: ChatMessage[];
  sending: boolean;
  /** 历史载入态（打开旧会话回放） */
  historyLoading: boolean;
  /** 文档面板列表（MP20：进页加载一次，上传/删除后局部更新） */
  docList: DocItem[];
  docListLoading: boolean;
  docListError: string;
  /** 文档上传中（面板上传钮 loading，防重复提交） */
  docUploading: boolean;
  /** 已挂载文档（输入栏上方 chips 数据源；发送时清空转移到 user 气泡） */
  attachedDocs: DocItem[];
  /** 用户附图 chip（MP30，单图；发送时清空转移到 user 气泡本地留痕） */
  attachedImage: AttachedImage | null;
}

/** 进行中的流句柄（同一时刻仅一轮对话；非响应式，模块级持有防 Proxy 包裹） */
let activeHandle: AgentChatStreamHandle | null = null;

/** 上轮挂载的文档 id（retry 复用；非响应式，跟随发送轮次快照） */
let lastDocIds: string[] = [];

/** 上轮附图句柄（retry 复用；非响应式，跟随发送轮次快照） */
let lastImage: AgentChatImage | null = null;

/** 附图世代号（attach/detach/send/切换会话递增；上传迟到回调世代不一致即丢弃） */
let imageEpoch = 0;

export const useAssistantStore = defineStore('assistant', {
  state: (): AssistantState => ({
    sessions: [],
    sessionsLoading: false,
    sessionsError: '',
    sessionId: null,
    messages: [],
    sending: false,
    historyLoading: false,
    docList: [],
    docListLoading: false,
    docListError: '',
    docUploading: false,
    attachedDocs: [],
    attachedImage: null,
  }),

  getters: {
    /** 上行载荷：仅带实际文本的消息（纯媒体占位 assistant 消息 content 为空不上行） */
    payload(state): AgentChatMessage[] {
      return state.messages
        .filter((m) => m.text.trim() !== '')
        .map((m) => ({ role: m.role, content: m.text }));
    },
  },

  actions: {
    async refreshSessions() {
      this.sessionsLoading = true;
      this.sessionsError = '';
      try {
        this.sessions = await listAgentSessions();
      } catch (err) {
        this.sessionsError = err instanceof Error ? err.message : '加载失败';
      } finally {
        this.sessionsLoading = false;
      }
    },

    /** 新对话：中断进行中的流，清空上下文与文档挂载；未发送附图按 __new__ 草稿恢复 */
    newChat() {
      activeHandle?.abort();
      activeHandle = null;
      this.sending = false;
      this.sessionId = null;
      this.messages = [];
      this.attachedDocs = [];
      lastDocIds = [];
      lastImage = null;
      imageEpoch += 1; // 进行中的上传回调失效（旧会话上下文不污染新会话）
      this.attachedImage = loadImageChip(null);
    },

    /** 打开旧会话：拉回放消息映射为 UI 模型（tool 消息媒体并入前一条 assistant 气泡） */
    async openSession(sid: string) {
      if (this.sending) return;
      this.historyLoading = true;
      try {
        const detail = await getAgentSession(sid);
        this.sessionId = detail.id;
        imageEpoch += 1; // 切换会话：旧会话进行中的上传回调丢弃（瞬态不入草稿）
        this.attachedImage = loadImageChip(detail.id); // 附图草稿按会话隔离恢复
        const messages: ChatMessage[] = [];
        for (const row of detail.messages) {
          if (row.role === 'user') {
            const msg = makeMessage('user');
            msg.text = row.content;
            msg.backendId = row.id;
            messages.push(msg);
          } else if (row.role === 'assistant') {
            const msg = makeMessage('assistant');
            msg.text = row.content;
            msg.backendId = row.id;
            messages.push(msg);
          } else if (row.role === 'tool') {
            if (row.media.length === 0) continue;
            let target = [...messages].reverse().find((m) => m.role === 'assistant');
            if (!target) {
              target = makeMessage('assistant');
              messages.push(target);
            }
            for (const media of row.media) {
              target.media.push({ type: media.type, urls: media.urls });
            }
            // 气泡含该 tool 产出：分叉定位取 tool 行 id（截断含这条媒体消息）
            target.backendId = row.id;
          }
        }
        this.messages = messages;
      } finally {
        this.historyLoading = false;
      }
    },

    async removeSession(sid: string) {
      await deleteAgentSession(sid);
      this.sessions = this.sessions.filter((s) => s.id !== sid);
      if (this.sessionId === sid) this.newChat();
    },

    /**
     * 分叉会话（MP24）：复制源会话（atMessageId 非空则截断到该消息含）生成新会话并打开
     * 新会话继承源标题、updated_at 最新 → 插列表头即时可见；失败抛错由页面 toast
     */
    async forkSession(sid: string, atMessageId?: number) {
      if (this.sending) return;
      const forked = await forkAgentSession(sid, atMessageId);
      this.sessions = [forked, ...this.sessions];
      await this.openSession(forked.id);
    },

    /**
     * 发送一轮：本地先落 user 气泡（含挂载文档留痕 + 附图本地预览）+ assistant 流式占位，再启动 SSE
     * 挂载 chips/附图 chip 随发送清空（转移到 user 气泡）；lastDocIds/lastImage 快照供 retry 复用
     * 附图上传中禁发（与页面 canSend 同律的 store 层防守，行为以测试钉死）
     */
    send(content: string) {
      const text = content.trim();
      if (!text || this.sending) return;
      if (!canSendWithImage(this.attachedImage)) return;

      this.clearDraft(); // 发送即清当前会话草稿（文本已进 user 气泡）

      const roundDocs = this.attachedDocs;
      this.attachedDocs = [];
      lastDocIds = roundDocs.map((d) => d.id);

      const roundImage = this.attachedImage;
      this.attachedImage = null;
      imageEpoch += 1;
      remove(imageStorageKey(this.sessionId)); // 附图草稿键随发送清除
      lastImage = buildChatImage(roundImage);

      const userMsg = makeMessage('user');
      userMsg.text = text;
      userMsg.docs = roundDocs.map((d) => ({ id: d.id, filename: d.filename }));
      if (roundImage) userMsg.image = { previewUri: roundImage.previewUri };
      this.messages = [...this.messages, userMsg];

      this._startRound(lastDocIds, lastImage);
    },

    /**
     * 重试：摘掉末尾错误气泡，重发上一条用户消息所在的对话（复用上轮挂载文档与附图）
     * 对齐 Web retry 语义；末尾非错误气泡（正常完成/停止）不重试
     */
    retry() {
      if (this.sending) return;
      const last = this.messages[this.messages.length - 1];
      if (!last || last.role !== 'assistant' || !last.error) return;
      this.messages = this.messages.slice(0, -1);
      this._startRound(lastDocIds, lastImage);
    },

    /** 启动一轮流式对话：assistant 占位 + SSE（send/retry 公共路径） */
    _startRound(docIds: string[], image: AgentChatImage | null) {
      const assistantMsg = makeMessage('assistant');
      assistantMsg.streaming = true;
      this.messages = [...this.messages, assistantMsg];
      this.sending = true;

      // 占位 assistant 空文本已被 payload 过滤，上行即「历史 + 本轮 user」
      const params: {
        messages: AgentChatMessage[];
        sessionId?: string;
        documentIds?: string[];
        image?: AgentChatImage;
      } = {
        messages: this.payload,
      };
      if (this.sessionId) params.sessionId = this.sessionId;
      if (docIds.length > 0) params.documentIds = docIds;
      if (image) params.image = image;

      const handle = agentChatStream(params, (event) => this._applyEvent(assistantMsg.id, event));
      activeHandle = handle;
      handle.promise
        .then((result) => {
          if (result.sessionId) this.sessionId = result.sessionId;
          this._finish(assistantMsg.id, null);
          void this.refreshSessions(); // 标题/时间后端已更新，静默刷新列表
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : '请求失败，请重试';
          this._finish(assistantMsg.id, message === STOPPED_MESSAGE ? null : message);
        });
    },

    /** 停止生成：中断流，已产出内容保留 */
    stop() {
      activeHandle?.abort();
    },

    // ── 输入草稿（MP24）──

    /** 读取会话草稿（无草稿返回空串；sid 省略取当前会话） */
    loadDraft(sid?: string | null): string {
      const key = draftStorageKey(sid === undefined ? this.sessionId : sid);
      return getString(key) ?? '';
    },

    /** 保存草稿（防抖 300ms 写存储，空文本等价清除；sid 省略取当前会话） */
    saveDraft(text: string, sid?: string | null) {
      const key = draftStorageKey(sid === undefined ? this.sessionId : sid);
      draftPending.set(key, text);
      if (draftTimer) clearTimeout(draftTimer);
      draftTimer = setTimeout(() => {
        draftTimer = null;
        drainDrafts();
      }, DRAFT_DEBOUNCE_MS);
    },

    /** 立即落盘待写草稿（切换会话/页面隐藏前调用防丢） */
    flushDraft() {
      if (draftTimer) {
        clearTimeout(draftTimer);
        draftTimer = null;
      }
      drainDrafts();
    },

    /** 清除会话草稿（同键待写一并取消，防旧文本回魂；sid 省略取当前会话） */
    clearDraft(sid?: string | null) {
      const key = draftStorageKey(sid === undefined ? this.sessionId : sid);
      draftPending.delete(key);
      remove(key);
    },

    // ── 文档挂载（MP20）──

    /** 文档面板列表：进面板加载一次；失败不阻塞对话，面板内可重试 */
    async loadDocs() {
      this.docListLoading = true;
      this.docListError = '';
      try {
        this.docList = await listDocs();
      } catch (err) {
        this.docListError = err instanceof Error ? err.message : '加载失败';
      } finally {
        this.docListLoading = false;
      }
    },

    /** 面板列表项点按：挂载/卸载切换（已挂载再点=卸载；上限 8 对齐后端硬上限） */
    toggleAttachDoc(doc: DocItem) {
      if (this.attachedDocs.some((d) => d.id === doc.id)) {
        this.attachedDocs = this.attachedDocs.filter((d) => d.id !== doc.id);
        return;
      }
      if (this.attachedDocs.length >= ATTACHED_DOCS_MAX) return;
      this.attachedDocs = [...this.attachedDocs, doc];
    },

    /** chips 行 X 移除 / 删除挂载中文档后卸载 */
    detachDoc(docId: string) {
      this.attachedDocs = this.attachedDocs.filter((d) => d.id !== docId);
    },

    /**
     * 上传并挂载：201 后新文档插列表头（created_at 倒序）+ 自动挂载（未满上限时）
     * 失败抛错由页面 toast；docUploading 防重复提交
     */
    async uploadAndAttach(filePath: string) {
      if (this.docUploading) return;
      this.docUploading = true;
      try {
        const doc = await uploadDoc(filePath);
        this.docList = [doc, ...this.docList];
        if (this.attachedDocs.length < ATTACHED_DOCS_MAX) {
          this.attachedDocs = [...this.attachedDocs, doc];
        }
      } finally {
        this.docUploading = false;
      }
    },

    /** 删除文档：列表与挂载同步移除（后端元数据+落盘原文/索引一并清理） */
    async removeDoc(docId: string) {
      await deleteDoc(docId);
      this.docList = this.docList.filter((d) => d.id !== docId);
      this.attachedDocs = this.attachedDocs.filter((d) => d.id !== docId);
    },

    // ── 用户附图（MP30）──

    /**
     * 选图即传：chip 立即进入 uploading（替换语义，单图），uploadImage(kind=img2img) 成功转
     * ready 并把句柄按会话键落盘（切换/新建会话恢复直接用不重复上传）；失败清 chip 并抛错
     * 由页面 toast。世代号防竞态：上传中被替换/移除/切会话/发送，迟到回调直接丢弃
     */
    async attachAndUploadImage(previewUri: string) {
      imageEpoch += 1;
      const epoch = imageEpoch;
      this.attachedImage = attachImageState(previewUri);
      try {
        const result = await uploadImage(previewUri, 'img2img');
        if (epoch !== imageEpoch) return;
        this.attachedImage = readyImageState(this.attachedImage, previewUri, result);
        const raw = serializeImageDraft(this.attachedImage);
        if (raw) setString(imageStorageKey(this.sessionId), raw);
      } catch (err) {
        if (epoch !== imageEpoch) return;
        this.attachedImage = failImageState(this.attachedImage, previewUri);
        throw err;
      }
    },

    /** chip X 移除：清 chip + 清当前会话附图草稿键；进行中的上传回调失效 */
    detachImage() {
      imageEpoch += 1;
      this.attachedImage = null;
      remove(imageStorageKey(this.sessionId));
    },

    _applyEvent(id: string, event: AgentEvent) {
      const msg = this.messages.find((m) => m.id === id);
      if (!msg) return;
      if (event.type === 'text') {
        msg.text += event.content ?? '';
        msg.toolActivity = null; // 文本段开始 = 上一轮工具已收尾
      } else if (event.type === 'tool') {
        msg.toolActivity = event.name ?? '';
      } else if (event.type === 'error') {
        msg.error = event.content ?? '生成失败，请重试';
      } else {
        // image / video / audio / model3d 媒体结果
        msg.media.push({ type: event.type, urls: event.urls ?? [] });
        msg.toolActivity = null;
      }
    },

    _finish(id: string, error: string | null) {
      const msg = this.messages.find((m) => m.id === id);
      if (msg) {
        msg.streaming = false;
        msg.toolActivity = null;
        if (error) msg.error = error;
        // 停止/失败且无任何产出：移除空气泡，让错误走 toast 层（页面负责展示）
        if (msg.text === '' && msg.media.length === 0 && !msg.error) {
          this.messages = this.messages.filter((m) => m.id !== id);
        }
      }
      this.sending = false;
      activeHandle = null;
    },
  },
});
