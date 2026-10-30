import { lazy } from "react";
import { useNavigate } from "react-router";
import { StudioShell } from "../shell/StudioShell";
import { faceHref } from "./studio-edit-route";
import { useStudioToast } from "../ui/toast-store";
import type { StudioFace } from "../flags";
import "@/studio/studio.css";

const MediaLibraryPage = lazy(() => import("@/pages/library/media-library-page"));
const ToivTasksPage = lazy(() => import("@/pages/toiv/tasks-page"));
const SettingsPage = lazy(() => import("@/pages/settings"));

function LegacyHost({ face, label, children }: { face: StudioFace; label: string; children: React.ReactNode }) {
    const navigate = useNavigate();
    const push = useStudioToast((state) => state.push);
    return (
        <StudioShell face={face} projectLabel={label} runningCount={0}
            onOpenTasks={() => push("任务中心抽屉在 Plan 5 接入")}
            onFaceChange={(next) => navigate(faceHref(next, ""))}>
            <div className="stv-legacy-host">{children}</div>
        </StudioShell>
    );
}

export function StudioLibraryRoute() {
    return <LegacyHost face="pipeline" label="素材库"><MediaLibraryPage /></LegacyHost>;
}

export function StudioTasksRoute() {
    return <LegacyHost face="pipeline" label="任务中心"><ToivTasksPage /></LegacyHost>;
}

export function StudioSettingsRoute() {
    return <LegacyHost face="pipeline" label="设置"><SettingsPage /></LegacyHost>;
}
