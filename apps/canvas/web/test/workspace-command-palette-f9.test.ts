/**
 * F9(2026-10-15 UI 统一波):canvas 全局 ⌘K 命令面板。
 * ① 路由表覆盖 canvas 现有路由/动作/设置段,且每个 `to` 的 pathname 都在 router.tsx 注册;
 * ② 纯过滤函数行为(空查询全量/大小写不敏感/子串匹配);
 * ③ 壳层注册:app-top-nav 全局 ⌘K/Ctrl+K 呼出 + 侧栏搜索入口;
 * ④ 「新对话」动作经 EV_AGENT_NEW_SESSION 通知智能体页。
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
import { EV_AGENT_NEW_SESSION } from "@/services/toiv/agent-draft";

const root = join(import.meta.dir, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf-8");

// R11：智能体对话收敛进 /create。
// BF1：引擎工具孤面改指 /toiv/market（工具台意图网格），不再绑创作台。
const REQUIRED_TARGETS = [
    "/",
    "/create",
    "/toiv/drama",
    "/project",
    "/canvas",
    "/library?source=materials",
    "/toiv/market",
    "/toiv/tasks",
    "/agents",
    "/settings",
    "/settings?section=channels",
    "/settings?section=models",
    "/toiv/drama?new=1",
    "/canvas?mode=new",
];

/** 智能体对话仍进 /create；工具孤面 BF1 进工具台。 */
const CREATE_ORPHAN_IDS = ["toiv:agent"];
const MARKET_TOOL_ORPHAN_IDS = ["toiv:audio", "toiv:image-tools", "toiv:video-tools", "toiv:dub-tools"];

describe("F9 workspace command palette", () => {
    test("命令面覆盖 canvas 全量路由 + 动作 + 设置段", () => {
        const targets = WORKSPACE_COMMAND_ROUTES.map((entry) => entry.to);
        for (const required of REQUIRED_TARGETS) {
            expect(targets).toContain(required);
        }
        for (const id of CREATE_ORPHAN_IDS) {
            const entry = WORKSPACE_COMMAND_ROUTES.find((candidate) => candidate.id === id);
            expect(entry).toBeDefined();
            expect(entry?.to).toBe("/create");
        }
        for (const id of MARKET_TOOL_ORPHAN_IDS) {
            const entry = WORKSPACE_COMMAND_ROUTES.find((candidate) => candidate.id === id);
            expect(entry).toBeDefined();
            expect(entry?.to?.startsWith("/toiv/market")).toBe(true);
        }
        // 分组提示齐备(动作/页面/工具/设置),对齐经典 web ⌘K 的信息密度
        const hints = new Set(WORKSPACE_COMMAND_ROUTES.map((entry) => entry.hint));
        for (const hint of ["动作", "页面", "工具", "设置"]) {
            expect(hints.has(hint)).toBe(true);
        }
        // id 唯一
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
        // 工具台/音频工具/图片工具/视频工具/译制工具
        expect(tools.length).toBeGreaterThanOrEqual(5);
        for (const entry of tools) expect(entry.title).toContain("工具");
        expect(filterCommandEntries(WORKSPACE_COMMAND_ROUTES, "AGENT").some((e) => e.id === "agents")).toBe(true);
        expect(filterCommandEntries(WORKSPACE_COMMAND_ROUTES, "不存在的命令").length).toBe(0);
    });

    test("壳层注册:app-top-nav 全局 ⌘K/Ctrl+K + 侧栏搜索入口", () => {
        const shell = read("src/components/layout/app-top-nav.tsx");
        expect(shell).toContain('event.key.toLowerCase() === "k"');
        expect(shell).toContain("event.metaKey || event.ctrlKey");
        expect(shell).toContain("WorkspaceCommandPalette");
        expect(shell).toContain("onOpenSearch={() => setPaletteOpen(true)}");
    });

    test("「新对话」动作经 EV_AGENT_NEW_SESSION 通知,智能体页监听并重置", () => {
        const palette = read("src/components/layout/workspace-command-palette.tsx");
        expect(palette).toContain("EV_AGENT_NEW_SESSION");
        expect(palette).toContain("window.dispatchEvent(new CustomEvent(EV_AGENT_NEW_SESSION))");
        const agent = read("src/pages/toiv/agent-page.tsx");
        expect(agent).toContain("EV_AGENT_NEW_SESSION");
        expect(agent).toContain("window.addEventListener(EV_AGENT_NEW_SESSION");
        expect(EV_AGENT_NEW_SESSION).toBe("toiv:agent-new-session");
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
    });
});

