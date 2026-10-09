/**
 * 画布节点「发到对话」一次性草稿通道(M2 加强点,2026-10-09)。
 * 右键节点 → stash → 跳 /toiv/agent；AgentPage 挂载时 take 并即删。
 */

export const AGENT_DRAFT_KEY = "toiv_agent_draft";

export type AgentDraftPayload = {
    text: string;
    source?: "canvas-node" | "manual";
    nodeId?: string;
    nodeTitle?: string;
    mediaUrl?: string;
};

export function stashAgentDraft(payload: AgentDraftPayload | string): void {
    if (typeof window === "undefined") return;
    try {
        const body: AgentDraftPayload = typeof payload === "string" ? { text: payload, source: "manual" } : payload;
        if (!body.text?.trim() && !body.mediaUrl) return;
        window.localStorage.setItem(AGENT_DRAFT_KEY, JSON.stringify(body));
    } catch {
        /* ignore */
    }
}

export function takeAgentDraft(): AgentDraftPayload | null {
    if (typeof window === "undefined") return null;
    try {
        const raw = window.localStorage.getItem(AGENT_DRAFT_KEY);
        if (!raw) return null;
        window.localStorage.removeItem(AGENT_DRAFT_KEY);
        const parsed = JSON.parse(raw) as AgentDraftPayload;
        if (!parsed || typeof parsed !== "object") return null;
        return {
            text: typeof parsed.text === "string" ? parsed.text : "",
            source: parsed.source,
            nodeId: typeof parsed.nodeId === "string" ? parsed.nodeId : undefined,
            nodeTitle: typeof parsed.nodeTitle === "string" ? parsed.nodeTitle : undefined,
            mediaUrl: typeof parsed.mediaUrl === "string" ? parsed.mediaUrl : undefined,
        };
    } catch {
        return null;
    }
}

/** 从画布节点拼一段可续聊的提示（文案 + 可选媒体 URL）。 */
export function draftFromCanvasNode(node: {
    id: string;
    title?: string;
    type?: string;
    metadata?: { content?: unknown; characterName?: unknown };
}): AgentDraftPayload {
    const title = (node.title || "").trim() || node.id.slice(0, 8);
    const content = typeof node.metadata?.content === "string" ? node.metadata.content.trim() : "";
    const charName = typeof node.metadata?.characterName === "string" ? node.metadata.characterName.trim() : "";
    const kind = node.type || "节点";
    const lines = [`【画布${kind}】${charName || title}`];
    if (content && content !== title) {
        if (/^https?:\/\//i.test(content) || content.startsWith("/") || content.startsWith("blob:")) {
            lines.push(`素材: ${content}`);
            return { text: lines.join("\n"), source: "canvas-node", nodeId: node.id, nodeTitle: title, mediaUrl: content };
        }
        lines.push(content.length > 1200 ? `${content.slice(0, 1200)}…` : content);
    }
    lines.push("请基于以上画布节点继续创作。");
    return { text: lines.join("\n"), source: "canvas-node", nodeId: node.id, nodeTitle: title, mediaUrl: /^https?:\/\//i.test(content) ? content : undefined };
}
