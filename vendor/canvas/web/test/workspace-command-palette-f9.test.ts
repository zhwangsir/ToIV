/**
 * W1 F5：⌘K 白名单 = 侧栏五项 + 短剧/工具深链（不再暴露 canvas/home/library/agent 全站地图）。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";

import {
    WORKSPACE_COMMAND_ROUTES,
    WorkspaceCommandPalette,
    filterCommandEntries,
} from "@/components/layout/workspace-command-palette";

const root = join(import.meta.dir, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf-8");

const REQUIRED_TARGETS = [
    "/create",
    "/toiv/drama",
    "/tasks",
    "/toiv/market",
    "/settings",
    "/settings?section=channels",
    "/settings?section=models",
    "/toiv/drama?new=1",
];

const FORBIDDEN_IDS = ["home", "projects", "canvas", "library", "agents", "toiv:agent", "act:new-canvas"];
const MARKET_TOOL_ORPHAN_IDS = ["toiv:audio", "toiv:image-tools", "toiv:video-tools", "toiv:dub-tools"];

describe("W1 workspace command palette whitelist", () => {
    test("命令面仅侧栏五项 + 短剧/工具深链", () => {
        const targets = WORKSPACE_COMMAND_ROUTES.map((entry) => entry.to);
        for (const required of REQUIRED_TARGETS) {
            expect(targets).toContain(required);
        }
        for (const id of FORBIDDEN_IDS) {
            expect(WORKSPACE_COMMAND_ROUTES.some((e) => e.id === id)).toBe(false);
        }
        for (const id of MARKET_TOOL_ORPHAN_IDS) {
            const entry = WORKSPACE_COMMAND_ROUTES.find((candidate) => candidate.id === id);
            expect(entry).toBeDefined();
            expect(entry?.to?.startsWith("/toiv/market")).toBe(true);
        }
        const hints = new Set(WORKSPACE_COMMAND_ROUTES.map((entry) => entry.hint));
        for (const hint of ["动作", "页面", "工具", "设置"]) {
            expect(hints.has(hint)).toBe(true);
        }
        const ids = WORKSPACE_COMMAND_ROUTES.map((entry) => entry.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    test("每个入口的 pathname 都在 router.tsx 注册(不得指向不存在的路由)", () => {
        const routerSrc = read("src/router.tsx");
        const registered = new Set<string>();
        for (const match of routerSrc.matchAll(/\{\s*path:\s*"([^"]+)"/g)) {
            registered.add(match[1]);
        }
        expect(registered.size).toBeGreaterThan(10);
        for (const entry of WORKSPACE_COMMAND_ROUTES) {
            const pathname = (entry.to ?? "").split("#")[0].split("?")[0];
            expect(registered.has(pathname)).toBe(true);
        }
    });

    test("过滤:空查询全量、大小写不敏感、子串匹配", () => {
        expect(filterCommandEntries(WORKSPACE_COMMAND_ROUTES, "  ").length).toBe(WORKSPACE_COMMAND_ROUTES.length);
        const tools = filterCommandEntries(WORKSPACE_COMMAND_ROUTES, "工具");
        expect(tools.length).toBeGreaterThanOrEqual(5);
        for (const entry of tools) expect(entry.title).toContain("工具");
        expect(filterCommandEntries(WORKSPACE_COMMAND_ROUTES, "创作").some((e) => e.id === "create")).toBe(true);
        expect(filterCommandEntries(WORKSPACE_COMMAND_ROUTES, "不存在的命令").length).toBe(0);
    });

    test("壳层注册:app-top-nav 全局 ⌘K/Ctrl+K + 侧栏搜索入口", () => {
        const shell = read("src/components/layout/app-top-nav.tsx");
        expect(shell).toContain('event.key.toLowerCase() === "k"');
        expect(shell).toContain("event.metaKey || event.ctrlKey");
        expect(shell).toContain("WorkspaceCommandPalette");
        expect(shell).toContain("onOpenSearch={() => setPaletteOpen(true)}");
    });

    test("W3：不再经 EV_AGENT_NEW_SESSION / legacy AgentPage 挂载", () => {
        const palette = read("src/components/layout/workspace-command-palette.tsx");
        expect(palette).not.toContain("EV_AGENT_NEW_SESSION");
        expect(palette).not.toContain("view=agent");
        const workbench = read("src/pages/create/creation-workbench.tsx");
        expect(workbench).not.toContain("agent-page");
        expect(workbench).not.toContain("LegacyAgentPage");
        expect(workbench).not.toContain("view=agent");
    });

    test("打开态渲染:输入框 + 路由条目 + 分组提示可见", () => {
        const html = renderToStaticMarkup(
            createElement(MemoryRouter, null, createElement(WorkspaceCommandPalette, { open: true, onClose: () => {} })),
        );
        expect(html).toContain('aria-label="命令面板搜索"');
        expect(html).toContain("短剧项目");
        expect(html).toContain("任务中心");
        expect(html).toContain("模型配置");
        expect(html).toContain("新建短剧");
        expect(html).toContain("设置");
        expect(html).not.toContain("自由画布");
        expect(html).not.toContain("媒体库");
    });
});
