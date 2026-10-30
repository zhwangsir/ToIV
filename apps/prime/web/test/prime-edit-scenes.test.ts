import { afterEach, describe, expect, test } from "bun:test";

const realFetch = globalThis.fetch;
const stub = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

afterEach(() => { globalThis.fetch = realFetch; });

const project = {
    id: "p1",
    title: "草船借箭",
    shots: [
        { id: "sh1", duration_sec: 4.5, dialogue: "或许我真不适合修仙", audio_media_status: "current", candidates: [{ id: "c1", is_picked: true, url: "/m/1.png" }] },
        { id: "sh2", duration_sec: 3, dialogue: "", audio_media_status: "none", candidates: [{ id: "c2", url: "/m/2.png" }] },
    ],
};

const scenes = {
    scenes: [{
        id: "s1", name: "中军主帅营帐", environment_prompt: "INT / 日",
        master_ref: "/m/a.png", reverse_ref: null, frozen_anchor: { anchor_id: "master" },
        variants: [{ id: "v1", master_ref: "/m/c.png" }],
    }],
};

describe("prime timeline adapter", () => {
    test("builds v1 clips sequentially and a1 only for current audio", async () => {
        globalThis.fetch = (async () => stub(project)) as typeof fetch;
        const { loadPrimeTimeline } = await import("../src/toiv/adapters/edit");
        const model = await loadPrimeTimeline("p1");
        const v1 = model.clips.filter((clip) => clip.track === "v1");
        const a1 = model.clips.filter((clip) => clip.track === "a1");
        expect(v1.map((clip) => clip.startSec)).toEqual([0, 4.5]);
        expect(v1[0].src).toBe("/m/1.png");
        expect(v1[1].src).toBeUndefined();
        expect(a1).toHaveLength(1);
        expect(a1[0].shotId).toBe("sh1");
        expect(model.totalSec).toBe(7.5);
    });
});

describe("prime scenes adapter", () => {
    test("maps four views with lock and variant count", async () => {
        globalThis.fetch = (async () => stub(scenes)) as typeof fetch;
        const { loadPrimeScenes } = await import("../src/toiv/adapters/scenes");
        const nodes = await loadPrimeScenes("p1");
        expect(nodes).toHaveLength(1);
        expect(nodes[0].views.map((view) => ({ label: view.label, src: view.src ?? null }))).toEqual([
            { label: "主视", src: "/m/a.png" },
            { label: "反打", src: null },
            { label: "左立面", src: "/m/c.png" },
            { label: "右立面", src: null },
        ]);
        expect(nodes[0].frozen).toBe(true);
        expect(nodes[0].variantCount).toBe(1);
    });
    test("api failure throws", async () => {
        globalThis.fetch = (async () => stub({}, 503)) as typeof fetch;
        const { loadPrimeScenes } = await import("../src/toiv/adapters/scenes");
        await expect(loadPrimeScenes("p1")).rejects.toThrow("scenes 503");
    });
});
