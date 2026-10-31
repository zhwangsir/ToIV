import { createRoot } from "react-dom/client";
import { StudioShell } from "@/studio/shell/StudioShell";
import { PipelineFace, type PipelineAction } from "@/studio/faces/pipeline/PipelineFace";
import { useStudioToast } from "@/studio/ui/toast-store";
import type { PipelineModel } from "@/studio/faces/pipeline/model";
import type { RecipeCardModel } from "@/studio/faces/pipeline/recipes-model";
import "@/studio/studio.css";

declare global {
    interface Window { __studioActions: PipelineAction[]; }
}
window.__studioActions = [];

const model: PipelineModel = {
    projectId: "p1",
    projectName: "草船借箭",
    runningCount: 1,
    companionHint: "还有 1 个镜头在渲染。",
    stages: [
        { key: "s0", label: "项目配置", done: true },
        { key: "s1", label: "剧本创作", done: true },
        { key: "s2", label: "素材准备", done: false },
        { key: "s3", label: "分镜设计", done: false },
    ],
    stageIndex: 2,
    scenes: [{
        id: "s1",
        name: "中军主帅营帐",
        slug: "INT / 日",
        views: [
            { id: "v1", label: "主视", status: "done", badge: "SEED 88213", locked: true },
            { id: "v2", label: "反打", status: "done", badge: "SEED 88214" },
            { id: "v3", label: "左立面", status: "run", progress: 48 },
            { id: "v4", label: "右立面", status: "wait" },
        ],
    }],
    shots: [{
        id: "sh1", title: "镜01", prompt: "晨雾悬崖", camera: "STATIC", durationSec: 4.5, status: "done",
        takes: [{ id: "c1", label: "T1", seed: 1 }, { id: "c2", label: "T2", seed: 2 }], activeTakeId: "c1",
    }],
};

const recipes: RecipeCardModel[] = [
    { id: "r1", name: "夜戏标准", description: "低光双灯", meta: "comfyui · ref2va · video", isDefault: true, updatedOn: "2026-10-29", sourceShotId: "sh9" },
    { id: "r2", name: "日戏外景", description: "", meta: "comfyui · t2i · image", isDefault: false, updatedOn: "2026-10-30", sourceShotId: "sh8" },
];

createRoot(document.getElementById("root")!).render(
    <StudioShell face="pipeline" projectLabel="草船借箭 / 素材准备" runningCount={model.runningCount}
        onFaceChange={() => {}} buddyText={model.companionHint} onDismissBuddy={() => {}}>
        <PipelineFace model={model} recipes={recipes} onAction={(action) => {
            window.__studioActions.push(action);
            useStudioToast.getState().push(`action:${action.type}`);
        }} />
    </StudioShell>,
);
