import { afterEach, describe, expect, test } from "bun:test";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

describe("prime create adapter", () => {
    test("creates then imports svml when provided", async () => {
        const calls: { path: string; method: string; body?: string }[] = [];
        globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
            const path = String(input);
            calls.push({ path, method: init?.method ?? "GET", body: init?.body as string | undefined });
            if (path.endsWith("/studio/projects")) return new Response(JSON.stringify({ id: "p9", title: "新剧" }), { status: 200 });
            return new Response(JSON.stringify({ shots: [] }), { status: 200 });
        }) as typeof fetch;
        const { createPrimeProject } = await import("../src/toiv/adapters/create");
        const result = await createPrimeProject({ title: "新剧", svml: "推近||旧词" });
        expect(result).toEqual({ id: "p9", title: "新剧", imported: true });
        expect(calls.map((call) => call.method)).toEqual(["POST", "POST"]);
        expect(calls[1].path).toContain("/import-svml");
        expect(JSON.parse(calls[0].body ?? "{}").title).toBe("新剧");
    });
    test("skips import without svml", async () => {
        const calls: string[] = [];
        globalThis.fetch = (async (input: RequestInfo | URL) => {
            calls.push(String(input));
            return new Response(JSON.stringify({ id: "p8", title: "空剧" }), { status: 200 });
        }) as typeof fetch;
        const { createPrimeProject } = await import("../src/toiv/adapters/create");
        const result = await createPrimeProject({ title: "空剧" });
        expect(result.imported).toBe(false);
        expect(calls).toHaveLength(1);
    });
});
