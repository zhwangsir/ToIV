import { Button, Tooltip } from "antd";
import { Bot, ChevronDown, History, Plus, Send, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { fetchAgentHistory, fetchAgentSessions, streamAgentChat, type ToivAgentSessionSummary, type ToivChatMessage, type ToivStreamEvent } from "@/services/toiv/agent-chat";

type ToolEvt = { tool: string; status?: string; summary?: string };

function parseMsgEvent(data: Record<string, unknown>): Partial<ToivChatMessage> | null {
    // 兼容三种形态(实测契约):整条 {type:"text",content} / 增量 {delta} / 整条 {role,content}
    if (data.type === "text" && typeof data.content === "string") return { role: "assistant", content: data.content };
    if (typeof data.delta === "string") return { role: "assistant", content: data.delta };
    if (typeof data.content === "string" && (data.role === "assistant" || data.role === "user")) return { role: data.role, content: data.content };
    return null;
}

function toolSummary(data: Record<string, unknown>): ToolEvt {
    return {
        tool: String(data.tool ?? data.name ?? data.tool_name ?? "工具"),
        status: String(data.status ?? data.state ?? ""),
        summary: String(data.summary ?? data.detail ?? data.text ?? "").slice(0, 120),
    };
}

export function ToivAgentFloat() {
    const [open, setOpen] = useState(false);
    const [input, setInput] = useState("");
    const [busy, setBusy] = useState(false);
    const [sessionId, setSessionId] = useState<string | null>(null);
    const [turns, setTurns] = useState<Array<{ kind: "text"; role: "user" | "assistant"; content: string } | { kind: "tool" } & ToolEvt>>([]);
    const [sessions, setSessions] = useState<ToivAgentSessionSummary[]>([]);
    const [historyOpen, setHistoryOpen] = useState(false);
    const abortRef = useRef<ReturnType<typeof streamAgentChat> | null>(null);
    const scrollRef = useRef<HTMLDivElement>(null);

    useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }); }, [turns]);

    const loadSessions = useCallback(async () => {
        try { setSessions(await fetchAgentSessions()); } catch { /* 静默 */ }
    }, []);

    useEffect(() => { if (open && historyOpen) void loadSessions(); }, [open, historyOpen, loadSessions]);

    const openSession = useCallback(async (sid: string) => {
        abortRef.current?.abort();
        setSessionId(sid);
        setHistoryOpen(false);
        setTurns((await fetchAgentHistory(sid)).map((m) => ({ kind: "text" as const, role: m.role, content: m.content })));
    }, []);

    const newSession = useCallback(() => { abortRef.current?.abort(); setSessionId(null); setTurns([]); setHistoryOpen(false); }, []);

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
                            next.push({ kind: "text", role: "assistant", content: acc } as never);
                            return next;
                        });
                    } else {
                        acc = m.content;
                        setTurns((prev) => [...prev, { kind: "text", role: "assistant", content: m.content as string }]);
                    }
                } else if (ev.kind === "tool" || ev.kind === "job" || ev.kind === "proposal") {
                    setTurns((prev) => [...prev, { kind: "tool", ...toolSummary(ev.data) }]);
                }
            },
            (err) => setTurns((prev) => [...prev, { kind: "text", role: "assistant", content: `⚠ ${err.message}` }]),
        );
        abortRef.current = handle;
        void handle.done.finally(() => { setBusy(false); abortRef.current = null; });
    }, [input, busy, sessionId]);

    if (!open) {
        return (
            <Tooltip title="ToIV 智能体(工具·市场·短剧全域)" placement="left">
                <button
                    type="button"
                    onClick={() => setOpen(true)}
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
                    <Button size="small" type="text" icon={<History className="h-3.5 w-3.5" />} onClick={() => setHistoryOpen((v) => !v)} aria-label="会话历史" />
                    <Button size="small" type="text" icon={<Plus className="h-3.5 w-3.5" />} onClick={newSession} aria-label="新会话" />
                    <Button size="small" type="text" icon={<X className="h-3.5 w-3.5" />} onClick={() => setOpen(false)} aria-label="收起" />
                </div>
            </header>

            {historyOpen ? (
                <div className="flex-1 overflow-auto p-2">
                    {sessions.length === 0 ? <p className="p-4 text-center text-xs text-[var(--muted-foreground,#a8a8a8)]">暂无历史会话</p> :
                        sessions.map((s) => (
                            <button key={s.id} type="button" onClick={() => void openSession(s.id)}
                                className={`mb-1 w-full truncate rounded-lg px-3 py-2 text-left text-xs hover:bg-[var(--surface-hover,rgba(255,255,255,0.06))] ${s.id === sessionId ? "bg-[var(--surface-active,rgba(255,255,255,0.1))]" : ""}`}>
                                {s.title || s.id.slice(0, 16)}
                            </button>
                        ))}
                </div>
            ) : (
                <div ref={scrollRef} className="flex-1 space-y-2 overflow-auto p-3">
                    {turns.length === 0 && <p className="pt-8 text-center text-xs text-[var(--muted-foreground,#a8a8a8)]">对智能体说点什么——它可以调用工具、查市场、跑生成任务</p>}
                    {turns.map((t, i) => t.kind === "tool" ? (
                        <div key={i} className="rounded-lg border border-dashed border-[var(--border)] px-2.5 py-1.5 text-[11px] text-[var(--muted-foreground,#a8a8a8)]">
                            🛠 {t.tool}{t.status ? ` · ${t.status}` : ""}{t.summary ? ` — ${t.summary}` : ""}
                        </div>
                    ) : (
                        <div key={i} className={`max-w-[85%] rounded-xl px-3 py-2 text-sm leading-relaxed ${t.role === "user" ? "self-end ml-auto bg-[var(--workspace-accent,#2a2a2a)]" : "bg-[var(--muted,rgba(255,255,255,0.06))]"}`}>
                            <p className="whitespace-pre-wrap break-words">{t.content}</p>
                        </div>
                    ))}
                    {busy && <div className="px-2 text-[11px] text-[var(--muted-foreground,#a8a8a8)]">思考中…</div>}
                </div>
            )}

            <footer className="flex items-center gap-2 border-t border-[var(--border)] p-2">
                <input
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
                    placeholder="输入指令，Enter 发送"
                    className="min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-transparent px-3 py-1.5 text-sm outline-none focus:border-[var(--workspace-accent,#3a3a3a)]"
                    disabled={busy}
                />
                <Button size="small" type="primary" icon={<Send className="h-3.5 w-3.5" />} onClick={send} loading={busy} disabled={!input.trim()} aria-label="发送" />
                {busy && <Button size="small" type="text" icon={<ChevronDown className="h-3.5 w-3.5" />} onClick={() => abortRef.current?.abort()} aria-label="停止" />}
            </footer>
        </div>
    );
}
