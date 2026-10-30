import { lazy, useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { studioFaceEnabled } from "../flags";
import { StudioShell } from "../shell/StudioShell";
import { CanvasHomeFace } from "../faces/canvas/CanvasHomeFace";
import { loadCanvasHomeModel, type CanvasHomeModel } from "../faces/canvas/model";
import { faceHref } from "./studio-edit-route";
import { useStudioToast } from "../ui/toast-store";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import "@/studio/studio.css";

const CanvasPage = lazy(() => import("@/pages/canvas/index"));

export default function StudioCanvasRoute() {
    if (!studioFaceEnabled("canvas")) return <CanvasPage />;
    return <StudioCanvasInner />;
}

function StudioCanvasInner() {
    const navigate = useNavigate();
    const [model, setModel] = useState<CanvasHomeModel | null>(null);
    const push = useStudioToast((state) => state.push);
    useEffect(() => {
        let alive = true;
        const canvasProjects = useCanvasStore.getState().projects.map((project) => ({ id: project.id, title: project.title }));
        loadCanvasHomeModel(canvasProjects).then((next) => { if (alive) setModel(next); }).catch(() => { if (alive) setModel(null); });
        return () => { alive = false; };
    }, []);
    if (!model) return <CanvasPage />;
    return (
        <StudioShell face="canvas" projectLabel="项目库" runningCount={0}
            onOpenTasks={() => push("任务中心在 Plan 4 接入抽屉")}
            onFaceChange={(face) => navigate(faceHref(face, ""))}>
            <CanvasHomeFace model={model}
                onOpen={(id) => {
                    const card = model.cards.find((item) => item.id === id);
                    navigate(card?.source === "canvas" ? `/canvas/${id}` : `/create?project=${id}`);
                }}
                onCreate={() => push("新建项目入口在 Plan 3b 接创建向导", true)} />
        </StudioShell>
    );
}
