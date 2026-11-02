import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { readFileSync } from "node:fs";

const mw = readFileSync(new URL("../middleware.ts", import.meta.url), "utf-8");

describe("F12/W6 retired-face deep-link redirects → Prime", () => {
    test("退役面 + /toiv 深链进 matcher 且 308 到 Prime 面", () => {
        assert.ok(mw.includes('"/library", "/library/:path*", "/market", "/market/:path*", "/tasks", "/tasks/:path*"'));
        assert.ok(mw.includes('"/toiv", "/toiv/:path*"'));
        assert.ok(mw.includes('"/create", "/create/:path*"'));
        assert.ok(mw.includes('"/desktop", "/desktop/:path*"'));
        assert.ok(mw.includes("/desktop(?:") || mw.includes("/desktop(?:\\/.*)?$"));
        // W6：/studio/create* · /studio/desktop* hydrate 前 308→/studio
        assert.ok(mw.includes("/studio/create") || mw.includes("studio\\/create"));
        assert.ok(mw.includes("/studio/desktop") || mw.includes("studio\\/desktop"));
        assert.ok(mw.includes("NextResponse.redirect(url, 308)"));
        // #8 library → Prime 作品库（禁止收成 drama/assets）
        assert.ok(mw.includes('"/studio/library$1"'));
        assert.ok(!mw.includes('"/drama/assets"') && !mw.includes("'/drama/assets'"), "library 不得并到资产库落点");
        // #9/#11 tasks/market → Prime
        assert.ok(mw.includes('"/studio/tasks$1"') || mw.includes('"/studio/tasks"'));
        assert.ok(mw.includes('"/studio/tools"'));
        assert.ok(mw.includes('"/studio/toiv$1"'));
        // W6 strangler → /studio（禁止再指 /studio/create 为目标）
        assert.ok(mw.includes('[/^\\/create(?:\\/.*)?$/, "/studio"]') || mw.includes('"/studio"'));
        assert.doesNotMatch(mw, /\[\/\^\\\/create[^\]]*\$,\s*"\/studio\/create"/);
        assert.ok(mw.includes("/toiv\\/agent") || mw.includes("/toiv\\/agent(?:"));
        assert.ok(mw.includes("run=$1") || mw.includes("?run=$1"));
        assert.ok(mw.includes("applyRetiredRedirect"));
        assert.ok(mw.includes("redirectPreserveSearch"));
    });

    test("旧创作台深链通过真实中间件保留 project/section/query → /studio", async () => {
        const { NextRequest } = await import("next/server");
        const { middleware } = await import("../middleware");
        const invoke = async (path: string) => {
            const response = await middleware(new NextRequest(new URL(path, "http://127.0.0.1:3100")));
            assert.equal(response.status, 308);
            return new URL(response.headers.get("location") || "");
        };
        const ws = await invoke("/toiv/ws/project-1/storyboard?tab=frames");
        assert.equal(ws.pathname, "/studio");
        assert.equal(ws.searchParams.get("project"), "project-1");
        assert.equal(ws.searchParams.get("section"), "storyboard");
        assert.equal(ws.searchParams.get("tab"), "frames");
        const bare = await invoke("/toiv/ws");
        assert.equal(bare.pathname, "/studio");
        const legacy = await invoke("/create/legacy?project=project-2");
        assert.equal(legacy.pathname, "/studio");
        assert.equal(legacy.searchParams.get("project"), "project-2");
        const bareCreate = await invoke("/create");
        assert.equal(bareCreate.pathname, "/studio");
        assert.equal(bareCreate.searchParams.get("project"), null);
        const agent = await invoke("/toiv/agent");
        assert.equal(agent.pathname, "/studio");
        assert.equal(agent.searchParams.get("view"), null);
        const desktop = await invoke("/desktop");
        assert.equal(desktop.pathname, "/studio");
        const desktopStore = await invoke("/desktop/store");
        assert.equal(desktopStore.pathname, "/studio");
        const studioCreate = await invoke("/studio/create?project=p9");
        assert.equal(studioCreate.pathname, "/studio");
        assert.equal(studioCreate.searchParams.get("project"), "p9");
        const imageTools = await invoke("/toiv/image-tools");
        assert.equal(imageTools.pathname, "/studio/tools");
        const videoTools = await invoke("/toiv/video-tools");
        assert.equal(videoTools.pathname, "/studio/tools");
        const library = await invoke("/library/works/w1");
        assert.equal(library.pathname, "/studio/library/works/w1");
        const market = await invoke("/market");
        assert.equal(market.pathname, "/studio/tools");
        const tasks = await invoke("/tasks");
        assert.equal(tasks.pathname, "/studio/tasks");
    });
});
