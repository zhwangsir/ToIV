export const PRIME_RECIPE_SCHEMA = "toiv_generation_recipe_v1";

export type PrimeRecipeCard = {
    id: string;
    name: string;
    description: string;
    meta: string;
    isDefault: boolean;
    updatedOn: string;
    sourceShotId: string;
};

export type PrimeRecipeParse = { payload: unknown } | { error: string };

function authHeaders(): HeadersInit {
    const token = typeof localStorage !== "undefined" ? localStorage.getItem("toiv_token") : null;
    return token ? { Authorization: `Bearer ${token}` } : {};
}

type RawRecipe = {
    id: string;
    name?: string;
    description?: string;
    engine?: string;
    pipeline?: string;
    render_mode?: string;
    is_default?: boolean;
    updated_at?: string;
    source_shot_id?: string;
};

function cardOf(recipe: RawRecipe): PrimeRecipeCard {
    return {
        id: recipe.id,
        name: recipe.name || recipe.id,
        description: recipe.description ?? "",
        meta: `${recipe.engine ?? "—"} · ${recipe.pipeline ?? "—"} · ${recipe.render_mode ?? "—"}`,
        isDefault: Boolean(recipe.is_default),
        updatedOn: (recipe.updated_at ?? "").slice(0, 10),
        sourceShotId: recipe.source_shot_id ?? "",
    };
}

export async function loadPrimeRecipes(): Promise<PrimeRecipeCard[]> {
    const res = await fetch("/api/studio/recipes", { headers: authHeaders() });
    if (!res.ok) throw new Error(`recipes ${res.status}`);
    const body = (await res.json()) as { recipes?: RawRecipe[] };
    return (body.recipes ?? []).map(cardOf);
}

export function parsePrimeRecipeImport(text: string): PrimeRecipeParse {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        return { error: "JSON 解析失败 · 请粘贴完整的配方导出文件" };
    }
    if ((parsed as { schema?: unknown } | null)?.schema !== PRIME_RECIPE_SCHEMA) {
        return { error: `配方格式不是 ${PRIME_RECIPE_SCHEMA} · 拒绝安装` };
    }
    return { payload: parsed };
}

export async function installPrimeRecipe(payload: unknown): Promise<PrimeRecipeCard> {
    const res = await fetch("/api/studio/recipes/import", {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`import ${res.status}`);
    return cardOf((await res.json()) as RawRecipe);
}

export async function savePrimeRecipeFromShot(shotId: string, name: string): Promise<PrimeRecipeCard> {
    const res = await fetch("/api/studio/recipes/from-shot", {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ shot_id: shotId, name, description: "" }),
    });
    if (!res.ok) throw new Error(`from-shot ${res.status}`);
    return cardOf((await res.json()) as RawRecipe);
}

export async function exportPrimeRecipeBundle(recipeId: string): Promise<{ fileName: string; text: string }> {
    const res = await fetch(`/api/studio/recipes/${encodeURIComponent(recipeId)}/export`, { headers: authHeaders() });
    if (!res.ok) throw new Error(`export ${res.status}`);
    const payload = (await res.json()) as { name?: string };
    const slug = (payload.name ?? "").trim().replace(/[^\p{L}\p{N}_.-]+/gu, "-").replace(/^-+|-+$/g, "");
    return { fileName: `${slug || "toiv-recipe"}.toiv-recipe.json`, text: JSON.stringify(payload, null, 2) };
}

export async function applyPrimeRecipeToShot(recipeId: string, shotId: string): Promise<string[]> {
    const res = await fetch(`/api/studio/recipes/${encodeURIComponent(recipeId)}/apply`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ shot_id: shotId, apply_project_specs: false }),
    });
    if (!res.ok) throw new Error(`apply ${res.status}`);
    const body = (await res.json()) as { applied_fields?: string[] };
    return body.applied_fields ?? [];
}
