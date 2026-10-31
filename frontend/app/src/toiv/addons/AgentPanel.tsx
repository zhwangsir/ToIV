import { useEffect, useRef, useState, type FormEvent } from "react";
import Button from "../../components/ui/Button";
import {
    fetchAgentCanvasProposal,
    streamAgentChat,
    type AgentApiGraph,
} from "../adapters/agent";

export type AgentCanvasPayload = { title: string; graph: AgentApiGraph };

type ToolEntry = {
    kind: "tool";
    id: string;
    name: string;
    summary: string;
    detail?: string;
    status: "running" | "done" | "error";
};

type JobEntry = { kind: "job"; id: string; label: string; status: string };

type ProposalEntry = {
    kind: "proposal";
    id: string;
    title: string;
    body: string;
    estimate?: string;
    nodeCount?: number;
    warnings: string[];
    canvas: boolean;
};

type Entry =
    | { kind: "user"; text: string }
    | { kind: "assistant"; text: string }
    | { kind: "error"; text: string }
    | ToolEntry
    | JobEntry
    | ProposalEntry;

const TOOL_STATUS_LABEL = { running: "运行中", done: "完成", error: "失败" } as const;

function str(value: unknown): string {
    return typeof value === "string" ? value : "";
}

function replaceTool(entries: Entry[], next: ToolEntry): Entry[] {
    const without = entries.filter((entry) => !(entry.kind === "tool" && entry.id === next.id));
    return [...without, next];
}

export default function AgentPanel({ onCanvasProposal }: {
    onCanvasProposal: (payload: AgentCanvasPayload) => void;
}) {
    const [entries, setEntries] = useState<Entry[]>([]);
    const [input, setInput] = useState("");
    const [streaming, setStreaming] = useState(false);
    const [sessionId, setSessionId] = useState<string | null>(null);
    const [loadingProposal, setLoadingProposal] = useState<string | null>(null);
    const abortRef = useRef<AbortController | null>(null);
    const logRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const log = logRef.current;
        if (log) log.scrollTop = log.scrollHeight;
    }, [entries, streaming]);

    const send = async (event: FormEvent) => {
        event.preventDefault();
        const text = input.trim();
        if (!text || streaming) return;
        setInput("");
        setEntries((prev) => [...prev, { kind: "user", text }]);
        setStreaming(true);
        const controller = new AbortController();
        abortRef.current = controller;
        try {
            const sid = await streamAgentChat(
                [{ role: "user", content: text }],
                sessionId,
                (name, data) => {
                    if (name === "session") {
                        if (str(data.session_id)) setSessionId(str(data.session_id));
                        return;
                    }
                    if (name === "msg") {
                        if (data.type === "text" && str(data.content).trim()) {
                            setEntries((prev) => [...prev, { kind: "assistant", text: str(data.content) }]);
                        } else if (data.type === "error" && str(data.content)) {
                            setEntries((prev) => [...prev, { kind: "error", text: str(data.content) }]);
                        }
                        return;
                    }
                    if (name === "tool") {
                        const status = data.status === "start" ? "running" : data.status === "error" ? "error" : "done";
                        setEntries((prev) => replaceTool(prev, {
                            kind: "tool",
                            id: str(data.id) || str(data.name) || "tool",
                            name: str(data.name) || "工具",
                            summary: str(data.summary),
                            detail: str(data.detail) || undefined,
                            status,
                        }));
                        return;
                    }
                    if (name === "job") {
                        const id = str(data.job_id) || str(data.label) || "job";
                        setEntries((prev) => {
                            const rest = prev.filter((entry) => !(entry.kind === "job" && entry.id === id));
                            return [...rest, { kind: "job", id, label: str(data.label) || str(data.kind) || "作业", status: str(data.status) }];
                        });
                        return;
                    }
                    if (name === "proposal") {
                        setEntries((prev) => [...prev, {
                            kind: "proposal",
                            id: str(data.proposal_id) || "proposal",
                            title: str(data.title) || "方案",
                            body: str(data.body),
                            estimate: str(data.estimate) || undefined,
                            nodeCount: typeof data.node_count === "number" ? data.node_count : undefined,
                            warnings: Array.isArray(data.warnings) ? data.warnings.filter((item): item is string => typeof item === "string") : [],
                            canvas: data.kind === "canvas_graph",
                        }]);
                    }
                },
                controller.signal,
            );
            if (sid && sid !== sessionId) setSessionId(sid);
        } catch (error) {
            if (!(error instanceof DOMException && error.name === "AbortError")) {
                setEntries((prev) => [...prev, {
                    kind: "error",
                    text: error instanceof Error ? error.message : String(error),
                }]);
            }
        } finally {
            setStreaming(false);
            abortRef.current = null;
        }
    };

    const stop = () => {
        abortRef.current?.abort();
        abortRef.current = null;
        setStreaming(false);
    };

    const reset = () => {
        stop();
        setEntries([]);
        setSessionId(null);
        setInput("");
    };

    const loadProposal = async (entry: ProposalEntry) => {
        if (!sessionId || loadingProposal) return;
        setLoadingProposal(entry.id);
        try {
            const proposal = await fetchAgentCanvasProposal(sessionId);
            onCanvasProposal({ title: proposal.title, graph: proposal.graph });
        } catch (error) {
            setEntries((prev) => [...prev, {
                kind: "error",
                text: error instanceof Error ? error.message : String(error),
            }]);
        } finally {
            setLoadingProposal(null);
        }
    };

    return (
        <div className="toiv-agent">
            <header className="toiv-agent-head">
                <h2>Agent</h2>
                <span className="meta">{sessionId ? `会话 ${sessionId.slice(0, 6)}` : "新会话"}</span>
                <Button size="sm" variant="text" onClick={reset} disabled={streaming || (!entries.length && !sessionId)}>
                    新会话
                </Button>
            </header>
            <div className="toiv-agent-log" role="log" aria-label="对话记录" ref={logRef}>
                {entries.length === 0 ? (
                    <p className="toiv-workspace-note">让 Agent 编排画布，或直接生成素材。</p>
                ) : null}
                {entries.map((entry, index) => {
                    if (entry.kind === "user" || entry.kind === "assistant") {
                        return (
                            <div className={`toiv-agent-msg ${entry.kind}`} key={index}>
                                <b>{entry.kind === "user" ? "你" : "Agent"}</b>
                                <p>{entry.text}</p>
                            </div>
                        );
                    }
                    if (entry.kind === "error") {
                        return <p className="toiv-agent-error" role="alert" key={index}>{entry.text}</p>;
                    }
                    if (entry.kind === "tool") {
                        return (
                            <div className={`toiv-agent-tool st-${entry.status}`} key={`tool-${entry.id}`}>
                                <b>{entry.name}</b>
                                <span>{entry.summary || entry.detail || ""}</span>
                                <em>{TOOL_STATUS_LABEL[entry.status]}</em>
                            </div>
                        );
                    }
                    if (entry.kind === "job") {
                        return (
                            <div className="toiv-agent-tool st-job" key={`job-${entry.id}`}>
                                <b>{entry.label}</b>
                                <span>{entry.id.slice(0, 8)}</span>
                                <em>{entry.status}</em>
                            </div>
                        );
                    }
                    return (
                        <div className="toiv-agent-proposal" key={`proposal-${entry.id}`}>
                            <header>
                                <b>{entry.title}</b>
                                {entry.nodeCount ? <span className="tag">{entry.nodeCount} 个节点</span> : null}
                            </header>
                            <p>{entry.body}</p>
                            {entry.estimate ? <span className="meta">预计 {entry.estimate}</span> : null}
                            {entry.warnings.length ? (
                                <ul>
                                    {entry.warnings.map((warning) => <li key={warning}>{warning}</li>)}
                                </ul>
                            ) : null}
                            {entry.canvas ? (
                                <Button size="sm" variant="lime"
                                    disabled={!sessionId || loadingProposal === entry.id}
                                    onClick={() => loadProposal(entry)}>
                                    {loadingProposal === entry.id ? "载入中…" : "载入画布"}
                                </Button>
                            ) : null}
                        </div>
                    );
                })}
                {streaming ? <p className="toiv-agent-thinking" role="status">思考中…</p> : null}
            </div>
            <form className="toiv-agent-compose" onSubmit={send}>
                <textarea aria-label="消息" rows={2} value={input} placeholder="描述你想生成的画面或编排…"
                    onChange={(event) => setInput(event.target.value)} />
                <div className="toiv-agent-actions">
                    {streaming ? <Button size="sm" variant="outline" onClick={stop}>停止</Button> : null}
                    <Button type="submit" size="sm" variant="lime" disabled={streaming || !input.trim()}>发送</Button>
                </div>
            </form>
        </div>
    );
}
