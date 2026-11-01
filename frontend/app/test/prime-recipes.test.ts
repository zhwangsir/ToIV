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
    test("apply posts the revision precondition and reports fields plus the new revision", async () => {
        let body: Record<string, unknown> = {};
        globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
            calls.push({ path: String(input), method: init?.method ?? "GET" });
            body = JSON.parse(String(init?.body ?? "{}"));
            return new Response(JSON.stringify({
                applied_fields: ["prompt", "seed"],
                shot: { id: "sh2", current_revision_id: "rev-applied" },
            }), { status: 200 });
        }) as typeof fetch;
        const { applyPrimeRecipeToShot } = await import("../src/toiv/adapters/recipes");
        expect(await applyPrimeRecipeToShot("r1", "sh2", "rev-base")).toEqual({
            fields: ["prompt", "seed"], revisionId: "rev-applied",
        });
        expect(calls[0].path).toContain("/api/studio/recipes/r1/apply");
        expect(calls[0].method).toBe("POST");
        expect(body).toEqual({ shot_id: "sh2", apply_project_specs: false, expected_revision: "rev-base" });
    });
    test("apply omits the precondition when the caller has no revision yet", async () => {
        let body: Record<string, unknown> = {};
        globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
            body = JSON.parse(String(init?.body ?? "{}"));
            return new Response(JSON.stringify({ applied_fields: [], shot: {} }), { status: 200 });
        }) as typeof fetch;
        const { applyPrimeRecipeToShot } = await import("../src/toiv/adapters/recipes");
        expect(await applyPrimeRecipeToShot("r1", "sh2")).toEqual({ fields: [], revisionId: "" });
        expect(body).toEqual({ shot_id: "sh2", apply_project_specs: false });
    });
});
