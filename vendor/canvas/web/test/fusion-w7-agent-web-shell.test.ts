/**
 * W7 F6/F11/F9：Agent→create、插件市场收口、web 薄壳断言、composer pending 消费。
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { WORKSPACE_COMMAND_ROUTES } from "@/components/layout/workspace-command-palette";
import { INTENT_TOOL_GROUPS } from "@/components/toiv/tools-intent-grid";
import { consumeCreationAgentHandoff } from "@/pages/create/creation-agent-handoff";
import { AGENT_DRAFT_KEY, AGENT_PENDING_SESSION_KEY, stashAgentDraft, stashPendingAgentSession } from "@/services/toiv/agent-draft";
import { newConversation } from "@/pages/create/creation-conversations";

const root = join(import.meta.dir, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf-8");

describe("W7 agent→create + plugin entry + pending handoff", () => {
    test("侧栏/⌘K 无独立 Agent 对话面；/toiv/agent → create", () => {
        const nav = read("src/components/layout/workspace-sidebar-nav.tsx");
        expect(nav).not.toContain('to: "/agents"');
        expect(nav).not.toContain('to: "/toiv/agent"');
        expect(nav).not.toContain('title: "外部 Agent"');
        const primary = nav.slice(nav.indexOf("const groups"), nav.indexOf("高级 / 专家面"));
        for (const title of ["创作", "短剧项目", "任务中心", "工具台", "设置"]) {
            expect(primary).toContain(`title: "${title}"`);
        }
        expect(WORKSPACE_COMMAND_ROUTES.some((e) => e.to === "/agents" || e.id === "agents")).toBe(false);
        expect(WORKSPACE_COMMAND_ROUTES.some((e) => (e.to || "").includes("/toiv/agent"))).toBe(false);
        const router = read("src/router.tsx");
        expect(router).toMatch(/path:\s*"\/toiv\/agent"[\s\S]*?Navigate to="\/create"/);
        expect(router).toContain('path: "/agents"'); // 外部客户端面保留（设置侧链）
    });

    test("插件主入口 = 市场 ToolsIntent → /plugins；⌘K 有插件中心；无第六导航", () => {
        expect(INTENT_TOOL_GROUPS.some((g) => g.id === "extensions")).toBe(true);
        const grid = read("src/components/toiv/tools-intent-grid.tsx");
        expect(grid).toContain('to="/plugins"');
        expect(grid).toContain('data-testid="tools-intent-plugins"');
        expect(WORKSPACE_COMMAND_ROUTES.some((e) => e.id === "plugins" && e.to === "/plugins")).toBe(true);
        const nav = read("src/components/layout/workspace-sidebar-nav.tsx");
        const primary = nav.slice(nav.indexOf("const groups"), nav.indexOf("高级 / 专家面"));
        expect(primary).not.toContain("/plugins");
        expect(primary.split("title:").length - 1).toBe(5);
    });

    test("create composer 消费 draft + pending session（handoff）", async () => {
        const g = globalThis as typeof globalThis & { localStorage?: Storage; window?: Window & typeof globalThis };
        const store = new Map<string, string>();
        const ls = {
            getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
            setItem: (k: string, v: string) => { store.set(k, String(v)); },
            removeItem: (k: string) => { store.delete(k); },
            clear: () => store.clear(),
            key: () => null,
            get length() { return store.size; },
        } as Storage;
        Object.defineProperty(g, "localStorage", { value: ls, configurable: true });
        Object.defineProperty(g, "window", { value: g, configurable: true });

        stashAgentDraft({ text: "雨夜镜头续写", source: "canvas-node", nodeTitle: "SHOT 01" });
        stashPendingAgentSession("session-1");
        expect(ls.getItem(AGENT_DRAFT_KEY)).toBeTruthy();
        expect(ls.getItem(AGENT_PENDING_SESSION_KEY)).toBe("session-1");

        try {
            const empty = [newConversation()];
            const result = await consumeCreationAgentHandoff(empty, empty[0].id, {
                fetchHistory: async (id) => [{ role: "assistant", content: `会话 ${id} 已恢复` }],
            });
            expect(result.draft?.text).toContain("雨夜镜头续写");
            expect(result.draft?.nodeTitle).toBe("SHOT 01");
            expect(result.sessionRestore).toBeTruthy();
            expect(result.sessionRestore!.conversations[0].messages.some((m) => m.content.includes("会话 session-1 已恢复"))).toBe(true);
            expect(ls.getItem(AGENT_DRAFT_KEY)).toBeNull();
            expect(ls.getItem(AGENT_PENDING_SESSION_KEY)).toBeNull();
        } finally {
            // @ts-expect-error cleanup
            delete g.localStorage;
            // @ts-expect-error cleanup
            delete g.window;
        }
    });

    test("未动 redline / SoftGlow / DesktopShell 默认挂载 / W6 门禁", () => {
        const redline = read("src/redline.ts");
        expect(redline).toContain("content_mode");
        const layout = read("src/layouts/user-layout.tsx");
        expect(layout).not.toContain("<DesktopShell");
        expect(existsSync(join(root, "src/lib/project-track-gate.ts"))).toBe(true);
        const workbench = read("src/pages/create/creation-workbench.tsx");
        expect(workbench).not.toContain("LegacyAgentPage");
        expect(workbench).toContain("CreationWorkbench");
        const create = read("src/pages/create/index.tsx");
        expect(create).toContain("consumeCreationAgentHandoff");
    });
});

describe("W7 web 薄壳静态断言", () => {
    test("middleware 含 studio/desktop→create；tokens 双生注释钉 canvas 真源", () => {
        const mw = readFileSync(join(root, "../../web/middleware.ts"), "utf-8");
        expect(mw).toContain("/studio/desktop");
        expect(mw).toContain('"/studio/create"');
        const webTokens = readFileSync(join(root, "../../web/app/styles/toiv-freezone-tokens.css"), "utf-8");
        expect(webTokens).toContain("Sync twin");
        const canvasTokens = read("src/styles/toiv-freezone-tokens.css");
        expect(canvasTokens).toContain("Sync twin");
        const engine = readFileSync(join(root, "../../web/components/studio/EngineStudioView.tsx"), "utf-8");
        expect(engine).toContain("@deprecated");
        expect(engine).toContain("page 不再挂载本组件");
    });
});
