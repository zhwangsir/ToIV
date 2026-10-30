import { afterEach, describe, expect, test } from "bun:test";

const realFetch = globalThis.fetch;

function stubProject() {
    return {
        id: "p1",
        title: "草船借箭",
        shots: [
            {
                id: "sh1", idx: 0, status: "voiced", prompt: "晨雾悬崖", camera: "STATIC", duration_sec: 4.5,
                beats: [{ text: "旧词", kind: "d" }, { text: "远景", kind: "v" }],
                candidates: [{ id: "c1", seed: 88213, is_picked: true, url: "/m/1.png" }, { id: "c2", seed: 88214, url: "/m/2.png" }],
            },
            { id: "sh2", idx: 1, status: "running", prompt: "睁眼特写", camera: "DOLLY IN", duration_sec: 3, candidates: [] },
            { id: "sh3", idx: 2, status: "draft", prompt: "", camera: "", duration_sec: 0 },
        ],
    };
}

afterEach(() => { globalThis.fetch = realFetch; });

describe("prime storyboard adapter", () => {
    test("maps shots, beats and takes with ToIV status semantics", async () => {
        globalThis.fetch = (async (input: RequestInfo | URL) => {
            expect(String(input)).toContain("/api/studio/projects/p1");
            return new Response(JSON.stringify(stubProject()), { status: 200 });
        }) as typeof fetch;
        const { loadPrimeStoryboard } = await import("../src/toiv/adapters/storyboard");
        const model = await loadPrimeStoryboard("p1");
        expect(model.title).toBe("草船借箭");
        expect(model.shots.map((shot) => shot.status)).toEqual(["done", "run", "wait"]);
        expect(model.runningCount).toBe(1);
        expect(model.shots[0].beats).toEqual([{ text: "旧词", kind: "d" }, { text: "远景", kind: "v" }]);
        expect(model.shots[0].takes.map((take) => ({ id: take.id, label: take.label, picked: take.picked }))).toEqual([
            { id: "c1", label: "T1", picked: true },
            { id: "c2", label: "T2", picked: false },
        ]);
        expect(model.shots[0].takes[0].src).toBe("/m/1.png");
        expect(model.shots[0].title).toBe("镜01");
    });
    test("missing beats and candidates degrade to empty lists", async () => {
        globalThis.fetch = (async () => new Response(JSON.stringify(stubProject()), { status: 200 })) as typeof fetch;
        const { loadPrimeStoryboard } = await import("../src/toiv/adapters/storyboard");
        const model = await loadPrimeStoryboard("p1");
        expect(model.shots[2].beats).toEqual([]);
        expect(model.shots[2].takes).toEqual([]);
    });
    test("api failure throws for the caller to degrade", async () => {
        globalThis.fetch = (async () => new Response("nope", { status: 503 })) as typeof fetch;
        const { loadPrimeStoryboard } = await import("../src/toiv/adapters/storyboard");
        await expect(loadPrimeStoryboard("p1")).rejects.toThrow("storyboard 503");
    });
});
