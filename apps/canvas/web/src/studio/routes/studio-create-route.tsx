import { lazy, useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { studioFaceEnabled } from "../flags";
import { faceHref } from "./studio-edit-route";
import { StudioShell } from "../shell/StudioShell";
import { PipelineFace, type PipelineAction } from "../faces/pipeline/PipelineFace";
import { loadPipelineModel, type PipelineModel } from "../faces/pipeline/model";
import { useStudioToast } from "../ui/toast-store";
import "@/studio/studio.css";

const CreationWorkbenchPage = lazy(() => import("@/pages/create/creation-workbench"));

export default function StudioCreateRoute() {
    if (!studioFaceEnabled("pipeline")) return <CreationWorkbenchPage />;
    return <StudioPipelineRoute />;
}

function StudioPipelineRoute() {
    const [params] = useSearchParams();
    const navigate = useNavigate();
    const projectId = params.get("project") ?? "";
    const [model, setModel] = useState<PipelineModel | null>(null);
    const [buddy, setBuddy] = useState(true);
    const push = useStudioToast((state) => state.push);
    useEffect(() => {
        if (!projectId) return;
        let alive = true;
        loadPipelineModel(projectId).then((next) => { if (alive) setModel(next); }).catch(() => { if (alive) setModel(null); });
        return () => { alive = false; };
    }, [projectId]);
    if (!projectId || !model) return <CreationWorkbenchPage />;
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
        };
        if (text[action.type]) push(text[action.type], action.type === "view-replace" || action.type === "take-new" || action.type === "scene-detect");
    };
    return (
        <StudioShell face="pipeline" projectLabel={`${model.projectName} / ${model.stages[model.stageIndex].label}`}
            runningCount={model.runningCount} onFaceChange={(face) => navigate(faceHref(face, projectId))}
            buddyText={buddy ? model.companionHint : undefined} onDismissBuddy={() => setBuddy(false)}>
            <PipelineFace model={model} onAction={onAction} />
        </StudioShell>
    );
}
