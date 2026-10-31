import { describe, expect, mock, test } from "bun:test";

const imported: unknown[] = [];
const applied: { recipeId: string; shotId: string }[] = [];
// bun 的 mock.module 是进程级的：补齐真实导出，避免同批次其它测试文件拿不到 toivHttp
const actualClient = await import("@/services/toiv/client");

mock.module("@/services/toiv/client", () => ({
    ...actualClient,
    fetchRecipes: async () => [
        {
            id: "r1", name: "夜戏标准", description: "低光双灯", engine: "comfyui", render_mode: "video",
            pipeline: "ref2va", pick_strategy: "auto", snapshot: {}, source_revision_id: "rev1",
            source_shot_id: "sh9", is_default: true, created_at: "2026-10-28T09:00:00Z", updated_at: "2026-10-29T12:30:00Z",
        },
        {
            id: "r2", name: "日戏 / 外景", description: "", engine: "comfyui", render_mode: "image",
            pipeline: "t2i", pick_strategy: "manual", snapshot: {}, source_revision_id: "rev2",
            source_shot_id: "sh8", is_default: false, created_at: "2026-10-29T09:00:00Z", updated_at: "2026-10-30T08:05:00Z",
        },
    ],
    createRecipeFromShot: async (shotId: string, opts: { name?: string }) => ({
        id: "r3", name: opts.name ?? shotId, description: "", engine: "comfyui", render_mode: "video",
        pipeline: "ref2va", pick_strategy: "auto", snapshot: {}, source_revision_id: "rev3",
        source_shot_id: shotId, is_default: false, created_at: "2026-10-30T09:00:00Z", updated_at: "2026-10-30T09:00:00Z",
    }),
    exportRecipe: async (recipeId: string) => ({
        schema: "toiv_generation_recipe_v1", name: recipeId === "r1" ? "夜戏标准" : "日戏 / 外景",
        description: "低光双灯", engine: "comfyui", render_mode: "video", pipeline: "ref2va",
        pick_strategy: "auto", snapshot: { seed: 88213 }, exported_at: "2026-10-30T09:10:00Z",
    }),
    importRecipe: async (payload: unknown) => {
        imported.push(payload);
        const shape = payload as { name?: string };
        return {
            id: "r4", name: shape.name ?? "导入配方", description: "", engine: "comfyui", render_mode: "video",
            pipeline: "ref2va", pick_strategy: "auto", snapshot: {}, source_revision_id: "rev4",
            source_shot_id: "sh1", is_default: false, created_at: "2026-10-30T09:20:00Z", updated_at: "2026-10-30T09:20:00Z",
        };
    },
    applyRecipe: async (recipeId: string, body: { shot_id: string }) => {
        applied.push({ recipeId, shotId: body.shot_id });
        return { shot: { id: body.shot_id }, render_params: {}, applied_fields: ["prompt", "seed"], project_specs_changed: [] };
    },
}));

const {
    RECIPE_SCHEMA,
    loadRecipeCards,
    parseRecipeImport,
    installRecipe,
    saveRecipeFromShot,
    exportRecipeBundle,
    applyRecipeToShot,
} = await import("@/studio/faces/pipeline/recipes-model");

describe("recipe cards", () => {
    test("maps recipes to cards with engine meta and default flag", async () => {
        const cards = await loadRecipeCards();
        expect(cards.map((card) => card.id)).toEqual(["r1", "r2"]);
        expect(cards[0].meta).toBe("comfyui · ref2va · video");
        expect(cards[0].isDefault).toBe(true);
        expect(cards[1].isDefault).toBe(false);
        expect(cards[0].updatedOn).toBe("2026-10-29");
    });
    test("card without description falls back to meta only", async () => {
        const cards = await loadRecipeCards();
        expect(cards[1].description).toBe("");
    });
});

describe("recipe import parsing", () => {
    test("rejects malformed json", () => {
        const result = parseRecipeImport("{ not json");
        expect("error" in result).toBe(true);
        if ("error" in result) expect(result.error).toContain("JSON");
    });
    test("rejects foreign schema", () => {
        const result = parseRecipeImport(JSON.stringify({ schema: "someone_elses_v9", name: "x" }));
        expect("error" in result).toBe(true);
        if ("error" in result) expect(result.error).toContain(RECIPE_SCHEMA);
    });
    test("accepts the export shape", () => {
        const payload = { schema: RECIPE_SCHEMA, name: "夜戏标准", engine: "comfyui" };
        const result = parseRecipeImport(JSON.stringify(payload));
        expect("error" in result).toBe(false);
        if (!("error" in result)) expect(result.payload).toEqual(payload);
    });
});

describe("recipe loop", () => {
    test("install posts the parsed payload and returns a card", async () => {
        const payload = { schema: RECIPE_SCHEMA, name: "外部配方", engine: "comfyui" };
        const card = await installRecipe(payload);
        expect(imported).toEqual([payload]);
        expect(card.id).toBe("r4");
        expect(card.name).toBe("外部配方");
    });
    test("save from shot carries the shot id and chosen name", async () => {
        const card = await saveRecipeFromShot("sh9", "夜戏标准 v2");
        expect(card.name).toBe("夜戏标准 v2");
        expect(card.sourceShotId).toBe("sh9");
    });
    test("export yields a downloadable json bundle named after the recipe", async () => {
        const bundle = await exportRecipeBundle("r1");
        expect(bundle.fileName).toBe("夜戏标准.toiv-recipe.json");
        expect(JSON.parse(bundle.text).schema).toBe(RECIPE_SCHEMA);
        expect(JSON.parse(bundle.text).snapshot.seed).toBe(88213);
    });
    test("export filename collapses unsafe characters", async () => {
        const bundle = await exportRecipeBundle("r2");
        expect(bundle.fileName).toBe("日戏-外景.toiv-recipe.json");
    });
    test("apply reports the fields the backend wrote", async () => {
        const fields = await applyRecipeToShot("r1", "sh2");
        expect(fields).toEqual(["prompt", "seed"]);
        expect(applied).toEqual([{ recipeId: "r1", shotId: "sh2" }]);
    });
});
