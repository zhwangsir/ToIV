import { afterEach, expect, test } from "bun:test";
import { loadPrimeProjects } from "../src/toiv/adapters/projects";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

test("canvas summaries are unwrapped from the Go envelope rather than lost", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => String(input).startsWith("/studio/api")
        ? json({ code: 0, data: { projects: [{ id: "c1", title: "画布甲", updatedAt: "2026-10-30T10:00:00Z" }] }, msg: "ok" })
        : json([{ id: "p1", title: "短片乙" }])) as typeof fetch;
    const result = await loadPrimeProjects();
    expect(result.cards.map(({ id, title, shotCount }) => ({ id, title, shotCount }))).toEqual([
        { id: "p1", title: "短片乙", shotCount: 0 },
        { id: "c1", title: "画布甲", shotCount: 0 },
    ]);
    expect(result.degraded).toBe("none");
});

test("both unavailable sources are reported instead of pretending the library is empty", async () => {
    globalThis.fetch = (async () => json({ detail: "unavailable" }, 503)) as typeof fetch;
    expect((await loadPrimeProjects()).degraded).toBe("both");
});

test("a rejected Go business envelope reports source failure even with HTTP 200", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => String(input).startsWith("/studio/api")
        ? json({ code: 403, data: null, msg: "denied" }) : json([])) as typeof fetch;
    expect((await loadPrimeProjects()).degraded).toBe("canvas");
});
