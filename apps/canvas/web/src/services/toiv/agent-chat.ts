import { toivHttp } from "./client";

/**
 * ToIV 智能体直连客户端(C4,2026-10-06):
 * 画布内助手升级为真智能体——SSE 流式对话 + 工具事件 + 会话域。
 * 事件协议(对齐 main routes/agent.py):msg(消息/增量) tool(工具) job(作业) proposal(画布提案) done。
 */
export type ToivChatMessage = { role: "user" | "assistant"; content: string };

export type ToivStreamEvent =
    | { kind: "msg"; data: Record<string, unknown> }
    | { kind: "tool"; data: Record<string, unknown> }
    | { kind: "job"; data: Record<string, unknown> }
    | { kind: "proposal"; data: Record<string, unknown> }
    | { kind: "done" }
    | { kind: "session"; sessionId: string };

export type ToivAgentSessionSummary = {
    id: string;
    title?: string;
    updated_at?: string;
    message_count?: number;
};

export async function fetchAgentSessions(): Promise<ToivAgentSessionSummary[]> {
    const { data } = await toivHttp.get("/agent/sessions");
    const list = Array.isArray(data) ? data : ((data as { sessions?: ToivAgentSessionSummary[] })?.sessions ?? []);
    return list;
}

export async function fetchAgentHistory(sessionId: string): Promise<ToivChatMessage[]> {
    const { data } = await toivHttp.get(`/agent/sessions/${sessionId}`);
    const messages = (data as { messages?: Array<{ role: string; content: string }> })?.messages ?? [];
    return messages.filter((m) => m.role === "user" || m.role === "assistant").map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
}

function getToken(): string {
    return typeof window !== "undefined" ? window.localStorage.getItem("toiv_token") ?? "" : "";
}

/** 流式对话:fetch 手解 SSE(event: xxx / data: {...}),回调逐事件;返回 abort 句柄。 */
export function streamAgentChat(
    messages: ToivChatMessage[],
    sessionId: string | null,
    onEvent: (ev: ToivStreamEvent) => void,
    onError: (err: Error) => void,
): { abort: () => void; done: Promise<string | null> } {
    const controller = new AbortController();
    const done = (async () => {
        let sid = sessionId;
        try {
            const resp = await fetch("/api/agent/chat", {
                method: "POST",
                signal: controller.signal,
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${getToken()}` },
                body: JSON.stringify({ messages, session_id: sessionId || undefined }),
            });
            if (!resp.ok || !resp.body) throw new Error(`智能体连接失败(${resp.status})`);
            const headerSid = resp.headers.get("X-Agent-Session-Id");
            if (headerSid && headerSid !== sid) { sid = headerSid; onEvent({ kind: "session", sessionId: headerSid }); }
            const reader = resp.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";
            for (;;) {
                const { value, done: finished } = await reader.read();
                if (finished) break;
                buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
                let sep: number;
                while ((sep = buffer.indexOf("\n\n")) >= 0) {
                    const frame = buffer.slice(0, sep);
                    buffer = buffer.slice(sep + 2);
                    let event = "msg";
                    const dataLines: string[] = [];
                    for (const line of frame.split("\n")) {
                        if (line.startsWith("event:")) event = line.slice(6).trim();
                        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
                    }
                    if (!dataLines.length) continue;
                    let data: Record<string, unknown> = {};
                    try { data = JSON.parse(dataLines.join("\n")); } catch { data = { raw: dataLines.join("\n") }; }
                    if (event === "done") onEvent({ kind: "done" });
                    else if (event === "tool") onEvent({ kind: "tool", data });
                    else if (event === "job") onEvent({ kind: "job", data });
                    else if (event === "proposal") onEvent({ kind: "proposal", data });
                    else onEvent({ kind: "msg", data });
                }
            }
            return sid;
        } catch (err) {
            if (!(err instanceof DOMException && err.name === "AbortError")) onError(err instanceof Error ? err : new Error(String(err)));
            return sid;
        }
    })();
    return { abort: () => controller.abort(), done };
}
