/**
 * W6 F4/F12：画布降级 + Cosmos /desktop* 断路由 + 项目双轨门禁。
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";

import { WORKSPACE_COMMAND_ROUTES } from "@/components/layout/workspace-command-palette";
import { beefTVCapabilityItems } from "@/pages/home/home-data";
import { HomeDashboard } from "@/pages/home/home-dashboard";
import {
    FREE_CANVAS_LIBRARY,
    PROJECT_TRACK_GATE,
    SHORT_DRAMA_ENTRY,
    shortDramaCreateHref,
} from "@/lib/project-track-gate";

const root = join(import.meta.dir, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf-8");

describe("W6 canvas demote + Cosmos cut + project gate", () => {
    test("⌘K 白名单无 canvas/project/desktop 主推", () => {
        const targets = WORKSPACE_COMMAND_ROUTES.map((e) => e.to ?? "");
        for (const forbidden of ["/canvas", "/project", "/projects", "/desktop", "/home"]) {
            expect(targets.some((t) => t === forbidden || t.startsWith(forbidden + "?"))).toBe(false);
        }
        expect(targets).toContain("/create");
        expect(targets).toContain("/toiv/drama");
        expect(WORKSPACE_COMMAND_ROUTES.some((e) => e.id === "canvas" || e.id === "act:new-canvas")).toBe(false);
    });

    test("侧栏一级五项无画布；画布只在高级/专家面", () => {
        const nav = read("src/components/layout/workspace-sidebar-nav.tsx");
        expect(nav).toContain('heading: "高级 / 专家面"');
        expect(nav).toContain('title: "自由画布库"');
        expect(nav).not.toContain('title: "新建自由画布"');
        expect(nav).not.toContain("canvas:new");
        expect(nav).not.toContain('"/canvas?mode=new"');
        expect(nav).toContain('to: "/create"');
        expect(nav).toContain('to: "/toiv/drama"');
        // 一级五项块不含 /project|/canvas
        const primary = nav.slice(nav.indexOf("const groups"), nav.indexOf("高级 / 专家面"));
        expect(primary).not.toContain('"/project"');
        expect(primary).not.toContain('"/canvas');
        expect(primary).not.toContain('"/desktop');
    });

    test("router：/desktop* → /create；源码种子仍在", () => {
        const router = read("src/router.tsx");
        expect(router).toContain('path: "/desktop"');
        expect(router).toContain('path: "/desktop/store"');
        expect(router).toContain('path: "/desktop/legacy-home"');
        expect(router).toContain('path: "/desktop/*"');
        expect(router).toMatch(/path:\s*"\/desktop"[\s\S]*?Navigate to="\/create"/);
        expect(router).not.toContain("DesktopHomePage");
        expect(router).not.toContain("DesktopAppStorePage");
        expect(existsSync(join(root, "src/pages/desktop/desktop-home-page.tsx"))).toBe(true);
        expect(existsSync(join(root, "src/components/desktop/desktop-shell.tsx"))).toBe(true);
        expect(existsSync(join(root, "../docs/COSMOS_APP_SHELL_SEED.md"))).toBe(true);
        const seed = readFileSync(join(root, "../docs/COSMOS_APP_SHELL_SEED.md"), "utf-8");
        expect(seed).toContain("默认不可达");
        expect(seed).toContain("禁");
    });

    test("首页 capability 无 /canvas；无新建画布次入口", () => {
        expect(beefTVCapabilityItems.every((item) => !item.to.includes("/canvas") && !item.to.includes("/project"))).toBe(true);
        expect(beefTVCapabilityItems.some((item) => item.to === "/create")).toBe(true);
        expect(beefTVCapabilityItems.some((item) => item.to === "/toiv/drama")).toBe(true);
        const markup = renderToStaticMarkup(
            createElement(MemoryRouter, null, createElement(HomeDashboard, { projects: [], loading: false, error: false, onRetry: () => {} })),
        );
        expect(markup).toContain("打开创作台");
        expect(markup).toContain("新建短剧");
        expect(markup).toContain("最近自由画布（专家）");
        expect(markup).not.toContain('aria-label="新建画布（专家）"');
        expect(markup).not.toContain("/canvas?mode=new");
        expect(markup).toContain("/project"); // 专家轨「查看画布库」仍可达
    });

    test("短剧入口仍 /create?project=；门禁常量写清双轨", () => {
        expect(SHORT_DRAMA_ENTRY).toBe("/toiv/drama");
        expect(FREE_CANVAS_LIBRARY).toBe("/project");
        expect(shortDramaCreateHref("p1")).toBe("/create?project=p1&section=script");
        expect(PROJECT_TRACK_GATE.canvasLibraryDescription).toContain("/create?project=");
        const drama = read("src/pages/toiv/drama-page.tsx");
        expect(drama).toContain("`/create?project=${");
        const canvasPage = read("src/pages/canvas/index.tsx");
        expect(canvasPage).toContain("自由画布库");
        expect(canvasPage).toContain("PROJECT_TRACK_GATE");
        const detail = read("src/pages/projects/detail.tsx");
        expect(detail).toContain("PROJECT_TRACK_GATE.projectDetailHint");
    });

    test("未动 redline 姿势闸 / SoftGlow / 第六导航", () => {
        const nav = read("src/components/layout/workspace-sidebar-nav.tsx");
        const primaryTitles = ["创作", "短剧项目", "任务中心", "工具台", "设置"];
        for (const title of primaryTitles) expect(nav).toContain(`title: "${title}"`);
        expect(nav).not.toContain("姿势参考");
        const redline = read("src/redline.ts");
        expect(redline).toContain("isPoseSystemVisible");
        expect(read("src/pages/home/home-dashboard.tsx")).not.toContain("SoftGlow");
        expect(read("src/layouts/user-layout.tsx")).toContain("AppWorkspaceShell");
        expect(read("src/layouts/user-layout.tsx")).not.toContain("<DesktopShell");
    });
});
