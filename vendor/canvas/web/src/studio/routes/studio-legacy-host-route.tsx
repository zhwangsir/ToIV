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
const DramaPage = lazy(() => import("@/pages/toiv/drama-page"));
const MarketPage = lazy(() => import("@/pages/toiv/market-page"));
const AgentsPage = lazy(() => import("@/pages/agents"));
const KpiPage = lazy(() => import("@/pages/toiv/kpi-page"));
const PluginsPage = lazy(() => import("@/pages/plugins"));
const EagleLibraryPage = lazy(() => import("@/pages/plugins/eagle"));
const CreationWorkbenchPage = lazy(() => import("@/pages/create/creation-workbench"));
const RequireFeature = lazy(() => import("@/components/workspace/require-feature").then((m) => ({ default: m.RequireFeature })));

function LegacyHost({ face, label, children }: { face: StudioFace; label: string; children: React.ReactNode }) {
    const navigate = useNavigate();
    const push = useStudioToast((state) => state.push);
    return (
        <StudioShell face={face} projectLabel={label} runningCount={0}
            onFaceChange={(next) => navigate(faceHref(next, ""))}>
            <div className="stv-legacy-host">{children}</div>
        </StudioShell>
    );
}

export function StudioLibraryRoute() {
    return <LegacyHost face="pipeline" label="素材库"><MediaLibraryPage /></LegacyHost>;
}

/** /create 无 project：新建向导尚未在新壳落地，先以 legacy host 承接 composer，避免创作入口断链。 */
export function StudioCreateHomeRoute() {
    return <LegacyHost face="pipeline" label="创作"><CreationWorkbenchPage /></LegacyHost>;
}

export function StudioTasksRoute() {
    return <LegacyHost face="pipeline" label="任务中心"><ToivTasksPage /></LegacyHost>;
}

export function StudioDramaRoute() {
    return <LegacyHost face="pipeline" label="短剧"><DramaPage /></LegacyHost>;
}

export function StudioMarketRoute() {
    return <LegacyHost face="pipeline" label="工具市场"><MarketPage /></LegacyHost>;
}

export function StudioAgentsRoute() {
    return <LegacyHost face="pipeline" label="智能体"><AgentsPage /></LegacyHost>;
}

export function StudioKpiRoute() {
    return <LegacyHost face="pipeline" label="KPI"><KpiPage /></LegacyHost>;
}

export function StudioSettingsRoute() {
    return <LegacyHost face="pipeline" label="设置"><SettingsPage /></LegacyHost>;
}

export function StudioPluginsRoute() {
    return (
        <RequireFeature feature="pluginCenterEnabled">
            <LegacyHost face="pipeline" label="插件中心"><PluginsPage /></LegacyHost>
        </RequireFeature>
    );
}

export function StudioPluginsEagleRoute() {
    return (
        <RequireFeature feature="pluginCenterEnabled">
            <LegacyHost face="pipeline" label="Eagle 库"><EagleLibraryPage /></LegacyHost>
        </RequireFeature>
    );
}
