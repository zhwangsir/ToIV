import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App, ConfigProvider, theme } from "antd";

import ProjectAssetsView from "@/pages/projects/detail/assets";
import ProjectChaptersView from "@/pages/projects/detail/chapters";
import { setActiveUserScope } from "@/lib/user-scope";
import type { ProjectDetail, ProjectShot, ProjectUnit } from "@/services/api/projects";
import { useUserStore } from "@/stores/use-user-store";

const params = new URLSearchParams(window.location.search);
const light = params.has("light");
const chapterMode = params.has("chapter");
const focusShot = params.get("shot") || "";
document.documentElement.classList.toggle("dark", !light);

useUserStore.setState({
    hydrated: true,
    storageMode: "remote",
    user: {
        id: "owner-b1b",
        username: "b1b-user",
        displayName: "对账验证账号",
        role: "user",
        status: "active",
    },
});
setActiveUserScope("owner-b1b");

const project = {
    id: "proj-b1b",
    userId: "owner-b1b",
    name: "跨集对账验证项目",
    type: "short-drama",
    aspectRatio: "9:16",
    sourceType: "blank",
    description: "",
    stylePresetId: "",
    status: "active" as const,
    revision: 1,
    createdAt: "2026-10-27T00:00:00.000Z",
    updatedAt: "2026-10-27T00:00:00.000Z",
};

const units: ProjectUnit[] = [
    { id: "unit-1", projectId: "proj-b1b", kind: "episode", title: "第 1 集", sourceText: "雨夜天台的对峙开场。", wordCount: 12, status: "ready", position: 0, createdAt: "2026-10-27T00:00:00.000Z", updatedAt: "2026-10-27T00:00:00.000Z" },
    { id: "unit-2", projectId: "proj-b1b", kind: "episode", title: "第 2 集", sourceText: "便利店门口的重逢。", wordCount: 10, status: "ready", position: 1, createdAt: "2026-10-27T00:00:00.000Z", updatedAt: "2026-10-27T00:00:00.000Z" },
    { id: "unit-3", projectId: "proj-b1b", kind: "episode", title: "第 3 集", sourceText: "末班车站的告别。", wordCount: 8, status: "draft", position: 2, createdAt: "2026-10-27T00:00:00.000Z", updatedAt: "2026-10-27T00:00:00.000Z" },
];

const shots: ProjectShot[] = [
    ...Array.from({ length: 12 }, (_, index) => ({
        id: `shot-1-${index + 1}`,
        projectId: "proj-b1b",
        unitId: "unit-1",
        title: index === 0 ? "雨夜对峙" : `镜头 ${String(index + 1).padStart(2, "0")}`,
        description: "",
        position: index,
        durationMs: 4_000,
        status: "ready",
        createdAt: "2026-10-27T00:00:00.000Z",
        updatedAt: "2026-10-27T00:00:00.000Z",
    })),
    {
        id: "shot-2-1",
        projectId: "proj-b1b",
        unitId: "unit-2",
        title: "门口重逢",
        description: "",
        position: 0,
        durationMs: 4_000,
        status: "ready",
        createdAt: "2026-10-27T00:00:00.000Z",
        updatedAt: "2026-10-27T00:00:00.000Z",
    },
    {
        id: "shot-2-9",
        projectId: "proj-b1b",
        unitId: "unit-2",
        title: "雨中回望",
        description: "",
        position: 1,
        durationMs: 4_000,
        status: "ready",
        createdAt: "2026-10-27T00:00:00.000Z",
        updatedAt: "2026-10-27T00:00:00.000Z",
    },
];

const detail: ProjectDetail = {
    project,
    units,
    canvases: [],
    canvasUnitLinks: [],
    unitCanvasCounts: { "unit-1": 1, "unit-2": 0, "unit-3": 0 },
    assets: [],
    assetFolders: [],
    workflows: [],
    shots,
    shotRevisions: [],
    shotArtifacts: [],
    shotReferences: [],
    assetCandidates: [],
    tasks: [],
};

const queryClient = new QueryClient({
    defaultOptions: {
        queries: { retry: false, refetchOnWindowFocus: false },
        mutations: { retry: false },
    },
});

type HarnessWindow = Window & { __refreshCount?: number };

const refreshProject = () => { (window as HarnessWindow).__refreshCount = ((window as HarnessWindow).__refreshCount || 0) + 1; };

const initialEntry = chapterMode
    ? `/projects/proj-b1b/chapters/unit-1${focusShot ? `?shot=${encodeURIComponent(focusShot)}` : ""}`
    : "/projects/proj-b1b/assets";

createRoot(document.getElementById("root")!).render(
    <QueryClientProvider client={queryClient}>
        <ConfigProvider theme={{ algorithm: light ? theme.defaultAlgorithm : theme.darkAlgorithm, token: { motion: false } }}>
            <App>
                <MemoryRouter initialEntries={[initialEntry]}>
                    <Routes>
                        <Route path="/projects/:projectId/assets" element={<ProjectAssetsView detail={detail} refreshProject={refreshProject} onCreateCanvas={() => undefined} />} />
                        <Route path="/projects/:projectId/chapters/:chapterId" element={<ProjectChaptersView detail={detail} refreshProject={refreshProject} onCreateCanvas={() => undefined} />} />
                    </Routes>
                </MemoryRouter>
            </App>
        </ConfigProvider>
    </QueryClientProvider>,
);
