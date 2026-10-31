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

describe("prime canvas graph", () => {
    test("scenes become sequential nodes with 280px stride", async () => {
        globalThis.fetch = (async () => stub(scenes)) as typeof fetch;
        const { loadPrimeScenes, primeSceneNodes } = await import("../src/toiv/adapters/scenes");
        const more = { scenes: [scenes.scenes[0], { ...scenes.scenes[0], id: "s2", name: "雨巷", frozen_anchor: null }] };
        globalThis.fetch = (async () => stub(more)) as typeof fetch;
        const graph = primeSceneNodes(await loadPrimeScenes("p1"));
        expect(graph.nodes.map((node) => node.position.x)).toEqual([0, 280]);
        expect(graph.edges).toEqual([{ id: "s1->s2", source: "s1", target: "s2" }]);
        expect(graph.nodes[0].data.views).toHaveLength(4);
        expect(graph.nodes[1].data.frozen).toBe(false);
    });
});

describe("prime scene freeze", () => {
    test("posts master anchor id", async () => {
        const calls: { path: string; body?: string }[] = [];
        globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
            calls.push({ path: String(input), body: init?.body as string | undefined });
            return new Response("{}", { status: 200 });
        }) as typeof fetch;
        const { freezePrimeSceneAnchor } = await import("../src/toiv/adapters/scenes");
        await freezePrimeSceneAnchor("s1");
        expect(calls[0].path).toContain("/api/drama/scenes/s1/freeze-anchor");
        expect(JSON.parse(calls[0].body ?? "{}")).toEqual({ anchor_id: "master" });
    });
});
