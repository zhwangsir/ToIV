import { Button } from "./Button";
import type { RecipeCardModel } from "../faces/pipeline/recipes-model";

export type RecipeCardAction = "apply" | "export";

export function RecipeCard({ recipe, shotId, onAction }: {
    recipe: RecipeCardModel;
    shotId?: string;
    onAction: (action: RecipeCardAction, recipeId: string) => void;
}) {
    return (
        <article className="stv-recipe">
            <header>
                <b>{recipe.name}</b>
                {recipe.isDefault ? <span className="tag">默认</span> : null}
                <span className="meta">{recipe.meta}</span>
            </header>
            {recipe.description ? <p className="desc">{recipe.description}</p> : null}
            <footer>
                <span className="sub">更新 {recipe.updatedOn}</span>
                <span className="acts">
                    <Button variant="quiet" onClick={() => onAction("export", recipe.id)}>导出</Button>
                    <Button variant="primary" disabled={!shotId} onClick={() => { if (shotId) onAction("apply", recipe.id); }}>复用到本镜</Button>
                </span>
            </footer>
        </article>
    );
}
