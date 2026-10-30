import { lazy, Suspense, type ReactNode } from "react";
import { Navigate, Outlet, useLocation, useParams, useSearchParams } from "react-router";

import { createWorkspaceRouter } from "@/lib/app-routing";
import { FullScreenLoader, WorkspaceRouteLoader } from "@/components/ui/aceternity/full-screen-loader";
import { loadAgentsPage, loadHomePage, loadProjectDetailPage } from "@/lib/workspace-route-modules";
import { CanvasRefreshShell } from "@/pages/canvas/canvas-refresh-shell";
import RouteErrorPage from "@/pages/route-error";
import { isLocalWorkspaceMode } from "@/services/workspace-mode";

const AgentsPage = lazy(loadAgentsPage);
const MediaLibraryPage = lazy(() => import("@/pages/library/media-library-page"));
const HomePage = lazy(loadHomePage);
/** COSMOS_SEED：Desktop 页源码保留（pages/desktop、components/desktop）；W6 默认路由不可达，见 docs/COSMOS_APP_SHELL_SEED.md */
const StudioCanvasRoute = lazy(() => import("@/studio/routes/studio-canvas-route"));
const StudioCreateRoute = lazy(() => import("@/studio/routes/studio-create-route"));
const StudioEditRoute = lazy(() => import("@/studio/routes/studio-edit-route"));
const StudioCanvasProjectRoute = lazy(() => import("@/studio/routes/studio-canvas-project-route"));
const NotFound = lazy(() => import("@/pages/not-found"));
const PluginsPage = lazy(() => import("@/pages/plugins"));
const EagleLibraryPage = lazy(() => import("@/pages/plugins/eagle"));
const ToivTasksPage = lazy(() => import("@/pages/toiv/tasks-page"));
const ToivMarketPage = lazy(() => import("@/pages/toiv/market-page"));
const ToivLibraryDetailPage = lazy(() => import("@/pages/toiv/library-detail"));
const ToivDramaPage = lazy(() => import("@/pages/toiv/drama-page"));
const ToivKpiPage = lazy(() => import("@/pages/toiv/kpi-page"));
const ProjectDetailPage = lazy(loadProjectDetailPage);
const SettingsPage = lazy(() => import("@/pages/settings"));
const UserLayout = lazy(() => import("@/layouts/user-layout"));
const RequireFeature = lazy(() => import("@/components/workspace/require-feature").then((module) => ({ default: module.RequireFeature })));
const RedlineRouteGuard = lazy(() => import("@/components/workspace/require-r18").then((module) => ({ default: module.RedlineRouteGuard })));

function deferred(element: ReactNode) {
    return <Suspense fallback={<WorkspaceRouteLoader />}>{element}</Suspense>;
}

function fullScreenDeferred(element: ReactNode) {
    return <Suspense fallback={<FullScreenLoader label="正在打开创作空间" detail="准备当前页面" />}>{element}</Suspense>;
}

function WorkspaceLayout() {
    const { pathname } = useLocation();
    const isCanvasProjectRoute = pathname.startsWith("/canvas/");
    const fallback = isCanvasProjectRoute ? <CanvasRefreshShell /> : <FullScreenLoader label="正在打开创作空间" detail="准备当前页面" />;
    // V4-5-fix:路由切换偶发视图卡死(实测:进入 /toiv/drama 后再切 /library,URL 推进但
    // Outlet 不重渲染)。根修是 drama-page 的 FromImageDialog 改条件挂载(f8633401);这里的
    // pathname-key 是防御性加固——路径变化时强制重建 Suspense 边界,代价是导航时整树重挂
    //(与旧多页行为一致,可接受)。注:当时环境是 React 19.2 + react-router 8.2,已证与 router
    // 版本无关;当前实装为钉版 react-router 7.9.5。摘除本 key 前须补往返回归——已于 2026-10-15 摘除,W0-2 门禁=部署后
    // drama↔library↔market↔tasks 往返×10 真机回归(见 test/w02-pathname-key.test.ts)。
    return <Suspense fallback={fallback}><UserLayout><Suspense fallback={fallback}><RedlineRouteGuard><Outlet /></RedlineRouteGuard></Suspense></UserLayout></Suspense>;
}

function LocalAwareProjectRoute() {
    const { projectId } = useParams();
    const localMode = isLocalWorkspaceMode();
    if (localMode && projectId) return <Navigate to={`/canvas/${projectId}`} replace />;
    return deferred(<ProjectDetailPage />);
}

function LegacyProjectAliasRoute() {
    const { projectId, "*": rest } = useParams();
    return <Navigate to={`/projects/${projectId}${rest ? `/${rest}` : ""}`} replace />;
}

function AssetsLegacyRedirect() {
    const [searchParams] = useSearchParams();
    const tab = searchParams.get("tab");
    if (tab === "history") return <Navigate to="/library?source=history" replace />;
    return <Navigate to="/library?source=materials" replace />;
}

function ToivLibraryDetailRedirect() {
    const { id } = useParams();
    return <Navigate to={`/library/works/${id ?? ""}`} replace />;
}

/** W2 F2: classic /toiv/drama/:id → /create?project=:id（保留 query；丢弃 classic=1） */
function ToivDramaDetailToCreateRedirect() {
    const { id } = useParams();
    const [searchParams] = useSearchParams();
    const next = new URLSearchParams(searchParams);
    next.delete("classic");
    if (id) next.set("project", id);
    const qs = next.toString();
    return <Navigate to={`/create${qs ? `?${qs}` : ""}`} replace />;
}

/** R11: 孤面 → 内链 /create（对外等价 /studio/create，由 studio 壳承载） */
function ToivWsToCreateRedirect() {
    const { id, section } = useParams();
    const [searchParams] = useSearchParams();
    const next = new URLSearchParams(searchParams);
    if (id) next.set("project", id);
    if (section) next.set("section", section);
    const qs = next.toString();
    return <Navigate to={`/create${qs ? `?${qs}` : ""}`} replace />;
}

/** R12①: /toiv/runs/:id → /create?run=:id（保留既有 query） */
function ToivRunToCreateRedirect() {
    const { id } = useParams();
    const [searchParams] = useSearchParams();
    const next = new URLSearchParams(searchParams);
    if (id) next.set("run", id);
    const qs = next.toString();
    return <Navigate to={`/create${qs ? `?${qs}` : ""}`} replace />;
}

/** R12②: /create/* 子路径漏网 → /create（保留 query） */
function CreateSubpathRedirect() {
    const [searchParams] = useSearchParams();
    const qs = searchParams.toString();
    return <Navigate to={`/create${qs ? `?${qs}` : ""}`} replace />;
}



/**
 * DEV 专用实验室路由。
 *
 * lazy(() => import(...)) 写在函数体内，而不是模块顶层常量：
 * 生产构建时 import.meta.env.DEV 被替换为 false，本函数随之不可达，
 * 摇树会连同其中的动态 import 一起删除，实验室代码不进入生产依赖图。
 * 若把 lazy 提到模块顶层，动态 import 会被静态分析成真实 chunk 并打进 dist。
 */
function devRoutes() {
    const FolderPreviewLab = lazy(() => import("@/pages/dev/folder-preview-lab"));
    const DirectorReproLab = lazy(() => import("@/pages/dev/director-repro-lab"));
    const AssistantPanelLab = lazy(() => import("@/pages/dev/assistant-panel-lab"));
    const TestVoiceRecording = lazy(() => import("@/pages/test-voice-recording"));
    return [
        { path: "/dev/folders", element: fullScreenDeferred(<FolderPreviewLab />), errorElement: <RouteErrorPage /> },
        { path: "/dev/director-repro", element: fullScreenDeferred(<DirectorReproLab />), errorElement: <RouteErrorPage /> },
        { path: "/dev/assistant-panel", element: fullScreenDeferred(<AssistantPanelLab />), errorElement: <RouteErrorPage /> },
        { path: "/test-voice-recording", element: deferred(<TestVoiceRecording />), errorElement: <RouteErrorPage /> },
    ];
}

export const router = createWorkspaceRouter([
    ...(import.meta.env.DEV ? devRoutes() : []),
    // studio 新壳三面：不套旧 WorkspaceLayout chrome（strangler 外层）
    { path: "/create", element: deferred(<StudioCreateRoute />) },
    { path: "/edit", element: deferred(<StudioEditRoute />) },
    { path: "/canvas", element: deferred(<StudioCanvasRoute />) },
    { path: "/projects", element: deferred(<StudioCanvasRoute />) },
    { path: "/project", element: deferred(<StudioCanvasRoute />) },
    { path: "/canvas/:id", element: deferred(<StudioCanvasProjectRoute />) },
    {
        element: <WorkspaceLayout />,
        errorElement: <RouteErrorPage />,
        children: [
            // W1 F1：登录后 /studio/ 默认落地密台创作（Home 降级 /home，非默认）
            { path: "/", element: <Navigate to="/create" replace /> },
            { path: "/home", element: deferred(<HomePage />) },
            // W6 F12：/desktop* 默认不可达 → /create（源码保留作 Cosmos 种子，禁接回默认交付）
            { path: "/desktop", element: <Navigate to="/create" replace /> },
            { path: "/desktop/store", element: <Navigate to="/create" replace /> },
            { path: "/desktop/legacy-home", element: <Navigate to="/create" replace /> },
            { path: "/desktop/*", element: <Navigate to="/create" replace /> },
            { path: "/create/*", element: <CreateSubpathRedirect /> },
            { path: "/tasks", element: deferred(<ToivTasksPage />) },
            { path: "/library", element: deferred(<MediaLibraryPage />) },
            { path: "/library/works/:id", element: deferred(<ToivLibraryDetailPage />) },
            { path: "/assets", element: <AssetsLegacyRedirect /> },
            { path: "/toiv/library", element: <Navigate to="/library?source=works" replace /> },
            { path: "/toiv/library/:id", element: <ToivLibraryDetailRedirect /> },
            { path: "/skills", element: <Navigate to="/create" replace /> },
            { path: "/skill", element: <Navigate to="/create" replace /> },
            { path: "/skills/reference", element: <Navigate to="/create" replace /> },
            {
                path: "/plugins",
                element: <RequireFeature feature="pluginCenterEnabled">{deferred(<PluginsPage />)}</RequireFeature>,
            },
            {
                path: "/plugins/eagle",
                element: <RequireFeature feature="pluginCenterEnabled">{deferred(<EagleLibraryPage />)}</RequireFeature>,
            },
            { path: "/settings", element: deferred(<SettingsPage />) },
            { /* W7：外部 Agent 客户端面保留；入口仅设置侧链，非侧栏/⌘K 独立 Agent 对话面 */ path: "/agents", element: deferred(<AgentsPage />) },
            { path: "/toiv/tasks", element: <Navigate to="/tasks" replace /> },
            { path: "/toiv/market", element: deferred(<ToivMarketPage />) },
            { path: "/toiv/agent", element: <Navigate to="/create" replace /> },
            { path: "/toiv/runs/:id", element: <ToivRunToCreateRedirect /> },
            { path: "/toiv/audio", element: <Navigate to="/toiv/market" replace /> },
            { path: "/toiv/image-tools", element: <Navigate to="/toiv/market" replace /> },
            { path: "/toiv/video-tools", element: <Navigate to="/toiv/market" replace /> },
            { path: "/toiv/dub-tools", element: <Navigate to="/toiv/market" replace /> },
            { path: "/toiv/drama", element: deferred(<ToivDramaPage />) },
            { path: "/toiv/kpi", element: deferred(<ToivKpiPage />) },
            { path: "/toiv/drama/:id", element: <ToivDramaDetailToCreateRedirect /> },
            // 永久重定向：旧六段工作区保留 project/section，进入单一创作台。
            { path: "/toiv/ws/:id/:section", element: <ToivWsToCreateRedirect /> },
            { path: "/toiv/ws/:id", element: <ToivWsToCreateRedirect /> },
            { path: "/toiv/ws", element: <ToivWsToCreateRedirect /> },
            // LibTV 使用单数 `/project` 作为项目库入口；直接渲染本地项目库，
            // 保留原始 URL，避免像素复刻时出现一次重定向造成的布局/加载闪烁。
            {
                path: "/projects/:projectId",
                element: <LocalAwareProjectRoute />,
            },
            { path: "/project/:projectId", element: <LegacyProjectAliasRoute /> },
            { path: "/project/:projectId/*", element: <LegacyProjectAliasRoute /> },
            {
                path: "/projects/:projectId/:view",
                element: <LocalAwareProjectRoute />,
            },
            {
                path: "/projects/:projectId/chapters/:chapterId",
                element: <LocalAwareProjectRoute />,
            },
            {
                path: "/projects/:projectId/workflow/:unitId/:stage",
                element: <LocalAwareProjectRoute />,
            },
        ],
    },
    { path: "*", element: fullScreenDeferred(<NotFound />) },
]);
