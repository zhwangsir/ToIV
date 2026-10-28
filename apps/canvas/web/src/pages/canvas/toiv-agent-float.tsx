/**
 * 画布内 ToIV 智能体浮窗(M2)：与 /toiv/agent 共用 toolcards registry。
 * F9(2026-10-15 UI 统一波):对齐经典 web 助手浮层的启动序列(打开动画/初始建议/
 * 会话分叉入口)与任务中心抽屉——功能等价移植,不搬霓虹灯带等超出 token 体系的视觉。
 */
import { Button, Popconfirm, Tooltip } from "antd";
import { Bot, ChevronDown, ExternalLink, GitBranch, History, ListChecks, Loader2, Plus, Send, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";

import { renderProposalCard, renderToolCard, toolTitle, type ToolCardCtx } from "@/components/toiv/toolcards/registry";
import {
    fetchAgentHistory,
    fetchAgentSessions,
    forkAgentSession,
    stashCanvasProposal,
    streamAgentChat,
    type ToivAgentCanvasProposal,
    type ToivAgentSessionSummary,
    type ToivStreamEvent,
} from "@/services/toiv/agent-chat";
import { stashPendingAgentSession } from "@/services/toiv/agent-draft";
import { cancelJob, fetchJobs, type ToivJob } from "@/services/toiv/client";

type TextTurn = { kind: "text"; role: "user" | "assistant"; content: string };
type ToolTurn = { kind: "tool"; name: string; payload: Record<string, unknown>; status?: string };
type ProposalTurn = { kind: "proposal"; payload: Record<string, unknown> };
type Turn = TextTurn | ToolTurn | ProposalTurn;

/** 启动序列时长:呼吸小核 + 状态文字(对齐 web av-boot 的 1.6s 呼吸节奏,取半程即入场)。 */
export const FLOAT_BOOT_MS = 800;

/** 初始建议(空会话时的快捷起手,点击填入输入框可编辑后发送——等价 web 场景卡/快捷动作)。 */
export const FLOAT_SUGGESTIONS = [
    "帮我策划一部三集短剧",
    "市场里有哪些图像生成应用?",
    "生成一张科幻电影海报",
] as const;

/** 任务抽屉的「在跑」判集(与 /toiv/tasks 页 CANCELABLE 同源)。 */
export const FLOAT_ACTIVE_JOB_STATUSES = ["queued", "held", "running"] as const;

const FLOAT_JOB_STATUS_LABELS: Record<string, string> = {
    queued: "排队中",
    held: "等待资源",
    running: "运行中",
};

export function floatJobStatusLabel(status: string): string {
    return FLOAT_JOB_STATUS_LABELS[status] ?? status;
}

/** 任务抽屉轮询节奏(与经典 web TaskCenter 一致:5s)。 */
const TASK_POLL_MS = 5_000;

function parseMsgEvent(data: Record<string, unknown>): { role: "user" | "assistant"; content: string } | null {
    if (data.type === "text" && typeof data.content === "string") return { role: "assistant", content: data.content };
    if (typeof data.delta === "string") return { role: "assistant", content: data.delta };
    if (typeof data.content === "string" && (data.role === "assistant" || data.role === "user")) {
        return { role: data.role as "user" | "assistant", content: data.content };
    }
    return null;
}

function toolNameOf(data: Record<string, unknown>): string {
    return String(data.tool ?? data.name ?? data.tool_name ?? "工具");
}

function toolCardPayload(data: Record<string, unknown>): Record<string, unknown> {
    const inner = data.payload;
    if (inner && typeof inner === "object" && !Array.isArray(inner)) {
        return inner as Record<string, unknown>;
    }
    return data;
}

function looksLikeProposal(payload: Record<string, unknown>): boolean {
    if (!payload || typeof payload !== "object") return false;
    if (typeof payload.proposal_id === "string" && payload.proposal_id) return true;
    if (payload.graph && typeof payload.graph === "object") return true;
    return false;
}

function toCanvasProposal(payload: Record<string, unknown>): ToivAgentCanvasProposal {
    const graphRaw = payload.graph;
    const graph =
        graphRaw && typeof graphRaw === "object" && !Array.isArray(graphRaw)
            ? (graphRaw as ToivAgentCanvasProposal["graph"])
            : {};
    return {
        proposal_id: String(payload.proposal_id ?? `local-${Date.now()}`),
        title: String(payload.title ?? ""),
        body: String(payload.body ?? payload.summary ?? ""),
        warnings: Array.isArray(payload.warnings) ? payload.warnings.map((w) => String(w)) : [],
        status: String(payload.status ?? "pending"),
        graph,
    };
}

export function ToivAgentFloat() {
    const navigate = useNavigate();
    const [open, setOpen] = useState(false);
    const [input, setInput] = useState("");
    const [busy, setBusy] = useState(false);
    const [sessionId, setSessionId] = useState<string | null>(null);
    const [turns, setTurns] = useState<Turn[]>([]);
    const [sessions, setSessions] = useState<ToivAgentSessionSummary[]>([]);
    const [historyOpen, setHistoryOpen] = useState(false);
    const [tasksOpen, setTasksOpen] = useState(false);
    const [notice, setNotice] = useState<string | null>(null);
    // 启动序列:首开播放一次(呼吸小核+状态文字);prefers-reduced-motion 直开。
    const [booting, setBooting] = useState(false);
    const bootedOnceRef = useRef(false);
    const bootTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    // 任务中心抽屉:在跑 ToIV 作业(5s 轮询,仅抽屉展开期间)。
    const [activeJobs, setActiveJobs] = useState<ToivJob[]>([]);
    const [tasksErr, setTasksErr] = useState(false);
    const [cancelingIds, setCancelingIds] = useState<ReadonlySet<string>>(new Set());
    const abortRef = useRef<ReturnType<typeof streamAgentChat> | null>(null);
    const scrollRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
    }, [turns]);

    useEffect(() => () => {
        if (bootTimerRef.current) clearTimeout(bootTimerRef.current);
    }, []);

    const openFloat = useCallback(() => {
        setOpen(true);
        if (bootedOnceRef.current) return;
        const reduceMotion =
            typeof window !== "undefined" &&
            typeof window.matchMedia === "function" &&
            window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        if (reduceMotion) {
            bootedOnceRef.current = true;
            return;
        }
        bootedOnceRef.current = true;
        setBooting(true);
        bootTimerRef.current = setTimeout(() => {
            setBooting(false);
            bootTimerRef.current = null;
            requestAnimationFrame(() => inputRef.current?.focus());
        }, FLOAT_BOOT_MS);
    }, []);

    const loadSessions = useCallback(async () => {
        try {
            setSessions(await fetchAgentSessions());
        } catch {
            /* 静默 */
        }
    }, []);

    useEffect(() => {
        if (open && historyOpen) void loadSessions();
    }, [open, historyOpen, loadSessions]);

    // 任务抽屉:展开期间 5s 轮询在跑作业(收起即停,浮层不做常驻轮询)。
    useEffect(() => {
        if (!open || !tasksOpen) return;
        let disposed = false;
        const tick = async () => {
            try {
                const jobs = await fetchJobs(50);
                if (disposed) return;
                setActiveJobs(jobs.filter((j) => (FLOAT_ACTIVE_JOB_STATUSES as readonly string[]).includes(j.status)));
                setTasksErr(false);
            } catch {
                if (!disposed) setTasksErr(true); // 保留旧数据,下轮自愈
            }
        };
        void tick();
        const timer = setInterval(() => void tick(), TASK_POLL_MS);
        return () => {
            disposed = true;
            clearInterval(timer);
        };
    }, [open, tasksOpen]);

    const onCancelJob = useCallback(async (job: ToivJob) => {
        setCancelingIds((prev) => new Set(prev).add(job.id));
        try {
            const ok = await cancelJob(job.id);
            setNotice(ok ? `已中止任务 ${job.prompt?.slice(0, 20) || job.id.slice(0, 8)}` : "中止失败,请到任务中心重试");
            const jobs = await fetchJobs(50);
            setActiveJobs(jobs.filter((j) => (FLOAT_ACTIVE_JOB_STATUSES as readonly string[]).includes(j.status)));
        } finally {
            setCancelingIds((prev) => {
                const next = new Set(prev);
                next.delete(job.id);
                return next;
            });
        }
    }, []);

    const openSession = useCallback(async (sid: string) => {
        abortRef.current?.abort();
        setSessionId(sid);
        setHistoryOpen(false);
        try {
            setTurns(
                (await fetchAgentHistory(sid))
                    .filter((m) => m.role === "user" || m.role === "assistant")
                    .map((m) => ({ kind: "text" as const, role: m.role as "user" | "assistant", content: m.content })),
            );
        } catch {
            setNotice("会话历史读取失败");
        }
    }, []);

    const newSession = useCallback(() => {
        abortRef.current?.abort();
        setSessionId(null);
        setTurns([]);
        setHistoryOpen(false);
    }, []);

    /** 会话分叉(等价 web SessionDrawer 的 fork):复制为新会话并就地打开。 */
    const forkSession = useCallback(async (sid: string) => {
        try {
            const next = await forkAgentSession(sid);
            await loadSessions();
            await openSession(next.id);
            setNotice("已分叉为新会话");
        } catch {
            setNotice("分叉会话失败");
        }
    }, [loadSessions, openSession]);

    /** 在对话视图打开:stash 会话 id,工作台内 AgentPage 挂载时消费。 */
    const openInAgentPage = useCallback((sid: string) => {
        stashPendingAgentSession(sid);
        navigate("/create?view=agent");
    }, [navigate]);

    const applyToCanvas = useCallback(async (payload: Record<string, unknown>) => {
        try {
            if (looksLikeProposal(payload)) {
                stashCanvasProposal(toCanvasProposal(payload), sessionId || "");
                setNotice("提案已暂存，打开画布后下一刀消费 stash");
                return;
            }
            setNotice("请先在对话页取回会话提案，或等待提案事件");
        } catch (err) {
            setNotice(err instanceof Error ? err.message : "入画布失败");
        }
    }, [sessionId]);

    const toolCtx: ToolCardCtx = useMemo(
        () => ({
            onApplyInput: (text) => {
                setInput(text);
                inputRef.current?.focus();
            },
            onOpenApp: (appId) => navigate(`/toiv/market?app=${encodeURIComponent(appId)}`),
            onOpenBoard: (boardId) => navigate(`/library/works/${encodeURIComponent(boardId)}`),
            onApplyToCanvas: (payload) => {
                void applyToCanvas(payload);
            },
        }),
        [navigate, applyToCanvas],
    );

    const send = useCallback(() => {
        const text = input.trim();
        if (!text || busy) return;
        setInput("");
        setTurns((prev) => [...prev, { kind: "text", role: "user", content: text }]);
        setBusy(true);
        let acc = "";
        const handle = streamAgentChat(
            [{ role: "user", content: text }],
            sessionId,
            (ev: ToivStreamEvent) => {
                if (ev.kind === "session") setSessionId(ev.sessionId);
                else if (ev.kind === "msg") {
                    const m = parseMsgEvent(ev.data);
                    if (!m?.content) return;
                    if (ev.data.delta !== undefined) {
                        acc += m.content;
                        setTurns((prev) => {
                            const next = [...prev];
                            for (let i = next.length - 1; i >= 0; i--) {
                                const item = next[i];
                                if (item.kind === "text" && item.role === "assistant") {
                                    next[i] = { kind: "text", role: "assistant", content: acc };
                                    return next;
                                }
                            }
                            next.push({ kind: "text", role: "assistant", content: acc });
                            return next;
                        });
                    } else {
                        acc = m.content;
                        setTurns((prev) => [...prev, { kind: "text", role: "assistant", content: m.content }]);
                    }
                } else if (ev.kind === "proposal") {
                    setTurns((prev) => [...prev, { kind: "proposal", payload: ev.data }]);
                } else if (ev.kind === "job") {
                    setTurns((prev) => [
                        ...prev,
                        {
                            kind: "tool",
                            name: "submit_generation",
                            payload: ev.data,
                            status: typeof ev.data.status === "string" ? ev.data.status : undefined,
                        },
                    ]);
                } else if (ev.kind === "tool") {
                    setTurns((prev) => [
                        ...prev,
                        {
                            kind: "tool",
                            name: toolNameOf(ev.data),
                            payload: toolCardPayload(ev.data),
                            status: typeof ev.data.status === "string" ? ev.data.status : undefined,
                        },
                    ]);
                }
            },
            (err) => setTurns((prev) => [...prev, { kind: "text", role: "assistant", content: `⚠ ${err.message}` }]),
        );
        abortRef.current = handle;
        void handle.done.finally(() => {
            setBusy(false);
            abortRef.current = null;
        });
    }, [input, busy, sessionId]);

    const renderTurn = (t: Turn, i: number): ReactNode => {
        if (t.kind === "proposal") {
            const card = renderProposalCard(t.payload, toolCtx);
            return (
                <div key={i} className="max-w-full">
                    {card ?? (
                        <div className="rounded-lg border border-dashed border-[var(--border)] px-2.5 py-1.5 text-[11px] text-[var(--muted-foreground,#a8a8a8)]">
                            画布提案
                        </div>
                    )}
                </div>
            );
        }
        if (t.kind === "tool") {
            const card = t.status === "ok" || t.status === undefined || t.payload.job_id
                ? renderToolCard(t.name, t.payload, toolCtx)
                : null;
            if (card) return <div key={i} className="max-w-full">{card}</div>;
            return (
                <div key={i} className="rounded-lg border border-dashed border-[var(--border)] px-2.5 py-1.5 text-[11px] text-[var(--muted-foreground,#a8a8a8)]">
                    🛠 {toolTitle(t.name)}
                    {t.status ? ` · ${t.status}` : ""}
                </div>
            );
        }
        return (
            <div key={i} className={`max-w-[85%] rounded-xl px-3 py-2 text-sm leading-relaxed ${t.role === "user" ? "ml-auto bg-[var(--workspace-accent,#2a2a2a)]" : "bg-[var(--muted,rgba(255,255,255,0.06))]"}`}>
                <p className="whitespace-pre-wrap break-words">{t.content}</p>
            </div>
        );
    };

    if (!open) {
        return (
            <Tooltip title="ToIV 智能体(工具·市场·短剧全域)" placement="left">
                <button
                    type="button"
                    onClick={openFloat}
                    className="fixed bottom-6 right-6 z-40 flex h-12 w-12 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--card,#181818)] shadow-lg transition-transform hover:scale-105"
                    aria-label="打开 ToIV 智能体"
                >
                    <Bot className="h-5 w-5" />
                </button>
            </Tooltip>
        );
    }

    return (
        <div className="fixed bottom-6 right-6 z-40 flex h-[32rem] w-[24rem] flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--card,#181818)] shadow-2xl">
            <header className="flex items-center justify-between border-b border-[var(--border)] px-3 py-2">
                <div className="flex items-center gap-2 text-sm font-medium"><Bot className="h-4 w-4" />ToIV 智能体</div>
                <div className="flex items-center gap-1">
                    <Button size="small" type="text" icon={<ListChecks className="h-3.5 w-3.5" />} onClick={() => { setTasksOpen((v) => !v); setHistoryOpen(false); }} aria-label="任务中心" aria-pressed={tasksOpen} />
                    <Button size="small" type="text" icon={<History className="h-3.5 w-3.5" />} onClick={() => { setHistoryOpen((v) => !v); setTasksOpen(false); }} aria-label="会话历史" aria-pressed={historyOpen} />
                    <Button size="small" type="text" icon={<Plus className="h-3.5 w-3.5" />} onClick={newSession} aria-label="新会话" />
                    <Button size="small" type="text" icon={<X className="h-3.5 w-3.5" />} onClick={() => setOpen(false)} aria-label="收起" />
                </div>
            </header>

            {notice ? (
                <p role="alert" className="border-b border-[var(--border)] px-3 py-1.5 text-[11px] text-status-error">
                    {notice}
                    <button type="button" className="ml-2 underline" onClick={() => setNotice(null)}>关闭</button>
                </p>
            ) : null}

            {booting ? (
                /* 启动序列:呼吸小核 + 状态文字(reduced-motion 不会到达此分支) */
                <div className="flex flex-1 flex-col items-center justify-center gap-3" role="status" aria-label="智能体启动中">
                    <span className="flex h-10 w-10 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--muted,rgba(255,255,255,0.06))]">
                        <Bot className="h-5 w-5 animate-pulse" aria-hidden="true" />
                    </span>
                    <p className="text-xs text-[var(--muted-foreground,#a8a8a8)]">正在接入 ToIV 智能体…</p>
                </div>
            ) : tasksOpen ? (
                <div className="flex min-h-0 flex-1 flex-col">
                    <div className="flex-1 overflow-auto p-2">
                        <p className="px-1 pb-1.5 text-[11px] font-medium text-[var(--muted-foreground,#a8a8a8)]">
                            在跑任务{activeJobs.length > 0 ? `(${activeJobs.length})` : ""}
                        </p>
                        {tasksErr && <p className="p-3 text-center text-xs text-[var(--muted-foreground,#a8a8a8)]">进度刷新失败,重试中…</p>}
                        {!tasksErr && activeJobs.length === 0 && (
                            <p className="p-4 text-center text-xs text-[var(--muted-foreground,#a8a8a8)]">当前没有在跑的任务</p>
                        )}
                        {activeJobs.map((job) => (
                            <div key={job.id} className="mb-1.5 rounded-lg border border-[var(--border)] px-2.5 py-2">
                                <div className="flex items-center justify-between gap-2">
                                    <span className="flex items-center gap-1.5 text-[11px] text-[var(--muted-foreground,#a8a8a8)]">
                                        {job.status === "running" && <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />}
                                        {job.kind || "生成"} · {floatJobStatusLabel(job.status)}
                                    </span>
                                    <Popconfirm
                                        title="中止任务"
                                        description="已产生的进度不会保留,确认中止?"
                                        okText="确认中止"
                                        cancelText="再想想"
                                        onConfirm={() => void onCancelJob(job)}
                                    >
                                        <Button size="small" type="text" danger loading={cancelingIds.has(job.id)} aria-label={`中止任务:${job.prompt || job.id}`}>
                                            中止
                                        </Button>
                                    </Popconfirm>
                                </div>
                                <p className="mt-1 truncate text-xs" title={job.prompt}>{job.prompt || "(无提示词)"}</p>
                            </div>
                        ))}
                    </div>
                    <footer className="border-t border-[var(--border)] p-2">
                        <Button size="small" type="text" block icon={<ExternalLink className="h-3.5 w-3.5" />} onClick={() => navigate("/toiv/tasks")}>
                            打开任务中心
                        </Button>
                    </footer>
                </div>
            ) : historyOpen ? (
                <div className="flex-1 overflow-auto p-2">
                    {sessions.length === 0 ? <p className="p-4 text-center text-xs text-[var(--muted-foreground,#a8a8a8)]">暂无历史会话</p> :
                        sessions.map((s) => (
                            <div
                                key={s.id}
                                className={`group mb-1 flex items-center gap-0.5 rounded-lg ${s.id === sessionId ? "bg-[var(--surface-active,rgba(255,255,255,0.1))]" : "hover:bg-[var(--surface-hover,rgba(255,255,255,0.06))]"}`}
                            >
                                <button type="button" onClick={() => void openSession(s.id)}
                                    className="min-w-0 flex-1 truncate px-3 py-2 text-left text-xs">
                                    {s.title || s.id.slice(0, 16)}
                                </button>
                                <Tooltip title="分叉为新会话">
                                    <Button size="small" type="text" className="opacity-0 transition-opacity group-hover:opacity-100"
                                        icon={<GitBranch className="h-3 w-3" />} aria-label={`分叉会话:${s.title || s.id}`}
                                        onClick={() => void forkSession(s.id)} />
                                </Tooltip>
                                <Tooltip title="在对话页打开">
                                    <Button size="small" type="text" className="mr-1 opacity-0 transition-opacity group-hover:opacity-100"
                                        icon={<ExternalLink className="h-3 w-3" />} aria-label={`在对话页打开:${s.title || s.id}`}
                                        onClick={() => openInAgentPage(s.id)} />
                                </Tooltip>
                            </div>
                        ))}
                </div>
            ) : (
                <div ref={scrollRef} className="flex-1 space-y-2 overflow-auto p-3">
                    {turns.length === 0 && (
                        <div className="flex h-full flex-col items-center justify-center gap-3 px-2 text-center">
                            <p className="text-xs text-[var(--muted-foreground,#a8a8a8)]">对智能体说点什么——它可以调用工具、查市场、跑生成任务</p>
                            {/* 初始建议(F9):点击填入输入框,可编辑后发送 */}
                            <div className="flex flex-wrap justify-center gap-1.5">
                                {FLOAT_SUGGESTIONS.map((s) => (
                                    <button
                                        key={s}
                                        type="button"
                                        onClick={() => { setInput(s); inputRef.current?.focus(); }}
                                        className="rounded-full border border-[var(--border)] px-2.5 py-1 text-[11px] text-[var(--muted-foreground,#a8a8a8)] transition-colors hover:bg-[var(--surface-hover,rgba(255,255,255,0.06))] hover:text-foreground"
                                    >
                                        {s}
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}
                    {turns.map(renderTurn)}
                    {busy && <div className="px-2 text-[11px] text-[var(--muted-foreground,#a8a8a8)]">思考中…</div>}
                </div>
            )}

            <footer className="flex items-center gap-2 border-t border-[var(--border)] p-2">
                <input
                    ref={inputRef}
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
                    placeholder="输入指令，Enter 发送"
                    className="min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-transparent px-3 py-1.5 text-sm outline-none focus:border-[var(--workspace-accent,#3a3a3a)]"
                    disabled={busy || booting}
                />
                <Button size="small" type="primary" icon={<Send className="h-3.5 w-3.5" />} onClick={send} loading={busy} disabled={!input.trim()} aria-label="发送" />
                {busy && <Button size="small" type="text" icon={<ChevronDown className="h-3.5 w-3.5" />} onClick={() => abortRef.current?.abort()} aria-label="停止" />}
            </footer>
        </div>
    );
}
