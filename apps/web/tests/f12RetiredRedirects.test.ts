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
        // R11 strangler → create
        assert.ok(mw.includes('"/studio/create$1"') || mw.includes('"/studio/create"'));
        assert.ok(mw.includes("/toiv\\/agent"));
    });
});
