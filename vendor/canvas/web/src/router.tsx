import { lazy, Suspense, useEffect, type ReactNode } from "react";
import { Navigate, Outlet, useLocation, useParams, useSearchParams } from "react-router";

import { createWorkspaceRouter } from "@/lib/app-routing";
import { FullScreenLoader, WorkspaceRouteLoader } from "@/components/ui/aceternity/full-screen-loader";
import { loadAgentsPage, loadHomePage, loadProjectDetailPage } from "@/lib/workspace-route-modules";
import { CanvasRefreshShell } from "@/pages/canvas/canvas-refresh-shell";
import RouteErrorPage from "@/pages/route-error";
import { isLocalWorkspaceMode } from "@/services/workspace-mode";
import { StudioAgentsRoute, StudioDramaRoute, StudioKpiRoute, StudioLibraryRoute, StudioMarketRoute, StudioPluginsEagleRoute, StudioPluginsRoute, StudioSettingsRoute, StudioTasksRoute } from "@/studio/routes/studio-legacy-host-route";

const AgentsPage = lazy(loadAgentsPage);
const MediaLibraryPage = lazy(() => import("@/pages/library/media-library-page"));
const HomePage = lazy(loadHomePage);
/** COSMOS_SEED：Desktop 页源码保留（pages/desktop、components/desktop）；W6 默认路由不可达，见 docs/COSMOS_APP_SHELL_SEED.md */
const StudioCanvasRoute = lazy(() => import("@/studio/routes/studio-canvas-route"));
/** COSMOS/W6：creation 路由源码保留（studio-create-route）；用户面已 RetireCreateToPrime */
const StudioEditRoute = lazy(() => import("@/studio/routes/studio-edit-route"));
const StudioCanvasProjectRoute = lazy(() => import("@/studio/routes/studio-canvas-project-route"));

const NotFound = lazy(() => import("@/pages/not-found"));
const ToivTasksPage = lazy(() => import("@/pages/toiv/tasks-page"));
const ToivMarketPage = lazy(() => import("@/pages/toiv/market-page"));
const ToivLibraryDetailPage = lazy(() => import("@/pages/toiv/library-detail"));
const ToivDramaPage = lazy(() => import("@/pages/toiv/drama-page"));
const ToivKpiPage = lazy(() => import("@/pages/toiv/kpi-page"));
const ProjectDetailPage = lazy(loadProjectDetailPage);
const SettingsPage = lazy(() => import("@/pages/settings"));
const UserLayout = lazy(() => import("@/layouts/user-layout"));
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

/** W6：旧创作入口整页收口到公网 Prime `/studio`（保留/合并 query；勿用 basename 内 Navigate）。 */
function RetireCreateToPrime({ extra }: { extra?: Record<string, string | undefined> } = {}) {
    const [searchParams] = useSearchParams();
    const next = new URLSearchParams(searchParams);
    if (extra) {
        for (const [k, v] of Object.entries(extra)) {
            if (v) next.set(k, v);
        }
    }
    next.delete("classic");
    const qs = next.toString();
    const href = `/studio${qs ? `?${qs}` : ""}`;
    useEffect(() => {
        window.location.replace(href);
    }, [href]);
    return <FullScreenLoader label="正在进入工作台" detail="旧创作入口已收口到 Prime" />;
}

/** W2 F2 / W6: classic /toiv/drama/:id → Prime /studio?project=:id */
function ToivDramaDetailToCreateRedirect() {
    const { id } = useParams();
    return <RetireCreateToPrime extra={{ project: id }} />;
}

/** R11 / W6: 孤面 → Prime /studio */
function ToivWsToCreateRedirect() {
    const { id, section } = useParams();
    return <RetireCreateToPrime extra={{ project: id, section }} />;
}

/** R12① / W6: /toiv/runs/:id → Prime /studio?run=:id */
function ToivRunToCreateRedirect() {
    const { id } = useParams();
    return <RetireCreateToPrime extra={{ run: id }} />;
}

/** R12② / W6: /create/* → Prime /studio */
function CreateSubpathRedirect() {
    return <RetireCreateToPrime />;
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
    // W6：/create 用户面收口 Prime（StudioCreateRoute 源码保留，禁接回默认）
    { path: "/create", element: <RetireCreateToPrime /> },
    { path: "/edit", element: deferred(<StudioEditRoute />) },
    { path: "/canvas", element: deferred(<StudioCanvasRoute />) },
    { path: "/projects", element: deferred(<StudioCanvasRoute />) },
    { path: "/project", element: deferred(<StudioCanvasRoute />) },
    { path: "/canvas/:id", element: deferred(<StudioCanvasProjectRoute />) },
    { path: "/library", element: deferred(<StudioLibraryRoute />) },
    { path: "/tasks", element: deferred(<StudioTasksRoute />) },
    { path: "/settings", element: deferred(<StudioSettingsRoute />) },
    { path: "/home", element: deferred(<HomePage />) },
    { path: "/toiv/drama", element: deferred(<StudioDramaRoute />) },
    { path: "/toiv/market", element: deferred(<StudioMarketRoute />) },
    { path: "/agents", element: deferred(<StudioAgentsRoute />) },
    { path: "/toiv/kpi", element: deferred(<StudioKpiRoute />) },
    { path: "/plugins", element: deferred(<StudioPluginsRoute />) },
    { path: "/plugins/eagle", element: deferred(<StudioPluginsEagleRoute />) },
    {
        element: <WorkspaceLayout />,
        errorElement: <RouteErrorPage />,
        children: [
            // W6：默认落地降级 Home（勿 Retire→/studio，避免 canvas 自环）；/create* 才整页收口 Prime
            { path: "/", element: deferred(<HomePage />) },
            // W6 F12/退役：/desktop* 默认不可达 → Prime /studio（源码保留作 Cosmos 种子，禁接回默认交付）
            { path: "/desktop", element: <RetireCreateToPrime /> },
            { path: "/desktop/store", element: <RetireCreateToPrime /> },
            { path: "/desktop/legacy-home", element: <RetireCreateToPrime /> },
            { path: "/desktop/*", element: <RetireCreateToPrime /> },
            { path: "/create/*", element: <CreateSubpathRedirect /> },
            { path: "/library/works/:id", element: deferred(<ToivLibraryDetailPage />) },
            { path: "/assets", element: <AssetsLegacyRedirect /> },
            { path: "/toiv/library", element: <Navigate to="/library?source=works" replace /> },
            { path: "/toiv/library/:id", element: <ToivLibraryDetailRedirect /> },
            { path: "/skills", element: <RetireCreateToPrime /> },
            { path: "/skill", element: <RetireCreateToPrime /> },
            { path: "/skills/reference", element: <RetireCreateToPrime /> },
            { path: "/toiv/tasks", element: <Navigate to="/tasks" replace /> },
            { path: "/toiv/agent", element: <RetireCreateToPrime /> },
            { path: "/toiv/runs/:id", element: <ToivRunToCreateRedirect /> },
            { path: "/toiv/audio", element: <Navigate to="/toiv/market" replace /> },
            { path: "/toiv/image-tools", element: <Navigate to="/toiv/market" replace /> },
            { path: "/toiv/video-tools", element: <Navigate to="/toiv/market" replace /> },
            { path: "/toiv/dub-tools", element: <Navigate to="/toiv/market" replace /> },
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
