"use client";

import { useState, useRef, useEffect, useCallback, useMemo, lazy, Suspense, type ReactNode } from "react";
import { Icon, type IconName } from "@/components/ui/Icon";
import { Button } from "@/components/ui/Button";
import { ErrorBar } from "@/components/ui/ErrorBar";
import { LoadingBlock } from "@/components/ui/LoadingBlock";
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
  entityKindLabel,
  entityThumbUrl,
  type EntityInfo,
} from "@/lib/entities";
import { EntityRefsPreview } from "@/components/ui/PromptWithEntities";
import { isVideoKind, kindLabel, kindToFilter } from "@/lib/libraryQuery";
import { mediaKindOf } from "@/lib/mediaKind";
import { ModelViewer } from "@/components/ui/ModelViewer";
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
  docKindFromFilename,
  docKindIcon,
  docStatusLabel,
  formatDocSize,
  listDocs,
  uploadDoc,
} from "@/lib/docs";
import { genId } from "@/lib/id";
import { useBreakpoint } from "@/lib/useBreakpoint";
import { useAutoResize } from "@/hooks/useAutoResize";
import "@/app/styles/docs.css";
import "@/app/styles/assistant.css";

// 模型名从 /api/system/llm 动态读取(display_model),不再硬编码;
// W4(2026-08-31 精简):首页/设置面板的固定文案描述全部移除,模型身份以实时名为准

// Modal 走 lazy(同 ResourcesView 懒加载范式):node:test 直接 import 本文件但不渲染视图,
// lazy 可避开链接期触达 ui/Modal → hooks/useFocusTrap(.ts 不经测试 loader 转译,
// 其 `RefObject` 值导入在 node ESM type-stripping 下会抛 named export 错);
// 生产端 chunk 随视图挂载即预热,打开确认弹窗无感知
const Modal = lazy(() =>
  import("@/components/ui/Modal").then((m) => ({ default: m.Modal })),
);

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
  for (const m of rows) {
    const ts = Date.parse(m.created_at) || Date.now();
    if (m.role === "user" || m.role === "assistant") {
      // 空 assistant 轮(工具调用中间轮)跳过;媒体由随后 tool 行并入下一条可见气泡
      if (m.role === "assistant" && !m.content.trim() && !(m.media?.length)) continue;
      out.push({ id: `srv-${m.id}`, role: m.role, content: m.content, timestamp: ts });
    } else if (m.role === "tool" && m.media?.length) {
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
    }
  }
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

/** 进行中作业状态(需前端轮询跟进)。 */
export const JOB_CARD_ACTIVE_STATUSES = ["queued", "held", "running"] as const;

export function isJobCardActive(status: string): boolean {
  return (JOB_CARD_ACTIVE_STATUSES as readonly string[]).includes(status);
}

/** 作业卡状态徽章文案(纯函数,单测锚点)。 */
export function jobCardStatusLabel(status: string): string {
  switch (status) {
    case "queued":
      return "排队中";
    case "held":
      return "资源等待";
    case "running":
      return "运行中";
    case "done":
      return "完成";
    case "error":
      return "失败";
    case "canceled":
      return "已中止";
    default:
      return status || "排队中";
  }
}

/** 作业产物 → 媒体渲染分支(纯函数,单测锚点)。
 *  已收敛为 lib/mediaKind.mediaKindOf 的薄封装(扩展名优先、kind 兜底),勿再各自维护正则。 */
export function mediaTypeForJob(kind: string, url = ""): string {
  return mediaKindOf(url, kind);
}

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

  return {
    serverMode,
    conversations: serverMode ? serverConvs : localConvs,
    listError,
    clearListError: () => setListError(null),
    open,
    register,
    remove,
  };
}

function getPreview(text: string, max = 28) {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max) + "…" : t;
}

// ───── 助手气泡行内 markdown(2026-08-16 审计修复):最小手写解析,不引第三方 md 库 ─────
// 此前气泡纯文本直出,LLM 的 `**` 标记原样泄漏。边界规则(CommonMark flanking 简化版):
// 开定界符后随空白不成立(`* *操作:…` 保持原文,不吞星号),闭定界符前是空白也不成立;
// 内容可含全角引号与单 `*`(`**…"视频超分"…**` 整体加粗,不会被引号/嵌套星号截断)。
const BOLD_RE = /\*\*(?=\S)([\s\S]*?\S)\*\*/g;
const ITALIC_RE = /\*(?=\S)([^*\n]*?\S)\*/g;

/** 片段内斜体替换(星号配对失败的按原文保留)。 */
function renderItalicSegments(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(ITALIC_RE)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push(text.slice(last, idx));
    out.push(<em key={`${keyPrefix}i${idx}`}>{m[1]}</em>);
    last = idx + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** 助手消息行内渲染:`**加粗**` / `*斜体*`;仅助手气泡使用(用户消息纯文本直出,避免 `2*3*5` 误斜体)。 */
export function renderInlineMarkdown(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(BOLD_RE)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push(...renderItalicSegments(text.slice(last, idx), `p${idx}`));
    out.push(<strong key={`b${idx}`}>{renderItalicSegments(m[1], `b${idx}`)}</strong>);
    last = idx + m[0].length;
  }
  if (last < text.length) out.push(...renderItalicSegments(text.slice(last), `t${last}`));
  return out;
}

/** 媒体产物渲染(image/video/audio/model3d 四分支):消息气泡媒体与作业卡 done 产物共用。
 *  W4 修复(2026-08-31):src 一律经 imageUrl 补 token——/api/images 强制登录态
 *  (Bearer 或 ?token=),<img>/<video> 无法带请求头,裸 sig URL 会 401 破图;
 *  渲染时现取现 token,轮换/续期自然跟随。 */
export function renderAvMedia(
  m: { type: string; urls: string[] },
  key: number | string,
): ReactNode {
  const src = m.urls[0] ? imageUrl(m.urls[0]) : "";
  return (
    <div key={key} className="av-media">
      {m.type === "image" && src && (
        <img
          src={src}
          alt="生成结果"
          className="av-media-img"
          loading="lazy"
          decoding="async"
        />
      )}
      {m.type === "video" && src && (
        <video src={src} controls className="av-media-video" />
      )}
      {m.type === "audio" && src && (
        <audio src={src} controls className="av-media-audio" />
      )}
      {m.type === "model3d" && src && (
        <>
          <div className="av-media-3d">
            <ModelViewer src={src} />
          </div>
          <a
            href={src}
            target="_blank"
            rel="noreferrer"
            className="av-media-link"
          >
            <Icon name="box" size={14} strokeWidth={1.8} />
            下载 3D 模型
          </a>
        </>
      )}
    </div>
  );
}

// ───── W4(2026-08-31)产物胶片条:对话流内多产物以 Film Atelier 胶片条横排内嵌 ─────

export interface AvMediaGroup {
  type: string;
  urls: string[];
}
export interface AvFrame {
  type: string;
  url: string;
}

/** 拍平媒体组为视觉帧序列(纯函数,单测锚点):仅 image/video 成帧;
 *  audio/model3d 非视觉产物不进胶片条,由调用方走 renderAvMedia 块级渲染。 */
export function flattenVisualFrames(media: readonly AvMediaGroup[]): AvFrame[] {
  const out: AvFrame[] = [];
  for (const m of media) {
    if (m.type !== "image" && m.type !== "video") continue;
    for (const u of m.urls) if (u) out.push({ type: m.type, url: u });
  }
  return out;
}

/** ≥2 帧走胶片条(导轨+打孔+帧号);单帧保持 renderAvMedia hero 直出;零帧不渲染。 */
export function renderAvFrames(frames: readonly AvFrame[], keyPrefix: string): ReactNode {
  if (frames.length === 0) return null;
  if (frames.length === 1) {
    return renderAvMedia({ type: frames[0].type, urls: [frames[0].url] }, `${keyPrefix}-0`);
  }
  return (
    <div className="av-filmstrip" role="group" aria-label="产物胶片条">
      <div className="av-filmstrip-track">
        {frames.map((f, i) => {
          // imageUrl 补 token(同 renderAvMedia 的 W4 修复):裸 sig URL 在 <img> 下 401
          const src = imageUrl(f.url);
          return (
          <figure key={`${keyPrefix}-${i}`} className="av-film-frame">
            {f.type === "video" ? (
              <video src={src} controls className="av-film-media" />
            ) : (
              <img
                src={src}
                alt={`产物 ${i + 1}`}
                className="av-film-media"
                loading="lazy"
                decoding="async"
              />
            )}
            <figcaption className="av-film-no">{String(i + 1).padStart(2, "0")}</figcaption>
          </figure>
          );
        })}
      </div>
    </div>
  );
}

/** 消息媒体列表:视觉帧进胶片条(或单帧 hero),audio/3d 块级跟随。 */
export function AvMediaList({ media }: { media: readonly AvMediaGroup[] }) {
  const frames = flattenVisualFrames(media);
  const blocks = media.filter((m) => m.type !== "image" && m.type !== "video");
  return (
    <>
      {renderAvFrames(frames, "ms")}
      {blocks.map((m, i) => renderAvMedia(m, `mb${i}`))}
    </>
  );
}

/** 作业卡 done 产物:results 逐个判定媒体类型后同上分流(视觉帧胶片条化)。 */
export function AvJobResults({
  kind,
  results,
  jobId,
}: {
  kind: string;
  results: readonly string[];
  jobId: string;
}) {
  const groups = results
    .filter(Boolean)
    .map((u) => ({ type: mediaTypeForJob(kind, u), urls: [u] }));
  const frames = flattenVisualFrames(groups);
  const blocks = groups.filter((g) => g.type !== "image" && g.type !== "video");
  return (
    <>
      {renderAvFrames(frames, `j${jobId}`)}
      {blocks.map((m, i) => renderAvMedia(m, `jb${jobId}-${i}`))}
    </>
  );
}

/** 同消息多作业卡产物聚合(纯函数,单测锚点):≥2 个 done 卡且合并视觉帧 ≥2 时,
 *  产物从各卡抽出、合并为一条胶片条(卡内不再重复渲染,对话流更紧凑);
 *  否则返回空数组,各卡照旧自带产物。 */
export function aggregateJobFrames(jobs: readonly AgentJobCard[]): AvFrame[] {
  const done = jobs.filter((j) => j.status === "done" && j.results?.length);
  if (done.length < 2) return [];
  const frames: AvFrame[] = [];
  for (const j of done) {
    for (const u of j.results ?? []) {
      if (!u) continue;
      const t = mediaTypeForJob(j.kind, u);
      if (t === "image" || t === "video") frames.push({ type: t, url: u });
    }
  }
  return frames.length >= 2 ? frames : [];
}

/** 作业卡组 + 聚合胶片条(W4):卡片只承担状态/进度/中止,视觉产物统一汇聚展示。 */
export function AvJobCards({
  jobs,
  msgId,
  onCancel,
}: {
  jobs: readonly AgentJobCard[];
  msgId: string;
  onCancel: (jobId: string) => void;
}) {
  const agg = aggregateJobFrames(jobs);
  return (
    <>
      {jobs.map((j) => (
        <div key={j.jobId} className={`av-job-card is-${isJobCardActive(j.status) ? "active" : j.status}`}>
          <div className="av-job-card-head">
            <span className="av-job-card-kind">
              <Icon name={isVideoKind(j.kind) ? "video" : kindToFilter(j.kind) === "audio" ? "audio" : kindToFilter(j.kind) === "3d" ? "box" : "image"} size={12} strokeWidth={1.8} />
              {kindLabel(j.kind)}
            </span>
            <span className="av-job-card-actions">
              <span className={`av-job-badge is-${j.status}`}>
                {jobCardStatusLabel(j.status)}
              </span>
              {isJobCardActive(j.status) ? (
                <button
                  type="button"
                  className="av-job-cancel"
                  title="中止后端作业并停止本页跟踪"
                  onClick={() => onCancel(j.jobId)}
                >
                  停止
                </button>
              ) : null}
            </span>
          </div>
          {j.label ? <div className="av-job-card-label">{j.label}</div> : null}
          {j.status === "held" && j.holdReason ? (
            <div className="av-job-card-hold">{j.holdReason}</div>
          ) : null}
          {/* 聚合模式:产物上移合并胶片条,卡内不再重复渲染 */}
          {agg.length === 0 && j.status === "done" && j.results?.length ? (
            <AvJobResults kind={j.kind} results={j.results} jobId={j.jobId} />
          ) : null}
        </div>
      ))}
      {agg.length > 0 && renderAvFrames(agg, `agg-${msgId}`)}
    </>
  );
}

// ───── @ 技能面板 / 离线降级入口(Studio Console v1:首页空态只剩输入框,
//        旧「引擎胶囊/场景 chip/快捷 chip/最近作品」门户区块已全部退役) ─────

interface PortalEntry {
  view: string;
  icon: IconName;
  label: string;
  desc: string;
  /** r18 = 仅 R18 模式渲染(drama 视图受 page.tsx 全局门控);sfwOnly = 仅 SFW 模式补位 */
  r18?: boolean;
  sfwOnly?: boolean;
}

/** @ 技能面板一期内容 = 工作台快捷入口(二期接 Skills 广场)。 */
export const SKILL_ENTRIES: PortalEntry[] = [
  { view: "drama", icon: "clapperboard", label: "短剧工作台", desc: "剧本到成片的全链路工作台", r18: true },
  { view: "image", icon: "image", label: "图像创作", desc: "文生图 / 图生图" },
  { view: "video", icon: "video", label: "视频创作", desc: "H3 / LongCat" },
  { view: "audio", icon: "audio", label: "音频工坊", desc: "音乐 / 配音 / 人声分离" },
  { view: "avatartalk", icon: "user", label: "数字人", desc: "照片说话 / 对口型" },
  { view: "library", icon: "library", label: "作品库", desc: "全部生成产物" },
];

/** W5 助手离线降级(2026-08-31):对话不可用时,门户展开全量工作台导航(替代对话框)。
 *  覆盖 L1 工作台层全部高频页,顺序与导航分组一致;drama 走 studio 直达(旧管线已退役)。 */
export const OFFLINE_ENTRIES: PortalEntry[] = [
  { view: "image", icon: "image", label: "图像", desc: "文生图 · 图生图" },
  { view: "video", icon: "video", label: "视频", desc: "H3 · LongCat" },
  { view: "audio", icon: "audio", label: "音频", desc: "音乐 · 配音" },
  { view: "studio", icon: "clapperboard", label: "工作室", desc: "短剧全流程" },
  { view: "avatartalk", icon: "user", label: "数字人", desc: "说话视频" },
  { view: "dub", icon: "mic", label: "译制", desc: "听写 · 配音" },
  { view: "imageEdit", icon: "palette", label: "图片编辑", desc: "重绘 · 扩图" },
  { view: "videoEdit", icon: "film", label: "视频剪辑", desc: "裁剪 · 补帧" },
  { view: "canvas", icon: "grid", label: "画布", desc: "专家工作流" },
  { view: "library", icon: "library", label: "作品库", desc: "全部产物" },
  { view: "entities", icon: "users", label: "主体库", desc: "角色 · 场景" },
  { view: "market", icon: "package", label: "市场", desc: "应用 · 技能" },
];

/** 按 R18 模式过滤门户入口(纯函数,单测锚点)。 */
export function filterPortalEntries(
  entries: readonly PortalEntry[],
  r18: boolean,
): PortalEntry[] {
  return entries.filter((e) => (e.r18 ? r18 : true) && (e.sfwOnly ? !r18 : true));
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
  const [modelName, setModelName] = useState("探测中");
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

  // ───── @ 面板 / R18 模式(Studio Console v1:引擎胶囊与最近作品门户区块已退役) ─────
  const [r18] = useR18Mode();
  // @ 技能面板:Esc/选定后关闭;输入再变化时重新允许弹出
  const [skillDismissed, setSkillDismissed] = useState(false);

  /** 视图跳转:优先 page.tsx SPA 切换(带 View Transitions),缺省整页跳转。 */
  const goView = useCallback(
    (view: string) => {
      if (onNavigate) onNavigate(view);
      else if (typeof window !== "undefined") window.location.assign(`/?view=${view}`);
    },
    [onNavigate],
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

  /** 选定技能入口:剥掉尾部的 @触发词,跳转对应视图。 */
  const onPickSkill = useCallback(
    (view: string) => {
      setInput((prev) => prev.replace(/@[^@]*$/, ""));
      setSkillDismissed(true);
      goView(view);
    },
    [goView],
  );

  /** 选定主体:@触发词 → `@实体名 `(文本内引用,不跳转;发送时解析为 entity_ids)。 */
  const onPickEntity = useCallback((ent: EntityInfo) => {
    setInput((prev) => prev.replace(/@[^@]*$/, `@${ent.name} `));
    setSkillDismissed(true);
    textareaRef.current?.focus();
  }, []);

  // 顶栏/设置面板的模型名跟随后端真实配置,避免显示与实际调用不一致;
  // W5(2026-08-31):同一探测兼任助手可用性哨兵——null/失败即离线,门户降级为纯工作台导航
  useEffect(() => {
    const ac = new AbortController();
    getLlmModel(ac.signal).then((info) => {
      if (info?.display_model) setModelName(info.display_model);
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

  const deleteConversation = useCallback(
    (id: string) => {
      void convStore.remove(id);
      if (activeConvId === id) {
        onNewChat();
      }
    },
    [activeConvId, onNewChat, convStore],
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

  const formatTime = (ts: number) => {
    const d = new Date(ts);
    return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
  };

  /* 会话列表(页形态历史面板 / popup 会话抽屉共用):加载态/空态/列表三分支,
     点击切换走 loadConversation(复用服务端回放),删除走二次确认 Modal */
  const renderConvList = () =>
    convStore.serverMode === null ? (
      <LoadingBlock variant="line" count={4} />
    ) : conversations.length === 0 ? (
      <div className="av-panel-empty">
        <Icon name="chat" size={20} strokeWidth={1.4} />
        <span>暂无历史对话</span>
      </div>
    ) : (
      <div className="av-conv-list">
        {conversations.map((conv) => (
          <div
            key={conv.id}
            className={`av-conv-item${activeConvId === conv.id ? " is-active" : ""}`}
          >
            <button
              type="button"
              className="av-conv-main"
              onClick={() => loadConversation(conv)}
            >
              <div className="av-conv-info">
                <span className="av-conv-title">{conv.title}</span>
                <span className="av-conv-meta">
                  {conv.messageCount ?? conv.messages.length} 条消息 · {formatTime(conv.updatedAt)}
                </span>
              </div>
            </button>
            <button
              type="button"
              className="av-conv-delete"
              onClick={(e) => { e.stopPropagation(); setConfirmDeleteConv(conv); }}
              title="删除对话"
              aria-label={`删除对话 ${conv.title}`}
            >
              <Icon name="delete" size={11} strokeWidth={1.8} />
            </button>
          </div>
        ))}
      </div>
    );

  /* 对话框(门户 C 位 / 会话底部两处复用):portal=true 时褪去底部固定档的渐变底与内边距 */
  const renderComposer = (portal: boolean) => (
    <div className={`av-composer${portal ? " av-composer--portal" : ""}`}>
      {attachedDocs.length > 0 && (
        <div className="doc-chips doc-chips--composer">
          {attachedDocs.map((d) => (
            <span key={d.id} className="doc-chip doc-chip--removable">
              <Icon name={docKindIcon(d.kind)} size={11} strokeWidth={1.8} />
              {d.filename}
              <button
                type="button"
                className="doc-chip-x"
                onClick={() => removeAttachedDoc(d.id)}
                aria-label={`移除文档 ${d.filename}`}
                title="移除"
              >
                <Icon name="close" size={10} strokeWidth={2} />
              </button>
            </span>
          ))}
        </div>
      )}
      {/* @主体引用预览:输入中的 @实体名 实时显示绑定 chip(图N);
          × 移除引用;实体库为空/未加载时自动隐藏,纯文本输入零影响 */}
      <EntityRefsPreview value={input} entities={subjectEntities} onChange={setInput} />
      <div className="av-composer-anchor">
        {/* popup 会话抽屉(锚于输入框上方,与 @ 技能面板同位):
            列表/切换/新建/删除全复用页形态逻辑;Esc/点外部关闭 */}
        {popup && (
          <div
            ref={convDrawerRef}
            className={`av-pop-conv${historyOpen ? " is-open" : ""}`}
            role="menu"
            aria-label="会话管理"
            aria-hidden={!historyOpen}
          >
            <div className="av-pop-conv-head">
              <span className="av-pop-conv-title">会话</span>
              <button
                type="button"
                className="av-tb-btn av-pop-conv-new"
                onClick={() => {
                  onNewChat();
                  setHistoryOpen(false);
                }}
                title="新会话"
                aria-label="新会话"
              >
                <Icon name="create" size={13} strokeWidth={1.8} />
                <span>新会话</span>
              </button>
            </div>
            <div className="av-pop-conv-body">{renderConvList()}</div>
          </div>
        )}
        {/* @ 技能面板(一期 = 工作台快捷入口;视觉与 at-card 同构)。
            2026-08-26 起并入第二分组「主体」(@主体引用):选定插入 @实体名 文本引用,
            不跳转;发送时解析为 entity_ids 传给后端 */}
        {skillPanelVisible && (
          <div className="av-skill-panel at-card" role="menu" aria-label="技能、工作台与主体库快捷入口">
            {skillEntries.length > 0 && (
              <div className="av-skill-panel-head">
                <span className="av-skill-panel-title">技能 / 工作台</span>
                <span className="av-skill-panel-hint">Enter 选定首项 · Esc 关闭</span>
              </div>
            )}
            {skillEntries.map((entry) => (
              <button
                key={entry.view}
                type="button"
                role="menuitem"
                className="av-skill-item"
                onClick={() => onPickSkill(entry.view)}
              >
                <span className="av-skill-item-icon">
                  <Icon name={entry.icon} size={14} strokeWidth={1.8} />
                </span>
                <span className="av-skill-item-main">
                  <span className="av-skill-item-label">{entry.label}</span>
                  <span className="av-skill-item-desc">{entry.desc}</span>
                </span>
              </button>
            ))}
            {entityEntries.length > 0 && (
              <div className="av-skill-panel-head">
                <span className="av-skill-panel-title">主体</span>
                <span className="av-skill-panel-hint">选定后插入 @名字 引用</span>
              </div>
            )}
            {entityEntries.map((ent) => (
              <button
                key={ent.id}
                type="button"
                role="menuitem"
                className="av-skill-item"
                onClick={() => onPickEntity(ent)}
              >
                <span className="av-skill-item-icon">
                  {entityThumbUrl(ent) ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img className="av-skill-item-thumb" src={entityThumbUrl(ent)} alt="" aria-hidden="true" />
                  ) : (
                    <Icon name="user" size={14} strokeWidth={1.8} />
                  )}
                </span>
                <span className="av-skill-item-main">
                  <span className="av-skill-item-label">@{ent.name}</span>
                  <span className="av-skill-item-desc">
                    {entityKindLabel(ent.kind)} · 引用为 图片{resolveEntityIds(input, subjectEntities).length + 1}
                  </span>
                </span>
              </button>
            ))}
          </div>
        )}
        <div className="av-composer-box">
          <div className="av-composer-actions av-composer-actions--left">
            {busy ? (
              <button type="button" className="av-composer-btn av-composer-stop" onClick={onStop} title="停止本轮回复并中止已提交的生成作业">
                <Icon name="minus" size={12} strokeWidth={2.2} />
              </button>
            ) : !popup ? (
              <>
              <button
                type="button"
                className={`av-composer-btn av-composer-btn-ghost av-composer-tool${docsOpen || attachedDocs.length ? " is-active" : ""}`}
                title="文档(上传/挂载,供长文本理解)"
                aria-label="文档"
                onClick={() => setDocsOpen((v) => !v)}
              >
                <Icon name="plus" size={14} strokeWidth={1.8} />
              </button>
              {/* Studio Console v1:历史/新对话从已退役页头收进输入框工具行 */}
              <button
                type="button"
                className={`av-composer-btn av-composer-btn-ghost av-composer-tool${historyOpen ? " is-active" : ""}`}
                title="对话历史"
                aria-label="对话历史"
                onClick={() => setHistoryOpen((v) => !v)}
              >
                <Icon name="history" size={14} strokeWidth={1.8} />
              </button>
              <button
                type="button"
                className="av-composer-btn av-composer-btn-ghost av-composer-tool"
                title="新对话"
                aria-label="新对话"
                onClick={onNewChat}
              >
                <Icon name="create" size={14} strokeWidth={1.8} />
              </button>
              </>
            ) : (
              /* popup:文档入口让位于「会话」按钮(历史/新建/删除抽屉) */
              <button
                type="button"
                className={`av-composer-btn av-composer-btn-ghost av-composer-tool av-pop-conv-toggle${historyOpen ? " is-active" : ""}`}
                title="会话(历史/新建/删除)"
                aria-label="会话管理"
                onClick={() => setHistoryOpen((v) => !v)}
              >
                <Icon name="history" size={14} strokeWidth={1.8} />
              </button>
            )}
          </div>
          <textarea
            ref={textareaRef}
            className="av-composer-input"
            placeholder={isMobileMq ? "说出你的创意,或输入 @ 调用技能/引用主体…" : "说出你的创意,或输入 @ 调用技能/引用主体…（Enter 发送 / Shift+Enter 换行）"}
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              setSkillDismissed(false); // 输入变化时重新允许 @ 面板弹出
            }}
            onKeyDown={onKeyDown}
            rows={1}
            disabled={busy}
          />
          <div className="av-composer-actions">
            <button
              type="button"
              className="av-composer-btn av-composer-send"
              onClick={() => send()}
              disabled={!input.trim() || busy}
              title="发送"
            >
              <Icon name="send" size={14} strokeWidth={1.8} />
            </button>
          </div>
        </div>
      </div>
      <div className="av-composer-hint">
        <span>内容由 AI 生成，请注意甄别</span>
      </div>
    </div>
  );

  return (
    <div className={`av-view${popup ? " av-view--popup" : ""}`}>
      <h1 className="sr-only">对话流</h1>
      {/* Studio Console v1(2026-08-31):页头整体移除——顶部无 chrome;
          历史/新收进输入框工具行,模型名在空态输入框下方,模型设置面板退役 */}

      {convStore.listError && (
        <ErrorBar message={convStore.listError} onClose={convStore.clearListError} />
      )}

      <div className="av-chat-wrap" ref={scrollRef}>

        {isEmpty ? (
          popup ? (
            /* 弹窗极简空态:标题 + 操作提示,输入框由底部 renderComposer 承担
               (Studio Console v1 起拉丁 kicker 铭牌退役,用户:文字太多) */
            <div className="av-empty av-popup-empty">
              <div className="av-empty-title">有什么可以帮你?</div>
              <div className="av-empty-desc">输入内容开始对话 · Esc 或点击遮罩关闭</div>
              <div className="av-popup-empty-hint">Shift+Enter 随时唤起/关闭</div>
            </div>
          ) : (
          /* Studio Console v1(2026-08-31)极简空态:品牌铭牌 + 无边框输入框 + 模型行,
             仅此而已——没有胶囊/chip/推荐卡/最近作品/粒子;功能由对话、⌘K、左栏驱动 */
          <div className="av-empty av-portal av-portal--console">
            <div className="av-console-wordmark" aria-hidden="true">TOIV</div>
            {llmOffline ? (
              /* W5 助手离线降级:对话框让位「离线提示 + 全量工作台导航」 */
              <>
                <div className="av-offline" role="alert">
                  <Icon name="warning" size={16} strokeWidth={1.8} />
                  <span className="av-offline-title">助手暂时离线</span>
                  <span className="av-offline-desc">对话能力暂不可用,可直接使用下方工作台继续创作。</span>
                </div>
                <div className="av-scene-row av-scene-row--offline">
                  {OFFLINE_ENTRIES.map((c) => (
                    <button
                      key={c.view}
                      type="button"
                      className="av-scene-chip"
                      title={c.desc}
                      onClick={() => goView(c.view)}
                    >
                      <Icon name={c.icon} size={14} strokeWidth={1.8} />
                      <span>{c.label}</span>
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <>
                <div className="av-portal-composer">{renderComposer(true)}</div>
                <div className="av-console-model">{modelName}</div>
              </>
            )}
          </div>
          )
        ) : (
          <div className="av-msg-list">
            {(() => {
              const MSG_RENDER_WINDOW = 80;
              const hiddenCount = showAllHistory ? 0 : Math.max(0, messages.length - MSG_RENDER_WINDOW);
              const visible = hiddenCount > 0 ? messages.slice(-MSG_RENDER_WINDOW) : messages;
              return (
                <>
                  {hiddenCount > 0 && (
                    <button
                      type="button"
                      className="av-msg-history-more"
                      onClick={() => setShowAllHistory(true)}
                    >
                      加载更早的 {hiddenCount} 条消息(默认只渲染最近 {MSG_RENDER_WINDOW} 条,防长会话卡顿)
                    </button>
                  )}
                  {visible.map((msg) => (
              <div
                key={msg.id}
                className={`av-msg${msg.role === "user" ? " is-user" : " is-assistant"}`}
              >
                <div className="av-msg-body">
                  <div className={`av-msg-bubble${msg.kind === "error" ? " av-msg-bubble--error" : ""}`}>
                    {msg.kind === "error" ? (
                      <>
                        <span className="av-msg-error-text">{msg.content}</span>
                        <button
                          type="button"
                          className="av-msg-retry"
                          onClick={retry}
                          disabled={busy}
                          title="重发上一条消息"
                        >
                          <Icon name="refresh" size={12} strokeWidth={1.8} />
                          <span>重试</span>
                        </button>
                      </>
                    ) : msg.content || msg.media?.length || msg.tools?.length || msg.jobs?.length || msg.proposals?.length ? (
                      <>
                        {msg.docs?.length ? (
                          <span className="doc-chips doc-chips--msg">
                            {msg.docs.map((d) => (
                              <span key={d.id} className="doc-chip">
                                <Icon name={docKindIcon(docKindFromFilename(d.filename))} size={11} strokeWidth={1.8} />
                                {d.filename}
                              </span>
                            ))}
                          </span>
                        ) : null}
                        {msg.role === "assistant" ? renderInlineMarkdown(msg.content) : msg.content}
                        {/* 工具调用小条:转圈(start)/绿勾(ok)/红叉(error+detail) */}
                        {msg.tools?.map((t) => (
                          <div key={t.id} className={`av-tool-chip is-${t.status}`}>
                            <span className="av-tool-chip-icon">
                              <Icon
                                name={t.status === "start" ? "loading" : t.status === "ok" ? "check" : "close"}
                                size={12}
                                strokeWidth={2}
                              />
                            </span>
                            <span className="av-tool-chip-text">
                              <span className="av-tool-chip-summary">{t.summary || t.name}</span>
                              {t.status === "error" && t.detail ? (
                                <span className="av-tool-chip-detail">{t.detail}</span>
                              ) : null}
                            </span>
                          </div>
                        ))}
                        {/* 生成作业卡:kind 中文名 + label + 状态徽章;W4 起经 AvJobCards
                            聚合——同消息 ≥2 个 done 作业的视觉产物合并为一条胶片条 */}
                        {msg.jobs?.length ? (
                          <AvJobCards jobs={msg.jobs} msgId={msg.id} onCancel={onJobCancel} />
                        ) : null}
                        {/* 提案确认卡:确认执行/修改/放弃;落锤后只读 */}
                        {msg.proposals?.map((p) => (
                          <div key={p.proposalId} className={`av-proposal${p.resolution ? " is-resolved" : ""}`}>
                            <div className="av-proposal-head">
                              <Icon name="sparkles" size={13} strokeWidth={1.8} />
                              <span className="av-proposal-title">{p.title}</span>
                              {p.estimate ? (
                                <span className="av-proposal-estimate">{p.estimate}</span>
                              ) : null}
                            </div>
                            {p.body ? (
                              <div className="av-proposal-body">{renderInlineMarkdown(p.body)}</div>
                            ) : null}
                            {p.resolution ? (
                              <div className={`av-proposal-result is-${p.resolution}`}>
                                <Icon
                                  name={p.resolution === "reject" ? "close" : "check"}
                                  size={12}
                                  strokeWidth={2}
                                />
                                {p.resolution === "approve"
                                  ? "已确认执行"
                                  : p.resolution === "modify"
                                    ? "已修改并执行"
                                    : "已放弃"}
                                {p.resolution === "modify" && p.note ? (
                                  <span className="av-proposal-result-note">{p.note}</span>
                                ) : null}
                              </div>
                            ) : (
                              <>
                                <div className="av-proposal-actions">
                                  <button
                                    type="button"
                                    className="av-proposal-btn is-primary"
                                    disabled={busy}
                                    onClick={() => onProposalDecision(p, "approve")}
                                  >
                                    确认执行
                                  </button>
                                  <button
                                    type="button"
                                    className="av-proposal-btn"
                                    disabled={busy}
                                    onClick={() => {
                                      setModifyFor(modifyFor === p.proposalId ? null : p.proposalId);
                                      setModifyNote("");
                                    }}
                                  >
                                    修改
                                  </button>
                                  <button
                                    type="button"
                                    className="av-proposal-btn is-danger"
                                    disabled={busy}
                                    onClick={() => onProposalDecision(p, "reject")}
                                  >
                                    放弃
                                  </button>
                                </div>
                                {modifyFor === p.proposalId && (
                                  <div className="av-proposal-modify">
                                    <textarea
                                      className="av-proposal-note"
                                      placeholder="填写修改意见…"
                                      value={modifyNote}
                                      onChange={(e) => setModifyNote(e.target.value)}
                                      rows={3}
                                    />
                                    <button
                                      type="button"
                                      className="av-proposal-btn is-primary"
                                      disabled={busy || !modifyNote.trim()}
                                      onClick={() => onProposalDecision(p, "modify", modifyNote.trim())}
                                    >
                                      提交修改
                                    </button>
                                  </div>
                                )}
                              </>
                            )}
                          </div>
                        ))}
                        {msg.media?.length ? <AvMediaList media={msg.media} /> : null}
                      </>
                    ) : (
                      <span className="av-typing">
                        <span className="av-typing-dot" />
                        <span className="av-typing-dot" />
                        <span className="av-typing-dot" />
                      </span>
                    )}
                  </div>
                  <span className="av-msg-time">{formatTime(msg.timestamp)}</span>
                </div>
              </div>
                  ))}
                </>
              );
            })()}
            {pending && (
              <div className="av-msg is-assistant" aria-live="polite">
                <div className="av-msg-body">
                  <div className="av-msg-bubble">
                    <span className="av-typing">
                      <span className="av-typing-dot" />
                      <span className="av-typing-dot" />
                      <span className="av-typing-dot" />
                    </span>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* 会话态:对话框沉底(门户态时由 C 位 renderComposer(true) 承担;
          popup 形态空态也走底部输入框,保持「仅对话区+输入框」的弹窗心智) */}
      {(!isEmpty || popup) && renderComposer(false)}

      {!popup && (
        <>
      <div className={`av-panel av-panel--left${historyOpen ? " is-open" : ""}`}>
        <div className="av-panel-head">
          <span className="av-panel-title">对话历史</span>
          <button type="button" className="av-panel-close" onClick={() => setHistoryOpen(false)} aria-label="关闭对话历史面板" title="关闭">
            <Icon name="close" size={12} strokeWidth={1.8} />
          </button>
        </div>
        <div className="av-panel-body">
          {renderConvList()}
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

      {/* 删除确认弹窗组(P0-2,lazy Modal 需 Suspense 边界;fallback null 不影响布局) */}
      <Suspense fallback={null}>
      {/* 删除对话二次确认(Modal 基座,对齐作品库删除确认模式) */}
      <Modal
        open={!!confirmDeleteConv}
        onClose={() => setConfirmDeleteConv(null)}
        title="删除对话"
        danger
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmDeleteConv(null)}>
              取消
            </Button>
            <Button
              variant="danger"
              icon={<Icon name="delete" size={14} />}
              onClick={() => {
                if (confirmDeleteConv) deleteConversation(confirmDeleteConv.id);
                setConfirmDeleteConv(null);
              }}
            >
              确认删除
            </Button>
          </>
        }
      >
        <div className="av-confirm-warn">
          确定删除这条对话{confirmDeleteConv?.title ? `「${confirmDeleteConv.title}」` : ""}?此操作不可撤销,全部消息记录将被永久移除。
        </div>
      </Modal>

      {/* 删除文档二次确认(删除中阻止关闭,失败保留弹窗可重试) */}
      <Modal
        open={!!confirmDeleteDoc}
        onClose={() => setConfirmDeleteDoc(null)}
        title="删除文档"
        danger
        preventClose={docDeleting}
        footer={
          <>
            <Button
              variant="secondary"
              disabled={docDeleting}
              onClick={() => setConfirmDeleteDoc(null)}
            >
              取消
            </Button>
            <Button
              variant="danger"
              loading={docDeleting}
              icon={<Icon name="delete" size={14} />}
              onClick={() => confirmDeleteDoc && onDeleteDoc(confirmDeleteDoc)}
            >
              {docDeleting ? "删除中…" : "确认删除"}
            </Button>
          </>
        }
      >
        <div className="av-confirm-warn">
          确定删除文档{confirmDeleteDoc ? `「${confirmDeleteDoc.filename}」` : ""}?此操作不可撤销,文档及其索引将被永久移除。
        </div>
      </Modal>
      </Suspense>

      <style jsx global>{`
        .av-view {
          position: absolute;
          inset: 0;
          display: flex;
          flex-direction: column;
          height: 100%;
          background: var(--bg-canvas);
          overflow: hidden;
        }

        /* Studio Console v1:页头整体退役(顶部零 chrome);
           .av-tb-btn 基座保留——popup 会话抽屉「新会话」按钮仍在用 */

        .av-tb-btn {
          display: inline-flex;
          align-items: center;
          gap: var(--space-1);
          height: 30px;
          padding: 0 var(--space-3);
          background: var(--bg-surface-2);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-control);
          color: var(--text-secondary);
          font-size: var(--text-aux);
          font-weight: var(--font-medium);
          font-family: var(--font-sans);
          cursor: pointer;
          transition: color var(--duration-fast) var(--ease-standard),
            background-color var(--duration-fast) var(--ease-standard),
            border-color var(--duration-fast) var(--ease-standard);
        }
        .av-tb-btn:hover:not(:disabled) {
          color: var(--text-primary);
          border-color: var(--border-strong);
          background: var(--bg-surface-3);
        }
        .av-tb-btn:disabled {
          opacity: 0.4;
          cursor: not-allowed;
          pointer-events: none;
        }
        .av-tb-btn.is-active {
          background: var(--accent-soft);
          border-color: var(--accent-halo);
          color: var(--accent);
        }
        .av-tb-btn-ghost {
          background: transparent;
        }

        /* ───── 聊天主区域 ───── */
        .av-chat-wrap {
          position: relative;
          flex: 1;
          min-height: 0;
          overflow-y: auto;
          overflow-x: hidden;
          background: var(--bg-canvas);
        }
        .av-chat-wrap::-webkit-scrollbar {
          width: 6px;
        }
        .av-chat-wrap::-webkit-scrollbar-track {
          background: transparent;
        }
        .av-chat-wrap::-webkit-scrollbar-thumb {
          background: var(--bg-surface-3);
          border-radius: 3px;
        }

        /* ───── 空态(欢迎页:hero 式舒展排版) ───── */
        .av-empty {
          position: relative;
          z-index: 1; /* 层内微调:内容压过点阵背景(0) */
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: var(--space-4);
          padding: var(--space-12) var(--space-8) var(--space-10);
          min-height: 100%;
          text-align: center;
        }
        /* 空态标题(Studio Console v1:去 Fraunces 展示位衬线,收敛为无衬线标题档;
           拉丁 kicker 铭牌 .av-empty-kicker 已退役) */
        .av-empty-title {
          font-size: var(--text-title);
          font-weight: var(--font-semibold);
          color: var(--text-primary);
          letter-spacing: -0.01em;
        }
        .av-empty-desc {
          font-size: var(--text-body);
          color: var(--text-muted);
          line-height: 1.65;
          max-width: 440px;
          margin-bottom: var(--space-5);
        }
        /* Studio Console v1(2026-08-31)极简空态:铭牌 + 输入框 + 模型行 */
        .av-portal--console {
          justify-content: center;
          gap: var(--space-6);
        }
        .av-console-wordmark {
          font-family: var(--font-mono);
          font-size: var(--text-label);
          font-weight: var(--font-medium);
          letter-spacing: 0.42em;
          text-indent: 0.42em; /* 补偿末字符 letter-spacing,视觉真正居中 */
          color: var(--text-muted);
          user-select: none;
        }
        .av-console-model {
          font-family: var(--font-mono);
          font-size: var(--text-label);
          color: var(--text-muted);
          letter-spacing: 0.02em;
        }

        /* ───── 消息列表(720px 居中列;Studio Console v1 文档式,无气泡/头像) ───── */
        .av-msg-list {
          position: relative;
          z-index: 1;
          display: flex;
          flex-direction: column;
          gap: var(--space-6);
          /* 顶部 chrome 带已随左栏骨架退役,首条消息自视口顶自然呼吸 */
          padding: var(--space-6) var(--space-6) var(--space-8);
          max-width: 720px;
          margin: 0 auto;
        }
        /* 长会话渲染窗口(2026-08-29):「加载更早消息」低调按钮 */
        .av-msg-history-more {
          align-self: center;
          padding: 6px 14px;
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-full, 999px);
          background: var(--bg-surface-2, transparent);
          color: var(--text-muted);
          font-size: 12px;
          cursor: pointer;
        }
        .av-msg-history-more:hover {
          color: var(--text-primary);
          border-color: var(--accent);
        }
        /* popup 形态(2026-08-18):弹窗居中卡内无灵动岛让位,顶部收敛;
           气泡列同步收窄到 640px——视觉焦点更集中,AI/用户两侧层次更分明 */
        .av-view--popup .av-msg-list {
          padding-top: var(--space-8);
          max-width: 640px;
        }
        /* 弹窗极简空态:垂直水平居中,仅品牌一行(popup 形态对话区空态) */
        .av-popup-empty {
          position: relative;
          z-index: 1;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: var(--space-3);
          height: 100%;
          padding: var(--space-6);
          text-align: center;
        }
        .av-popup-empty-hint {
          font-size: var(--text-label);
          color: var(--text-muted);
          font-family: var(--font-mono);
          letter-spacing: 0.04em;
        }

        /* ───── popup 会话抽屉(锚于 av-composer-anchor,输入框上方弹出) ───── */
        .av-pop-conv {
          position: absolute;
          left: 0;
          right: 0;
          bottom: calc(100% + var(--space-2));
          z-index: 2; /* 层内微调:压过 composer-box 渐变描边 */
          display: flex;
          flex-direction: column;
          max-height: 320px;
          background: var(--bg-surface-1);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-panel);
          box-shadow: var(--shadow-xl);
          overflow: hidden;
          /* 常驻 DOM + visibility/opacity/transform 过渡:开/关均有 200ms 轻过渡,
             关闭态 visibility:hidden 自动退出 Tab 序与命中测试 */
          opacity: 0;
          transform: translateY(6px);
          visibility: hidden;
          pointer-events: none;
          transition: opacity 200ms var(--ease-standard),
            transform 200ms var(--ease-standard),
            visibility 200ms var(--ease-standard);
        }
        .av-pop-conv.is-open {
          opacity: 1;
          transform: translateY(0);
          visibility: visible;
          pointer-events: auto;
        }
        .av-pop-conv-head {
          flex-shrink: 0;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: var(--space-2);
          padding: var(--space-2) var(--space-3);
          border-bottom: 1px solid var(--border-subtle);
        }
        .av-pop-conv-title {
          font-size: var(--text-label);
          font-weight: var(--font-medium);
          color: var(--text-muted);
          text-transform: uppercase;
          letter-spacing: 0.06em;
        }
        .av-pop-conv-new {
          height: 26px;
        }
        .av-pop-conv-body {
          flex: 1;
          min-height: 0;
          overflow-y: auto;
          padding: var(--space-2);
        }
        /* Studio Console v1(2026-08-31)文档式消息流:无头像、无气泡底色;
           助手回复全文宽文档排版,用户消息右对齐灰字——节奏差即角色区分 */
        .av-msg {
          display: flex;
          flex-direction: column;
        }
        .av-msg-body {
          display: flex;
          flex-direction: column;
          gap: var(--space-2);
          min-width: 0;
          max-width: 100%;
        }
        .av-msg.is-user .av-msg-body {
          align-items: flex-end;
        }
        .av-msg-bubble {
          display: flex;
          flex-direction: column;
          gap: var(--space-2);
          font-size: var(--text-body);
          color: var(--text-primary);
          line-height: 1.75;
          word-break: break-word;
          white-space: pre-wrap;
        }
        .av-msg.is-user .av-msg-bubble {
          max-width: 80%;
          color: var(--text-secondary);
          text-align: right;
        }
        .av-msg-time {
          font-size: var(--text-label);
          color: var(--text-muted);
          font-family: var(--font-mono);
        }
        .av-msg.is-user .av-msg-time {
          text-align: right;
        }

        /* 失败态错误气泡(替换打字指示器) */
        .av-msg-bubble--error {
          display: flex;
          flex-direction: column;
          align-items: flex-start;
          gap: var(--space-2);
          padding: var(--space-3) var(--space-4);
          border-radius: var(--radius-control);
          background: var(--err-soft);
          border: 1px solid color-mix(in oklab, var(--err) 45%, transparent);
        }
        .av-msg-error-text {
          color: var(--err);
          font-size: var(--text-body);
        }
        .av-msg-retry {
          display: inline-flex;
          align-items: center;
          gap: var(--space-1);
          height: 26px;
          padding: 0 var(--space-3);
          background: var(--bg-surface-2);
          border: 1px solid var(--border-strong);
          border-radius: var(--radius-control);
          color: var(--text-primary);
          font-size: var(--text-aux);
          font-weight: var(--font-medium);
          font-family: var(--font-sans);
          cursor: pointer;
          transition: color var(--duration-fast) var(--ease-standard),
            background-color var(--duration-fast) var(--ease-standard),
            border-color var(--duration-fast) var(--ease-standard);
        }
        .av-msg-retry:hover:not(:disabled) {
          color: var(--accent);
          border-color: var(--accent-halo);
          background: var(--bg-surface-3);
        }
        .av-msg-retry:disabled {
          opacity: 0.4;
          cursor: not-allowed;
        }

        /* 媒体产物 */
        .av-media {
          margin-top: var(--space-2);
          max-width: 100%;
        }
        .av-media-img,
        .av-media-video,
        .av-media-audio {
          display: block;
          max-width: 100%;
          border-radius: var(--radius-control);
          border: 1px solid var(--border-subtle);
          background: var(--bg-canvas);
        }
        .av-media-img {
          max-height: 320px;
          object-fit: contain;
        }
        .av-media-video {
          max-height: 320px;
        }
        /* 3D 模型内联查看器(高度约束在容器,查看器 100% 填充) */
        .av-media-3d {
          height: 260px;
          border-radius: var(--radius-control);
          border: 1px solid var(--border-subtle);
          overflow: hidden;
          margin-bottom: var(--space-2);
        }
        .av-media-link {
          display: inline-flex;
          align-items: center;
          gap: var(--space-1);
          padding: var(--space-2) var(--space-3);
          border-radius: var(--radius-control);
          background: var(--bg-surface-2);
          border: 1px solid var(--border-subtle);
          color: var(--accent);
          font-size: var(--text-aux);
          text-decoration: none;
          transition: border-color var(--duration-fast) var(--ease-standard),
            background-color var(--duration-fast) var(--ease-standard);
        }
        .av-media-link:hover {
          border-color: var(--border-strong);
          background: var(--bg-surface-3);
        }

        /* ───── 产物胶片条(W4 2026-08-31):≥2 视觉产物横排 Film Atelier 胶片,
           导轨打孔 + 帧号;单产物保持 .av-media hero 直出 ───── */
        .av-filmstrip {
          position: relative;
          margin-top: var(--space-2);
          max-width: 100%;
          padding: 11px var(--space-2) 12px; /* 上下让位打孔列 */
          background: var(--film-rail-bg);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-control);
          overflow: hidden;
        }
        /* 打孔列在 wrapper(不随轨道横向滚动) */
        .av-filmstrip::before,
        .av-filmstrip::after {
          content: "";
          position: absolute;
          left: var(--space-2);
          right: var(--space-2);
          height: 5px;
          background-image: radial-gradient(circle, var(--film-perf-color) 1.1px, transparent 1.6px);
          background-size: 14px 5px;
          background-repeat: repeat-x;
          opacity: 0.5;
          pointer-events: none;
        }
        .av-filmstrip::before {
          top: 3px;
        }
        .av-filmstrip::after {
          bottom: 3px;
        }
        .av-filmstrip-track {
          display: flex;
          gap: var(--space-2);
          overflow-x: auto;
          scroll-snap-type: x mandatory;
        }
        .av-film-frame {
          position: relative;
          flex: 0 0 auto;
          width: var(--film-frame-w);
          margin: 0;
          border: 1px solid var(--border-subtle);
          border-radius: calc(var(--radius-control) - 2px);
          overflow: hidden;
          background: var(--bg-canvas);
          scroll-snap-align: start;
        }
        .av-film-media {
          display: block;
          width: 100%;
          height: var(--film-frame-h);
          object-fit: cover;
        }
        .av-film-no {
          position: absolute;
          right: 4px;
          bottom: 3px;
          padding: 1px 5px;
          border-radius: 3px;
          font-family: var(--font-mono);
          font-size: 9px;
          letter-spacing: 0.08em;
          color: var(--text-on-accent);
          background: var(--overlay-strong);
          pointer-events: none;
        }

        /* ───── 工具调用小条(tool 事件,2026-08-24) ───── */
        .av-tool-chip {
          display: flex;
          align-items: flex-start;
          gap: var(--space-2);
          margin-top: var(--space-2);
          padding: var(--space-2) var(--space-3);
          background: var(--bg-surface-2);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-control);
          font-size: var(--text-aux);
          white-space: normal; /* 气泡 pre-wrap 不传染卡片内部排版 */
        }
        .av-tool-chip-icon {
          flex-shrink: 0;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 18px;
          height: 18px;
          margin-top: 1px;
          color: var(--text-muted);
        }
        .av-tool-chip.is-ok .av-tool-chip-icon {
          color: var(--ok);
        }
        .av-tool-chip.is-error .av-tool-chip-icon {
          color: var(--err);
        }
        .av-tool-chip-text {
          display: flex;
          flex-direction: column;
          gap: 2px;
          min-width: 0;
        }
        .av-tool-chip-summary {
          color: var(--text-secondary);
          line-height: 1.45;
        }
        .av-tool-chip-detail {
          color: var(--err);
          font-size: var(--text-label);
          line-height: 1.45;
          word-break: break-word;
        }

        /* ───── 生成作业卡(job 事件) ───── */
        .av-job-card {
          display: flex;
          flex-direction: column;
          gap: var(--space-2);
          min-width: 220px;
          margin-top: var(--space-2);
          padding: var(--space-3);
          background: var(--bg-surface-2);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-control);
          white-space: normal;
        }
        .av-job-card-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: var(--space-2);
        }
        .av-job-card-kind {
          display: inline-flex;
          align-items: center;
          gap: var(--space-1);
          font-size: var(--text-aux);
          font-weight: var(--font-medium);
          color: var(--text-primary);
        }
        .av-job-badge {
          flex-shrink: 0;
          padding: 1px var(--space-2);
          border-radius: var(--radius-full);
          border: 1px solid var(--border-subtle);
          font-size: var(--text-label);
          color: var(--text-secondary);
        }
        .av-job-badge.is-running {
          color: var(--run);
          border-color: color-mix(in oklab, var(--run) 40%, transparent);
          background: var(--run-soft);
        }
        .av-job-badge.is-held {
          color: var(--warn);
          border-color: color-mix(in oklab, var(--warn) 40%, transparent);
          background: var(--warn-soft);
        }
        .av-job-badge.is-done {
          color: var(--ok);
          border-color: color-mix(in oklab, var(--ok) 40%, transparent);
        }
        .av-job-badge.is-error {
          color: var(--err);
          border-color: color-mix(in oklab, var(--err) 40%, transparent);
          background: var(--err-soft);
        }
        .av-job-badge.is-canceled {
          color: var(--text-muted);
        }
        .av-job-card-actions {
          display: inline-flex;
          align-items: center;
          gap: var(--space-2);
          flex-shrink: 0;
        }
        .av-job-cancel {
          padding: 1px var(--space-2);
          border-radius: var(--radius-full);
          border: 1px solid var(--border-subtle);
          background: transparent;
          color: var(--text-secondary);
          font-size: var(--text-label);
          cursor: pointer;
        }
        .av-job-cancel:hover {
          color: var(--err);
          border-color: color-mix(in oklab, var(--err) 40%, transparent);
        }
        .av-job-card-label {
          font-size: var(--text-aux);
          color: var(--text-secondary);
          line-height: 1.45;
          word-break: break-word;
        }
        .av-job-card-hold {
          font-size: var(--text-label);
          color: var(--warn);
          line-height: 1.45;
          word-break: break-word;
        }

        /* ───── 提案确认卡(proposal 事件) ───── */
        .av-proposal {
          display: flex;
          flex-direction: column;
          gap: var(--space-2);
          min-width: 260px;
          margin-top: var(--space-2);
          padding: var(--space-3) var(--space-4);
          background: linear-gradient(145deg, var(--bg-surface-2), var(--bg-surface-3));
          border: 1px solid var(--accent-halo);
          border-radius: var(--radius-panel);
          box-shadow: 0 0 0 1px var(--accent-soft);
          white-space: normal;
        }
        .av-proposal.is-resolved {
          border-color: var(--border-subtle);
          box-shadow: none;
        }
        .av-proposal-head {
          display: flex;
          align-items: center;
          gap: var(--space-2);
          color: var(--accent);
        }
        .av-proposal-title {
          font-size: var(--text-body);
          font-weight: var(--font-semibold);
          color: var(--text-primary);
        }
        .av-proposal-estimate {
          margin-left: auto;
          font-size: var(--text-label);
          color: var(--text-muted);
          font-family: var(--font-mono);
        }
        .av-proposal-body {
          font-size: var(--text-aux);
          color: var(--text-secondary);
          line-height: 1.6;
          white-space: pre-wrap;
          word-break: break-word;
        }
        .av-proposal-actions {
          display: flex;
          gap: var(--space-2);
        }
        .av-proposal-btn {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          height: 28px;
          padding: 0 var(--space-3);
          background: var(--bg-surface-2);
          border: 1px solid var(--border-strong);
          border-radius: var(--radius-control);
          color: var(--text-primary);
          font-size: var(--text-aux);
          font-weight: var(--font-medium);
          font-family: var(--font-sans);
          cursor: pointer;
          transition: color var(--duration-fast) var(--ease-standard),
            background-color var(--duration-fast) var(--ease-standard),
            border-color var(--duration-fast) var(--ease-standard);
        }
        .av-proposal-btn:hover:not(:disabled) {
          color: var(--accent);
          border-color: var(--accent-halo);
          background: var(--bg-surface-3);
        }
        .av-proposal-btn:disabled {
          opacity: 0.4;
          cursor: not-allowed;
        }
        .av-proposal-btn.is-primary {
          background: var(--accent);
          border-color: transparent;
          color: var(--text-on-accent);
        }
        .av-proposal-btn.is-primary:hover:not(:disabled) {
          background: var(--accent-hover);
          color: var(--text-on-accent);
        }
        .av-proposal-btn.is-danger:hover:not(:disabled) {
          color: var(--err);
          border-color: color-mix(in oklab, var(--err) 45%, transparent);
          background: var(--err-soft);
        }
        .av-proposal-modify {
          display: flex;
          flex-direction: column;
          gap: var(--space-2);
        }
        .av-proposal-note {
          width: 100%;
          resize: vertical;
          padding: var(--space-2) var(--space-3);
          background: var(--bg-surface-1);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-control);
          color: var(--text-primary);
          font-size: var(--text-aux);
          font-family: var(--font-sans);
          line-height: 1.55;
          outline: none;
        }
        .av-proposal-note:focus {
          border-color: var(--accent-halo);
        }
        .av-proposal-note::placeholder {
          color: var(--text-muted);
        }
        .av-proposal-result {
          display: flex;
          align-items: center;
          gap: var(--space-1);
          font-size: var(--text-aux);
          font-weight: var(--font-medium);
        }
        .av-proposal-result.is-approve,
        .av-proposal-result.is-modify {
          color: var(--ok);
        }
        .av-proposal-result.is-reject {
          color: var(--text-muted);
        }
        .av-proposal-result-note {
          font-weight: var(--font-regular, 400);
          color: var(--text-secondary);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        /* 打字指示器(运行态,用 --run) */
        .av-typing {
          display: inline-flex;
          align-items: center;
          gap: var(--space-1);
          padding: var(--space-1) 0;
        }
        .av-typing-dot {
          width: 5px;
          height: 5px;
          border-radius: 50%;
          background: var(--run);
          animation: av-typing-pulse 1.2s ease-in-out infinite;
        }
        .av-typing-dot:nth-child(2) { animation-delay: 0.15s; }
        .av-typing-dot:nth-child(3) { animation-delay: 0.3s; }
        @keyframes av-typing-pulse {
          0%, 60%, 100% { opacity: 0.25; }
          30% { opacity: 1; }
        }

        /* ───── 输入区(composer:浮动大卡,视觉焦点) ───── */
        .av-composer {
          flex-shrink: 0;
          padding: var(--space-4) var(--space-6) var(--space-5);
          /* Studio Console v1:去渐变底色,输入区与画布同底 */
          background: transparent;
          /* 悬浮 chrome 档:让位于抽屉面板(var(--z-drawer)) */
          z-index: var(--z-sticky);
        }
        .av-composer-box {
          position: relative;
          display: flex;
          align-items: flex-end;
          gap: var(--space-2);
          width: 100%;
          max-width: 720px;
          margin: 0 auto;
          padding: var(--space-3) var(--space-3) var(--space-3) var(--space-4);
          background: var(--bg-surface-1);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-panel);
          /* 2026-09-01 组件精修:whisper 投影 + focus 柔光环,与全局 .input 同语言 */
          box-shadow: var(--shadow-xs);
          transition: border-color var(--duration-fast) var(--ease-standard),
            box-shadow var(--duration-fast) var(--ease-standard);
          overflow: hidden;
        }
        .av-composer-box:hover {
          border-color: var(--border-strong);
        }
        .av-composer-box:focus-within {
          border-color: var(--accent);
          box-shadow: var(--shadow-xs), 0 0 0 3px var(--accent-halo);
        }
        .av-composer-actions {
          position: relative;
          z-index: 1; /* 层内微调:压过 composer-box::before 渐变描边 */
          display: flex;
          align-items: center;
          gap: var(--space-1);
          padding-bottom: 2px;
        }
        .av-composer-actions--left {
          margin-right: auto;
        }
        .av-composer-btn {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 32px;
          height: 32px;
          border-radius: 50%;
          background: transparent;
          border: none;
          color: var(--text-muted);
          cursor: pointer;
          transition: background-color var(--duration-fast) var(--ease-standard),
            color var(--duration-fast) var(--ease-standard),
            transform var(--duration-fast) var(--ease-standard),
            box-shadow var(--duration-fast) var(--ease-standard);
        }
        .av-composer-btn:hover:not(:disabled) {
          background: var(--bg-surface-2);
          color: var(--text-primary);
        }
        .av-composer-btn:active:not(:disabled) {
          transform: scale(0.94);
        }
        .av-composer-btn:disabled {
          opacity: 0.4;
          cursor: not-allowed;
        }
        /* 发送:primary(accent),运行中由 stop 按钮接管 */
        .av-composer-send {
          width: 36px;
          height: 36px;
          background: var(--accent);
          color: var(--text-on-accent);
          box-shadow: 0 2px 8px color-mix(in oklab, var(--accent) 30%, transparent);
        }
        .av-composer-send:hover:not(:disabled) {
          background: var(--accent-hover);
          color: var(--text-on-accent);
          box-shadow: 0 4px 14px color-mix(in oklab, var(--accent) 45%, transparent);
        }
        .av-composer-send:active:not(:disabled) {
          transform: scale(0.96);
        }
        .av-composer-send:disabled {
          background: var(--bg-surface-2);
          color: var(--text-muted);
          box-shadow: none;
        }
        /* 停止:运行态专用 --run */
        .av-composer-stop {
          background: var(--run-soft);
          color: var(--run);
          animation: av-stop-breathe 2s ease-in-out infinite;
        }
        @keyframes av-stop-breathe {
          0%, 100% { box-shadow: 0 0 0 0 color-mix(in oklab, var(--run) 25%, transparent); }
          50% { box-shadow: 0 0 0 6px color-mix(in oklab, var(--run) 0%, transparent); }
        }
        .av-composer-stop:hover {
          background: var(--run);
          color: var(--text-on-accent);
        }
        .av-composer-stop:active {
          transform: scale(0.94);
        }
        .av-composer-input {
          position: relative;
          z-index: 1; /* 层内微调:压过 composer-box::before 渐变描边 */
          flex: 1;
          min-width: 0;
          resize: vertical;
          border: none;
          background: transparent;
          color: var(--text-primary);
          font-size: var(--text-body);
          font-family: var(--font-sans);
          line-height: 1.55;
          padding: calc(var(--space-1) + 2px) var(--space-2) calc(var(--space-1) + 2px) 0;
          outline: none;
        }
        .av-composer-input::placeholder {
          color: var(--text-muted);
          animation: av-placeholder-breathe 3s ease-in-out infinite;
        }
        @keyframes av-placeholder-breathe {
          0%, 100% { opacity: 0.7; }
          50% { opacity: 0.95; }
        }
        .av-composer-input:disabled {
          opacity: 0.5;
        }
        .av-composer-hint {
          display: flex;
          justify-content: center;
          margin-top: var(--space-2);
        }
        .av-composer-hint span {
          font-size: var(--text-label);
          color: var(--text-muted);
        }

        /* ───── 侧边面板(历史 / 模型设置 / 文档) ───── */
        .av-panel {
          position: absolute;
          /* W4 修复:桌面端顶让位 56px chrome 带(CornerNav/账户/任务中心),
             此前 top:0 致右面板关闭钮与账户头像同域重叠、点击被拦截 */
          top: 56px;
          bottom: 0;
          width: 280px;
          display: flex;
          flex-direction: column;
          background: var(--bg-surface-1);
          /* 抽屉档:对齐全局 .drawer 约定(遮罩 +1),压过页头/输入区(var(--z-sticky)) */
          z-index: calc(var(--z-drawer) + 1);
          transition: transform var(--duration-base) var(--ease-standard);
          box-shadow: var(--shadow-xl);
        }
        .av-panel--left {
          left: 0;
          border-right: 1px solid var(--border-subtle);
          transform: translateX(-100%);
        }
        .av-panel--right {
          right: 0;
          border-left: 1px solid var(--border-subtle);
          transform: translateX(100%);
        }
        /* <1024px 无顶部 chrome 带(app-main padding-top:0),面板恢复全高 */
        @media (max-width: 1023px) {
          .av-panel {
            top: 0;
          }
        }
        .av-panel.is-open {
          transform: translateX(0);
        }
        .av-panel-head {
          flex-shrink: 0;
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: var(--space-3) var(--space-4);
          border-bottom: 1px solid var(--border-subtle);
        }
        .av-panel-title {
          font-size: var(--text-label);
          font-weight: var(--font-medium);
          color: var(--text-secondary);
          text-transform: uppercase;
          letter-spacing: 0.04em;
        }
        .av-panel-close {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 24px;
          height: 24px;
          border-radius: var(--radius-badge);
          color: var(--text-muted);
          cursor: pointer;
          transition: background-color var(--duration-fast) var(--ease-standard),
            color var(--duration-fast) var(--ease-standard);
        }
        .av-panel-close:hover {
          background: var(--bg-surface-2);
          color: var(--text-primary);
        }
        .av-panel-body {
          flex: 1;
          overflow-y: auto;
          padding: var(--space-3);
        }
        .av-panel-empty {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: var(--space-2);
          padding: var(--space-8) var(--space-4);
          color: var(--text-muted);
          font-size: var(--text-aux);
          text-align: center;
          line-height: 1.5;
        }

        /* 对话列表 */
        .av-conv-list {
          display: flex;
          flex-direction: column;
          gap: var(--space-1);
        }
        .av-conv-item {
          display: flex;
          align-items: flex-start;
          gap: var(--space-2);
          padding: var(--space-2) var(--space-3);
          background: transparent;
          border: 1px solid transparent;
          border-radius: var(--radius-control);
          transition: background-color var(--duration-fast) var(--ease-standard),
            border-color var(--duration-fast) var(--ease-standard);
        }
        .av-conv-main {
          flex: 1;
          min-width: 0;
          display: flex;
          background: transparent;
          border: none;
          padding: 0;
          text-align: left;
          cursor: pointer;
          border-radius: var(--radius-control);
        }
        .av-conv-item:hover {
          background: var(--bg-surface-2);
          border-color: var(--border-subtle);
        }
        .av-conv-item.is-active {
          background: var(--accent-soft);
          border-color: var(--accent-halo);
        }
        .av-conv-info {
          flex: 1;
          min-width: 0;
          display: flex;
          flex-direction: column;
          gap: var(--space-1);
        }
        .av-conv-title {
          font-size: var(--text-aux);
          font-weight: var(--font-medium);
          color: var(--text-primary);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .av-conv-item.is-active .av-conv-title {
          color: var(--accent);
        }
        .av-conv-meta {
          font-size: var(--text-label);
          color: var(--text-muted);
          font-family: var(--font-mono);
        }
        .av-conv-delete {
          flex-shrink: 0;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 24px;
          height: 24px;
          border-radius: var(--radius-badge);
          color: var(--text-muted);
          opacity: 0;
          transition: opacity var(--duration-fast) var(--ease-standard),
            background-color var(--duration-fast) var(--ease-standard),
            color var(--duration-fast) var(--ease-standard);
        }
        /* 触屏无 hover,删除键常显,否则会话无法删除 */
        @media (hover: none) {
          .av-conv-delete {
            opacity: 1;
          }
        }
        .av-conv-item:hover .av-conv-delete,
        .av-conv-delete:focus-visible {
          opacity: 1;
        }
        .av-conv-delete:hover {
          background: var(--err-soft);
          color: var(--err);
        }

        /* 属性组 */
        .av-prop-group {
          display: flex;
          flex-direction: column;
          gap: var(--space-2);
          padding: var(--space-3) 0;
          border-bottom: 1px solid var(--border-subtle);
        }
        .av-prop-group:last-child {
          border-bottom: none;
        }
        .av-prop-label {
          font-size: var(--text-label);
          font-weight: var(--font-medium);
          color: var(--text-muted);
          text-transform: uppercase;
          letter-spacing: 0.04em;
        }
        .av-prop-value {
          font-size: var(--text-aux);
          color: var(--text-primary);
        }
        .av-prop-desc {
          margin: 0;
          font-size: var(--text-aux);
          color: var(--text-secondary);
          line-height: 1.55;
        }
        .av-stats-row {
          display: flex;
          gap: var(--space-4);
        }
        .av-stat {
          display: flex;
          flex-direction: column;
          gap: var(--space-1);
        }
        .av-stat-value {
          font-size: var(--text-title);
          font-weight: var(--font-semibold);
          color: var(--text-primary);
          font-family: var(--font-mono);
          font-variant-numeric: tabular-nums;
        }
        .av-stat-label {
          font-size: var(--text-label);
          color: var(--text-muted);
        }

        /* 遮罩 */
        .av-panel-overlay {
          position: absolute;
          inset: 0;
          background: var(--overlay-light);
          backdrop-filter: blur(2px);
          /* 抽屉遮罩档:对齐全局 .drawer-overlay,低于面板(+1) */
          z-index: var(--z-drawer);
          animation: av-overlay-in var(--duration-fast) var(--ease-standard);
        }
        @keyframes av-overlay-in {
          from { opacity: 0; }
          to { opacity: 1; }
        }

        /* 删除确认弹窗正文(对齐作品库 lib-confirm-warn 排版) */
        .av-confirm-warn {
          font-size: var(--text-body);
          color: var(--text-secondary);
          line-height: 1.55;
          word-break: break-word;
        }

        @media (prefers-reduced-motion: reduce) {
          .av-typing-dot { animation: none; }
          .av-composer-stop { animation: none; }
          .av-composer-input::placeholder { animation: none; }
          .av-panel-overlay { animation: none; }
          .av-pop-conv { transition: none; }
        }

        /* 移动端 */
        @media (max-width: 767px) {
          /* 纯图标按钮:触控目标提到 ≥44px */
          .av-tb-btn {
            width: 44px;
            height: 44px;
            padding: 0;
            justify-content: center;
          }
          .av-msg-list {
            padding: var(--space-6) var(--space-4) var(--space-5);
          }
          .av-scene-row {
            gap: var(--space-1);
          }
          /* 窄屏胶片帧收窄,保证至少露出下一帧边缘(可横滑暗示) */
          .av-film-frame {
            width: calc(var(--film-frame-w) * 0.72);
          }
          .av-film-media {
            height: calc(var(--film-frame-h) * 0.8);
          }
          .av-panel {
            width: 85vw;
            max-width: 300px;
          }
          .av-panel-close {
            width: 44px;
            height: 44px;
          }
          .av-conv-delete {
            width: 32px;
            height: 32px;
          }
          .av-msg-retry {
            height: 36px;
            padding: 0 var(--space-4);
          }
          .av-composer {
            padding: var(--space-3) var(--space-3) var(--space-3);
          }
          .av-composer-btn {
            width: 44px;
            height: 44px;
          }
          /* iOS <16px 输入框聚焦自动放大页面,提到 16px 规避 */
          .av-composer-input {
            font-size: 16px;
          }
        }
      `}</style>
    </div>
  );
}
