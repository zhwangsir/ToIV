import { lazy, Suspense, useEffect, useState } from "react";
import { BrowserRouter, Navigate, Route, Routes, useParams } from "react-router-dom";
import ProjectHome from "../toiv/addons/ProjectHome";
import { RequireSession, ToivLoginPage, storeToken } from "../toiv/auth/session";
import LegacyHandoff from "./addons/LegacyHandoff";

const PrimeStoryboard = lazy(() => import("./pages/PrimeStoryboard"));
const PrimeEditor = lazy(() => import("./pages/PrimeEditor"));
const PrimeCanvas = lazy(() => import("./pages/PrimeCanvas"));
const PrimeAssets = lazy(() => import("./pages/PrimeAssets"));
const PrimeHistory = lazy(() => import("./pages/PrimeHistory"));
const PrimeCreate = lazy(() => import("./pages/PrimeCreate"));
const PrimeStyle = lazy(() => import("./pages/PrimeStyle"));
const PrimeSettings = lazy(() => import("./pages/PrimeSettings"));

export const PRIME_ROUTES = [
    "/", "/studio", "/studio/new", "/studio/:id", "/studio/:id/style", "/studio/:id/editor",
    "/drama", "/drama/assets", "/drama/projects/:projectId/canvas", "/drama/projects/:projectId/assets",
    "/history", "/settings", "/auth", "/legacy/canvas/:id",
];

function LegacyCanvas() {
    const { id } = useParams();
    return <LegacyHandoff title="画布编辑器" href={`/canvas/${encodeURIComponent(id!)}`} note="已有画布保留在原工作台，独立入口就绪后可在这里打开。" />;
}

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
        <BrowserRouter basename={import.meta.env?.BASE_URL || "/"}>
            <Suspense fallback={<p role="status">正在加载工作面…</p>}>
            <Routes>
                <Route path="/" element={<RequireSession><ProjectHome /></RequireSession>} />
                <Route path="/studio" element={<RequireSession><ProjectHome /></RequireSession>} />
                <Route path="/auth" element={<ToivLoginPage />} />
                <Route path="/studio/new" element={<RequireSession><PrimeCreate /></RequireSession>} />
                <Route path="/studio/:id/style" element={<RequireSession><PrimeStyle /></RequireSession>} />
                <Route path="/studio/:id/editor" element={<RequireSession><PrimeEditor /></RequireSession>} />
                <Route path="/studio/:id" element={<RequireSession><PrimeStoryboard /></RequireSession>} />
                <Route path="/drama" element={<RequireSession><ProjectHome face="canvas" /></RequireSession>} />
                <Route path="/drama/projects/:projectId/canvas" element={<RequireSession><PrimeCanvas /></RequireSession>} />
                <Route path="/drama/assets" element={<RequireSession><ProjectHome face="canvas" openHref={(card) => (card.source === "canvas" ? `/legacy/canvas/${card.id}` : `/drama/projects/${card.id}/assets`)} /></RequireSession>} />
                <Route path="/drama/projects/:projectId/assets" element={<RequireSession><PrimeAssets /></RequireSession>} />
                <Route path="/legacy/canvas/:id" element={<RequireSession><LegacyCanvas /></RequireSession>} />
                <Route path="/assets" element={<Navigate to="/drama/assets" replace />} />
                <Route path="/history" element={<RequireSession><PrimeHistory /></RequireSession>} />
                <Route path="/settings" element={<RequireSession><PrimeSettings /></RequireSession>} />
                <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
            </Suspense>
        </BrowserRouter>
    );
}
