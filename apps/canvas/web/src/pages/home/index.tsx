import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useUserStore } from "@/stores/use-user-store";
import { listWorkspaceCanvasProjectsPage, type CanvasLibrarySummary } from "@/services/api/workspace-data";
import { isLocalWorkspaceMode } from "@/services/workspace-mode";
import { listCanvasWorkspaceProjectRoots, previewNodesForWorkspaceProject } from "@/lib/canvas/canvas-workspace-project";
import { HomeDashboard } from "./home-dashboard";
import "./home-dashboard.css";

export default function HomePage() {
    const userId = useUserStore((state) => state.user?.id);
    const storageMode = useUserStore((state) => state.storageMode);
    const sessionHydrated = useUserStore((state) => state.hydrated);
    const localProjects = useCanvasStore((state) => state.projects);
    const localHydrated = useCanvasStore((state) => state.hydrated);
    const localMode = isLocalWorkspaceMode() || storageMode === "local";
    const query = useQuery({
        queryKey: ["beeftv-home-canvases", userId],
        queryFn: () => listWorkspaceCanvasProjectsPage({ page: 1, pageSize: 4, sort: "updated" }),
        // The local workspace store only holds projects that were opened this session, so the
        // home list always asks the workspace API (local backend or hosted) for the latest four.
        enabled: sessionHydrated && (localMode || Boolean(userId)),
    });
    const localSummaries = useMemo<CanvasLibrarySummary[]>(() => listCanvasWorkspaceProjectRoots(localProjects)
        .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
        .slice(0, 4)
        .map((project) => ({
            ...project,
            nodeCount: project.nodes.length,
            previewNodes: previewNodesForWorkspaceProject(localProjects, project.id),
        })), [localProjects]);
    const remote = query.data?.projects || [];
    const projects = remote.length || !localMode ? remote : localSummaries;

    return <HomeDashboard projects={projects} loading={!sessionHydrated || !localHydrated || (query.isLoading && !localSummaries.length)} error={!localMode && query.isError} onRetry={() => void query.refetch()} />;
}
