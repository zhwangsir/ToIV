import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const studioDir = resolve(import.meta.dir, "../src/studio");
const primeToivDir = resolve(import.meta.dir, "../../../prime/web/src/toiv");
const primeSkin = resolve(import.meta.dir, "../../../prime/web/src/styles/toiv-skin.css");

function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        return statSync(path).isDirectory() ? walk(path) : [path];
    });
}

const files = [...walk(studioDir), ...walk(primeToivDir), primeSkin];
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
    test("inline styles limited to geometry/background keys", () => {
        const allowed = new Set(["left", "width", "paddingTop", "backgroundImage"]);
        for (const file of tsx) {
            const body = readFileSync(file, "utf8");
            const blocks = body.match(/style=\{(?:[^?]*\?\s*)?\{([^}]*)\}/g) ?? [];
            for (const block of blocks) {
                const keys = block.match(/[a-zA-Z]+(?=\s*:)/g) ?? [];
                for (const key of keys) expect(allowed.has(key)).toBe(true);
            }
        }
    });
    test("each css file <= 800 lines", () => {
        for (const file of css) expect(readFileSync(file, "utf8").split("\n").length).toBeLessThanOrEqual(800);
    });
    test("no antd imports in studio", () => {
        for (const file of tsx) expect(readFileSync(file, "utf8")).not.toMatch(/from "antd"/);
    });
});
