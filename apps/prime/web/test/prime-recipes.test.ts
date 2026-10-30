import { afterEach, describe, expect, test } from "bun:test";

const realFetch = globalThis.fetch;
const calls: { path: string; method: string }[] = [];

afterEach(() => { globalThis.fetch = realFetch; calls.length = 0; });

const recipe = {
    id: "r1", name: "夜戏标准", description: "低光双灯", engine: "comfyui", pipeline: "ref2va",
    render_mode: "video", is_default: true, updated_at: "2026-10-29T12:30:00Z", source_shot_id: "sh9",
};

describe("prime recipes adapter", () => {
    test("maps list to cards", async () => {
        globalThis.fetch = (async (input: RequestInfo | URL) => {
            calls.push({ path: String(input), method: "GET" });
            return new Response(JSON.stringify({ recipes: [recipe] }), { status: 200 });
        }) as typeof fetch;
        const { loadPrimeRecipes } = await import("../src/toiv/adapters/recipes");
        const cards = await loadPrimeRecipes();
        expect(cards[0].meta).toBe("comfyui · ref2va · video");
        expect(cards[0].isDefault).toBe(true);
        expect(cards[0].updatedOn).toBe("2026-10-29");
    });
    test("import parsing rejects foreign schema and accepts export shape", async () => {
        const { parsePrimeRecipeImport, PRIME_RECIPE_SCHEMA } = await import("../src/toiv/adapters/recipes");
        const bad = parsePrimeRecipeImport('{"schema":"x_v9"}');
        expect("error" in bad && bad.error).toContain(PRIME_RECIPE_SCHEMA);
        const ok = parsePrimeRecipeImport(JSON.stringify({ schema: PRIME_RECIPE_SCHEMA, name: "外部" }));
        expect("error" in ok).toBe(false);
    });
    test("export slug collapses unsafe characters", async () => {
        globalThis.fetch = (async (input: RequestInfo | URL) => {
            calls.push({ path: String(input), method: "GET" });
            return new Response(JSON.stringify({ schema: "toiv_generation_recipe_v1", name: "日戏 / 外景", snapshot: {} }), { status: 200 });
        }) as typeof fetch;
        const { exportPrimeRecipeBundle } = await import("../src/toiv/adapters/recipes");
        const bundle = await exportPrimeRecipeBundle("r2");
        expect(bundle.fileName).toBe("日戏-外景.toiv-recipe.json");
    });
    test("apply posts shot id and reports fields", async () => {
        globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
            calls.push({ path: String(input), method: init?.method ?? "GET" });
            return new Response(JSON.stringify({ applied_fields: ["prompt", "seed"] }), { status: 200 });
        }) as typeof fetch;
        const { applyPrimeRecipeToShot } = await import("../src/toiv/adapters/recipes");
        expect(await applyPrimeRecipeToShot("r1", "sh2")).toEqual(["prompt", "seed"]);
        expect(calls[0].path).toContain("/api/studio/recipes/r1/apply");
        expect(calls[0].method).toBe("POST");
    });
});
