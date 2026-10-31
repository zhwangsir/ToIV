export type AgentSseHandler = (event: string, data: Record<string, unknown>) => void;

/** 逐块喂入 SSE 文本；按空行切帧，`event:` 缺省为 msg，注释帧（保活）直接丢弃。 */
export function createSseParser(emit: AgentSseHandler): (chunk: string) => void {
    let buffer = "";
    return (chunk) => {
        buffer += chunk.replace(/\r\n/g, "\n");
        let sep: number;
        while ((sep = buffer.indexOf("\n\n")) >= 0) {
            const frame = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            let event = "msg";
            const dataLines: string[] = [];
            for (const line of frame.split("\n")) {
                if (line.startsWith(":")) continue;
                if (line.startsWith("event:")) event = line.slice(6).trim();
                else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
            }
            if (!dataLines.length) continue;
            const raw = dataLines.join("\n");
            let data: Record<string, unknown>;
            try {
                data = JSON.parse(raw) as Record<string, unknown>;
            } catch {
                data = { raw };
            }
            emit(event, data);
        }
    };
}

export type AgentChatMessage = { role: "user" | "assistant"; content: string };

export type AgentApiGraph = Record<string, { class_type?: string; inputs?: Record<string, unknown> }>;

export type AgentCanvasProposal = {
    proposal_id: string;
    title: string;
    body: string;
    warnings: string[];
    status: string;
    graph: AgentApiGraph;
};

function authHeaders(extra?: HeadersInit): HeadersInit {
    const token = typeof localStorage !== "undefined" ? localStorage.getItem("toiv_token") : null;
    return { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra };
}

/**
 * POST /api/agent/chat 的流式读取。事件原样交给 onEvent：
 * session（响应头）/ msg / tool / job / proposal / done。
 */
export async function streamAgentChat(
    messages: AgentChatMessage[],
    sessionId: string | null,
    onEvent: AgentSseHandler,
    signal?: AbortSignal,
): Promise<string | null> {
    const res = await fetch("/api/agent/chat", {
        method: "POST",
        signal,
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ messages, session_id: sessionId || undefined }),
    });
    if (!res.ok || !res.body) throw new Error(`Agent 连接失败（${res.status}）`);
    let sid = sessionId;
    const header = res.headers.get("X-Agent-Session-Id");
    if (header && header !== sid) {
        sid = header;
        onEvent("session", { session_id: header });
    }
    const parse = createSseParser(onEvent);
    const decoder = new TextDecoder();
    const reader = res.body.getReader();
    for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        parse(decoder.decode(value, { stream: true }));
    }
    parse(decoder.decode());
    return sid;
}

export async function fetchAgentCanvasProposal(sessionId: string): Promise<AgentCanvasProposal> {
    const res = await fetch(`/api/agent/sessions/${encodeURIComponent(sessionId)}/canvas-proposal`, {
        headers: authHeaders(),
    });
    if (!res.ok) throw new Error(`画布提案载入失败（${res.status}）`);
    return (await res.json()) as AgentCanvasProposal;
}
