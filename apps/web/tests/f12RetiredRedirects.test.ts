import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { readFileSync } from "node:fs";

const mw = readFileSync(new URL("../middleware.ts", import.meta.url), "utf-8");

describe("F12 retired-face deep-link redirects", () => {
    test("退役面 + /toiv 深链进 matcher 且 308 到 canvas 面", () => {
        assert.ok(mw.includes('"/library", "/library/:path*", "/market", "/market/:path*", "/tasks", "/tasks/:path*"'));
        assert.ok(mw.includes('"/toiv", "/toiv/:path*"'));
        assert.ok(mw.includes('"/create", "/create/:path*"'));
        assert.ok(mw.includes("NextResponse.redirect(url, 308)"));
        assert.ok(mw.includes('"/studio/library$1"'));
        assert.ok(mw.includes('"/studio/toiv/market$1"'));
        assert.ok(mw.includes('"/studio/toiv/tasks$1"'));
        assert.ok(mw.includes('"/studio/toiv$1"'));
        // R11/R12 strangler → create (no bare /create; /create/* strips to /studio/create)
        assert.ok(mw.includes('"/studio/create"'));
        assert.ok(mw.includes("/toiv\\/agent") || mw.includes("/toiv\\/agent(?:"));
        // R12① runs keep id
        assert.ok(mw.includes("run=$1") || mw.includes("?run=$1"));
        assert.ok(mw.includes("applyRetiredRedirect"));
    });

    test("旧创作台深链通过真实中间件保留 project/section/query", async () => {
        const { NextRequest } = await import("next/server");
        const { middleware } = await import("../middleware");
        const invoke = async (path: string) => {
            const response = await middleware(new NextRequest(new URL(path, "http://127.0.0.1:3100")));
            assert.equal(response.status, 308);
            return new URL(response.headers.get("location") || "");
        };
        const ws = await invoke("/toiv/ws/project-1/storyboard?tab=frames");
        assert.equal(ws.pathname, "/studio/create");
        assert.equal(ws.searchParams.get("project"), "project-1");
        assert.equal(ws.searchParams.get("section"), "storyboard");
        assert.equal(ws.searchParams.get("tab"), "frames");
        const bare = await invoke("/toiv/ws");
        assert.equal(bare.pathname, "/studio/create");
        const legacy = await invoke("/create/legacy?project=project-2");
        assert.equal(legacy.pathname, "/studio/create");
        assert.equal(legacy.searchParams.get("project"), "project-2");
        const agent = await invoke("/toiv/agent");
        assert.equal(agent.pathname, "/studio/create");
        assert.equal(agent.searchParams.get("view"), null);
        // W3：工具孤面统一落 market（勿再指 create）
        const imageTools = await invoke("/toiv/image-tools");
        assert.equal(imageTools.pathname, "/studio/toiv/market");
        const videoTools = await invoke("/toiv/video-tools");
        assert.equal(videoTools.pathname, "/studio/toiv/market");
    });
});
