/**
 * W7 F6/F9：浮窗 / 画布 stash → /create composer 消费（替代 legacy AgentPage）。
 * take 即删；失败不抛，由调用方 toast。
 */
import { createClientId } from "@/lib/client-id";
import { fetchAgentHistory as defaultFetchAgentHistory } from "@/services/toiv/agent-chat";
import { takeAgentDraft, takePendingAgentSession, type AgentDraftPayload } from "@/services/toiv/agent-draft";

import { newConversation, newMessage } from "./creation-conversations";
import type { CreationConversation } from "./creation-types";

export type CreationAgentHandoffResult = {
    draft: AgentDraftPayload | null;
    /** 若恢复了 pending session，返回合并后的会话列表与应激活的 id；否则 null */
    sessionRestore: { conversations: CreationConversation[]; activeId: string } | null;
};

export type CreationAgentHandoffDeps = {
    fetchHistory?: typeof defaultFetchAgentHistory;
};

export async function consumeCreationAgentHandoff(
    conversations: CreationConversation[],
    activeId: string,
    deps: CreationAgentHandoffDeps = {},
): Promise<CreationAgentHandoffResult> {
    const draft = takeAgentDraft();
    const sessionId = takePendingAgentSession();
    if (!sessionId) {
        return { draft, sessionRestore: null };
    }
    const fetchHistory = deps.fetchHistory ?? defaultFetchAgentHistory;
    let history: Array<{ role: "user" | "assistant"; content: string }> = [];
    try {
        history = await fetchHistory(sessionId);
    } catch {
        return { draft, sessionRestore: null };
    }
    const messages = history
        .filter((item) => item.role === "user" || item.role === "assistant")
        .map((item) => newMessage(item.role, item.content, { mode: "text", status: "done" }));
    if (!messages.length) {
        messages.push(newMessage("assistant", `会话 ${sessionId} 已恢复`, { mode: "text", status: "done" }));
    }
    const current = conversations.find((item) => item.id === activeId) || conversations[0];
    const reuseEmpty = Boolean(current && current.messages.length === 0);
    const restored: CreationConversation = reuseEmpty && current
        ? {
            ...current,
            title: current.title === "新创作" ? `会话 ${sessionId.slice(0, 8)}` : current.title,
            updatedAt: new Date().toISOString(),
            messages,
        }
        : {
            ...newConversation(),
            id: createClientId(),
            title: `会话 ${sessionId.slice(0, 8)}`,
            messages,
        };
    const next = reuseEmpty && current
        ? conversations.map((item) => (item.id === current.id ? restored : item))
        : [restored, ...conversations];
    return { draft, sessionRestore: { conversations: next, activeId: restored.id } };
}
