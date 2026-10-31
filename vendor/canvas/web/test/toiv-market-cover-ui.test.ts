import { describe, expect, test, beforeEach } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { toivCoverImageUrl } from "../src/services/toiv/cover-url";

function installMemoryLocalStorage(seed?: Record<string, string>) {
    const store = new Map<string, string>(Object.entries(seed ?? {}));
    const ls = {
        getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
        setItem: (k: string, v: string) => {
            store.set(k, String(v));
        },
        removeItem: (k: string) => {
            store.delete(k);
        },
        clear: () => store.clear(),
    };
    Object.defineProperty(globalThis, "localStorage", { value: ls, configurable: true });
    Object.defineProperty(globalThis, "window", {
        value: {
            localStorage: ls,
            location: { origin: "https://toiv.wineryz.top" },
        },
        configurable: true,
    });
}

describe("toivCoverImageUrl", () => {
    beforeEach(() => {
        installMemoryLocalStorage({ toiv_token: "test-jwt-token" });
    });

    test("self-hosted relative cover gets ?token= and is not raw cover_url", () => {
        const raw = "/api/apps/covers/file/appcover-0123456789abcdef0123456789abcdef.png";
        const out = toivCoverImageUrl(raw);
        expect(out).not.toBe(raw);
        expect(out.startsWith(raw + "?")).toBe(true);
        expect(out).toContain("token=test-jwt-token");
    });

    test("self-hosted /apps/covers path prefixes /api and tokens", () => {
        const raw = "/apps/covers/file/demo.jpg";
        const out = toivCoverImageUrl(raw);
        expect(out).toContain("/api/apps/covers/file/demo.jpg");
        expect(out).toContain("token=");
        expect(out).not.toBe(raw);
    });

    test("external RH image keeps no JWT", () => {
        const raw = "https://cdn.example.com/covers/foo.png";
        expect(toivCoverImageUrl(raw)).toBe(raw);
    });

    test("RH COS video cover uses snapshot without token", () => {
        const raw = "https://rh-images.xiaoyaoyou.com/path/clip.mp4";
        const out = toivCoverImageUrl(raw);
        expect(out).toContain("ci-process=snapshot");
        expect(out).not.toContain("token=");
    });

    test("empty / null returns empty string", () => {
        expect(toivCoverImageUrl("")).toBe("");
        expect(toivCoverImageUrl(null)).toBe("");
        expect(toivCoverImageUrl(undefined)).toBe("");
    });

    test("without token, relative cover stays path-only (still not broken by injecting empty token)", () => {
        installMemoryLocalStorage({});
        const raw = "/api/apps/covers/file/x.png";
        expect(toivCoverImageUrl(raw)).toBe(raw);
    });
});

describe("market-page cover contracts (source)", () => {
    const page = readFileSync(join(import.meta.dir, "../src/pages/toiv/market-page.tsx"), "utf8");
    const client = readFileSync(join(import.meta.dir, "../src/services/toiv/client.ts"), "utf8");

    test("exports toivCoverImageUrl and market uses CoverThumb not raw cover_url img", () => {
        expect(client).toContain('export { toivCoverImageUrl } from "./cover-url"');
        expect(readFileSync(join(import.meta.dir, "../src/services/toiv/cover-url.ts"), "utf8")).toContain("export function toivCoverImageUrl");
        expect(page).toContain("toivCoverImageUrl");
        expect(page).toContain("function CoverThumb");
        expect(page).toContain("onError");
        expect(page).toContain("aspect-[4/3]");
        expect(page).not.toContain("src={app.cover_url}");
        expect(page).not.toMatch(/flex h-28 items-center justify-center/);
        expect(page).toContain("hover:border-[var(--workspace-accent");
        expect(page).not.toMatch(/--rh-lime/);
    });
});
