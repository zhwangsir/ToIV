import { useEffect, useState } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router";
import { triggerBlobDownload } from "@/services/toiv/jianying-draft";
import { faceHref } from "./studio-edit-route";
import { StudioCreateHomeRoute } from "./studio-legacy-host-route";
import { StudioShell } from "../shell/StudioShell";
import { PipelineFace, type PipelineAction } from "../faces/pipeline/PipelineFace";
import { loadPipelineModel, type PipelineModel } from "../faces/pipeline/model";
import {
    applyRecipeToShot,
    exportRecipeBundle,
    installRecipe,
    loadRecipeCards,
    saveRecipeFromShot,
    type RecipeCardModel,
} from "../faces/pipeline/recipes-model";
import { useStudioToast } from "../ui/toast-store";
import "@/studio/studio.css";

export default function StudioCreateRoute() {
    const [params] = useSearchParams();
    const projectId = params.get("project") ?? "";
    if (!projectId) return <StudioCreateHomeRoute />;
    return <StudioPipelineRoute projectId={projectId} />;
}

function reasonOf(error: unknown) {
    return error instanceof Error ? error.message : String(error);
}

function StudioPipelineRoute({ projectId }: { projectId: string }) {
    const navigate = useNavigate();
    const [model, setModel] = useState<PipelineModel | null>(null);
    const [failed, setFailed] = useState(false);
    const [recipes, setRecipes] = useState<RecipeCardModel[]>([]);
    const [buddy, setBuddy] = useState(true);
    const push = useStudioToast((state) => state.push);
    useEffect(() => {
        let alive = true;
        setModel(null);
        setFailed(false);
        loadPipelineModel(projectId)
            .then((next) => { if (alive) setModel(next); })
            .catch(() => { if (alive) { setFailed(true); push("项目载入失败 · 回到项目库", true); } });
        return () => { alive = false; };
    }, [projectId, push]);
    useEffect(() => {
        let alive = true;
        loadRecipeCards()
            .then((cards) => { if (alive) setRecipes(cards); })
            .catch(() => { if (alive) push("配方列表加载失败 · 创作不受影响", true); });
        return () => { alive = false; };
    }, [projectId, push]);
    if (failed) return <Navigate to="/canvas" replace />;
    if (!model) {
        return (
            <StudioShell face="pipeline" projectLabel="载入中" runningCount={0} onFaceChange={(face) => navigate(faceHref(face, projectId))}>
                <div className="stv-main"><div className="stv-empty"><p>正在载入项目…</p></div></div>
            </StudioShell>
        );
    }
    const runRecipeAction = async (action: PipelineAction) => {
        try {
            if (action.type === "recipe-apply" && action.recipeId && action.shotId) {
                const fields = await applyRecipeToShot(action.recipeId, action.shotId);
                push(`已复用配方 · 写入 ${fields.join(" / ") || "无字段变化"}`);
            } else if (action.type === "recipe-export" && action.recipeId) {
                const bundle = await exportRecipeBundle(action.recipeId);
                triggerBlobDownload(new Blob([bundle.text], { type: "application/json" }), bundle.fileName);
                push(`配方已导出 · ${bundle.fileName}`);
            } else if (action.type === "recipe-save" && action.shotId) {
                const card = await saveRecipeFromShot(action.shotId, action.recipeName ?? "");
                setRecipes((prev) => [card, ...prev]);
                push(`已存为配方 · ${card.name}`);
            } else if (action.type === "recipe-install" && action.payload) {
                const card = await installRecipe(action.payload);
                setRecipes((prev) => [card, ...prev]);
                push(`配方已安装 · ${card.name}`);
            }
        } catch (error) {
            push(`配方操作失败 · ${reasonOf(error)}`, true);
        }
    };
    const onAction = (action: PipelineAction) => {
        const text: Record<PipelineAction["type"], string> = {
            "view-select": "",
            "view-preview": "预览已打开",
            "view-replace": "已加入生成队列 · 视图锚点已锁定",
            "view-download": "已存本地媒体库",
            "take-pick": "Take 已设为采用",
            "take-new": "新 Take 生成中 · 满血档",
            "stage-change": "阶段切换请求已记录",
            "scene-detect": "场景识别已入队 · 从剧本自动拆分",
            "recipe-apply": "",
            "recipe-export": "",
            "recipe-save": "",
            "recipe-install": "",
        };
        if (action.type.startsWith("recipe-")) {
            void runRecipeAction(action);
            return;
        }
        if (text[action.type]) push(text[action.type], action.type === "view-replace" || action.type === "take-new" || action.type === "scene-detect");
    };
    return (
        <StudioShell face="pipeline" projectLabel={`${model.projectName} / ${model.stages[model.stageIndex].label}`}
            runningCount={model.runningCount} onFaceChange={(face) => navigate(faceHref(face, projectId))}
            buddyText={buddy ? model.companionHint : undefined} onDismissBuddy={() => setBuddy(false)}>
            <PipelineFace model={model} recipes={recipes} onAction={onAction} />
        </StudioShell>
    );
}
