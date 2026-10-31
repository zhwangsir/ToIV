import { afterEach, describe, expect, test } from "bun:test";
import { loadPrimeWorks } from "../src/toiv/adapters/works";
import { cancelPrimeTask, loadPrimeTasks } from "../src/toiv/addons/TaskDrawerPrime";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

// Mirrors GET /api/jobs (_job_dict), not a hypothetical object[] results envelope.
function job(overrides: Record<string, unknown> = {}) {
    return { id: "j1", prompt_id: "p1", kind: "render", status: "done", prompt: "海边日落",
        created_at: "2026-10-29T10:00:00Z", results: [], progress: { pct: null },
        error: "", hold_reason: "", post_status: "", ...overrides };
}
function respond(body: unknown, status = 200) {
    globalThis.fetch = (async () => Response.json(body, { status })) as typeof fetch;
}

describe("prime works: actual jobs protocol", () => {
    test("maps string result URLs, including filename query media, without signing stored cards", async () => {
        respond([
            job({ results: ["/api/images?filename=shot.MP4&type=output"] }),
            job({ id: "j2", kind: "tts", results: ["/api/studio/files/voice.wav"] }),
            job({ id: "j3", results: ["https://cdn.example.test/still.webp"] }),
        ]);
        const works = await loadPrimeWorks();
        expect(works.map(work => work.media)).toEqual([
            "/api/images?filename=shot.MP4&type=output", "/api/studio/files/voice.wav", "https://cdn.example.test/still.webp",
        ]);
        expect(works.map(work => work.mediaKind)).toEqual(["video", "audio", "image"]);
        expect(works[0].createdAt).toBe("2026-10-29");
        expect(works[1].kind).toBe("tts");
    });
    test("ignores malformed results and finds a supported URL rather than pretending objects are media", async () => {
        respond([
            job({ results: [{ url: "/fake.png" }, "javascript:alert(1)", "/notes.txt", "/real.png"] }),
            job({ id: "empty", results: null }),
            job({ id: "unsupported", results: ["data:text/html,<h1>unsafe</h1>", "/notes.html"] }),
        ]);
        const works = await loadPrimeWorks();
        expect(works[0].media).toBe("/real.png");
        expect(works[1].media).toBeUndefined();
        expect(works[2].media).toBeUndefined();
    });
    test("does not label canceled jobs as queued", async () => {
        respond([job({ status: "canceled" }), job({ status: "error" }), job({ status: "held" })]);
        expect((await loadPrimeWorks()).map(work => work.status)).toEqual(["canceled", "fail", "wait"]);
    });
    test("rejects HTTP errors and malformed lists instead of presenting an empty library", async () => {
        respond({ detail: "unavailable" }, 503);
        await expect(loadPrimeWorks()).rejects.toThrow();
        respond({ unexpected: [] });
        await expect(loadPrimeWorks()).rejects.toThrow();
    });
    test("forwards AbortSignal to the jobs request", async () => {
        const controller = new AbortController();
        let signal: AbortSignal | null | undefined;
        globalThis.fetch = (async (_url, init) => { signal = init?.signal; return Response.json([]); }) as typeof fetch;
        await loadPrimeWorks(controller.signal);
        expect(signal).toBe(controller.signal);
    });
});

describe("prime tasks: jobs only", () => {
    test("uses real progress snapshots and permits queued/held cancellation but never terminal cancellation", async () => {
        respond([job({ status: "running", progress: { pct: 37 } }), job({ status: "queued" }),
            job({ status: "held" }), job({ status: "canceled" }), job(), job({ status: "error" })]);
        const tasks = await loadPrimeTasks();
        expect(tasks[0].progress).toBe(37);
        expect(tasks.map(task => task.cancellable)).toEqual([true, true, true, false, false, false]);
        expect(tasks[3].status).toBe("canceled");
    });
    test("never sends an empty cancellation id and preserves cancel failures", async () => {
        let requests = 0;
        globalThis.fetch = (async () => { requests++; return Response.json({ ok: true }); }) as typeof fetch;
        await expect(cancelPrimeTask("")).rejects.toThrow();
        expect(requests).toBe(0);
        respond({ detail: "already terminal" }, 409);
        await expect(cancelPrimeTask("j1")).rejects.toThrow();
    });
});
