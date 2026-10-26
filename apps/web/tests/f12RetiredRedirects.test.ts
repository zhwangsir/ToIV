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
});
