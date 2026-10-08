import { ArrowLeft, History, Loader2, Plus, Send, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router";

import { IconButton, ToolButton } from "@/components/ui/base/buttons";
import { EmptyState } from "@/components/ui/product/empty-state";
import { fetchAgentHistory, fetchAgentSessions, streamAgentChat, type ToivAgentSessionSummary, type ToivStreamEvent } from "@/services/toiv/agent-chat";

type Turn = { kind: "text"; role: "user" | "assistant"; content: string } | { kind: "tool"; tool: string; status?: string; summary?: string };

function parseMsg(data: Record<string, unknown>): { role: "user" | "assistant"; content: string } | null {
    if (data.type === "text" && typeof data.content === "string") return { role: "assistant", content: data.content };
    if (typeof data.delta === "string") return { role: "assistant", content: data.delta };
    if (typeof data.content === "string" && (data.role === "assistant" || data.role === "user")) return { role: data.role as "user" | "assistant", content: data.content };
    return null;
}

export default function AgentPage() {
    const [input, setInput] = useState("");
    const [busy, setBusy] = useState(false);
    const [sessionId, setSessionId] = useState<string | null>(null);
    const [turns, setTurns] = useState<Turn[]>([]);
    const [sessions, setSessions] = useState<ToivAgentSessionSummary[]>([]);
    const [listOpen, setListOpen] = useState(true);
    const [notice, setNotice] = useState<string | null>(null);
    const abortRef = useRef<ReturnType<typeof streamAgentChat> | null>(null);
    const scrollRef = useRef<HTMLDivElement>(null);

    useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }); }, [turns]);
    const loadSessions = useCallback(async () => {
        try { setSessions(await fetchAgentSessions()); } catch { /* 静默 */ }
    }, []);
    useEffect(() => { void loadSessions(); }, [loadSessions]);

    const openSession = useCallback(async (sid: string) => {
        abortRef.current?.abort();
        setSessionId(sid);
        try { setTurns((await fetchAgentHistory(sid)).map((m) => ({ kind: "text" as const, role: m.role, content: m.content }))); }
        catch { setNotice("会话历史读取失败"); }
    }, []);

    const newSession = useCallback(() => { abortRef.current?.abort(); setSessionId(null); setTurns([]); }, []);

    const send = useCallback(() => {
        const text = input.trim();
        if (!text || busy) return;
        setInput("");
        setTurns((p) => [...p, { kind: "text", role: "user", content: text }]);
        setBusy(true);
        let acc = "";
        const h = streamAgentChat([{ role: "user", content: text }], sessionId, (ev: ToivStreamEvent) => {
            if (ev.kind === "session") { setSessionId(ev.sessionId); void loadSessions(); }
            else if (ev.kind === "msg") {
                const m = parseMsg(ev.data);
                if (!m?.content) return;
                if (ev.data.delta !== undefined) {
                    acc += m.content;
                    setTurns((prev) => {
                        const next = [...prev];
                        for (let i = next.length - 1; i >= 0; i--) {
                            const it = next[i];
                            if (it.kind === "text" && it.role === "assistant") { next[i] = { kind: "text", role: "assistant", content: acc }; return next; }
                        }
                        next.push({ kind: "text", role: "assistant", content: acc });
                        return next;
                    });
                } else {
                    acc = m.content;
                    setTurns((p) => [...p, { kind: "text", role: "assistant", content: m.content as string }]);
                }
            } else if (ev.kind === "tool" || ev.kind === "job" || ev.kind === "proposal") {
                setTurns((p) => [...p, { kind: "tool", tool: String(ev.data.tool ?? ev.data.name ?? "工具"), status: String(ev.data.status ?? ""), summary: String(ev.data.summary ?? ev.data.detail ?? "").slice(0, 140) }]);
            }
        }, (err) => setTurns((p) => [...p, { kind: "text", role: "assistant", content: `⚠ ${err.message}` }]));
        abortRef.current = h;
        void h.done.finally(() => { setBusy(false); abortRef.current = null; });
    }, [input, busy, sessionId, loadSessions]);

    return (
        <main className="flex h-full w-full overflow-hidden">
            {listOpen && (
                <aside className="flex w-60 shrink-0 flex-col border-r border-[var(--border)]">
                    <div className="flex items-center justify-between px-3 py-3">
                        <IconButton icon={X} size="sm" aria-label="收起会话列表" onClick={() => setListOpen(false)} />
                        <ToolButton size="sm" variant="default" icon={<Plus />} label="新会话" onClick={newSession} />
                    </div>
                    <div className="flex-1 overflow-auto p-2">
                        {sessions.length === 0 ? <p className="p-3 text-center text-xs text-[var(--muted-foreground,#a8a8a8)]">暂无会话</p> :
                            sessions.map((s) => (
                                <button key={s.id} type="button" onClick={() => void openSession(s.id)}
                                    className={`mb-1 w-full truncate rounded-lg px-3 py-2 text-left text-xs hover:bg-[var(--surface-hover,rgba(255,255,255,0.06))] ${s.id === sessionId ? "bg-[var(--surface-active,rgba(255,255,255,0.1))]" : ""}`}>
                                    {s.title || s.id.slice(0, 18)}
                                </button>
                            ))}
                    </div>
                </aside>
            )}
            <section className="flex min-w-0 flex-1 flex-col">
                <header className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
                    <div className="flex items-center gap-2">
                        {!listOpen && <IconButton icon={History} size="sm" aria-label="展开会话列表" onClick={() => setListOpen(true)} />}
                        <h1 className="text-lg font-semibold leading-7 text-foreground">智能体对话</h1>
                    </div>
                    <Link to="/"><ToolButton size="sm" variant="default" icon={<ArrowLeft />} label="返回首页" /></Link>
                </header>
                {notice ? (
                    <p role="alert" className="border-b border-[var(--border)] px-4 py-2 text-xs text-status-error">
                        {notice}
                        <button type="button" className="ml-2 underline" onClick={() => setNotice(null)}>关闭</button>
                    </p>
                ) : null}
                <div ref={scrollRef} className="flex-1 space-y-3 overflow-auto p-6">
                    {turns.length === 0 && (
                        <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
                            <EmptyState description="对智能体说点什么——生成图片/视频/音乐、查市场、做短剧、粗剪成片" />
                        </div>
                    )}
                    {turns.map((t, i) => t.kind === "tool" ? (
                        <div key={i} className="max-w-[70%] rounded-lg border border-dashed border-[var(--border)] px-3 py-2 text-xs text-[var(--muted-foreground,#a8a8a8)]">
                            🛠 {t.tool}{t.status ? ` · ${t.status}` : ""}{t.summary ? ` — ${t.summary}` : ""}
                        </div>
                    ) : (
                        <div key={i} className={`flex ${t.role === "user" ? "justify-end" : "justify-start"}`}>
                            <div className={`max-w-[70%] whitespace-pre-wrap break-words rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${t.role === "user" ? "bg-[var(--workspace-accent,#2a2a2a)]" : "border border-[var(--border)] bg-[var(--card,#181818)]"}`}>
                                {t.content}
                            </div>
                        </div>
                    ))}
                    {busy && <div className="flex items-center gap-2 px-2 text-xs text-[var(--muted-foreground,#a8a8a8)]"><Loader2 className="size-3.5 animate-spin" />思考中…</div>}
                </div>
                <footer className="flex items-center gap-2 border-t border-[var(--border)] p-4">
                    <textarea
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
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
