import { applyRecipe, createRecipeFromShot, exportRecipe, fetchRecipes, importRecipe } from "@/services/toiv/client";
import type { ToivRecipe, ToivRecipeExport } from "@/services/toiv/client";

export const RECIPE_SCHEMA = "toiv_generation_recipe_v1";

export type RecipeCardModel = {
    id: string;
    name: string;
    description: string;
    meta: string;
    isDefault: boolean;
    updatedOn: string;
    sourceShotId: string;
};

export type RecipeImportParse = { payload: ToivRecipeExport } | { error: string };

function cardOf(recipe: ToivRecipe): RecipeCardModel {
    return {
        id: recipe.id,
        name: recipe.name || recipe.id,
        description: recipe.description ?? "",
        meta: `${recipe.engine} · ${recipe.pipeline} · ${recipe.render_mode}`,
        isDefault: recipe.is_default,
        updatedOn: (recipe.updated_at ?? "").slice(0, 10),
        sourceShotId: recipe.source_shot_id ?? "",
    };
}

export async function loadRecipeCards(): Promise<RecipeCardModel[]> {
    return (await fetchRecipes()).map(cardOf);
}

export function parseRecipeImport(text: string): RecipeImportParse {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        return { error: "JSON 解析失败 · 请粘贴完整的配方导出文件" };
    }
    if ((parsed as { schema?: unknown } | null)?.schema !== RECIPE_SCHEMA) {
        return { error: `配方格式不是 ${RECIPE_SCHEMA} · 拒绝安装` };
    }
    return { payload: parsed as ToivRecipeExport };
}

export async function installRecipe(payload: unknown): Promise<RecipeCardModel> {
    return cardOf(await importRecipe(payload));
}

export async function saveRecipeFromShot(shotId: string, name: string): Promise<RecipeCardModel> {
    return cardOf(await createRecipeFromShot(shotId, { name }));
}

export async function exportRecipeBundle(recipeId: string): Promise<{ fileName: string; text: string }> {
    const payload = await exportRecipe(recipeId);
    const slug = payload.name.trim().replace(/[^\p{L}\p{N}_.-]+/gu, "-").replace(/^-+|-+$/g, "");
    return { fileName: `${slug || "toiv-recipe"}.toiv-recipe.json`, text: JSON.stringify(payload, null, 2) };
}

export async function applyRecipeToShot(recipeId: string, shotId: string): Promise<string[]> {
    const result = await applyRecipe(recipeId, { shot_id: shotId });
    return result.applied_fields ?? [];
}
