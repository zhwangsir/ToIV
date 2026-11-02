import { lazy, Suspense, useEffect, useState } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import ProjectHome from "../toiv/addons/ProjectHome";
import { TaskCenterProvider } from "./addons/TaskCenterProvider";
import { RequireSession, ToivLoginPage, storeToken } from "../toiv/auth/session";

const CanvasHub = lazy(() => import("./pages/CanvasHub"));
const AssetsHub = lazy(() => import("./pages/AssetsHub"));
const PrimeStoryboard = lazy(() => import("./pages/PrimeStoryboard"));
const PrimeEditor = lazy(() => import("./pages/PrimeEditor"));
const PrimeCanvas = lazy(() => import("./pages/PrimeCanvas"));
const PrimeAssets = lazy(() => import("./pages/PrimeAssets"));
const PrimeLibrary = lazy(() => import("./pages/PrimeLibrary"));
const PrimeTasks = lazy(() => import("./pages/PrimeTasks"));
const PrimeCreate = lazy(() => import("./pages/PrimeCreate"));
const PrimeStyle = lazy(() => import("./pages/PrimeStyle"));
const PrimeSettings = lazy(() => import("./pages/PrimeSettings"));
const PrimeTools = lazy(() => import("./pages/PrimeTools"));
const PrimeToolRun = lazy(() => import("./pages/PrimeToolRun"));
const PrimeLegacyCanvas = lazy(() => import("./pages/PrimeLegacyCanvas"));


/** W6：旧 /create → Prime 首页 /（公网 /studio）；保留 query，勿默认 /studio/new。 */
function CreateToStudioRedirect() {
    const { search } = useLocation();
    return <Navigate to={{ pathname: "/", search }} replace />;
}

// 远端 Next 兜底把 /studio/ 重定向成 /studio，带尾斜杠的 basename 会整页不渲染
export function routerBasename(base: string | undefined): string {
    return (base || "").replace(/\/+$/, "") || "/";
}

export const PRIME_ROUTES = [
    "/", "/studio", "/studio/new", "/studio/:id", "/studio/:id/style", "/studio/:id/editor",
    "/drama", "/drama/assets", "/drama/projects/:projectId/canvas", "/drama/projects/:projectId/assets",
    "/tools", "/tools/:id", "/tasks", "/library", "/history", "/settings", "/auth", "/create", "/legacy/canvas/:id",
];

export default function ToivBootstrap() {
    const [ready, setReady] = useState(false);
    const [entryError, setEntryError] = useState(false);
    useEffect(() => {
        const url = new URL(window.location.href);
        const token = url.searchParams.get("miniapp_token");
        if (token) {
            url.searchParams.delete("miniapp_token");
            window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
            try { storeToken(token); } catch { setEntryError(true); }
        }
        setReady(true);
    }, []);
    if (!ready) return <p role="status">正在打开工作台…</p>;
    if (entryError) return <p role="alert">浏览器无法保存登录状态，请允许本站存储后重试。</p>;
    return (
        <BrowserRouter basename={routerBasename(import.meta.env?.BASE_URL)}>
            <TaskCenterProvider>
            <Suspense fallback={<p role="status">正在加载工作面…</p>}>
            <Routes>
                <Route path="/" element={<RequireSession><ProjectHome /></RequireSession>} />
                <Route path="/studio" element={<RequireSession><ProjectHome /></RequireSession>} />
                <Route path="/auth" element={<ToivLoginPage />} />
                <Route path="/create" element={<CreateToStudioRedirect />} />
                <Route path="/create/*" element={<CreateToStudioRedirect />} />
                <Route path="/studio/new" element={<RequireSession><PrimeCreate /></RequireSession>} />
                <Route path="/studio/:id/style" element={<RequireSession><PrimeStyle /></RequireSession>} />
                <Route path="/studio/:id/editor" element={<RequireSession><PrimeEditor /></RequireSession>} />
                <Route path="/studio/:id" element={<RequireSession><PrimeStoryboard /></RequireSession>} />
                <Route path="/drama" element={<RequireSession><CanvasHub /></RequireSession>} />
                <Route path="/drama/projects/:projectId/canvas" element={<RequireSession><PrimeCanvas /></RequireSession>} />
                <Route path="/drama/assets" element={<RequireSession><AssetsHub /></RequireSession>} />
                <Route path="/drama/projects/:projectId/assets" element={<RequireSession><PrimeAssets /></RequireSession>} />
                <Route path="/legacy/canvas/:id" element={<RequireSession><PrimeLegacyCanvas /></RequireSession>} />
                <Route path="/assets" element={<Navigate to="/drama/assets" replace />} />
                <Route path="/tools" element={<RequireSession><PrimeTools /></RequireSession>} />
                <Route path="/tools/:id" element={<RequireSession><PrimeToolRun /></RequireSession>} />
                <Route path="/tasks" element={<RequireSession><PrimeTasks /></RequireSession>} />
                <Route path="/library" element={<RequireSession><PrimeLibrary /></RequireSession>} />
                <Route path="/history" element={<Navigate to="/tasks" replace />} />
                <Route path="/settings" element={<RequireSession><PrimeSettings /></RequireSession>} />
                <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
            </Suspense>
            </TaskCenterProvider>
        </BrowserRouter>
    );
}
