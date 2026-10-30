import { lazy, useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { studioFaceEnabled, type StudioFace } from "../flags";
import { StudioShell } from "../shell/StudioShell";
import { EditFace } from "../faces/edit/EditFace";
import { loadEditModel, type EditModel } from "../faces/edit/model";
import { useStudioToast } from "../ui/toast-store";
import "@/studio/studio.css";

const CreationWorkbenchPage = lazy(() => import("@/pages/create/creation-workbench"));

export function faceHref(face: StudioFace, projectId: string) {
    if (face === "pipeline") return `/create${projectId ? `?project=${projectId}` : ""}`;
    if (face === "edit") return `/edit${projectId ? `?project=${projectId}` : ""}`;
    return "/canvas";
}

export default function StudioEditRoute() {
    if (!studioFaceEnabled("edit")) return <CreationWorkbenchPage />;
    return <StudioEditInner />;
}

function StudioEditInner() {
    const [params] = useSearchParams();
    const navigate = useNavigate();
    const projectId = params.get("project") ?? "";
    const [model, setModel] = useState<EditModel | null>(null);
    const push = useStudioToast((state) => state.push);
    useEffect(() => {
        if (!projectId) return;
        let alive = true;
        loadEditModel(projectId).then((next) => { if (alive) setModel(next); }).catch(() => { if (alive) setModel(null); });
        return () => { alive = false; };
    }, [projectId]);
    if (!projectId || !model) return <CreationWorkbenchPage />;
    return (
        <StudioShell face="edit" projectLabel={`${model.projectName} / 成片剪辑`} runningCount={0}
            onFaceChange={(face) => navigate(faceHref(face, projectId))}>
            <EditFace model={model} onResult={push} />
        </StudioShell>
    );
}
