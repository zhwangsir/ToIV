import { useEffect, useState } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router";
import type { StudioFace } from "../flags";
import { StudioShell } from "../shell/StudioShell";
import { EditFace } from "../faces/edit/EditFace";
import { loadEditModel, type EditModel } from "../faces/edit/model";
import { useStudioToast } from "../ui/toast-store";
import "@/studio/studio.css";

export function faceHref(face: StudioFace, projectId: string) {
    if (face === "pipeline") return `/create${projectId ? `?project=${projectId}` : ""}`;
    if (face === "edit") return `/edit${projectId ? `?project=${projectId}` : ""}`;
    return "/canvas";
}

export default function StudioEditRoute() {
    const [params] = useSearchParams();
    const projectId = params.get("project") ?? "";
    if (!projectId) return <Navigate to="/canvas" replace />;
    return <StudioEditInner projectId={projectId} />;
}

function StudioEditInner({ projectId }: { projectId: string }) {
    const navigate = useNavigate();
    const [model, setModel] = useState<EditModel | null>(null);
    const [failed, setFailed] = useState(false);
    const push = useStudioToast((state) => state.push);
    useEffect(() => {
        let alive = true;
        setModel(null);
        setFailed(false);
        loadEditModel(projectId)
            .then((next) => { if (alive) setModel(next); })
            .catch(() => { if (alive) { setFailed(true); push("剪辑湾载入失败 · 回到项目库", true); } });
        return () => { alive = false; };
    }, [projectId, push]);
    if (failed) return <Navigate to="/canvas" replace />;
    if (!model) {
        return (
            <StudioShell face="edit" projectLabel="载入中" runningCount={0} onFaceChange={(face) => navigate(faceHref(face, projectId))}>
                <div className="stv-main"><div className="stv-empty"><p>正在载入剪辑湾…</p></div></div>
            </StudioShell>
        );
    }
    return (
        <StudioShell face="edit" projectLabel={`${model.projectName} / 成片剪辑`} runningCount={0}
            onFaceChange={(face) => navigate(faceHref(face, projectId))}>
            <EditFace model={model} onResult={push} />
        </StudioShell>
    );
}
