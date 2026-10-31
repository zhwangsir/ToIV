import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import config, { resolvePolicyModule } from "../vite.config";

test("canvas dev requests reach the Go /api route with no duplicate studio prefix", () => {
    const proxy = config.server!.proxy!["/studio/api"];
    expect(typeof proxy).toBe("object");
    if (typeof proxy === "string") throw new Error("Expected proxy options");
    expect(proxy.rewrite?.("/studio/api/canvas-projects?q=x")).toBe("/api/canvas-projects?q=x");
});

test("content lock resolves to the existing shared canvas module", () => {
    const aliases = config.resolve!.alias as Record<string, string>;
    expect(existsSync(aliases["@content-lock"])).toBe(true);
});

test("content lock also resolves in the deployed apps/canvas layout", () => {
    const root = mkdtempSync(join(tmpdir(), "prime-policy-"));
    try {
        const appDir = join(root, "apps/prime/web");
        const policy = join(root, "apps/canvas/web/src/content-lock.ts");
        mkdirSync(appDir, { recursive: true });
        mkdirSync(join(root, "apps/canvas/web/src"), { recursive: true });
        writeFileSync(policy, "export {};\n");
        expect(resolvePolicyModule(appDir)).toBe(policy);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("session exchange is proxied to the web gateway rather than the Go API", () => {
    expect(config.server!.proxy!["/studio/auth"]).toBeDefined();
});
