import { toivHttp } from "./client";

/**
 * ToIV 智能体直连客户端(C4 / M2 对话移植,2026-10-09):
 * SSE 流式对话 + 工具/作业/提案事件 + 会话域(列表/历史/分叉/删除/画布提案)。
 * 事件协议对齐 main routes/agent.py:msg tool job proposal done。
 * 会话 id 经响应头 X-Agent-Session-Id 返回(与 CORS expose_headers 一致)。
 */

export type ToivChatMessage = { role: "user" | "assistant"; content: string };

export type ToivStreamEvent =
    | { kind: "msg"; data: Record<string, unknown> }
    | { kind: "tool"; data: Record<string, unknown> }
    | { kind: "job"; data: Record<string, unknown> }
    | { kind: "proposal"; data: Record<string, unknown> }
    | { kind: "session"; sessionId: string }
    | { kind: "done" };

export type ToivAgentSessionSummary = {
    id: string;
    title?: string;
    updated_at?: string;
    created_at?: string;
    message_count?: number;
};

export type ToivAgentCanvasProposal = {
    proposal_id: string;
    title: string;
    body: string;
    warnings: string[];
    status: string;
    graph: Record<string, { class_type: string; inputs: Record<string, unknown> }>;
};

function getToken(): string {
    return typeof window !== "undefined" ? window.localStorage.getItem("toiv_token") ?? "" : "";
}

export async function fetchAgentSessions(): Promise<ToivAgentSessionSummary[]> {
    const { data } = await toivHttp.get("/agent/sessions");
    const list = Array.isArray(data)
        ? data
        : ((data as { sessions?: ToivAgentSessionSummary[] })?.sessions
            ?? (data as { items?: ToivAgentSessionSummary[] })?.items
            ?? []);
    return list as ToivAgentSessionSummary[];
}

export async function fetchAgentHistory(sessionId: string): Promise<ToivChatMessage[]> {
    const { data } = await toivHttp.get(`/agent/sessions/${sessionId}`);
    const messages = (data as { messages?: Array<{ role: string; content?: string; text?: string }> })?.messages ?? [];
    return messages
        .map((m) => {
            const role: "user" | "assistant" = m.role === "user" ? "user" : "assistant";
            const content = typeof m.content === "string" ? m.content : typeof m.text === "string" ? m.text : "";
            return { role, content };
        })
        .filter((m) => m.content);
}

export async function forkAgentSession(sessionId: string, atMessageId?: number): Promise<ToivAgentSessionSummary> {
    const { data } = await toivHttp.post(
        `/agent/sessions/${sessionId}/fork`,
        atMessageId != null ? { at_message_id: atMessageId } : {},
    );
    return data as ToivAgentSessionSummary;
}

export async function deleteAgentSession(sessionId: string): Promise<void> {
    await toivHttp.delete(`/agent/sessions/${sessionId}`);
}

/** 对话产物一键入画布：取回会话级 canvas-proposal（Comfy 风格 graph；落节点由画布侧消费）。 */
export async function fetchAgentCanvasProposal(sessionId: string): Promise<ToivAgentCanvasProposal> {
    const { data } = await toivHttp.get(`/agent/sessions/${sessionId}/canvas-proposal`);
    return data as ToivAgentCanvasProposal;
}

/** 把提案暂存到 sessionStorage，供画布页下一刀消费（本切片只接线，不强行改节点图）。 */
export const CANVAS_PROPOSAL_STASH_KEY = "toiv_agent_canvas_proposal";

export function stashCanvasProposal(proposal: ToivAgentCanvasProposal, sessionId: string): void {
    if (typeof window === "undefined") return;
    try {
        window.sessionStorage.setItem(
            CANVAS_PROPOSAL_STASH_KEY,
            JSON.stringify({ sessionId, proposal, stashedAt: Date.now() }),
        );
    } catch {
        /* quota / private mode */
    }
}

export function takeCanvasProposalStash(): { sessionId: string; proposal: ToivAgentCanvasProposal; stashedAt: number } | null {
    if (typeof window === "undefined") return null;
    try {
        const raw = window.sessionStorage.getItem(CANVAS_PROPOSAL_STASH_KEY);
        if (!raw) return null;
        window.sessionStorage.removeItem(CANVAS_PROPOSAL_STASH_KEY);
        return JSON.parse(raw) as { sessionId: string; proposal: ToivAgentCanvasProposal; stashedAt: number };
    } catch {
        return null;
    }
}

/** 流式对话:fetch 手解 SSE(event: xxx / data: {...}),回调逐事件;返回 abort 句柄。 */
export function streamAgentChat(
    messages: ToivChatMessage[],
    sessionId: string | null,
    onEvent: (ev: ToivStreamEvent) => void,
    onError: (err: Error) => void,
): { abort: () => void; done: Promise<string | null> } {
    const controller = new AbortController();
    const done = (async (): Promise<string | null> => {
        let sid = sessionId;
        try {
            const resp = await fetch("/api/agent/chat", {
                method: "POST",
                signal: controller.signal,
                headers: {
                    "Content-Type": "application/json",
                    ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}),
                },
                body: JSON.stringify({ messages, session_id: sessionId || undefined }),
            });
            if (!resp.ok || !resp.body) throw new Error(`智能体连接失败(${resp.status})`);
            const headerSid = resp.headers.get("X-Agent-Session-Id");
            if (headerSid && headerSid !== sid) {
                sid = headerSid;
                onEvent({ kind: "session", sessionId: headerSid });
            }
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
                    try {
                        data = JSON.parse(dataLines.join("\n"));
                    } catch {
                        data = { raw: dataLines.join("\n") };
                    }
                    if (typeof data.session_id === "string" && data.session_id && data.session_id !== sid) {
                        sid = data.session_id;
                        onEvent({ kind: "session", sessionId: data.session_id });
                    }
                    if (event === "done") onEvent({ kind: "done" });
                    else if (event === "tool") onEvent({ kind: "tool", data });
                    else if (event === "job") onEvent({ kind: "job", data });
                    else if (event === "proposal") onEvent({ kind: "proposal", data });
                    else onEvent({ kind: "msg", data });
                }
            }
            return sid;
        } catch (err) {
            if (!(err instanceof DOMException && err.name === "AbortError")) {
                onError(err instanceof Error ? err : new Error(String(err)));
            }
            return sid;
        }
    })();
    return { abort: () => controller.abort(), done };
}
