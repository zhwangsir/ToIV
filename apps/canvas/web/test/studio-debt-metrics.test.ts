import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const studioDir = resolve(import.meta.dir, "../src/studio");

function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        return statSync(path).isDirectory() ? walk(path) : [path];
    });
}

const files = walk(studioDir);
const css = files.filter((file) => file.endsWith(".css"));
const tsx = files.filter((file) => file.endsWith(".tsx"));

describe("studio debt metrics", () => {
    test("no !important anywhere", () => {
        for (const file of files) expect(readFileSync(file, "utf8")).not.toContain("!important");
    });
    test("no hardcoded colors outside tokens.css", () => {
        for (const file of files.filter((f) => !f.endsWith("tokens.css"))) {
            const body = readFileSync(file, "utf8").replace(/oklch\([^)]*\)/g, "");
            expect(body).not.toMatch(/#[0-9a-fA-F]{6}/);
        }
    });
    test("inline styles limited to backgroundImage/width allowlist", () => {
        for (const file of tsx) {
            const body = readFileSync(file, "utf8");
            const inline = body.match(/style=\{/g) ?? [];
            const allowed = body.match(/backgroundImage|width: box\.width|width: `\$\{/g) ?? [];
            expect(inline.length).toBe(allowed.length);
        }
    });
    test("each css file <= 800 lines", () => {
        for (const file of css) expect(readFileSync(file, "utf8").split("\n").length).toBeLessThanOrEqual(800);
    });
    test("no antd imports in studio", () => {
        for (const file of tsx) expect(readFileSync(file, "utf8")).not.toMatch(/from "antd"/);
    });
});
