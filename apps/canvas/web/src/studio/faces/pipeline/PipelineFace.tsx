import { useState } from "react";
import { SlidingTabs } from "@/studio/ui/SlidingTabs";
import { ViewGroup } from "@/studio/ui/ViewGroup";
import { TakeStrip } from "@/studio/ui/TakeStrip";
import { Field } from "@/studio/ui/Field";
import { Button } from "@/studio/ui/Button";
import type { PipelineModel } from "./model";

export type PipelineAction = {
    type: "view-select" | "view-preview" | "view-replace" | "view-download" | "take-pick" | "take-new" | "stage-change";
    sceneId?: string;
    viewId?: string;
    shotId?: string;
    takeId?: string;
    stageIndex?: number;
};

export function PipelineFace({ model, onAction }: { model: PipelineModel; onAction: (action: PipelineAction) => void }) {
    const [sceneId, setSceneId] = useState(model.scenes[0]?.id ?? "");
    const [viewId, setViewId] = useState(model.scenes[0]?.views[0]?.id ?? "");
    const [stageIndex, setStageIndex] = useState(model.stageIndex);
    const [activeTake, setActiveTake] = useState<Record<string, string | undefined>>({});
    const scene = model.scenes.find((group) => group.id === sceneId) ?? model.scenes[0];
    const shot = model.shots[0];
    const currentTake = shot ? activeTake[shot.id] ?? shot.activeTakeId : undefined;
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
                {shot ? (
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
            </aside>
        </div>
    );
}
