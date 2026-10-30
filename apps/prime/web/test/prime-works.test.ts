import { afterEach, describe, expect, test } from "bun:test";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

describe("prime works adapter", () => {
    test("maps jobs with media and status semantics", async () => {
        globalThis.fetch = (async () => new Response(JSON.stringify({
            jobs: [
                { id: "j1", kind: "render", status: "succeeded", created_at: "2026-10-29T10:00:00Z", results: [{ url: "/m/out1.mp4" }] },
                { id: "j2", type: "tts", status: "running", created_at: "2026-10-30T01:00:00Z", results: [] },
            ],
        }), { status: 200 })) as typeof fetch;
        const { loadPrimeWorks } = await import("../src/toiv/adapters/works");
        const works = await loadPrimeWorks();
        expect(works.map((work) => work.status)).toEqual(["done", "run"]);
        expect(works[0].media).toBe("/m/out1.mp4");
        expect(works[1].media).toBeUndefined();
        expect(works[1].kind).toBe("tts");
        expect(works[0].createdAt).toBe("2026-10-29");
    });
    test("tolerates bare array payload", async () => {
        globalThis.fetch = (async () => new Response(JSON.stringify([{ id: "j9", status: "failed" }]), { status: 200 })) as typeof fetch;
        const { loadPrimeWorks } = await import("../src/toiv/adapters/works");
        expect((await loadPrimeWorks())[0].status).toBe("fail");
    });
});
