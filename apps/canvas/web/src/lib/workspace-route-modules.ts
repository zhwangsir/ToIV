const workspaceRouteLoaders = {
    agents: () => import("@/pages/agents"),
    home: () => import("@/pages/home"),
    assets: () => import("@/pages/assets"),
    library: () => import("@/pages/library/media-library-page"),
    canvas: () => import("@/pages/canvas"),
    create: () => import("@/pages/create"),
    projects: () => import("@/pages/projects"),
    projectDetail: () => import("@/pages/projects/detail"),
    toivTasks: () => import("@/pages/toiv/tasks-page"),
    toivLibrary: () => import("@/pages/toiv/library-page"),
    toivMarket: () => import("@/pages/toiv/market-page"),
    toivAgent: () => import("@/pages/toiv/agent-page"),
    toivDrama: () => import("@/pages/toiv/drama-page"),
};

export const loadAgentsPage = workspaceRouteLoaders.agents;
export const loadAssetsPage = workspaceRouteLoaders.assets;
export const loadHomePage = workspaceRouteLoaders.home;
export const loadCanvasPage = workspaceRouteLoaders.canvas;
export const loadCanvasProjectPage = () => import("@/pages/canvas/project");
export const loadCreatePage = workspaceRouteLoaders.create;
export const loadProjectDetailPage = workspaceRouteLoaders.projectDetail;
export const loadProjectsPage = workspaceRouteLoaders.projects;

export function preloadWorkspaceRoute(pathnameOrSlug: string) {
    const segments = pathnameOrSlug.replace(/^\//, "").split("/").filter(Boolean);
    const slug = segments[0] || "home";
    if (slug === "projects" && segments.length > 1) {
        void workspaceRouteLoaders.projectDetail();
        return;
    }
    if (slug === "toiv") {
        const map = {
            tasks: workspaceRouteLoaders.toivTasks,
            library: workspaceRouteLoaders.library,
            market: workspaceRouteLoaders.toivMarket,
            agent: workspaceRouteLoaders.toivAgent,
            drama: workspaceRouteLoaders.toivDrama,
        } as const;
        const sub = segments[1] as keyof typeof map | undefined;
        const load = sub ? map[sub] : undefined;
        if (load) void load();
        return;
    }
    // Legacy /assets bookmarks preload the unified media-library shell.
    if (slug === "assets") {
        void workspaceRouteLoaders.library();
        return;
    }
    const load = workspaceRouteLoaders[slug as keyof typeof workspaceRouteLoaders];
    if (load) void load();
}
