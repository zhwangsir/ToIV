import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { StudioShell } from "../shell/StudioShell";
import { CanvasHomeFace } from "../faces/canvas/CanvasHomeFace";
import { loadCanvasHomeModel, type CanvasHomeModel } from "../faces/canvas/model";
import { faceHref } from "./studio-edit-route";
import { useStudioToast } from "../ui/toast-store";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import "@/studio/studio.css";

const EMPTY_MODEL: CanvasHomeModel = { cards: [], empty: true };

export default function StudioCanvasRoute() {
    const navigate = useNavigate();
    const [model, setModel] = useState<CanvasHomeModel | null>(null);
    const push = useStudioToast((state) => state.push);
    useEffect(() => {
        let alive = true;
        const canvasProjects = useCanvasStore.getState().projects.map((project) => ({ id: project.id, title: project.title }));
        loadCanvasHomeModel(canvasProjects)
            .then((next) => { if (alive) setModel(next); })
            .catch(() => {
                if (!alive) return;
                setModel(EMPTY_MODEL);
                push("项目列表加载失败 · 已显示空列表", true);
            });
        return () => { alive = false; };
    }, [push]);
    return (
        <StudioShell face="canvas" projectLabel="项目库" runningCount={0}
            onFaceChange={(face) => navigate(faceHref(face, ""))}>
            <CanvasHomeFace model={model ?? EMPTY_MODEL}
                onOpen={(id) => {
                    const card = model?.cards.find((item) => item.id === id);
                    navigate(card?.source === "canvas" ? `/canvas/${id}` : `/create?project=${id}`);
                }}
                onCreate={() => push("新建项目入口在 Plan 3b 接创建向导", true)} />
        </StudioShell>
    );
}
