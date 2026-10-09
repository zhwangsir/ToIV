/**
 * M2 /toiv/agent 移植单测：会话 API 形状 + 草稿通道 + 工具卡注册表 + 提案 stash。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { draftFromCanvasNode, AGENT_DRAFT_KEY } from "../src/services/toiv/agent-draft";
import { JOB_TOOL_NAMES, TOOL_RENDERERS, renderToolCard, toolTitle } from "../src/components/toiv/toolcards/registry";

const root = join(import.meta.dir, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf-8");

const TOOL_NAMES = [
    "optimize_prompt",
    "search_knowledge",
    "list_apps",
    "list_models",
    "create_storyboard",
    "list_smoke_failures",
    "explain_app_failure",
    "submit_generation",
    "run_app",
    "generate_image",
] as const;

describe("toiv agent-chat service surface", () => {
    test("agent-chat exports sessions/history/stream/fork/delete/proposal + stash keys", () => {
        const src = read("src/services/toiv/agent-chat.ts");
        for (const name of [
            "fetchAgentSessions",
            "fetchAgentHistory",
            "streamAgentChat",
            "forkAgentSession",
            "deleteAgentSession",
            "fetchAgentCanvasProposal",
            "stashCanvasProposal",
            "takeCanvasProposalStash",
            "CANVAS_PROPOSAL_STASH_KEY",
        ]) {
            expect(src.includes(`export `) && src.includes(name)).toBe(true);
            expect(src).toContain(name);
        }
        expect(src).toContain('CANVAS_PROPOSAL_STASH_KEY = "toiv_agent_canvas_proposal"');
        expect(src).toContain("/api/agent/chat");
        expect(src).toContain("toiv_token");
        expect(src).toContain("X-Agent-Session-Id");
    });

    test("agent page routes SSE tool/job/proposal and BeefTV shell copy", () => {
        const src = read("src/pages/toiv/agent-page.tsx");
        expect(src).toContain("智能体对话");
        expect(src).toContain("一键入画布");
        expect(src).toContain("renderToolCard");
        expect(src).toContain("renderProposalCard");
        expect(src).toContain("takeAgentDraft");
        expect(src).toContain("fetchAgentCanvasProposal");
        expect(src).toContain("toolCardPayload");
        expect(src).toContain("looksLikeProposal");
        expect(src).not.toContain('navigate("/studio")');
        expect(src).not.toContain("BeefTV leftover");
        // BeefTV tokens / shell cues
        expect(src).toContain("var(--border)");
        expect(src).toContain("var(--card");
        expect(src).toContain("EmptyState");
        expect(src).toContain("ToolButton");
    });

    test("float shares toolcards registry with agent page", () => {
        const src = read("src/pages/canvas/toiv-agent-float.tsx");
        expect(src).toContain('from "@/components/toiv/toolcards/registry"');
        expect(src).toContain("renderToolCard");
        expect(src).toContain("renderProposalCard");
        expect(src).toContain("toolCardPayload");
    });

    test("sidebar already points internal /toiv/agent", () => {
        const src = read("src/components/layout/workspace-sidebar-nav.tsx");
        expect(src).toContain('to: "/toiv/agent"');
        expect(src).toContain("智能体对话");
    });
});

describe("agent draft (发到对话)", () => {
    test("draftFromCanvasNode builds ToIV copy from text node", () => {
        const d = draftFromCanvasNode({
            id: "n1",
            title: "镜头A",
            type: "text",
            metadata: { content: "雨夜霓虹巷口，女主回头" },
        });
        expect(d.source).toBe("canvas-node");
        expect(d.nodeId).toBe("n1");
        expect(d.text).toContain("镜头A");
        expect(d.text).toContain("雨夜霓虹巷口");
        expect(d.text).toContain("继续创作");
        expect(AGENT_DRAFT_KEY).toBe("toiv_agent_draft");
    });

    test("draftFromCanvasNode treats http content as mediaUrl", () => {
        const d = draftFromCanvasNode({
            id: "img1",
            title: "定妆",
            type: "image",
            metadata: { content: "https://cdn.example/a.png" },
        });
        expect(d.mediaUrl).toBe("https://cdn.example/a.png");
        expect(d.text).toContain("素材:");
    });

    test("context menu wires 发到对话", () => {
        const menu = read("src/components/canvas/canvas-context-menu.tsx");
        expect(menu).toContain("发到对话");
        expect(menu).toContain("onSendToAgent");
        expect(menu).toContain("MessageSquarePlus");
        const project = read("src/pages/canvas/project.tsx");
        expect(project).toContain("stashAgentDraft");
        expect(project).toContain('navigate("/toiv/agent")');
    });
});

describe("toiv toolcards transplant", () => {
    test("十个工具名全注册，未知回退 null", () => {
        for (const name of TOOL_NAMES) {
            expect(TOOL_RENDERERS[name]?.title).toBeTruthy();
            expect(typeof TOOL_RENDERERS[name].render).toBe("function");
        }
        expect(renderToolCard("unknown_tool", { a: 1 }, {})).toBeNull();
        expect(renderToolCard("list_models", null as unknown as Record<string, unknown>, {})).toBeNull();
        expect(JOB_TOOL_NAMES.has("generate_image")).toBe(true);
        expect(toolTitle("optimize_prompt")).toBe("提示词优化");
    });

    test("OptimizePromptCard renders BeefTV classes + 应用到输入框", () => {
        let applied = "";
        const html = renderToStaticMarkup(
            React.createElement(
                React.Fragment,
                null,
                renderToolCard(
                    "optimize_prompt",
                    { original: "cat", optimized: "cinematic cat", negative: "blur" },
                    { onApplyInput: (t) => { applied = t; } },
                ),
            ),
        );
        expect(html).toContain("toiv-tc-optimize");
        expect(html).toContain("原文");
        expect(html).toContain("优化后");
        expect(html).toContain("应用到输入框");
        expect(html).toContain("var(--border)");
        expect(applied).toBe(""); // render only
    });

    test("GenerationJobCard + ProposalCard defensive", () => {
        const job = renderToStaticMarkup(
            React.createElement(React.Fragment, null, renderToolCard("generate_image", { job_id: "j1", status: "running", kind: "image" }, {})),
        );
        expect(job).toContain("toiv-tc-job");
        expect(job).toContain("运行中");
        const empty = renderToStaticMarkup(
            React.createElement(React.Fragment, null, renderToolCard("generate_image", {}, {})),
        );
        expect(empty).toBe("");
    });
});
