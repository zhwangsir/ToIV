"use client";

import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { Icon } from "@/components/ui/Icon";
import { takeAssistantDraft } from "@/lib/assistantDraft";
import { type ToolCardCtx } from "@/components/assistant/toolcards/registry";
import { ErrorBar } from "@/components/ui/ErrorBar";
import { useToast } from "@/components/ui/Toast";
import {
  agentChatResume,
  agentChatStream,
  AgentChatResumeBody,
  AgentEvent,
  AgentSessionMessage,
  AgentSessionSummary,
  cancelJob,
  deleteAgentSession,
  fetchJobsPage,
  forkAgentSession,
  getAgentSession,
  getLlmModel,
  imageUrl,
  JOBS_PAGE_LIMIT,
  listAgentSessions,
} from "@/lib/api";
import {
  filterEntities,
  resolveEntityIds,
  useEntities,
  type EntityInfo,
} from "@/lib/entities";
import {
  EV_NEW_CHAT,
  EV_OPEN_SESSION,
  PENDING_SESSION_KEY,
} from "@/components/nav/CommandPalette";
import { useR18Mode } from "@/lib/r18";
import type { JobItem } from "@/lib/types";
import {
  deleteDoc,
  DOC_ACCEPT,
  DOC_FORMAT_HINT,
  DocItem,
  docKindIcon,
  docStatusLabel,
  formatDocSize,
  listDocs,
  uploadDoc,
} from "@/lib/docs";
import { genId } from "@/lib/id";
import { useBreakpoint } from "@/lib/useBreakpoint";
import { useAutoResize } from "@/hooks/useAutoResize";
import { AvMessageList, isJobCardActive } from "./MessageList";
import { Composer } from "./Composer";
import {
  PortalEmpty,
  PopupEmpty,
  SKILL_ENTRIES,
  filterPortalEntries,
  portalGreeting,
} from "./PortalEmpty";
import { ConvList, DeleteConfirmModals, RecentTasksList } from "./SessionDrawer";
import "@/app/styles/docs.css";
import "@/app/styles/assistant.css";
import "@/app/styles/assistant-view.css";

// A3(2026-09-22)组件工程化:渲染层拆分为 MessageList/Composer/PortalEmpty/SessionDrawer
// 四模块,样式外迁 app/styles/assistant-view.css;以下 re-export 保持原路径可导入
// (单测/外部引用零迁移),本文件保留数据层(类型/纯函数/会话 store hook)+ 主壳。
export {
  renderInlineMarkdown,
  renderAvMedia,
  flattenVisualFrames,
  renderAvFrames,
  AvMediaList,
  AvJobResults,
  aggregateJobFrames,
  AvJobCards,
  JOB_CARD_ACTIVE_STATUSES,
  isJobCardActive,
  jobCardStatusLabel,
  mediaTypeForJob,
} from "./MessageList";
export type { AvMediaGroup, AvFrame } from "./MessageList";
export {
  SKILL_ENTRIES,
  OFFLINE_ENTRIES,
  filterPortalEntries,
  portalGreeting,
} from "./PortalEmpty";
export type { PortalEntry } from "./PortalEmpty";

// 模型名从 /api/system/llm 动态读取(display_model),不再硬编码;
// W4(2026-08-31 精简):首页/设置面板的固定文案描述全部移除,模型身份以实时名为准

export interface Conversation {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
  /** 服务端列表的消息数(回放前 messages 为空,展示以它为准) */
  messageCount?: number;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  media?: { type: string; urls: string[] }[];
  /** 用户消息挂载的文档(展示 chip;回传后端时只取 id) */
  docs?: { id: string; filename: string }[];
  /** error = 失败态气泡(不进历史、不回传后端) */
  kind?: "error";
  /** tool 事件:内联工具调用小条(同 id 更新) */
  tools?: ToolChip[];
  /** job 事件:生成作业卡(进行中前端 8s 轮询) */
  jobs?: AgentJobCard[];
  /** proposal 事件:方案确认卡(确认/修改/放弃 后只读) */
  proposals?: AgentProposalCard[];
}

/** 工具调用小条(tool 事件,2026-08-24 助手升级协议)。 */
export interface ToolChip {
  id: string;
  name: string;
  status: "start" | "ok" | "error";
  summary: string;
  detail?: string;
  /** A1(2026-09-22):ok 态结构化结果,注册工具渲染结果卡(toolcards/registry);
      未注册/解析失败忽略,仅 chip 展示 */
  payload?: Record<string, unknown>;
}

/** 生成作业卡(job 事件):kind/label/状态徽章,done 后渲染 results 媒体。 */
export interface AgentJobCard {
  jobId: string;
  kind: string;
  status: string; // queued | held | running | done | error
  label: string;
  holdReason?: string;
  results?: string[];
}

/** 提案确认卡(proposal 事件):resolution 非空即只读态。 */
export interface AgentProposalCard {
  proposalId: string;
  title: string;
  body: string;
  estimate?: string;
  /** 提案类型(A2 canvas_graph=画布图,可在画布中打开审查;缺省=纯文本方案) */
  kind?: string;
  resolution?: "approve" | "modify" | "reject";
  note?: string;
}

/** 提案确认决策:resume 回执仍是同构 SSE 流,当一次新的发送接进现有流处理。 */
export interface ResumeDecision {
  proposalId: string;
  action: "approve" | "modify" | "reject";
  note?: string;
  conversationId: string;
}

// localStorage 按天存储仅作「离线/未登录兜底」:服务端会话接口不可达时回退现状行为
const CONV_STORAGE_KEY = (() => {
  const d = new Date();
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return `toiv_av_convs_${day}`;
})();

// 不活跃超时上限:后端 LLM 等待期每 10s 发 SSE 保活 comment,任何字节都会重置
// 计时;只有 120s 完全无字节(真断连/服务死)才中止,超时按失败处理并允许重试
const FIRST_CHUNK_TIMEOUT_MS = 120_000;

function loadStoredConversations(): Conversation[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(CONV_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// ───── 会话存储(H2):服务端会话优先,localStorage 离线/未登录兜底 ─────

/** 服务端会话摘要 → 列表项(消息留空,打开时才回放拉取)。 */
export function summaryToConversation(s: AgentSessionSummary): Conversation {
  return {
    id: s.id,
    title: s.title || "新对话",
    messages: [],
    createdAt: Date.parse(s.created_at) || Date.now(),
    updatedAt: Date.parse(s.updated_at) || Date.now(),
    messageCount: s.message_count,
  };
}

/** 服务端消息日志 → 前端气泡:tool 消息的媒体产物并回最近一条 assistant 气泡
 * (无则补一条空气泡,对齐流式渲染时媒体挂最后一条 assistant 的行为)。
 * W4(2026-08-31):纯工具轮 assistant(content 空、仅 tool_calls 记录)不回放为气泡——
 * 空内容气泡会渲染成常驻打字点,且推理碎片本就刻意不落库( runner 伴生文本抑制)。 */
export function messagesToChat(rows: AgentSessionMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  // A1 回放卡(2026-09-22):tool 行 tool_calls JSON 内的结构化 payload 重建为 chip
  // (注册工具渲染结果卡);缓冲后并入下一条可见气泡——真实时序里 tool 行先于
  // 助手文本气泡,不能直接挂"上一条"(那是上一轮)
  let pendingTools: ToolChip[] = [];
  const flushTools = (target: ChatMessage | undefined) => {
    if (!pendingTools.length || !target) return;
    target.tools = [...(target.tools ?? []), ...pendingTools];
    pendingTools = [];
  };
  const flushToolsToLastAssistant = () => {
    const last = out[out.length - 1];
    flushTools(last && last.role === "assistant" ? last : undefined);
  };
  for (const m of rows) {
    const ts = Date.parse(m.created_at) || Date.now();
    if (m.role === "user") {
      // 新一轮开始:上轮中止遗留的 chip 挂到上一条 assistant 气泡(没有则丢弃)
      flushToolsToLastAssistant();
      out.push({ id: `srv-${m.id}`, role: m.role, content: m.content, timestamp: ts });
    } else if (m.role === "assistant") {
      // 空 assistant 轮(工具调用中间轮)跳过;媒体由随后 tool 行并入下一条可见气泡
      if (!m.content.trim() && !(m.media?.length)) continue;
      const bubble: ChatMessage = { id: `srv-${m.id}`, role: m.role, content: m.content, timestamp: ts };
      out.push(bubble);
      flushTools(bubble);
    } else if (m.role === "tool") {
      // payload chip 缓冲(等待本轮 assistant 文本气泡)
      const tc = m.tool_calls && typeof m.tool_calls === "object"
        ? (m.tool_calls as { name?: unknown; payload?: unknown })
        : null;
      if (tc && typeof tc.name === "string" && tc.payload && typeof tc.payload === "object") {
        pendingTools.push({
          id: `srv-${m.id}`,
          name: tc.name,
          status: "ok",
          summary: tc.name,
          payload: tc.payload as Record<string, unknown>,
        });
      }
      if (m.media?.length) {
        let last = out[out.length - 1];
        if (!last || last.role !== "assistant") {
          last = { id: `srv-${m.id}-media`, role: "assistant", content: "", timestamp: ts };
          out.push(last);
        }
        // W4:按 URL 去重——check_jobs 落库媒体与 submit_generation 回填媒体可能同产物双来源
        const seen = new Set((last.media ?? []).flatMap((g) => g.urls));
        const fresh = m.media
          .map((g) => ({ ...g, urls: g.urls.filter((u) => !seen.has(u)) }))
          .filter((g) => g.urls.length > 0);
        for (const g of fresh) g.urls.forEach((u) => seen.add(u));
        if (fresh.length) last.media = [...(last.media ?? []), ...fresh];
        // 媒体行就是本轮收尾:缓冲的 chip 一并并入
        flushTools(last);
      }
    }
  }
  // 流尾兜底:中止轮(tool 行后无 assistant 文本)不产空气泡(守 W4 不变式),
  // chip 仅在上一条为 assistant 气泡时并入,否则丢弃(实时流已展示过一次)
  flushToolsToLastAssistant();
  return out;
}

/** 流超时/中断且非 HTTP 4xx/5xx 时，可凭会话 id 回放服务端已落库的回复。 */
export function shouldRecoverFromTimeout(
  err: unknown,
  sessionId: string | null | undefined,
): boolean {
  if (!sessionId) return false;
  const status =
    err && typeof err === "object" && "status" in err
      ? (err as { status?: number }).status
      : undefined;
  if (typeof status === "number" && status >= 400) return false;
  const name =
    err && typeof err === "object" && "name" in err
      ? String((err as { name?: string }).name ?? "")
      : "";
  const message =
    err instanceof Error
      ? err.message
      : err && typeof err === "object" && "message" in err
        ? String((err as { message?: unknown }).message ?? "")
        : "";
  if (name === "AbortError") return true;
  return /timeout|timed out|超时|aborted|abort/i.test(message);
}

/** 最后一条 user 之后是否已有助手产出（文本或 tool 媒体）。空会话不可当成功。 */
export function sessionHasAssistantAfterLastUser(
  rows: { role: string; content?: string; media?: { urls?: string[] }[] }[],
): boolean {
  let lastUser = -1;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].role === "user") lastUser = i;
  }
  if (lastUser < 0) return false;
  for (let i = lastUser + 1; i < rows.length; i++) {
    const row = rows[i];
    if (row.role === "assistant" && (row.content ?? "").trim()) return true;
    if ((row.media?.length ?? 0) > 0) return true;
  }
  return false;
}

// ───── 工具条 / 作业卡 / 提案卡(2026-08-24 助手升级协议:tool/job/proposal 三类 SSE 事件) ─────

/** tool/job/proposal 事件归并到最后一条 assistant 气泡(无则补一条空气泡,
 *  对齐 messagesToChat 的 tool 媒体归并行为);返回 [新数组, 目标气泡]。 */
function mutateLastAssistant(
  msgs: ChatMessage[],
  fn: (m: ChatMessage) => ChatMessage,
): [ChatMessage[], ChatMessage] {
  const last = msgs[msgs.length - 1];
  if (last && last.role === "assistant" && last.kind !== "error") {
    const target = fn(last);
    return [[...msgs.slice(0, -1), target], target];
  }
  const fresh: ChatMessage = {
    id: genId(),
    role: "assistant",
    content: "",
    timestamp: Date.now(),
  };
  const target = fn(fresh);
  return [[...msgs, target], target];
}

/** tool 事件 upsert:同 id 更新而非追加(纯函数,单测锚点)。 */
export function upsertToolChip(msgs: ChatMessage[], chip: ToolChip): ChatMessage[] {
  const [next] = mutateLastAssistant(msgs, (m) => {
    const tools = [...(m.tools ?? [])];
    const idx = tools.findIndex((t) => t.id === chip.id);
    if (idx >= 0) tools[idx] = { ...tools[idx], ...chip };
    else tools.push(chip);
    return { ...m, tools };
  });
  return next;
}

/** job 事件 upsert:同 jobId 更新(状态推进/hold_reason/results)(纯函数,单测锚点)。 */
export function upsertJobCard(msgs: ChatMessage[], card: AgentJobCard): ChatMessage[] {
  const [next] = mutateLastAssistant(msgs, (m) => {
    const jobs = [...(m.jobs ?? [])];
    const idx = jobs.findIndex((j) => j.jobId === card.jobId);
    if (idx >= 0) jobs[idx] = { ...jobs[idx], ...card };
    else jobs.push(card);
    return { ...m, jobs };
  });
  return next;
}

/** proposal 事件 upsert(纯函数,单测锚点)。 */
export function upsertProposalCard(
  msgs: ChatMessage[],
  card: AgentProposalCard,
): ChatMessage[] {
  const [next] = mutateLastAssistant(msgs, (m) => {
    const proposals = [...(m.proposals ?? [])];
    const idx = proposals.findIndex((p) => p.proposalId === card.proposalId);
    if (idx >= 0) proposals[idx] = { ...proposals[idx], ...card };
    else proposals.push(card);
    return { ...m, proposals };
  });
  return next;
}

/** 提案卡落锤:写入用户选择,卡片转只读态(纯函数,单测锚点)。 */
export function markProposalResolved(
  msgs: ChatMessage[],
  proposalId: string,
  action: "approve" | "modify" | "reject",
  note?: string,
): ChatMessage[] {
  return msgs.map((m) =>
    m.proposals?.some((p) => p.proposalId === proposalId)
      ? {
          ...m,
          proposals: m.proposals.map((p) =>
            p.proposalId === proposalId ? { ...p, resolution: action, note } : p,
          ),
        }
      : m,
  );
}

// A3:作业卡纯函数(JOB_CARD_ACTIVE_STATUSES/isJobCardActive/jobCardStatusLabel/
// mediaTypeForJob)随消息渲染同源迁至 ./MessageList,上方 re-export 保持原路径。

/** 上送 API 的消息构造上限:后端 ChatRequest messages≤200、content≤32768。
 *  有 session_id 时只上送最新 user(服务端用 DB 历史);无会话才带一段尾部防 422。 */
export const MAX_API_MESSAGES = 200;
export const MAX_API_MESSAGE_CHARS = 32000;

/** 上送 API 的消息列表构造(纯函数,单测锚点):过滤 error 卡;单条超长截断;
 *  续聊(sessionId)只带最新 user;否则总数超限保留最近 N 条。 */
export function buildApiMessages(
  msgs: ChatMessage[],
  opts?: { sessionId?: string | null },
): { role: string; content: string }[] {
  const usable = msgs.filter(
    (m) => (m.role === "user" || m.role === "assistant") && m.kind !== "error",
  );
  const clip = (m: ChatMessage) => ({
    role: m.role,
    content:
      m.content.length > MAX_API_MESSAGE_CHARS
        ? `${m.content.slice(0, MAX_API_MESSAGE_CHARS)}…(已截断)`
        : m.content,
  });
  if (opts?.sessionId) {
    for (let i = usable.length - 1; i >= 0; i--) {
      if (usable[i].role === "user") return [clip(usable[i])];
    }
    return usable.slice(-1).map(clip);
  }
  const tail = usable.length > MAX_API_MESSAGES ? usable.slice(-MAX_API_MESSAGES) : usable;
  return tail.map(clip);
}

/** 作业卡轮询快照回写(纯函数,单测锚点):进行中卡片按 job id / prompt_id 匹配
 *  列表行,推进状态;done 时灌入产物 URL(经 imageUrl 归一签名/相对路径)。
 *  无变化时原样返回(引用不变,避免轮询空转触发重渲染)。 */
export function applyJobSnapshots(msgs: ChatMessage[], rows: JobItem[]): ChatMessage[] {
  let changed = false;
  const next = msgs.map((m) => {
    if (!m.jobs?.length) return m;
    let mChanged = false;
    const jobs = m.jobs.map((card) => {
      if (!isJobCardActive(card.status)) return card;
      const row = rows.find((r) => r.id === card.jobId || r.prompt_id === card.jobId);
      if (!row || !row.status || row.status === card.status) return card;
      mChanged = true;
      return {
        ...card,
        status: row.status,
        results:
          row.status === "done" && row.results?.length
            ? row.results.map(imageUrl)
            : card.results,
      };
    });
    if (!mChanged) return m;
    changed = true;
    return { ...m, jobs };
  });
  return changed ? next : msgs;
}

/** 作业卡用户中止:本地先落 canceled,轮询不再跟进(纯函数,单测锚点)。 */
export function markJobCanceled(msgs: ChatMessage[], jobId: string): ChatMessage[] {
  let changed = false;
  const next = msgs.map((m) => {
    if (!m.jobs?.some((j) => j.jobId === jobId && isJobCardActive(j.status))) return m;
    changed = true;
    return {
      ...m,
      jobs: m.jobs.map((j) => (j.jobId === jobId ? { ...j, status: "canceled" } : j)),
    };
  });
  return changed ? next : msgs;
}

export interface AgentConversationStore {
  /** null=探测中;true=服务端会话;false=localStorage 兜底 */
  serverMode: boolean | null;
  conversations: Conversation[];
  listError: string | null;
  clearListError: () => void;
  /** 打开会话:server 模式从服务端回放;local 模式读本地缓存。失败返回 null(错误透出)。 */
  open: (id: string) => Promise<ChatMessage[] | null>;
  /**
   * 一轮对话完成后登记列表。getConvId 惰性读取(组件在 setState updater 里调用,
   * StrictMode 双调用幂等);sessionId 为服务端新会话 id(首轮响应头带回)。
   */
  register: (
    getConvId: () => string | null,
    sessionId: string | null,
    msgs: ChatMessage[],
    onId: (id: string) => void,
  ) => void;
  remove: (id: string) => Promise<void>;
  /** 分叉(A2 2026-09-22):复制源会话为新会话(server 走 fork 端点;local 兜底本地复制),
      返回新会话 id(失败返回 null,错误透出到 listError)。 */
  fork: (id: string) => Promise<string | null>;
}

export function useAgentConversations(): AgentConversationStore {
  const [serverMode, setServerMode] = useState<boolean | null>(null);
  const [serverConvs, setServerConvs] = useState<Conversation[]>([]);
  const [localConvs, setLocalConvs] = useState<Conversation[]>(loadStoredConversations);
  const [listError, setListError] = useState<string | null>(null);

  // 进页探测:服务端列表成功 → server 模式;401/网络失败 → localStorage 兜底(迁移前现状行为)
  useEffect(() => {
    let cancelled = false;
    listAgentSessions()
      .then((rows) => {
        if (cancelled) return;
        setServerConvs(rows.map(summaryToConversation));
        setServerMode(true);
      })
      .catch(() => {
        if (!cancelled) setServerMode(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // local 模式:列表变更即写 localStorage(仅兜底模式写;server 模式消息由服务端落库)
  useEffect(() => {
    if (serverMode !== false) return;
    try {
      localStorage.setItem(CONV_STORAGE_KEY, JSON.stringify(localConvs));
    } catch {
      /* 存储满/隐私模式下静默忽略 */
    }
  }, [serverMode, localConvs]);

  const open = useCallback(
    async (id: string): Promise<ChatMessage[] | null> => {
      if (serverMode) {
        try {
          const detail = await getAgentSession(id);
          return messagesToChat(detail.messages);
        } catch (err) {
          setListError(err instanceof Error ? err.message : "会话加载失败");
          return null;
        }
      }
      return localConvs.find((c) => c.id === id)?.messages ?? null;
    },
    [serverMode, localConvs],
  );

  const register = useCallback(
    (
      getConvId: () => string | null,
      sessionId: string | null,
      msgs: ChatMessage[],
      onId: (id: string) => void,
    ) => {
      // 错误气泡不进历史(本地兜底态,非真实对话内容)
      const cleaned = msgs.filter((m) => m.kind !== "error");
      if (cleaned.length === 0) return;
      const userMsg = cleaned.find((m) => m.role === "user");
      const title = userMsg ? getPreview(userMsg.content, 20) : "新对话";
      const now = Date.now();
      if (serverMode) {
        // 服务端模式:消息已由 chat 端点落库,这里只维护列表摘要
        const id = getConvId() ?? sessionId;
        if (!id) return;
        onId(id);
        const finalId = id;
        setServerConvs((prev) => {
          const exists = prev.some((c) => c.id === finalId);
          if (exists) {
            return prev.map((c) =>
              c.id === finalId
                ? {
                    ...c,
                    messages: cleaned,
                    title: c.title || title,
                    updatedAt: now,
                    messageCount: undefined, // 已有真实 messages,以它为准
                  }
                : c,
            );
          }
          const newConv: Conversation = {
            id: finalId,
            title,
            messages: cleaned,
            createdAt: now,
            updatedAt: now,
          };
          return [newConv, ...prev];
        });
        return;
      }
      // local 模式:原 saveToHistory 逻辑(全量消息写 localStorage)
      let id = getConvId();
      if (!id) {
        id = genId();
        onId(id); // 同步回写,StrictMode 双调用幂等(第二次执行读到同一 id)
      }
      const finalId = id;
      setLocalConvs((prev) => {
        const exists = prev.some((c) => c.id === finalId);
        if (exists) {
          return prev.map((c) =>
            c.id === finalId ? { ...c, messages: cleaned, title, updatedAt: now } : c,
          );
        }
        const newConv: Conversation = {
          id: finalId,
          title,
          messages: cleaned,
          createdAt: now,
          updatedAt: now,
        };
        return [newConv, ...prev];
      });
    },
    [serverMode],
  );

  const remove = useCallback(
    async (id: string) => {
      if (serverMode) {
        try {
          await deleteAgentSession(id);
        } catch (err) {
          setListError(err instanceof Error ? err.message : "删除会话失败");
          return;
        }
        setServerConvs((prev) => prev.filter((c) => c.id !== id));
        return;
      }
      setLocalConvs((prev) => prev.filter((c) => c.id !== id));
    },
    [serverMode],
  );

  const fork = useCallback(
    async (id: string): Promise<string | null> => {
      if (serverMode) {
        try {
          const summary = await forkAgentSession(id);
          const conv = summaryToConversation(summary);
          setServerConvs((prev) => [conv, ...prev]);
          return conv.id;
        } catch (err) {
          setListError(err instanceof Error ? err.message : "分叉会话失败");
          return null;
        }
      }
      // local 兜底:本地复制(消息全量拷贝,标题加分叉后缀)
      const srcConv = localConvs.find((c) => c.id === id);
      if (!srcConv) return null;
      const newId = genId();
      const now = Date.now();
      setLocalConvs((prev) => [
        { ...srcConv, id: newId, title: `${srcConv.title}(分叉)`, createdAt: now, updatedAt: now },
        ...prev,
      ]);
      return newId;
    },
    [serverMode, localConvs],
  );

  return {
    serverMode,
    conversations: serverMode ? serverConvs : localConvs,
    listError,
    clearListError: () => setListError(null),
    open,
    register,
    remove,
    fork,
  };
}

function getPreview(text: string, max = 28) {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max) + "…" : t;
}

export interface AssistantViewProps {
  /** 视图跳转(page.tsx SPA 切换机制);未注入时退化为整页跳转 ?view= */
  onNavigate?: (view: string) => void;
  /**
   * 展示形态(2026-08-18 弹窗化):
   * - page(默认):整页视图,门户空态/历史/设置/文档面板全量;
   * - popup:Shift+Enter 全局弹窗——界面仅保留对话显示区与输入框
   *   (隐藏页头/三个侧面板/文档挂载入口,空态为极简提示,输入框沉底);
   *   会话管理(列表/切换/新建/删除)由输入区左侧「会话」按钮弹出的
   *   抽屉承担,与页形态历史面板共用同一份列表渲染(renderConvList)。
   */
  variant?: "page" | "popup";
}

export function AssistantView(props?: AssistantViewProps) {
  const onNavigate = props?.onNavigate;
  const popup = props?.variant === "popup";
  const toast = useToast();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  // 渲染窗口(2026-08-29 性能:长会话全量渲染 DOM 节点线性膨胀致卡顿/闪退;
  // 默认只渲染最近 80 条,顶部「加载更早消息」展开;数据层 messages 不动,
  // 上传给 API 的历史截断仍由 MAX_API_MESSAGES/MAX_API_MESSAGE_CHARS 承载)
  const [showAllHistory, setShowAllHistory] = useState(false);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  // pending = 已发送、等待首个响应块(打字指示器),出错即替换为错误气泡
  const [pending, setPending] = useState(false);
  // 会话存储:服务端优先,localStorage 兜底(见 useAgentConversations)
  const convStore = useAgentConversations();
  const conversations = convStore.conversations;
  const [activeConvId, setActiveConvId] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  /** P0.3:左侧面板 / popup 抽屉分栏(会话 | 最近任务) */
  const [panelTab, setPanelTab] = useState<"sessions" | "tasks">("sessions");
  // W5:助手离线降级(门户空态探活失败 → 隐藏对话框,展开全量工作台导航)
  const [llmOffline, setLlmOffline] = useState(false);
  // 移动端断点:placeholder 文案按端适配(移动端无 Enter 键)
  const isMobileMq = useBreakpoint("md");
  // 文档挂载:已上传文档列表 / 文档管理面板 / 待发送挂载 / 上传中
  const [docList, setDocList] = useState<DocItem[]>([]);
  const [docsOpen, setDocsOpen] = useState(false);
  const [attachedDocs, setAttachedDocs] = useState<DocItem[]>([]);
  const [docUploading, setDocUploading] = useState(false);
  // 删除二次确认(P0-2):会话/文档删除均不可逆,统一走 Modal 确认后执行
  const [confirmDeleteConv, setConfirmDeleteConv] = useState<Conversation | null>(null);
  const [confirmDeleteDoc, setConfirmDeleteDoc] = useState<DocItem | null>(null);
  const [docDeleting, setDocDeleting] = useState(false);
  const abortRef = useRef<boolean>(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const activeConvIdRef = useRef<string | null>(null);
  const userStoppedRef = useRef<boolean>(false);
  const gotFirstChunkRef = useRef<boolean>(false);
  const lastDocIdsRef = useRef<string[]>([]); // 重试时复用上轮挂载
  const lastSessionIdRef = useRef<string | null>(null); // 本轮响应头带回的会话 id
  const docFileRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // popup 会话抽屉根节点(点外部关闭判定用)
  const convDrawerRef = useRef<HTMLDivElement>(null);

  const isEmpty = messages.length === 0;

  // ───── @ 面板 / R18 模式(门户空态场景卡复用 SKILL_ENTRIES,经 filterPortalEntries 门控) ─────
  const [r18] = useR18Mode();
  // @ 技能面板:Esc/选定后关闭;输入再变化时重新允许弹出
  const [skillDismissed, setSkillDismissed] = useState(false);
  // 门户问候语:挂载时按时段取一次(纯展示)
  const [greeting] = useState(() => portalGreeting(new Date().getHours()));

  /** 视图跳转:优先 page.tsx SPA 切换(带 View Transitions),缺省整页跳转。 */
  const goView = useCallback(
    (view: string) => {
      if (onNavigate) onNavigate(view);
      else if (typeof window !== "undefined") window.location.assign(`/?view=${view}`);
    },
    [onNavigate],
  );

  /** A1 工具结果卡(2026-09-22)动作回调:应用到输入框 / 打开应用 / 打开画板。 */
  const toolCardCtx = useMemo<ToolCardCtx>(
    () => ({
      // 优化后提示词直接回填受控输入框并聚焦,等待用户确认发送
      onApplyInput: (text) => {
        setInput(text);
        textareaRef.current?.focus();
      },
      // 应用深链形态同 LibraryView 作业卡(onNavigate?.(`market?app=${id}`))
      onOpenApp: (appId) => goView(`market?app=${appId}`),
      // 画板详情暂无 URL 定位参数(BoardsView 详情为本地 state),兜底跳作品库
      onOpenBoard: () => goView("library"),
    }),
    [goView],
  );

  // @ 触发:取最后一个 @ 之后的文本作过滤词(空词=全量入口)
  const skillEntries = useMemo(() => {
    const idx = input.lastIndexOf("@");
    if (idx < 0) return [];
    const q = input.slice(idx + 1).trim().toLowerCase();
    return filterPortalEntries(SKILL_ENTRIES, r18).filter(
      (e) => !q || e.label.toLowerCase().includes(q),
    );
  }, [input, r18]);
  // 主体库(@主体引用,2026-08-26):与技能同一 @ 面板,第二分组「主体」;
  // 选定不跳转,把 @触发词 替换为 `@实体名 ` 引用(chip 预览由 EntityRefsPreview 承担)
  const subjectEntities = useEntities();
  const entityEntries = useMemo(() => {
    const idx = input.lastIndexOf("@");
    if (idx < 0) return [];
    const q = input.slice(idx + 1);
    // 触发词含空白 = 已离开 @ 语境(继续写正文),不再提示
    if (/\s/.test(q)) return [];
    return filterEntities(subjectEntities, q).slice(0, 6);
  }, [input, subjectEntities]);
  // 无匹配项时收敛面板,Enter 照常发送原文
  const skillPanelVisible =
    input.includes("@") && !skillDismissed && !busy &&
    (skillEntries.length > 0 || entityEntries.length > 0);

  /** P0.2 选定技能:剥掉 @触发词;生成类预填 prompt 留在对话,浏览类(作品库)仍 goView。 */
  const onPickSkill = useCallback(
    (view: string) => {
      const entry = SKILL_ENTRIES.find((e) => e.view === view);
      setSkillDismissed(true);
      if (entry?.navigate || !entry?.prompt) {
        setInput((prev) => prev.replace(/@[^@]*$/, ""));
        goView(view);
        return;
      }
      setInput(entry.prompt);
      requestAnimationFrame(() => textareaRef.current?.focus());
    },
    [goView],
  );

  /** P0.2 门户场景卡:预填 composer + 聚焦(不离开智能体)。 */
  const onChipPrompt = useCallback((prompt: string) => {
    setInput(prompt);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, []);

  /** 选定主体:@触发词 → `@实体名 `(文本内引用,不跳转;发送时解析为 entity_ids)。 */
  const onPickEntity = useCallback((ent: EntityInfo) => {
    setInput((prev) => prev.replace(/@[^@]*$/, `@${ent.name} `));
    setSkillDismissed(true);
    textareaRef.current?.focus();
  }, []);

  // W5(2026-08-31):探活兼任助手可用性哨兵——null/失败即离线,门户降级为纯工作台导航
  useEffect(() => {
    const ac = new AbortController();
    getLlmModel(ac.signal).then((info) => {
      setLlmOffline(!info);
    });
    return () => ac.abort();
  }, []);

  // 文档列表:进页加载一次;上传/删除后局部更新,无需重复拉取
  useEffect(() => {
    const ac = new AbortController();
    listDocs(ac.signal)
      .then(setDocList)
      .catch(() => {
        /* 列表加载失败不阻塞对话,面板里可重试 */
      });
    return () => ac.abort();
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // 门户首页(空态):滚动容器顶对齐——会话态沉底逻辑会把英雄标题推出裁剪窗(审计实测残留 163.5px);
    // 挂载/视图切回 assistant/清空会话三条路径都汇聚到 isEmpty=true,一并归零
    if (isEmpty) {
      el.scrollTop = 0;
      return;
    }
    el.scrollTop = el.scrollHeight;
  }, [messages, busy, isEmpty]);

  // composer 自动增高(scrollHeight 方案,40vh 宽松封顶,超出内滚;替代原行数估算 176px 硬顶)
  useAutoResize(textareaRef, input, { maxVh: 40 });

  const onNewChat = useCallback(() => {
    setMessages([]);
    setActiveConvId(null);
    activeConvIdRef.current = null;
    setInput("");
  }, []);

  // activeConvId 同步到 ref,供流式回调结束时拿到最新会话 id
  useEffect(() => {
    activeConvIdRef.current = activeConvId;
  }, [activeConvId]);

  // 一轮对话收尾:登记列表(server 模式只维护摘要;local 模式写全量)并同步会话 id
  const finishTurn = useCallback(
    (msgs: ChatMessage[]) => {
      convStore.register(
        () => activeConvIdRef.current,
        lastSessionIdRef.current,
        msgs,
        (id) => {
          if (id !== activeConvIdRef.current) {
            setActiveConvId(id);
            activeConvIdRef.current = id;
          }
        },
      );
    },
    [convStore],
  );

  const loadConversation = useCallback(
    async (conv: Conversation) => {
      const msgs = await convStore.open(conv.id);
      if (msgs === null) return; // 错误已由 store 透出(ErrorBar)
      setMessages(msgs);
      setActiveConvId(conv.id);
      setInput("");
      setHistoryOpen(false);
    },
    [convStore],
  );

  // Studio Console v1:⌘K 命令面板指令——「新对话」与「打开会话」(跨组件 CustomEvent;
  // 跨视图时 page.tsx 先切 home,本组件未挂载,经 PENDING_SESSION_KEY 暂存后消费)
  useEffect(() => {
    const onNew = () => onNewChat();
    const onOpen = (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      if (!id) return;
      const conv = conversations.find((c) => c.id === id);
      if (conv) loadConversation(conv);
    };
    window.addEventListener(EV_NEW_CHAT, onNew);
    window.addEventListener(EV_OPEN_SESSION, onOpen);
    return () => {
      window.removeEventListener(EV_NEW_CHAT, onNew);
      window.removeEventListener(EV_OPEN_SESSION, onOpen);
    };
  }, [conversations, loadConversation, onNewChat]);

  // 跨视图暂存消费:会话列表就绪后若有待开会话,打开并清除
  useEffect(() => {
    const pending = (window as unknown as Record<string, unknown>)[PENDING_SESSION_KEY];
    if (typeof pending !== "string" || !pending) return;
    const conv = conversations.find((c) => c.id === pending);
    if (conv) {
      (window as unknown as Record<string, unknown>)[PENDING_SESSION_KEY] = undefined;
      loadConversation(conv);
    }
  }, [conversations, loadConversation]);

  // A2(2026-09-22):跨页「在对话中继续」一次性草稿——仅 page 形态消费,
  // 挂载时取出即删(popup 不抢:草稿的目标是 home 整页);回填后聚焦输入框
  useEffect(() => {
    if (popup) return;
    const draft = takeAssistantDraft();
    if (draft) {
      setInput(draft);
      textareaRef.current?.focus();
    }
    // 仅首挂载消费一次(一次性语义);textareaRef/setInput 稳定
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const deleteConversation = useCallback(
    (id: string) => {
      void convStore.remove(id);
      if (activeConvId === id) {
        onNewChat();
      }
    },
    [activeConvId, onNewChat, convStore],
  );

  // 分叉(A2):复制会话为新对话(列表顶部);正在浏览的源会话不受影响
  const forkConversation = useCallback(
    (conv: Conversation) => {
      void convStore.fork(conv.id).then((newId) => {
        if (newId) toast.success("已分叉为新对话(见列表顶部)");
      });
    },
    [convStore, toast],
  );

  // popup 会话抽屉:Esc 关闭。浮层全局 Esc 是 capture 监听(AssistantOverlay),
  // 见 .av-pop-conv.is-open 即让位不吞事件;事件冒泡回 window 时由这里收敛抽屉
  useEffect(() => {
    if (!popup || !historyOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setHistoryOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [popup, historyOpen]);

  // 页形态三面板(历史/设置/文档):Esc 统一关闭(W4 修复:此前仅 popup 抽屉响应 Esc,
  // 页形态面板只能靠遮罩点击/关闭钮,键盘用户无出口)
  useEffect(() => {
    if (popup || (!historyOpen && !docsOpen)) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setHistoryOpen(false);
        setDocsOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [popup, historyOpen, docsOpen]);

  // popup 会话抽屉:点外部关闭(抽屉本体/触发按钮之外的 mousedown 即收敛)
  useEffect(() => {
    if (!popup || !historyOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t) return;
      if (convDrawerRef.current?.contains(t)) return;
      if (t.closest(".av-pop-conv-toggle")) return;
      setHistoryOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [popup, historyOpen]);

  // ───── 文档挂载 ─────
  const onPickDocFile = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = ""; // 允许重复选同一文件
      if (!file) return;
      if (file.size > 50 * 1024 * 1024) {
        toast.error("文件超过 50MB 上限");
        return;
      }
      setDocUploading(true);
      try {
        const doc = await uploadDoc(file);
        setDocList((prev) => [doc, ...prev]);
        // 上传成功即挂载,符合「上传新文档并提问」的直觉路径
        setAttachedDocs((prev) =>
          prev.some((d) => d.id === doc.id) ? prev : [...prev, doc],
        );
        toast.success(
          doc.status === "no_embed"
            ? "文档已保存,但向量服务不可用,暂无法检索"
            : "文档已上传并挂载",
        );
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "文档上传失败");
      } finally {
        setDocUploading(false);
      }
    },
    [toast],
  );

  // 由确认弹窗触发:删除中阻止关闭;失败保留弹窗可重试/取消,成功即关闭
  const onDeleteDoc = useCallback(
    async (doc: DocItem) => {
      setDocDeleting(true);
      try {
        await deleteDoc(doc.id);
        setDocList((prev) => prev.filter((d) => d.id !== doc.id));
        setAttachedDocs((prev) => prev.filter((d) => d.id !== doc.id));
        setConfirmDeleteDoc(null);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "删除文档失败");
      } finally {
        setDocDeleting(false);
      }
    },
    [toast],
  );

  const toggleAttachDoc = useCallback((doc: DocItem) => {
    setAttachedDocs((prev) =>
      prev.some((d) => d.id === doc.id)
        ? prev.filter((d) => d.id !== doc.id)
        : [...prev, doc],
    );
  }, []);

  const removeAttachedDoc = useCallback((id: string) => {
    setAttachedDocs((prev) => prev.filter((d) => d.id !== id));
  }, []);

  // 发起一次对话请求:立即进入 pending(打字指示器),120s 完全无字节(含保活
  // comment 也算活动,每次活动重置计时)才按失败处理,
  // 失败/超时 → 错误气泡 + 重试;成功/失败均写入历史。docIds = 本轮挂载的文档。
  // resume = 提案确认回执(POST /api/agent/chat/resume,响应同构 SSE,不再发 messages)
  const requestReply = useCallback(
    async (baseMsgs: ChatMessage[], docIds: string[] = [], resume?: ResumeDecision, entityIds?: string[]) => {
      setBusy(true);
      setPending(true);
      abortRef.current = false;
      userStoppedRef.current = false;
      gotFirstChunkRef.current = false;
      lastDocIdsRef.current = docIds;
      // 真实错误原因(2026-08-25 修复):HTTP 错误(status+detail)/流内 error 事件
      // 不再被吞成统一「连接中断或超时」,错误气泡显示真实原因
      let errorDetail: string | null = null;
      let errorStatus: number | null = null;
      let caughtErr: unknown = null;

      const controller = new AbortController();
      abortControllerRef.current = controller;

      // 不活跃计时:任何字节(含后端 10s 保活 comment)都重置;120s 无活动才中止
      let timeoutId = window.setTimeout(() => controller.abort(), FIRST_CHUNK_TIMEOUT_MS);
      const resetInactivityTimer = () => {
        window.clearTimeout(timeoutId);
        timeoutId = window.setTimeout(() => controller.abort(), FIRST_CHUNK_TIMEOUT_MS);
      };

      let failed = false;
      // 后端以 SSE msg 事件下发 {type:"error"}(如「主模型暂不可用」),HTTP 仍 200,
      // 必须显式识别为失败;同理,流正常结束但零内容也按失败处理
      let streamError = false;
      try {
        const sid = convStore.serverMode ? (activeConvIdRef.current ?? null) : null;
        const apiMessages = buildApiMessages(baseMsgs, { sessionId: sid });

        let assistantMsg: ChatMessage | null = null;

        const onEvent = (ev: AgentEvent) => {
          if (controller.signal.aborted) return;
          if (!gotFirstChunkRef.current) {
            gotFirstChunkRef.current = true;
            setPending(false);
          }
          if (ev.type === "text") {
            const delta = ev.content || "";
            if (!assistantMsg) {
              assistantMsg = {
                id: genId(),
                role: "assistant",
                content: delta,
                timestamp: Date.now(),
              };
              setMessages((prev) => [...prev, assistantMsg!]);
            } else {
              setMessages((prev) => {
                const last = prev[prev.length - 1];
                if (last && last.id === assistantMsg!.id) {
                  return [
                    ...prev.slice(0, -1),
                    { ...last, content: last.content + delta },
                  ];
                }
                return prev;
              });
            }
          } else if (ev.type === "error") {
            streamError = true;
            // 保留后端真实错误(LLM 暂不可用/工具失败等),供错误气泡展示
            if (ev.content) errorDetail = ev.content;
          } else if (
            ["image", "video", "audio", "model3d"].includes(ev.type)
          ) {
            setMessages((prev) => {
              const last = prev[prev.length - 1];
              if (!last || last.role !== "assistant") return prev;
              const media = [
                ...(last.media || []),
                { type: ev.type, urls: ev.urls || [] },
              ];
              return [...prev.slice(0, -1), { ...last, media }];
            });
          } else if (ev.type === "ui_action") {
            // W3(2026-08-31):助手 UI 驱动指令——跳转/预填/开产物,即收即执行
            const act = ev.action;
            if (act === "navigate_view" && ev.view) {
              goView(ev.view);
            } else if (act === "prefill_generate" && ev.prompt && ev.kind) {
              // 经引擎草稿机制回填工作台(lib/engine,GenerateView 挂载时消费)
              try {
                window.localStorage.setItem(
                  "toiv_engine_draft",
                  JSON.stringify({ prompt: ev.prompt, target: ev.kind }),
                );
              } catch { /* 存储不可用时仅跳转 */ }
              goView(ev.kind);
            } else if (act === "open_asset") {
              goView("library");
            }
          } else if (ev.type === "tool" || ev.type === "job" || ev.type === "proposal") {
            // 工具条/作业卡/提案卡:upsert 归并到最后一条 assistant 气泡(同 id 更新);
            // 本轮尚无文本气泡且事件新建了气泡时,后续 text 增量续到该气泡(避免碎片化)
            setMessages((prev) => {
              let next: ChatMessage[];
              if (ev.type === "tool") {
                next = upsertToolChip(prev, {
                  id: ev.id || genId(),
                  name: ev.name || "tool",
                  status: ev.status === "ok" ? "ok" : ev.status === "error" ? "error" : "start",
                  summary: ev.summary || "",
                  detail: ev.detail,
                  // A1:ok 态结构化 payload 透传;条件展开——缺省不写入键,
                  // upsert 归并(...chip 展开)时保留此前已透传的 payload
                  ...(ev.payload ? { payload: ev.payload } : {}),
                });
              } else if (ev.type === "job") {
                next = upsertJobCard(prev, {
                  jobId: ev.job_id || genId(),
                  kind: ev.kind || "",
                  status: ev.status || "queued",
                  label: ev.label || "",
                  holdReason: ev.hold_reason,
                  results: ev.results?.length ? ev.results : undefined,
                });
              } else {
                next = upsertProposalCard(prev, {
                  proposalId: ev.proposal_id || genId(),
                  title: ev.title || "执行方案",
                  body: ev.body || "",
                  estimate: ev.estimate,
                  kind: typeof ev.kind === "string" ? ev.kind : undefined,
                });
              }
              if (!assistantMsg) {
                const last = next[next.length - 1];
                if (last?.role === "assistant" && !prev.some((m) => m.id === last.id)) {
                  assistantMsg = last;
                }
              }
              return next;
            });
          }
        };

        const { sessionId } = resume
          ? await agentChatResume(
              {
                conversation_id: resume.conversationId,
                proposal_id: resume.proposalId,
                action: resume.action,
                ...(resume.note?.trim() ? { note: resume.note.trim() } : {}),
              } satisfies AgentChatResumeBody,
              onEvent,
              controller.signal,
              resetInactivityTimer,
            )
          : await agentChatStream(
              {
                messages: apiMessages,
                document_ids: docIds,
                // 仅服务端模式携带会话 id(local 兜底模式的 id 是本地 genId,服务端不认)
                session_id: convStore.serverMode ? (activeConvIdRef.current ?? null) : null,
                // @主体引用:@实体名 解析出的主体库 id(提及首现序),空则不携带
                ...(entityIds?.length ? { entity_ids: entityIds } : {}),
              },
              onEvent,
              controller.signal,
              resetInactivityTimer,
            );
        if (sessionId) lastSessionIdRef.current = sessionId;
      } catch (e) {
        failed = true;
        caughtErr = e;
        // 保留真实 HTTP 错误(如「会话不存在」「对话失败 (502)」)供展示与 404 判定
        if (e instanceof Error) {
          errorDetail = e.message || errorDetail;
          errorStatus = (e as Error & { status?: number }).status ?? null;
          const sid = (e as Error & { sessionId?: string }).sessionId;
          if (sid) lastSessionIdRef.current = sid;
        }
      } finally {
        window.clearTimeout(timeoutId);
        setBusy(false);
        setPending(false);
        abortRef.current = false;
        abortControllerRef.current = null;
      }

      // 404「会话不存在」(刷新后携带失效会话 id):自动降级为新会话重试一次,
      // 不再把 404 误报为「超时」(2026-08-25 用户实证「刷新后再提问立即超时」根因)
      if (failed && errorStatus === 404 && !resume) {
        activeConvIdRef.current = null;
        setActiveConvId(null);
        lastSessionIdRef.current = null;
        return requestReply(baseMsgs, docIds);
      }

      // 流内错误或零内容空响应,统一按失败处理;resume 回执允许空流(如 reject 仅确认落库)
      if (streamError || (!resume && !gotFirstChunkRef.current)) failed = true;

      // 用户主动停止:不补错误气泡,也不重写历史(保留已流出的内容)
      if (failed && userStoppedRef.current) return;

      // 流超时/中断但后端可能已落库:回放会话，有助手产出则不当失败
      if (failed && !streamError) {
        const sid = lastSessionIdRef.current ?? activeConvIdRef.current;
        if (sid && shouldRecoverFromTimeout(caughtErr ?? { message: errorDetail, status: errorStatus }, sid)) {
          try {
            const detail = await getAgentSession(sid);
            if (sessionHasAssistantAfterLastUser(detail.messages)) {
              const recovered = messagesToChat(detail.messages);
              setMessages(recovered);
              finishTurn(recovered);
              return;
            }
          } catch {
            /* 回放失败仍走下方错误气泡 */
          }
        }
      }

      if (failed) {
        const errMsg: ChatMessage = {
          id: genId(),
          role: "assistant",
          // 真实原因优先(后端 error 事件/HTTP detail);无法归因才回退通用超时文案
          content: errorDetail
            ? `回复失败:${errorDetail}`
            : "回复失败:连接中断或超时,请重试",
          timestamp: Date.now(),
          kind: "error",
        };
        setMessages((prev) => {
          const next = [...prev, errMsg];
          finishTurn(next);
          return next;
        });
      } else {
        setMessages((prev) => {
          finishTurn(prev);
          return prev;
        });
      }
    },
    [finishTurn, convStore],
  );

  // ───── 提案确认卡 / 作业卡轮询(2026-08-24 助手升级) ─────
  // 最新 messages 快照:提案按钮回调里发 resume 需要当前完整消息基(不依赖闭包旧值)
  const messagesRef = useRef<ChatMessage[]>([]);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);
  // 「修改」展开的提案卡 id + 修改意见草稿
  const [modifyFor, setModifyFor] = useState<string | null>(null);
  const [modifyNote, setModifyNote] = useState("");

  /** 提案卡三按钮:先落锤转只读,再走 resume(approve/modify/reject)接回流式处理。 */
  const onProposalDecision = useCallback(
    (card: AgentProposalCard, action: "approve" | "modify" | "reject", note?: string) => {
      setModifyFor(null);
      setModifyNote("");
      setMessages((prev) => markProposalResolved(prev, card.proposalId, action, note));
      const conversationId =
        activeConvIdRef.current ?? lastSessionIdRef.current ?? "";
      void requestReply(messagesRef.current, [], {
        proposalId: card.proposalId,
        action,
        note,
        conversationId,
      });
    },
    [requestReply],
  );

  // A2 画布编排:画布提案卡「在画布中打开」——取回图本体经 localStorage 手off 给画布视图
  const onOpenCanvasProposal = useCallback(
    async (card: AgentProposalCard) => {
      const conversationId =
        activeConvIdRef.current ?? lastSessionIdRef.current ?? "";
      if (!conversationId) {
        toast.error("没有可定位的会话,无法取回画布提案");
        return;
      }
      try {
        const { fetchAgentCanvasProposal } = await import("@/lib/api");
        const prop = await fetchAgentCanvasProposal(conversationId);
        localStorage.setItem(
          "toiv_canvas_proposal",
          JSON.stringify({ title: prop.title, warnings: prop.warnings, graph: prop.graph }),
        );
        goView("canvas");
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "取回画布提案失败");
      }
    },
    [goView, toast],
  );

  // 进行中作业卡 8s 轮询:无单 job 查询端点,复用列表端点(fetchJobsPage 直连网络,
  // 不走 listJobs 的 SWR 缓存防陈旧)按 job id / prompt_id 过滤回写;done 自动出列停轮询
  const activeJobKey = useMemo(() => {
    const ids: string[] = [];
    for (const m of messages) {
      for (const j of m.jobs ?? []) {
        if (isJobCardActive(j.status)) ids.push(j.jobId);
      }
    }
    return ids.sort().join(",");
  }, [messages]);

  useEffect(() => {
    if (!activeJobKey) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const rows = await fetchJobsPage(0, JOBS_PAGE_LIMIT);
        if (!cancelled) setMessages((prev) => applyJobSnapshots(prev, rows));
      } catch {
        /* 网络抖动下轮再试,卡片保持当前状态 */
      }
    };
    void poll();
    const timer = window.setInterval(poll, 8000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [activeJobKey]);

  /** 作业卡「停止」:cancelJob 中止后端,卡片立即转已中止。 */
  const onJobCancel = useCallback((jobId: string) => {
    setMessages((prev) => markJobCanceled(prev, jobId));
    void cancelJob(jobId).catch((e) => {
      toast.error(e instanceof Error ? e.message : "中止失败");
    });
  }, [toast]);

  const send = useCallback(
    async (presetPrompt?: string) => {
      const text = (presetPrompt ?? input).trim();
      if (!text || busy) return;

      const docs = attachedDocs.map((d) => ({ id: d.id, filename: d.filename }));
      const userMsg: ChatMessage = {
        id: genId(),
        role: "user",
        content: text,
        timestamp: Date.now(),
        docs: docs.length ? docs : undefined,
      };
      const newMsgs = [...messages, userMsg];
      setMessages(newMsgs);
      if (!presetPrompt) {
        setInput("");
      }
      setAttachedDocs([]); // 挂载随消息发出,芯片转移到消息气泡上
      setSkillDismissed(true); // 发送后收敛 @ 面板
      // @主体引用:把文本里的 @实体名 解析为 entity_ids(提及首现序)随本轮发送
      await requestReply(newMsgs, docs.map((d) => d.id), undefined, resolveEntityIds(text, subjectEntities));
    },
    [input, busy, messages, attachedDocs, subjectEntities, requestReply],
  );

  // 重试:摘掉末尾错误气泡,重发上一条用户消息所在的对话(复用上轮挂载的文档)
  const retry = useCallback(() => {
    if (busy) return;
    const base =
      messages[messages.length - 1]?.kind === "error"
        ? messages.slice(0, -1)
        : messages;
    setMessages(base);
    void requestReply(base, lastDocIdsRef.current);
  }, [busy, messages, requestReply]);

  const onStop = useCallback(() => {
    userStoppedRef.current = true;
    abortRef.current = true;
    abortControllerRef.current?.abort();
    setBusy(false);
    setPending(false);
    // 本轮已提交的生成作业:abort SSE 只停对话,GPU 作业要 cancelJob。
    const ids: string[] = [];
    for (const m of messagesRef.current) {
      for (const j of m.jobs ?? []) {
        if (isJobCardActive(j.status)) ids.push(j.jobId);
      }
    }
    for (const id of ids) {
      setMessages((prev) => markJobCanceled(prev, id));
      void cancelJob(id).catch((e) => {
        toast.error(e instanceof Error ? e.message : "中止失败");
      });
    }
  }, [toast]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Escape" && skillPanelVisible) {
        e.preventDefault();
        setSkillDismissed(true);
        return;
      }
      if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault();
        // @ 面板展开时 Enter = 选定首项(堆友交互;技能优先,无技能候选取首个主体);
        // 面板关闭/无候选时照常发送
        if (skillPanelVisible) {
          if (skillEntries.length > 0) onPickSkill(skillEntries[0].view);
          else onPickEntity(entityEntries[0]);
          return;
        }
        send();
      }
    },
    [send, skillPanelVisible, skillEntries, entityEntries, onPickSkill, onPickEntity],
  );

  const onOpenTasks = useCallback(() => {
    setPanelTab("tasks");
    setHistoryOpen(true);
    setDocsOpen(false);
  }, []);

  const onContinueTaskInChat = useCallback((draft: string) => {
    setInput(draft);
    setHistoryOpen(false);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, []);

  const tasksSlot = (
    <RecentTasksList
      active={historyOpen && panelTab === "tasks"}
      onContinueInChat={onContinueTaskInChat}
    />
  );

  /* 对话框(门户 C 位 / 会话底部两处复用):portal=true 时褪去底部固定档的渐变底与内边距 */
  const renderComposer = (portal: boolean) => (
    <Composer
      portal={portal}
      popup={popup}
      busy={busy}
      input={input}
      setInput={setInput}
      setSkillDismissed={setSkillDismissed}
      textareaRef={textareaRef}
      isMobileMq={isMobileMq}
      onKeyDown={onKeyDown}
      onStop={onStop}
      send={send}
      onNewChat={onNewChat}
      docsOpen={docsOpen}
      setDocsOpen={setDocsOpen}
      historyOpen={historyOpen}
      setHistoryOpen={(v) => {
        // 兼容 boolean | updater;打开历史默认会话分栏
        setHistoryOpen((prev) => {
          const next = typeof v === "function" ? v(prev) : v;
          if (next && !prev) setPanelTab("sessions");
          return next;
        });
      }}
      onOpenTasks={onOpenTasks}
      attachedDocs={attachedDocs}
      removeAttachedDoc={removeAttachedDoc}
      subjectEntities={subjectEntities}
      skillPanelVisible={skillPanelVisible}
      skillEntries={skillEntries}
      entityEntries={entityEntries}
      onPickSkill={onPickSkill}
      onPickEntity={onPickEntity}
      convDrawerRef={convDrawerRef}
      convStore={convStore}
      activeConvId={activeConvId}
      loadConversation={loadConversation}
      forkConversation={forkConversation}
      setConfirmDeleteConv={setConfirmDeleteConv}
      drawerTab={panelTab}
      setDrawerTab={setPanelTab}
      tasksSlot={tasksSlot}
    />
  );

  return (
    <div className={`av-view${popup ? " av-view--popup" : ""}`}>
      <h1 className="sr-only">智能体</h1>
      {/* Studio Console v1(2026-08-31):页头整体移除——顶部无 chrome;
          历史/新收进输入框工具行;2026-09-06 单色极简:模型行亦退役 */}

      {convStore.listError && (
        <ErrorBar message={convStore.listError} onClose={convStore.clearListError} />
      )}

      <div className="av-chat-wrap" ref={scrollRef}>

        {isEmpty ? (
          popup ? (
            /* 弹窗极简空态:标题 + 操作提示,输入框由底部 renderComposer 承担
               (Studio Console v1 起拉丁 kicker 铭牌退役,用户:文字太多) */
            <PopupEmpty isMobileMq={isMobileMq} />
          ) : (
          /* 门户空态(2026-09-06 单色极简改造):Fraunces 问候 + 输入框 + 极简场景入口行;
             铭牌/模型行/快捷提示 chips/最近作品带全部退役;
             版心 --layout-content,区块节奏 --space-3(2026-09-06 紧凑化;样式在 assistant.css 门户区块) */
          <PortalEmpty
            llmOffline={llmOffline}
            greeting={greeting}
            r18={r18}
            goView={goView}
            onChipPrompt={onChipPrompt}
            composer={renderComposer(true)}
          />
          )
        ) : (
          <AvMessageList
            messages={messages}
            showAllHistory={showAllHistory}
            setShowAllHistory={setShowAllHistory}
            pending={pending}
            busy={busy}
            retry={retry}
            toolCardCtx={toolCardCtx}
            onJobCancel={onJobCancel}
            onProposalDecision={onProposalDecision}
            onOpenCanvasProposal={onOpenCanvasProposal}
            modifyFor={modifyFor}
            setModifyFor={setModifyFor}
            modifyNote={modifyNote}
            setModifyNote={setModifyNote}
          />
        )}
      </div>

      {/* 会话态:对话框沉底(门户态时由 C 位 renderComposer(true) 承担;
          popup 形态空态也走底部输入框,保持「仅对话区+输入框」的弹窗心智) */}
      {(!isEmpty || popup) && renderComposer(false)}

      {!popup && (
        <>
      <div className={`av-panel av-panel--left${historyOpen ? " is-open" : ""}`}>
        <div className="av-panel-head">
          <div className="av-panel-tabs" role="tablist" aria-label="会话与任务">
            <button
              type="button"
              role="tab"
              className={`av-panel-tab${panelTab === "sessions" ? " is-active" : ""}`}
              aria-selected={panelTab === "sessions"}
              onClick={() => setPanelTab("sessions")}
            >
              对话历史
            </button>
            <button
              type="button"
              role="tab"
              className={`av-panel-tab${panelTab === "tasks" ? " is-active" : ""}`}
              aria-selected={panelTab === "tasks"}
              onClick={() => setPanelTab("tasks")}
            >
              最近任务
            </button>
          </div>
          <button type="button" className="av-panel-close" onClick={() => setHistoryOpen(false)} aria-label="关闭面板" title="关闭">
            <Icon name="close" size={12} strokeWidth={1.8} />
          </button>
        </div>
        <div className="av-panel-body">
          {panelTab === "tasks" ? (
            tasksSlot
          ) : (
            <ConvList
              convStore={convStore}
              activeConvId={activeConvId}
              loadConversation={loadConversation}
              forkConversation={forkConversation}
              setConfirmDeleteConv={setConfirmDeleteConv}
            />
          )}
        </div>
      </div>

      <div className={`av-panel av-panel--right${docsOpen ? " is-open" : ""}`}>
        <div className="av-panel-head">
          <span className="av-panel-title">文档</span>
          <button type="button" className="av-panel-close" onClick={() => setDocsOpen(false)} aria-label="关闭文档面板" title="关闭">
            <Icon name="close" size={12} strokeWidth={1.8} />
          </button>
        </div>
        <div className="av-panel-body">
          <button
            type="button"
            className="doc-upload-btn"
            onClick={() => docFileRef.current?.click()}
            disabled={docUploading}
          >
            <Icon name={docUploading ? "loading" : "upload"} size={13} strokeWidth={1.8} />
            {docUploading ? "上传中…" : `上传文件(${DOC_FORMAT_HINT})`}
          </button>
          {docList.length === 0 ? (
            <div className="av-panel-empty">
              <Icon name="file" size={20} strokeWidth={1.4} />
              <span>暂无文档,上传后可挂载到对话做长文本理解</span>
            </div>
          ) : (
            <div className="doc-list">
              {docList.map((doc) => {
                const attached = attachedDocs.some((d) => d.id === doc.id);
                return (
                  <div key={doc.id} className={`doc-item${attached ? " is-attached" : ""}`}>
                    <button
                      type="button"
                      className="doc-item-main"
                      onClick={() => toggleAttachDoc(doc)}
                      title={attached ? "取消挂载" : "挂载到下一条消息"}
                    >
                      <div className="doc-item-info">
                        <span className="doc-item-name">
                          <Icon name={docKindIcon(doc.kind)} size={12} strokeWidth={1.8} />
                          {doc.filename}
                        </span>
                        <span className="doc-item-meta">
                          {doc.kind.toUpperCase()} · {formatDocSize(doc.size)} · {doc.chunk_count} 块 · {docStatusLabel(doc.status)}
                        </span>
                      </div>
                      <span className={`doc-item-check${attached ? " is-on" : ""}`}>
                        <Icon name="check" size={12} strokeWidth={2} />
                      </span>
                    </button>
                    <button
                      type="button"
                      className="doc-item-delete"
                      onClick={() => setConfirmDeleteDoc(doc)}
                      title="删除文档"
                      aria-label={`删除文档 ${doc.filename}`}
                    >
                      <Icon name="delete" size={11} strokeWidth={1.8} />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
        </>
      )}

      <input
        ref={docFileRef}
        type="file"
        accept={DOC_ACCEPT}
        className="doc-file-input"
        onChange={onPickDocFile}
        aria-hidden="true"
        tabIndex={-1}
      />

      {!popup && (historyOpen || docsOpen) && (
        <div
          className="av-panel-overlay"
          onClick={() => { setHistoryOpen(false); setDocsOpen(false); }}
        />
      )}

      {/* 删除确认弹窗组(P0-2):会话/文档删除均不可逆,统一走 Modal 确认后执行 */}
      <DeleteConfirmModals
        confirmDeleteConv={confirmDeleteConv}
        setConfirmDeleteConv={setConfirmDeleteConv}
        deleteConversation={deleteConversation}
        confirmDeleteDoc={confirmDeleteDoc}
        setConfirmDeleteDoc={setConfirmDeleteDoc}
        docDeleting={docDeleting}
        onDeleteDoc={onDeleteDoc}
      />
    </div>
  );
}
