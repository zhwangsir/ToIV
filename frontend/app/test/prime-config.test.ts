import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import config from "../vite.config";

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

test("session exchange is proxied to the web gateway rather than the Go API", () => {
    expect(config.server!.proxy!["/studio/auth"]).toBeDefined();
});
