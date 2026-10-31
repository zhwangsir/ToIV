import { afterEach, describe, expect, test } from "bun:test";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

describe("prime assets adapter", () => {
    test("merges characters and scenes with first reference image", async () => {
        globalThis.fetch = (async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url.includes("/scenes")) {
                return new Response(JSON.stringify({ scenes: [{ id: "s1", name: "雨巷", environment_prompt: "EXT / 夜", master_ref: "/m/a.png" }] }), { status: 200 });
            }
            return new Response(JSON.stringify({
                characters: [{ id: "c1", name: "小周", style: "anime", reference_images_by_style: { anime: ["/m/ref1.png"] } }],
            }), { status: 200 });
        }) as typeof fetch;
        const { loadPrimeAssets } = await import("../src/toiv/adapters/assets");
        const model = await loadPrimeAssets("p1");
        expect(model.characters).toEqual([{ id: "c1", name: "小周", style: "anime", refImage: "/m/ref1.png" }]);
        expect(model.scenes).toHaveLength(1);
        expect(model.scenes[0].views[0].src).toBe("/m/a.png");
    });
});
