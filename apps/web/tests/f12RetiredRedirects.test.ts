/** F12 收尾:退役面旧路径深链必须 308 到 canvas 对应面(书签/外链不 404)。源码断言。 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const mw = readFileSync(join(import.meta.dir, "..", "middleware.ts"), "utf-8");

describe("F12 retired-face deep-link redirects", () => {
    test("三条旧路径进 matcher 且 308 到 canvas 面", () => {
        expect(mw).toContain('"/library", "/library/:path*", "/market", "/market/:path*", "/tasks", "/tasks/:path*"');
        expect(mw).toContain('NextResponse.redirect(url, 308)');
        expect(mw).toContain('"/studio/library$1"');
        expect(mw).toContain('"/studio/toiv/market$1"');
        expect(mw).toContain('"/studio/toiv/tasks$1"');
    });
});
