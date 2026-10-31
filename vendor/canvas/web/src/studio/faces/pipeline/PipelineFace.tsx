import { useState } from "react";
import { SlidingTabs } from "@/studio/ui/SlidingTabs";
import { ViewGroup } from "@/studio/ui/ViewGroup";
import { TakeStrip } from "@/studio/ui/TakeStrip";
import { Field } from "@/studio/ui/Field";
import { Button } from "@/studio/ui/Button";
import { RecipeCard } from "@/studio/ui/RecipeCard";
import { ImportDialog } from "@/studio/ui/ImportDialog";
import type { ToivRecipeExport } from "@/services/toiv/client";
import type { RecipeCardModel } from "./recipes-model";
import type { PipelineModel } from "./model";

export type RecipeActionType = "recipe-apply" | "recipe-export" | "recipe-save" | "recipe-install";

export type PipelineAction = {
    type: "view-select" | "view-preview" | "view-replace" | "view-download" | "take-pick" | "take-new" | "stage-change" | "scene-detect" | RecipeActionType;
    sceneId?: string;
    viewId?: string;
    shotId?: string;
    takeId?: string;
    stageIndex?: number;
    recipeId?: string;
    recipeName?: string;
    payload?: ToivRecipeExport;
};

const PANELS = [{ key: "shot", label: "镜头" }, { key: "recipe", label: "配方" }];

export function PipelineFace({ model, recipes, onAction }: {
    model: PipelineModel;
    recipes: RecipeCardModel[];
    onAction: (action: PipelineAction) => void;
}) {
    const [sceneId, setSceneId] = useState(model.scenes[0]?.id ?? "");
    const [viewId, setViewId] = useState(model.scenes[0]?.views[0]?.id ?? "");
    const [stageIndex, setStageIndex] = useState(model.stageIndex);
    const [activeTake, setActiveTake] = useState<Record<string, string | undefined>>({});
    const [panel, setPanel] = useState("shot");
    const [importOpen, setImportOpen] = useState(false);
    const [recipeName, setRecipeName] = useState("");
    const scene = model.scenes.find((group) => group.id === sceneId) ?? model.scenes[0];
    const shot = model.shots[0];
    const currentTake = shot ? activeTake[shot.id] ?? shot.activeTakeId : undefined;
    const saveRecipe = () => {
        if (!shot) return;
        onAction({ type: "recipe-save", shotId: shot.id, recipeName: recipeName.trim() || `${shot.title} 配方` });
    };
    return (
        <div className="stv-body">
            <aside className="stv-rail" aria-label="场次目录">
                <h4>场次</h4>
                {model.scenes.map((group, index) => {
                    const running = group.views.some((view) => view.status === "run");
                    const done = group.views.every((view) => view.status === "done");
                    return (
                        <button key={group.id} type="button" className="stv-rail-item" aria-current={group.id === scene?.id}
                            onClick={() => { setSceneId(group.id); setViewId(group.views[0]?.id ?? ""); }}>
                            <span className="no">{String(index + 1).padStart(2, "0")}</span>{group.name}
                            <span className={`st stv-status-${running ? "run" : done ? "done" : "wait"}`}>{running ? "●" : done ? "✓" : "○"}</span>
                        </button>
                    );
                })}
            </aside>
            <main className="stv-main">
                <SlidingTabs items={model.stages.map((stage) => ({ key: stage.key, label: stage.label, done: stage.done }))}
                    value={model.stages[stageIndex]?.key ?? model.stages[0].key}
                    onChange={(key) => {
                        const index = model.stages.findIndex((stage) => stage.key === key);
                        setStageIndex(index);
                        onAction({ type: "stage-change", stageIndex: index });
                    }} />
                <div className="stv-bar">
                    <h2>场景</h2><span className="meta">{model.scenes.length} 场景 · 每场景 4 视图</span>
                </div>
                {model.scenes.length === 0 ? (
                    <div className="stv-empty">
                        <p>这个项目还没有场景。从剧本自动识别场景与多视图。</p>
                        <Button variant="primary" onClick={() => onAction({ type: "scene-detect" })}>从剧本识别场景</Button>
                    </div>
                ) : null}
                {model.scenes.map((group) => (
                    <ViewGroup key={group.id} scene={group} views={group.views}
                        selectedViewId={group.id === scene?.id ? viewId : undefined}
                        onViewSelect={(sid, vid) => { setSceneId(sid); setViewId(vid); onAction({ type: "view-select", sceneId: sid, viewId: vid }); }}
                        onPreview={(sid, vid) => onAction({ type: "view-preview", sceneId: sid, viewId: vid })}
                        onReplace={(sid, vid) => onAction({ type: "view-replace", sceneId: sid, viewId: vid })}
                        onDownload={(sid, vid) => onAction({ type: "view-download", sceneId: sid, viewId: vid })} />
                ))}
            </main>
            <aside className="stv-insp" aria-label="场景检查器">
                <header>
                    <span className="no">{String(model.stageIndex + 1).padStart(2, "0")}</span>
                    <div><b>{scene?.name ?? "—"}</b><small>{scene?.slug ?? ""} · 4 VIEWS</small></div>
                </header>
                <SlidingTabs items={PANELS} value={panel} onChange={setPanel} label="检查器面板" />
                {panel === "shot" && shot ? (
                    <>
                        <Field label="镜头提示词" htmlFor="shot-prompt"><textarea id="shot-prompt" rows={4} defaultValue={shot.prompt} /></Field>
                        <Field label="候选 Takes" htmlFor="shot-takes">
                            <div id="shot-takes">
                                <TakeStrip takes={shot.takes} activeId={currentTake}
                                    onPick={(takeId) => { setActiveTake((prev) => ({ ...prev, [shot.id]: takeId })); onAction({ type: "take-pick", shotId: shot.id, takeId }); }} />
                            </div>
                        </Field>
                        <Button variant="primary" onClick={() => onAction({ type: "take-new", shotId: shot.id })}>生成新 Take</Button>
                    </>
                ) : null}
                {panel === "recipe" ? (
                    <div className="stv-recipes">
                        <Field label="配方名" htmlFor="recipe-name">
                            <input id="recipe-name" value={recipeName} placeholder={shot ? `${shot.title} 配方` : "配方名"}
                                onChange={(event) => setRecipeName(event.target.value)} />
                        </Field>
                        <div className="stv-recipebar">
                            <Button variant="primary" disabled={!shot} onClick={saveRecipe}>从本镜存配方</Button>
                            <Button variant="quiet" onClick={() => setImportOpen(true)}>安装配方 JSON</Button>
                        </div>
                        {recipes.length === 0 ? (
                            <div className="stv-empty"><p>还没有配方。存一个满意的镜头，或安装别处导出的 JSON。</p></div>
                        ) : null}
                        {recipes.map((recipe) => (
                            <RecipeCard key={recipe.id} recipe={recipe} shotId={shot?.id}
                                onAction={(type, recipeId) => onAction({
                                    type: type === "apply" ? "recipe-apply" : "recipe-export",
                                    recipeId,
                                    shotId: shot?.id,
                                })} />
                        ))}
                    </div>
                ) : null}
            </aside>
            <ImportDialog open={importOpen} onClose={() => setImportOpen(false)}
                onInstall={(payload) => { setImportOpen(false); onAction({ type: "recipe-install", payload }); }} />
        </div>
    );
}
