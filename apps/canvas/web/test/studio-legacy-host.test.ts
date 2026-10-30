import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const router = readFileSync(resolve(import.meta.dir, "../src/router.tsx"), "utf8");
const css = readFileSync(resolve(import.meta.dir, "../src/studio/studio.css"), "utf8");

describe("legacy host strangler", () => {
    test("shared pages are top-level studio routes", () => {
        for (const path of ["/library", "/tasks", "/settings"]) {
            expect(router).toContain(`{ path: "${path}", element: deferred(<Studio`);
        }
    });
    test("demote rule hides duplicated title cluster but keeps actions", () => {
        expect(css).toContain(".stv-legacy-host .app-page-header-main { display: none; }");
        expect(css).not.toContain(".stv-legacy-host .app-page-header {");
    });
});
