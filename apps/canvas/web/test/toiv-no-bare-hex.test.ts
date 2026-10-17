/** A 波收口批防回归:toiv/create 面禁裸 hex 与 hex fallback(token 单一源在 globals.css)。 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p, out);
        else if (/\.(tsx?|css)$/.test(name)) out.push(p);
    }
    return out;
}

const SRC = join(import.meta.dir, "..", "src");

describe("toiv/create 裸 hex 收口", () => {
    test("CSS 使用面零裸 hex(token 定义只许 globals.css)", () => {
        const offenders: string[] = [];
        for (const f of [...walk(join(SRC, "pages", "toiv")), ...walk(join(SRC, "pages", "create"))]) {
            if (!f.endsWith(".css")) continue;
            const src = readFileSync(f, "utf8");
            if (/#(?:[0-9a-fA-F]{3,8})\b/.test(src)) offenders.push(f);
        }
        expect(offenders, `CSS 裸 hex 残留: ${offenders.join(", ")}`).toEqual([]);
    });

    test("var(--token,#hex) 型 fallback 零残留", () => {
        const offenders: string[] = [];
        for (const f of [...walk(join(SRC, "pages", "toiv")), ...walk(join(SRC, "pages", "create"))]) {
            if (!f.endsWith(".tsx")) continue;
            const src = readFileSync(f, "utf8");
            if (/var\(--[\w-]+\s*,\s*#/.test(src)) offenders.push(f);
        }
        expect(offenders, `fallback 裸 hex 残留: ${offenders.join(", ")}`).toEqual([]);
    });
});
