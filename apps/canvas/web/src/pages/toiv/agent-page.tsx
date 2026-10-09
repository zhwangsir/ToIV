/**
 * M2 智能体对话原生页(`/toiv/agent`,2026-10-09):
 * 移植 ToIV chat（SSE + 工具卡 + 会话管理）到 BeefTV 壳；加强点：
 * - 对话产物「一键入画布」(canvas-proposal API + stash)
 * - 画布节点「发到对话」草稿 take
 */
import { ArrowLeft, GitBranch, History, Loader2, MessageSquarePlus, Plus, Send, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";

import { renderProposalCard, renderToolCard, toolTitle, type ToolCardCtx } from "@/components/toiv/toolcards/registry";
import { IconButton, ToolButton } from "@/components/ui/base/buttons";
import { EmptyState } from "@/components/ui/product/empty-state";
import {
    deleteAgentSession,
    fetchAgentCanvasProposal,
    fetchAgentHistory,
    fetchAgentSessions,
    forkAgentSession,
    stashCanvasProposal,
    streamAgentChat,
    type ToivAgentSessionSummary,
    type ToivStreamEvent,
} from "@/services/toiv/agent-chat";
import { takeAgentDraft } from "@/services/toiv/agent-draft";

type TextTurn = { kind: "text"; role: "user" | "assistant"; content: string };
type ToolTurn = { kind: "tool"; name: string; payload: Record<string, unknown>; status?: string };
type ProposalTurn = { kind: "proposal"; payload: Record<string, unknown> };
type Turn = TextTurn | ToolTurn | ProposalTurn;

function parseMsg(data: Record<string, unknown>): { role: "user" | "assistant"; content: string } | null {
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

export default function AgentPage() {
    const navigate = useNavigate();
    const [input, setInput] = useState("");
    const [busy, setBusy] = useState(false);
    const [sessionId, setSessionId] = useState<string | null>(null);
    const [turns, setTurns] = useState<Turn[]>([]);
    const [sessions, setSessions] = useState<ToivAgentSessionSummary[]>([]);
    const [listOpen, setListOpen] = useState(true);
    const [notice, setNotice] = useState<string | null>(null);
    const [applyingProposal, setApplyingProposal] = useState(false);
    const abortRef = useRef<ReturnType<typeof streamAgentChat> | null>(null);
    const scrollRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLTextAreaElement>(null);

    useEffect(() => {
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
    }, [turns]);

    const loadSessions = useCallback(async () => {
        try {
            setSessions(await fetchAgentSessions());
        } catch {
            /* 未登录等静默 */
        }
    }, []);

    useEffect(() => {
        void loadSessions();
    }, [loadSessions]);

    useEffect(() => {
        const draft = takeAgentDraft();
        if (!draft) return;
        const seed = [draft.text, draft.mediaUrl && !draft.text.includes(draft.mediaUrl) ? `素材: ${draft.mediaUrl}` : ""]
            .filter(Boolean)
            .join("\n");
        if (seed) {
            setInput(seed);
            setNotice(draft.nodeTitle ? `已从画布节点「${draft.nodeTitle}」带入，可编辑后发送` : "已带入草稿，可编辑后发送");
            requestAnimationFrame(() => inputRef.current?.focus());
        }
    }, []);

    const openSession = useCallback(async (sid: string) => {
        abortRef.current?.abort();
        setSessionId(sid);
        try {
            setTurns((await fetchAgentHistory(sid)).map((m) => ({ kind: "text" as const, role: m.role === "user" ? "user" : "assistant", content: m.content })));
        } catch {
            setNotice("会话历史读取失败");
        }
    }, []);

    const newSession = useCallback(() => {
        abortRef.current?.abort();
        setSessionId(null);
        setTurns([]);
    }, []);

    const onFork = useCallback(async () => {
        if (!sessionId || busy) return;
        try {
            const next = await forkAgentSession(sessionId);
            await loadSessions();
            await openSession(next.id);
            setNotice("已分叉为新会话");
        } catch {
            setNotice("分叉失败");
        }
    }, [sessionId, busy, loadSessions, openSession]);

    const onDelete = useCallback(async (sid: string) => {
        try {
            await deleteAgentSession(sid);
            if (sessionId === sid) newSession();
            await loadSessions();
        } catch {
            setNotice("删除会话失败");
        }
    }, [sessionId, newSession, loadSessions]);

    const applyToCanvas = useCallback(async (payload: Record<string, unknown>) => {
        if (!sessionId) {
            setNotice("请先完成一轮对话以绑定会话，再入画布");
            return;
        }
        setApplyingProposal(true);
        try {
            const proposal = await fetchAgentCanvasProposal(sessionId);
            stashCanvasProposal(proposal, sessionId);
            setNotice(`提案「${proposal.title || proposal.proposal_id}」已取回，正在打开画布（图结构落节点下一刀消费 stash）`);
            // 优先回当前画布；无项目上下文时回工作室首页由用户选画布
            navigate("/canvas");
            void payload;
        } catch (err) {
            setNotice(err instanceof Error ? err.message : "取回画布提案失败");
        } finally {
            setApplyingProposal(false);
        }
    }, [sessionId, navigate]);

    const toolCtx: ToolCardCtx = useMemo(
        () => ({
            onApplyInput: (text) => {
                setInput(text);
                inputRef.current?.focus();
            },
            onOpenApp: (appId) => navigate(`/toiv/market?app=${encodeURIComponent(appId)}`),
            onOpenBoard: (boardId) => navigate(`/toiv/library/${encodeURIComponent(boardId)}`),
            onApplyToCanvas: (payload) => applyToCanvas(payload),
        }),
        [navigate, applyToCanvas],
    );

    const send = useCallback(() => {
        const text = input.trim();
        if (!text || busy) return;
        setInput("");
        setTurns((p) => [...p, { kind: "text", role: "user", content: text }]);
        setBusy(true);
        let acc = "";
        const h = streamAgentChat([{ role: "user", content: text }], sessionId, (ev: ToivStreamEvent) => {
            if (ev.kind === "session") {
                setSessionId(ev.sessionId);
                void loadSessions();
            } else if (ev.kind === "msg") {
                const m = parseMsg(ev.data);
                if (!m?.content) return;
                if (ev.data.delta !== undefined) {
                    acc += m.content;
                    setTurns((prev) => {
                        const next = [...prev];
                        for (let i = next.length - 1; i >= 0; i--) {
                            const it = next[i];
                            if (it.kind === "text" && it.role === "assistant") {
                                next[i] = { kind: "text", role: "assistant", content: acc };
                                return next;
                            }
                        }
                        next.push({ kind: "text", role: "assistant", content: acc });
                        return next;
                    });
                } else {
                    acc = m.content;
                    setTurns((p) => [...p, { kind: "text", role: "assistant", content: m.content }]);
                }
            } else if (ev.kind === "proposal") {
                setTurns((p) => [...p, { kind: "proposal", payload: ev.data }]);
            } else if (ev.kind === "tool" || ev.kind === "job") {
                setTurns((p) => [
                    ...p,
                    {
                        kind: "tool",
                        name: toolNameOf(ev.data),
                        payload: ev.data,
                        status: typeof ev.data.status === "string" ? ev.data.status : undefined,
                    },
                ]);
            }
        }, (err) => setTurns((p) => [...p, { kind: "text", role: "assistant", content: `⚠ ${err.message}` }]));
        abortRef.current = h;
        void h.done.finally(() => {
            setBusy(false);
            abortRef.current = null;
            void loadSessions();
        });
    }, [input, busy, sessionId, loadSessions]);

    const renderTurn = (t: Turn, i: number): ReactNode => {
        if (t.kind === "proposal") {
            const card = renderProposalCard(t.payload, toolCtx);
            return (
                <div key={i} className="max-w-[min(100%,520px)]">
                    {card ?? (
                        <div className="rounded-lg border border-dashed border-[var(--border)] px-3 py-2 text-xs text-[var(--muted-foreground,#a8a8a8)]">
                            画布提案
                            {sessionId ? (
                                <button
                                    type="button"
                                    className="ml-2 underline"
                                    disabled={applyingProposal}
                                    onClick={() => void applyToCanvas(t.payload)}
                                >
                                    一键入画布
                                </button>
                            ) : null}
                        </div>
                    )}
                </div>
            );
        }
        if (t.kind === "tool") {
            const card = renderToolCard(t.name, t.payload, toolCtx);
            if (card) return <div key={i} className="max-w-[min(100%,520px)]">{card}</div>;
            return (
                <div key={i} className="max-w-[70%] rounded-lg border border-dashed border-[var(--border)] px-3 py-2 text-xs text-[var(--muted-foreground,#a8a8a8)]">
                    🛠 {toolTitle(t.name)}
                    {t.status ? ` · ${t.status}` : ""}
                </div>
            );
        }
        return (
            <div key={i} className={`flex ${t.role === "user" ? "justify-end" : "justify-start"}`}>
                <div
                    className={`max-w-[70%] whitespace-pre-wrap break-words rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                        t.role === "user" ? "bg-[var(--workspace-accent,#2a2a2a)]" : "border border-[var(--border)] bg-[var(--card,#181818)]"
                    }`}
                >
                    {t.content}
                </div>
            </div>
        );
    };

    return (
        <main className="flex h-full w-full overflow-hidden">
            {listOpen && (
                <aside className="flex w-60 shrink-0 flex-col border-r border-[var(--border)]">
                    <div className="flex items-center justify-between px-3 py-3">
                        <IconButton icon={X} size="sm" aria-label="收起会话列表" onClick={() => setListOpen(false)} />
                        <ToolButton size="sm" variant="default" icon={<Plus />} label="新会话" onClick={newSession} />
                    </div>
                    <div className="flex-1 overflow-auto p-2">
                        {sessions.length === 0 ? (
                            <p className="p-3 text-center text-xs text-[var(--muted-foreground,#a8a8a8)]">暂无会话</p>
                        ) : (
                            sessions.map((s) => (
                                <div
                                    key={s.id}
                                    className={`group mb-1 flex items-center gap-1 rounded-lg ${
                                        s.id === sessionId ? "bg-[var(--surface-active,rgba(255,255,255,0.1))]" : "hover:bg-[var(--surface-hover,rgba(255,255,255,0.06))]"
                                    }`}
                                >
                                    <button
                                        type="button"
                                        onClick={() => void openSession(s.id)}
                                        className="min-w-0 flex-1 truncate px-3 py-2 text-left text-xs"
                                    >
                                        {s.title || s.id.slice(0, 18)}
                                    </button>
                                    <button
                                        type="button"
                                        className="mr-1 hidden rounded p-1 text-[var(--muted-foreground,#a8a8a8)] hover:text-red-400 group-hover:inline-flex"
                                        aria-label="删除会话"
                                        onClick={() => void onDelete(s.id)}
                                    >
                                        <Trash2 className="size-3" />
                                    </button>
                                </div>
                            ))
                        )}
                    </div>
                </aside>
            )}
            <section className="flex min-w-0 flex-1 flex-col">
                <header className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
                    <div className="flex items-center gap-2">
                        {!listOpen && <IconButton icon={History} size="sm" aria-label="展开会话列表" onClick={() => setListOpen(true)} />}
                        <h1 className="text-lg font-semibold leading-7 tracking-tight text-foreground">智能体对话</h1>
                        {sessionId ? (
                            <ToolButton size="sm" variant="ghost" icon={<GitBranch />} label="分叉" onClick={() => void onFork()} disabled={busy} />
                        ) : null}
                    </div>
                    <div className="flex items-center gap-2">
                        {sessionId ? (
                            <ToolButton
                                size="sm"
                                variant="default"
                                icon={<MessageSquarePlus />}
                                label={applyingProposal ? "取回中…" : "一键入画布"}
                                loading={applyingProposal}
                                onClick={() => void applyToCanvas({})}
                            />
                        ) : null}
                        <Link to="/">
                            <ToolButton size="sm" variant="default" icon={<ArrowLeft />} label="返回首页" />
                        </Link>
                    </div>
                </header>
                {notice ? (
                    <p role="alert" className="border-b border-[var(--border)] bg-[var(--surface-hover,rgba(255,255,255,0.03))] px-4 py-2 text-xs text-[var(--muted-foreground,#a8a8a8)]">
                        {notice}
                        <button type="button" className="ml-2 underline" onClick={() => setNotice(null)}>
                            关闭
                        </button>
                    </p>
                ) : null}
                <div ref={scrollRef} className="flex-1 space-y-3 overflow-auto p-6">
                    {turns.length === 0 && (
                        <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
                            <EmptyState description="对智能体说点什么——生成图片/视频/音乐、查市场、做短剧、粗剪成片" />
                        </div>
                    )}
                    {turns.map(renderTurn)}
                    {busy && (
                        <div className="flex items-center gap-2 px-2 text-xs text-[var(--muted-foreground,#a8a8a8)]">
                            <Loader2 className="size-3.5 animate-spin" />
                            思考中…
                        </div>
                    )}
                </div>
                <footer className="flex items-center gap-2 border-t border-[var(--border)] p-4">
                    <textarea
                        ref={inputRef}
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === "Enter" && !e.shiftKey) {
                                e.preventDefault();
                                send();
                            }
                        }}
                        placeholder="输入指令，Enter 发送 / Shift+Enter 换行"
                        rows={2}
                        className="min-w-0 flex-1 resize-none rounded-xl border border-[var(--border)] bg-transparent px-4 py-2.5 text-sm outline-none focus:border-[var(--workspace-accent,#3a3a3a)]"
                        disabled={busy}
                    />
                    <button
                        type="button"
                        onClick={send}
                        disabled={busy || !input.trim()}
                        aria-busy={busy || undefined}
                        className="inline-flex h-9 select-none items-center justify-center gap-1.5 rounded-md bg-foreground px-3 text-caption font-medium text-background transition-opacity hover:opacity-85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-45 [&_svg]:size-4"
                    >
                        {busy ? <Loader2 className="animate-spin" aria-hidden /> : <Send aria-hidden />}
                        <span>发送</span>
                    </button>
                </footer>
            </section>
        </main>
    );
}
