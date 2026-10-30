import { lazy } from "react";
import { useNavigate, useParams } from "react-router";
import { StudioShell } from "../shell/StudioShell";
import { faceHref } from "./studio-edit-route";
import { useStudioToast } from "../ui/toast-store";
import "@/studio/studio.css";

const CanvasProjectPage = lazy(() => import("@/pages/canvas/project"));

export default function StudioCanvasProjectRoute() {
    const { id } = useParams();
    const navigate = useNavigate();
    const push = useStudioToast((state) => state.push);
    return (
        <StudioShell face="canvas" projectLabel={`画布 / ${(id ?? "").slice(0, 8)}`} runningCount={0}
            onOpenTasks={() => push("任务中心在 Plan 4 接入抽屉")}
            onFaceChange={(face) => navigate(faceHref(face, ""))}>
            <div className="stv-canvas-host">
                <CanvasProjectPage />
            </div>
        </StudioShell>
    );
}
