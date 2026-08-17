"use client";

import { useState, useRef, useEffect, useCallback, useMemo, lazy, Suspense, type ReactNode } from "react";
import { Icon, type IconName } from "@/components/ui/Icon";
import { Button } from "@/components/ui/Button";
import { ErrorBar } from "@/components/ui/ErrorBar";
import { LoadingBlock } from "@/components/ui/LoadingBlock";
import { LazyVideo } from "@/components/ui/LazyVideo";
import { useToast } from "@/components/ui/Toast";
import {
  agentChatStream,
  AgentEvent,
  AgentSessionMessage,
  AgentSessionSummary,
  deleteAgentSession,
  getAgentSession,
  getLlmModel,
  imageUrl,
  listAgentSessions,
  listJobs,
} from "@/lib/api";
import { fetchEngines, type EngineInfo } from "@/lib/engines";
import { isVideoKind, kindLabel, kindToFilter } from "@/lib/libraryQuery";
import { useR18Mode } from "@/lib/r18";
import type { JobItem } from "@/lib/types";
import {
  deleteDoc,
  DocItem,
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

// 模型名从 /api/system/llm 动态读取(display_model),不再硬编码;desc 为通用说明
const MODEL_DESC = "本地 L1 快速对话模型，适合灵感捕获、提示词润色、简单问答";

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
}

// localStorage 按天存储仅作「离线/未登录兜底」:服务端会话接口不可达时回退现状行为
const CONV_STORAGE_KEY = (() => {
  const d = new Date();
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return `toiv_av_convs_${day}`;
})();

// 等待首个响应块的超时;超时按「服务不可用」处理并允许重试
const FIRST_CHUNK_TIMEOUT_MS = 30000;

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
 * (无则补一条空气泡,对齐流式渲染时媒体挂最后一条 assistant 的行为)。 */
export function messagesToChat(rows: AgentSessionMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of rows) {
    const ts = Date.parse(m.created_at) || Date.now();
    if (m.role === "user" || m.role === "assistant") {
      out.push({ id: `srv-${m.id}`, role: m.role, content: m.content, timestamp: ts });
    } else if (m.role === "tool" && m.media?.length) {
      let last = out[out.length - 1];
      if (!last || last.role !== "assistant") {
        last = { id: `srv-${m.id}-media`, role: "assistant", content: "", timestamp: ts };
        out.push(last);
      }
      last.media = [...(last.media ?? []), ...m.media];
    }
  }
  return out;
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

const QUICK_ACTIONS = [
  { icon: "sparkles" as const, label: "文生图提示词", prompt: "帮我写一段高质量的文生图提示词，主题是：赛博朋克风格的未来城市夜景，要求细节丰富、光影逼真" },
  { icon: "file" as const, label: "剧本大纲", prompt: "帮我生成一个1分钟短剧的剧本大纲，主题：职场逆袭，要求有反转" },
  { icon: "image" as const, label: "图生图参考", prompt: "我想做图生图，请告诉我需要准备什么，以及如何写参考图的描述提示词" },
  { icon: "clapperboard" as const, label: "分镜脚本", prompt: "帮我写一个产品广告的分镜脚本，要求5-8个镜头，节奏紧凑" },
];

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

// ───── 首页门户(2026-08-16 堆友范式):引擎胶囊 / 场景胶囊 / @ 技能面板 / 最近作品 ─────

/** 引擎状态胶囊分组:按注册表 id 前缀归类;组内任一引擎可用即绿灯,组在注册表缺席则不渲染。 */
const ENGINE_CAPSULE_GROUPS: { key: string; label: string; match: (id: string) => boolean }[] = [
  { key: "h3", label: "H3", match: (id) => id.startsWith("h3-") },
  { key: "ltx25", label: "LTX-2.5", match: (id) => id.startsWith("ltx25-") },
  { key: "longcat", label: "LongCat", match: (id) => id.startsWith("longcat-") },
  { key: "wan", label: "Wan", match: (id) => id.startsWith("wan-") },
  { key: "image", label: "图像", match: (id) => id === "txt2img" || id === "img2img" },
  { key: "audio", label: "音乐", match: (id) => id.startsWith("ace-") },
];

export interface EngineCapsule {
  key: string;
  label: string;
  available: boolean;
}

/** 引擎注册表 → 胶囊条数据(纯函数,单测锚点)。 */
export function buildEngineCapsules(engines: readonly EngineInfo[]): EngineCapsule[] {
  return ENGINE_CAPSULE_GROUPS.filter((g) =>
    engines.some((e) => g.match(e.id)),
  ).map((g) => ({
    key: g.key,
    label: g.label,
    available: engines.some((e) => g.match(e.id) && e.available),
  }));
}

/** 门户「最近作品」挑选(纯函数,单测锚点):完成态有产物、排除 R18、按创建时间倒序、截取前 N 件。 */
export function pickRecentWorks(jobs: readonly JobItem[], limit = 12): JobItem[] {
  return jobs
    .filter(
      (j) =>
        !j.nsfw && j.status === "done" && Array.isArray(j.results) && j.results.length > 0,
    )
    .slice()
    .sort((a, b) => (Date.parse(b.created_at) || 0) - (Date.parse(a.created_at) || 0))
    .slice(0, limit);
}

interface PortalEntry {
  view: string;
  icon: IconName;
  label: string;
  desc: string;
  /** r18 = 仅 R18 模式渲染(drama 视图受 page.tsx 全局门控);sfwOnly = 仅 SFW 模式补位 */
  r18?: boolean;
  sfwOnly?: boolean;
}

/** 场景胶囊(对话框下方):R18 模式首位=短剧工作台;SFW 模式由视频创作补位(drama 受全局门控不可达)。 */
export const SCENE_CAPSULES: PortalEntry[] = [
  { view: "drama", icon: "clapperboard", label: "短剧工作台", desc: "剧本 · 资产 · 分镜 · 成片", r18: true },
  { view: "video", icon: "video", label: "视频创作", desc: "LTX-2.5 · H3 · LongCat 长视频", sfwOnly: true },
  { view: "image", icon: "image", label: "图像创作", desc: "文生图 · 图生图 · 风格预设" },
  { view: "avatartalk", icon: "user", label: "数字人", desc: "照片开口说话 · 对口型" },
  { view: "library", icon: "library", label: "作品库", desc: "灵感与成果的档案馆" },
];

/** @ 技能面板一期内容 = 工作台快捷入口(二期接 Skills 广场)。 */
export const SKILL_ENTRIES: PortalEntry[] = [
  { view: "drama", icon: "clapperboard", label: "短剧工作台", desc: "剧本到成片的全链路工作台", r18: true },
  { view: "image", icon: "image", label: "图像创作", desc: "文生图 / 图生图" },
  { view: "video", icon: "video", label: "视频创作", desc: "LTX-2.5 / H3 / LongCat" },
  { view: "audio", icon: "audio", label: "音频工坊", desc: "音乐 / 配音 / 人声分离" },
  { view: "avatartalk", icon: "user", label: "数字人", desc: "照片说话 / 对口型" },
  { view: "library", icon: "library", label: "作品库", desc: "全部生成产物" },
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
}

export function AssistantView(props?: AssistantViewProps) {
  const onNavigate = props?.onNavigate;
  const toast = useToast();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  // pending = 已发送、等待首个响应块(打字指示器),出错即替换为错误气泡
  const [pending, setPending] = useState(false);
  // 会话存储:服务端优先,localStorage 兜底(见 useAgentConversations)
  const convStore = useAgentConversations();
  const conversations = convStore.conversations;
  const [activeConvId, setActiveConvId] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [modelName, setModelName] = useState("L1 对话模型");
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

  const isEmpty = messages.length === 0;

  // ───── 门户状态(2026-08-16):引擎胶囊 / 最近作品 / @ 面板 / R18 模式 ─────
  const [r18] = useR18Mode();
  // 引擎状态胶囊:失败兜底 = 整条隐藏,不报错穿帮
  const [engines, setEngines] = useState<EngineInfo[] | null>(null);
  // 最近作品:仅门户空态加载(listJobs 走 SWR 缓存,二访秒开)
  const [recentJobs, setRecentJobs] = useState<JobItem[] | null>(null);
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

  useEffect(() => {
    let cancelled = false;
    fetchEngines()
      .then((rows) => {
        if (!cancelled) setEngines(rows);
      })
      .catch(() => {
        /* 接口挂了就隐藏胶囊条(engines 保持 null) */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!isEmpty) return;
    let cancelled = false;
    listJobs()
      .then((rows) => {
        if (!cancelled) setRecentJobs(rows);
      })
      .catch(() => {
        /* 失败隐藏作品流,不阻塞对话 */
      });
    return () => {
      cancelled = true;
    };
  }, [isEmpty]);

  const engineCapsules = useMemo(
    () => (engines ? buildEngineCapsules(engines) : []),
    [engines],
  );
  const recentWorks = useMemo(() => pickRecentWorks(recentJobs ?? []), [recentJobs]);
  const sceneCapsules = useMemo(() => filterPortalEntries(SCENE_CAPSULES, r18), [r18]);
  // @ 触发:取最后一个 @ 之后的文本作过滤词(空词=全量入口)
  const skillEntries = useMemo(() => {
    const idx = input.lastIndexOf("@");
    if (idx < 0) return [];
    const q = input.slice(idx + 1).trim().toLowerCase();
    return filterPortalEntries(SKILL_ENTRIES, r18).filter(
      (e) => !q || e.label.toLowerCase().includes(q),
    );
  }, [input, r18]);
  // 无匹配项时收敛面板,Enter 照常发送原文
  const skillPanelVisible =
    input.includes("@") && !skillDismissed && !busy && skillEntries.length > 0;

  /** 选定技能入口:剥掉尾部的 @触发词,跳转对应视图。 */
  const onPickSkill = useCallback(
    (view: string) => {
      setInput((prev) => prev.replace(/@[^@]*$/, ""));
      setSkillDismissed(true);
      goView(view);
    },
    [goView],
  );

  // 顶栏/设置面板的模型名跟随后端真实配置,避免显示与实际调用不一致
  useEffect(() => {
    const ac = new AbortController();
    getLlmModel(ac.signal).then((info) => {
      if (info?.display_model) setModelName(info.display_model);
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

  const deleteConversation = useCallback(
    (id: string) => {
      void convStore.remove(id);
      if (activeConvId === id) {
        onNewChat();
      }
    },
    [activeConvId, onNewChat, convStore],
  );

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

  // 发起一次对话请求:立即进入 pending(打字指示器),30s 无首个响应块按失败处理,
  // 失败/超时 → 错误气泡 + 重试;成功/失败均写入历史。docIds = 本轮挂载的文档。
  const requestReply = useCallback(
    async (baseMsgs: ChatMessage[], docIds: string[] = []) => {
      setBusy(true);
      setPending(true);
      abortRef.current = false;
      userStoppedRef.current = false;
      gotFirstChunkRef.current = false;
      lastDocIdsRef.current = docIds;

      const controller = new AbortController();
      abortControllerRef.current = controller;

      const timeoutId = window.setTimeout(() => {
        if (!gotFirstChunkRef.current) controller.abort();
      }, FIRST_CHUNK_TIMEOUT_MS);

      let failed = false;
      // 后端以 SSE msg 事件下发 {type:"error"}(如「主模型暂不可用」),HTTP 仍 200,
      // 必须显式识别为失败;同理,流正常结束但零内容也按失败处理
      let streamError = false;
      try {
        const apiMessages = baseMsgs
          .filter(
            (m) =>
              (m.role === "user" || m.role === "assistant") && m.kind !== "error"
          )
          .map((m) => ({ role: m.role, content: m.content }));

        let assistantMsg: ChatMessage | null = null;

        const onEvent = (ev: AgentEvent) => {
          if (controller.signal.aborted) return;
          if (!gotFirstChunkRef.current) {
            gotFirstChunkRef.current = true;
            window.clearTimeout(timeoutId);
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
          }
        };

        const { sessionId } = await agentChatStream(
          {
            messages: apiMessages,
            document_ids: docIds,
            // 仅服务端模式携带会话 id(local 兜底模式的 id 是本地 genId,服务端不认)
            session_id: convStore.serverMode ? (activeConvIdRef.current ?? null) : null,
          },
          onEvent,
          controller.signal,
        );
        if (sessionId) lastSessionIdRef.current = sessionId;
      } catch {
        failed = true;
      } finally {
        window.clearTimeout(timeoutId);
        setBusy(false);
        setPending(false);
        abortRef.current = false;
        abortControllerRef.current = null;
      }

      // 流内错误或零内容空响应,统一按失败处理
      if (streamError || !gotFirstChunkRef.current) failed = true;

      // 用户主动停止:不补错误气泡,也不重写历史(保留已流出的内容)
      if (failed && userStoppedRef.current) return;

      if (failed) {
        const errMsg: ChatMessage = {
          id: genId(),
          role: "assistant",
          content: "回复失败:服务暂时不可用",
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
      await requestReply(newMsgs, docs.map((d) => d.id));
    },
    [input, busy, messages, attachedDocs, requestReply],
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
  }, []);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Escape" && skillPanelVisible) {
        e.preventDefault();
        setSkillDismissed(true);
        return;
      }
      if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault();
        // @ 面板展开时 Enter = 选定首项(堆友交互);面板关闭/无候选时照常发送
        if (skillPanelVisible) {
          onPickSkill(skillEntries[0].view);
          return;
        }
        send();
      }
    },
    [send, skillPanelVisible, skillEntries, onPickSkill],
  );

  const formatTime = (ts: number) => {
    const d = new Date(ts);
    return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
  };

  /* 对话框(门户 C 位 / 会话底部两处复用):portal=true 时褪去底部固定档的渐变底与内边距 */
  const renderComposer = (portal: boolean) => (
    <div className={`av-composer${portal ? " av-composer--portal" : ""}`}>
      {attachedDocs.length > 0 && (
        <div className="doc-chips doc-chips--composer">
          {attachedDocs.map((d) => (
            <span key={d.id} className="doc-chip doc-chip--removable">
              <Icon name="file" size={11} strokeWidth={1.8} />
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
      <div className="av-composer-anchor">
        {/* @ 技能面板(一期 = 工作台快捷入口;视觉与 at-card 同构) */}
        {skillPanelVisible && (
          <div className="av-skill-panel at-card" role="menu" aria-label="技能与工作台快捷入口">
            <div className="av-skill-panel-head">
              <span className="av-skill-panel-title">技能 / 工作台</span>
              <span className="av-skill-panel-hint">Enter 选定首项 · Esc 关闭</span>
            </div>
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
          </div>
        )}
        <div className="av-composer-box">
          <div className="av-composer-actions av-composer-actions--left">
            {busy ? (
              <button type="button" className="av-composer-btn av-composer-stop" onClick={onStop} title="停止生成">
                <Icon name="minus" size={12} strokeWidth={2.2} />
              </button>
            ) : (
              <button
                type="button"
                className={`av-composer-btn av-composer-btn-ghost av-composer-tool${docsOpen || attachedDocs.length ? " is-active" : ""}`}
                title="文档(上传/挂载,供长文本理解)"
                aria-label="文档"
                onClick={() => setDocsOpen((v) => !v)}
              >
                <Icon name="plus" size={14} strokeWidth={1.8} />
              </button>
            )}
          </div>
          <textarea
            ref={textareaRef}
            className="av-composer-input"
            placeholder={isMobileMq ? "说出你的创意,或输入 @ 调用技能…" : "说出你的创意,或输入 @ 调用技能…（Enter 发送 / Shift+Enter 换行）"}
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
    <div className="av-view">
      <h1 className="sr-only">对话流</h1>
      <header className="page-header av-header">
        <div className="av-header-main">
          <div className="page-header-title av-header-title">对话流</div>
          <p className="page-header-desc av-header-desc">
            与本地模型对话,打磨提示词、剧本与分镜创意
          </p>
        </div>
        <div className="page-header-actions av-header-actions">
          {/* 模型胶囊:Film Atelier 编辑徽章语言(.at-badge hairline,去灰底填充);
              模型名单独成元素——flex 容器内的匿名文本节点无法 text-overflow 省略,
              移动端长模型名靠 .av-model-name 真省略截断(assistant.css ≤767) */}
          <div className="av-model-pill at-badge">
            <span className="av-model-dot" />
            <Icon name="braincircuit" size={12} strokeWidth={1.8} />
            <span className="av-model-name">{modelName}</span>
          </div>
          <button
            type="button"
            className={`av-tb-btn${historyOpen ? " is-active" : ""}`}
            onClick={() => setHistoryOpen((v) => !v)}
            title="对话历史"
            aria-label="对话历史"
          >
            <Icon name="history" size={14} strokeWidth={1.8} />
            <span>历史</span>
          </button>
          <button
            type="button"
            className="av-tb-btn av-tb-btn-ghost"
            onClick={onNewChat}
            title="新对话"
            aria-label="新对话"
          >
            <Icon name="create" size={14} strokeWidth={1.8} />
            <span>新建</span>
          </button>
          <button
            type="button"
            className={`av-tb-btn${contextOpen ? " is-active" : ""}`}
            onClick={() => setContextOpen((v) => !v)}
            title="上下文设置"
            aria-label="上下文设置"
          >
            <Icon name="admin" size={14} strokeWidth={1.8} />
            <span>设置</span>
          </button>
        </div>
      </header>

      {convStore.listError && (
        <ErrorBar message={convStore.listError} onClose={convStore.clearListError} />
      )}

      <div className="av-chat-wrap" ref={scrollRef}>
        <div className="av-dot-grid" aria-hidden="true" />

        {isEmpty ? (
          /* 首页门户(2026-08-16 堆友范式):引擎胶囊条 → kicker/标题 → 对话框 C 位
             → 场景胶囊 → 提示词建议卡 → 最近作品瀑布流;
             保留 v6.1 空态美学(DIALOGUE ATELIER kicker / Fraunces 标题 / at-card 建议卡) */
          <div className="av-empty av-portal">
            {engineCapsules.length > 0 && (
              /* 2026-08-16 视图批 1:胶囊行补语义化小标题「引擎状态」(label 档),
                 孤立悬浮的徽章行锚定语境;aria-labelledby 关联可见标签,不重复播报 */
              <div className="av-eng-block">
                <span className="av-eng-label" id="av-eng-label">引擎状态</span>
                <div className="av-eng-strip" role="status" aria-labelledby="av-eng-label">
                  {engineCapsules.map((c) => (
                    <span
                      key={c.key}
                      className={`at-badge av-eng-pill${c.available ? " is-ok" : " is-err"}`}
                      title={c.available ? `${c.label} 引擎可用` : `${c.label} 引擎离线`}
                    >
                      <span
                        className={`av-eng-dot${c.available ? " is-ok" : " is-err"}`}
                        aria-hidden="true"
                      />
                      {c.label}
                    </span>
                  ))}
                </div>
              </div>
            )}
            <div className="av-empty-kicker">DIALOGUE ATELIER</div>
            <div className="av-empty-title">今天想创作什么?</div>
            <div className="av-empty-desc">{MODEL_DESC}</div>
            <div className="av-portal-composer">{renderComposer(true)}</div>
            <div className="av-scene-grid">
              {sceneCapsules.map((c) => (
                <button
                  key={c.view}
                  type="button"
                  className="av-scene-card at-card at-card--lift at-card-in"
                  onClick={() => goView(c.view)}
                >
                  <span className="av-scene-text">
                    <span className="av-scene-title">{c.label}</span>
                    <span className="av-scene-desc">{c.desc}</span>
                  </span>
                  <span className="av-scene-icon">
                    <Icon name={c.icon} size={20} strokeWidth={1.6} />
                  </span>
                </button>
              ))}
            </div>
            <div className="av-quick-grid">
              {QUICK_ACTIONS.map((a) => (
                <button
                  key={a.label}
                  type="button"
                  className="av-quick-card at-card at-card--lift at-card-in"
                  onClick={() => send(a.prompt)}
                >
                  <span className="av-quick-icon">
                    <Icon name={a.icon} size={14} strokeWidth={1.8} />
                  </span>
                  <span className="av-quick-label">{a.label}</span>
                  <span className="av-quick-desc">{getPreview(a.prompt, 36)}</span>
                </button>
              ))}
            </div>
            {recentWorks.length > 0 && (
              <section className="av-works" aria-label="最近作品">
                <div className="av-works-head">
                  <span className="av-works-title">最近作品</span>
                  <button
                    type="button"
                    className="at-btn at-btn--ghost av-works-more"
                    onClick={() => goView("library")}
                  >
                    查看全部
                  </button>
                </div>
                <div className="av-works-grid">
                  {recentWorks.map((job) => {
                    const filterKey = kindToFilter(job.kind);
                    return (
                      <button
                        key={job.id}
                        type="button"
                        className="av-work-card at-card at-card--lift at-card-in"
                        onClick={() => goView("library")}
                        aria-label={`在作品库查看: ${job.prompt || "未命名作品"}`}
                      >
                        <span className="av-work-thumb">
                          {isVideoKind(job.kind) ? (
                            <LazyVideo
                              src={imageUrl(job.results[0])}
                              muted
                              loop
                              playsInline
                            />
                          ) : filterKey === "image" ? (
                            <img
                              src={imageUrl(job.results[0])}
                              alt={job.prompt || "作品缩略图"}
                              /* 属性仅作加载前纵横比提示(16:9),CSS object-fit 裁切填满 */
                              width={480}
                              height={270}
                              loading="lazy"
                              decoding="async"
                            />
                          ) : (
                            <span className="av-work-thumb-icon" aria-hidden="true">
                              <Icon
                                name={
                                  filterKey === "audio"
                                    ? "audio"
                                    : filterKey === "3d"
                                      ? "box"
                                      : "file"
                                }
                                size={20}
                                strokeWidth={1.4}
                              />
                            </span>
                          )}
                        </span>
                        <span className="av-work-meta">
                          <span className="av-work-kind">{kindLabel(job.kind)}</span>
                          <span className="av-work-prompt">
                            {getPreview(job.prompt || "", 40)}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </section>
            )}
          </div>
        ) : (
          <div className="av-msg-list">
            {messages.map((msg) => (
              <div
                key={msg.id}
                className={`av-msg${msg.role === "user" ? " is-user" : " is-assistant"}`}
              >
                <div className="av-msg-avatar">
                  <Icon name={msg.role === "user" ? "user" : "braincircuit"} size={13} strokeWidth={1.8} />
                </div>
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
                    ) : msg.content || msg.media?.length ? (
                      <>
                        {msg.docs?.length ? (
                          <span className="doc-chips doc-chips--msg">
                            {msg.docs.map((d) => (
                              <span key={d.id} className="doc-chip">
                                <Icon name="file" size={11} strokeWidth={1.8} />
                                {d.filename}
                              </span>
                            ))}
                          </span>
                        ) : null}
                        {msg.role === "assistant" ? renderInlineMarkdown(msg.content) : msg.content}
                        {msg.media?.map((m, idx) => (
                          <div key={idx} className="av-media">
                            {m.type === "image" && m.urls[0] && (
                              <img
                                src={m.urls[0]}
                                alt="生成结果"
                                className="av-media-img"
                                loading="lazy"
                                decoding="async"
                              />
                            )}
                            {m.type === "video" && m.urls[0] && (
                              <video
                                src={m.urls[0]}
                                controls
                                className="av-media-video"
                              />
                            )}
                            {m.type === "audio" && m.urls[0] && (
                              <audio
                                src={m.urls[0]}
                                controls
                                className="av-media-audio"
                              />
                            )}
                            {m.type === "model3d" && m.urls[0] && (
                              <a
                                href={m.urls[0]}
                                target="_blank"
                                rel="noreferrer"
                                className="av-media-link"
                              >
                                <Icon name="box" size={14} strokeWidth={1.8} />
                                3D 模型
                              </a>
                            )}
                          </div>
                        ))}
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
            {pending && (
              <div className="av-msg is-assistant" aria-live="polite">
                <div className="av-msg-avatar">
                  <Icon name="braincircuit" size={13} strokeWidth={1.8} />
                </div>
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

      {/* 会话态:对话框沉底(门户态时由 C 位 renderComposer(true) 承担) */}
      {!isEmpty && renderComposer(false)}

      <div className={`av-panel av-panel--left${historyOpen ? " is-open" : ""}`}>
        <div className="av-panel-head">
          <span className="av-panel-title">对话历史</span>
          <button type="button" className="av-panel-close" onClick={() => setHistoryOpen(false)} aria-label="关闭对话历史面板" title="关闭">
            <Icon name="close" size={12} strokeWidth={1.8} />
          </button>
        </div>
        <div className="av-panel-body">
          {convStore.serverMode === null ? (
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
                  >
                    <Icon name="delete" size={11} strokeWidth={1.8} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className={`av-panel av-panel--right${contextOpen ? " is-open" : ""}`}>
        <div className="av-panel-head">
          <span className="av-panel-title">模型设置</span>
          <button type="button" className="av-panel-close" onClick={() => setContextOpen(false)} aria-label="关闭模型设置面板" title="关闭">
            <Icon name="close" size={12} strokeWidth={1.8} />
          </button>
        </div>
        <div className="av-panel-body" tabIndex={0}>
          <div className="av-prop-group">
            <div className="av-prop-label">当前模型</div>
            <div className="av-prop-value">
              <div className="av-model-pill av-model-pill--sm">
                <span className="av-model-dot" />
                <span className="av-model-name">{modelName}</span>
              </div>
            </div>
          </div>
          <div className="av-prop-group">
            <div className="av-prop-label">模型说明</div>
            <p className="av-prop-desc">{MODEL_DESC}</p>
          </div>
          <div className="av-prop-group">
            <div className="av-prop-label">对话统计</div>
            <div className="av-stats-row">
              <div className="av-stat">
                <span className="av-stat-value">{messages.length}</span>
                <span className="av-stat-label">消息</span>
              </div>
              <div className="av-stat">
                <span className="av-stat-value">{conversations.length}</span>
                <span className="av-stat-label">会话</span>
              </div>
            </div>
          </div>
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
            {docUploading ? "上传中…" : "上传文档(pdf / docx / txt / md,≤50MB)"}
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
                          <Icon name="file" size={12} strokeWidth={1.8} />
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

      <input
        ref={docFileRef}
        type="file"
        accept=".pdf,.docx,.txt,.md"
        className="doc-file-input"
        onChange={onPickDocFile}
        aria-hidden="true"
        tabIndex={-1}
      />

      {(historyOpen || contextOpen || docsOpen) && (
        <div
          className="av-panel-overlay"
          onClick={() => { setHistoryOpen(false); setContextOpen(false); setDocsOpen(false); }}
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

        /* ───── 页头(全局 page-header 规范:大标题+辅助描述+右侧操作区) ───── */
        .av-header {
          flex-shrink: 0;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: var(--space-4);
          padding: var(--space-4) var(--space-6); /* 壳层 app-main padding-top:56px 已垂直让开 CornerNav 触发器,左右对称 */
          background: var(--bg-surface-1);
          border-bottom: 1px solid var(--border-subtle);
          /* 悬浮 chrome 档:压过聊天内容层(0/1),让位于抽屉面板(var(--z-drawer)) */
          z-index: var(--z-sticky);
        }
        .av-header-main {
          display: flex;
          flex-direction: column;
          gap: var(--space-1);
          min-width: 0;
        }
        .av-header-title {
          font-size: var(--text-title);
          font-weight: var(--font-bold);
          color: var(--text-primary);
          letter-spacing: -0.01em;
          line-height: 1.2;
        }
        .av-header-desc {
          margin: 0;
          font-size: var(--text-aux);
          color: var(--text-muted);
          line-height: 1.5;
        }
        .av-header-actions {
          flex-shrink: 0;
          display: flex;
          align-items: center;
          gap: var(--space-2);
        }

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
          border-color: var(--accent-glow);
          color: var(--accent);
        }
        .av-tb-btn-ghost {
          background: transparent;
        }

        .av-model-pill {
          display: inline-flex;
          align-items: center;
          gap: var(--space-2);
          height: 26px;
          padding: 0 var(--space-3);
          /* Film Atelier:去灰底填充,编辑徽章 hairline(顶栏实例再叠 .at-badge) */
          background: transparent;
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-full);
          color: var(--text-secondary);
          font-size: var(--text-label);
          font-weight: var(--font-medium);
          font-family: var(--font-mono);
          letter-spacing: 0.04em;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .av-model-pill--sm {
          height: 22px;
          padding: 0 var(--space-2);
        }
        .av-model-dot {
          flex-shrink: 0;
          width: 6px;
          height: 6px;
          border-radius: 50%;
          background: var(--ok);
          box-shadow: 0 0 6px color-mix(in oklab, var(--ok) 60%, transparent);
          animation: av-dot-pulse 2s ease-in-out infinite;
        }
        @keyframes av-dot-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
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

        /* 点阵网格背景(Film Atelier 收敛:0.32→0.16,仅余极淡画布质感,空态 Fraunces 标题为主角) */
        .av-dot-grid {
          position: absolute;
          inset: 0;
          background-image: radial-gradient(circle, var(--border-strong) 1px, transparent 1px);
          background-size: 20px 20px;
          background-position: 0 0;
          opacity: 0.16;
          pointer-events: none;
          z-index: 0; /* 层内微调:点阵质感压底,内容层(1)浮其上 */
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
        /* 空态 kicker:Film Atelier 拉丁铭牌(.at-empty-kicker 语言,去 accent 药丸填充) */
        .av-empty-kicker {
          font-size: var(--text-label);
          font-weight: var(--font-medium);
          letter-spacing: 0.22em;
          text-transform: uppercase;
          color: var(--text-muted);
        }
        /* 空态大标题:Fraunces 展示位衬线(中文回退 PingFang SC),替代系统黑体 */
        .av-empty-title {
          font-family: var(--font-display);
          font-size: var(--text-display-md);
          font-weight: var(--font-semibold);
          color: var(--text-primary);
          letter-spacing: -0.01em;
          line-height: var(--leading-display);
        }
        .av-empty-desc {
          font-size: var(--text-body);
          color: var(--text-muted);
          line-height: 1.65;
          max-width: 440px;
          margin-bottom: var(--space-5);
        }
        .av-quick-grid {
          display: grid;
          grid-template-columns: repeat(2, 1fr);
          gap: var(--space-3);
          width: 100%;
          max-width: 560px;
        }
        /* 建议卡:材质由 .at-card 承担(发夹线 + 软阴影),入场走 .at-card-in 错落;
           本类只保留布局;hover 升浮走 .at-card--lift */
        .av-quick-card {
          display: flex;
          flex-direction: column;
          align-items: flex-start;
          gap: var(--space-2);
          padding: var(--space-4) var(--space-5);
          cursor: pointer;
          text-align: left;
        }
        .av-quick-icon {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 30px;
          height: 30px;
          border-radius: var(--radius-control);
          background: var(--accent-soft);
          color: var(--accent);
          margin-bottom: var(--space-1);
        }
        .av-quick-label {
          font-size: var(--text-body);
          font-weight: var(--font-semibold);
          color: var(--text-primary);
        }
        .av-quick-desc {
          font-size: var(--text-aux);
          /* AA 对比度:text-muted 在 surface-1 卡片上仅 ~3.4:1,用 secondary(≥4.5:1) */
          color: var(--text-secondary);
          line-height: 1.45;
          display: -webkit-box;
          -webkit-line-clamp: 2;
          -webkit-box-orient: vertical;
          overflow: hidden;
        }

        /* ───── 消息列表(720px 居中列,气泡尾角+圆形头像) ───── */
        .av-msg-list {
          position: relative;
          z-index: 1; /* 层内微调:内容压过点阵背景(0) */
          display: flex;
          flex-direction: column;
          gap: var(--space-6);
          /* 顶部让位灵动岛,首条气泡不贴岛 */
          padding: var(--space-12) var(--space-6) var(--space-8);
          max-width: 720px;
          margin: 0 auto;
        }
        .av-msg {
          display: flex;
          gap: var(--space-3);
          align-items: flex-start;
        }
        .av-msg.is-user {
          flex-direction: row-reverse;
        }
        .av-msg-avatar {
          flex-shrink: 0;
          width: 32px;
          height: 32px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          border-radius: var(--radius-full);
          background: var(--bg-surface-2);
          border: 1px solid var(--border-subtle);
          color: var(--text-secondary);
        }
        .av-msg.is-user .av-msg-avatar {
          background: var(--accent-soft);
          border-color: var(--accent-glow);
          color: var(--accent);
        }
        .av-msg-body {
          display: flex;
          flex-direction: column;
          gap: var(--space-2);
          max-width: calc(100% - 48px);
          min-width: 0;
        }
        .av-msg.is-user .av-msg-body {
          align-items: flex-end;
        }
        .av-msg-bubble {
          padding: var(--space-3) var(--space-5);
          background: var(--bg-surface-1);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-xl) var(--radius-xl) var(--radius-xl) var(--radius-xs); /* 助手气泡:左下尾角指向头像 */
          box-shadow: var(--shadow-sm);
          font-size: var(--text-body);
          color: var(--text-primary);
          line-height: 1.65;
          word-break: break-word;
          white-space: pre-wrap;
        }
        .av-msg.is-user .av-msg-bubble {
          background: var(--accent);
          border-color: transparent;
          border-radius: var(--radius-xl) var(--radius-xl) var(--radius-xs) var(--radius-xl); /* 用户气泡:右下尾角 */
          box-shadow: 0 2px 10px color-mix(in oklab, var(--accent) 18%, transparent);
          color: var(--text-on-accent);
        }
        .av-msg-time {
          font-size: var(--text-label);
          color: var(--text-muted);
          font-family: var(--font-mono);
          padding: 0 var(--space-2);
        }

        /* 失败态错误气泡(替换打字指示器) */
        .av-msg-bubble--error {
          display: flex;
          flex-direction: column;
          align-items: flex-start;
          gap: var(--space-2);
          background: var(--err-soft);
          border-color: color-mix(in oklab, var(--err) 45%, transparent);
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
          border-color: var(--accent-glow);
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
          background: linear-gradient(180deg, transparent 0%, var(--bg-surface-1) 24%);
          /* 悬浮 chrome 档:与页头同级,让位于抽屉面板(var(--z-drawer)) */
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
          background: linear-gradient(145deg, var(--bg-surface-2), var(--bg-surface-3));
          border: 1px solid var(--border-subtle);
          border-radius: calc(var(--radius-panel) * 2); /* 24px 大圆角,区别于普通面板 */
          box-shadow:
            inset 0 1px 1px color-mix(in oklab, var(--text-primary) 4%, transparent),
            var(--shadow-md);
          transition: border-color var(--duration-fast) var(--ease-standard),
            box-shadow var(--duration-fast) var(--ease-standard),
            transform var(--duration-fast) var(--ease-standard);
          overflow: hidden;
        }
        .av-composer-box::before {
          content: "";
          position: absolute;
          inset: 0;
          border-radius: inherit;
          padding: 1px;
          background: linear-gradient(160deg, color-mix(in oklab, var(--accent) 10%, transparent), transparent 60%);
          -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
          -webkit-mask-composite: xor;
          mask-composite: exclude;
          opacity: 0;
          transition: opacity var(--duration-fast) var(--ease-standard);
          pointer-events: none;
        }
        .av-composer-box:hover {
          border-color: var(--border-strong);
          transform: translateY(-1px);
          box-shadow:
            inset 0 1px 1px color-mix(in oklab, var(--text-primary) 5%, transparent),
            var(--shadow-lg);
        }
        .av-composer-box:hover::before {
          opacity: 1;
        }
        .av-composer-box:focus-within {
          border-color: var(--accent-glow);
          transform: translateY(-2px);
          /* Film Atelier:聚焦态补 accent 软晕(accent-soft 外环 + accent 投影) */
          box-shadow:
            0 0 0 1px var(--accent-glow),
            0 0 0 5px var(--accent-soft),
            0 12px 32px color-mix(in oklab, var(--accent) 16%, transparent),
            inset 0 1px 1px color-mix(in oklab, var(--text-primary) 5%, transparent);
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

        /* ───── 侧边面板(历史 / 模型设置) ───── */
        .av-panel {
          position: absolute;
          top: 0;
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
          border-radius: var(--radius-sm);
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
          border-color: var(--accent-glow);
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
          border-radius: var(--radius-sm);
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
          .av-model-dot { animation: none; }
          .av-typing-dot { animation: none; }
          .av-composer-stop { animation: none; }
          .av-composer-input::placeholder { animation: none; }
          .av-panel-overlay { animation: none; }
        }

        /* 移动端 */
        @media (max-width: 767px) {
          .av-header {
            flex-wrap: wrap;
            gap: var(--space-2);
            padding: var(--space-3) var(--space-4);
          }
          .av-header-title {
            font-size: 17px;
          }
          .av-header-desc {
            display: none;
          }
          .av-header-actions {
            margin-left: auto;
          }
          .av-model-pill {
            max-width: 132px;
          }
          /* 图标按钮:标签隐藏后收成正方形,触控目标 ≥44px */
          .av-tb-btn {
            width: 44px;
            height: 44px;
            padding: 0;
            justify-content: center;
          }
          .av-tb-btn span {
            display: none;
          }
          .av-msg-list {
            padding: var(--space-8) var(--space-4) var(--space-5);
          }
          .av-empty-title {
            font-size: var(--text-display-sm);
          }
          .av-quick-grid {
            grid-template-columns: 1fr;
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
