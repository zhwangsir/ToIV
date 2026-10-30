import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import ToivShell from "./shell/ToivShell";
import ComingSoon from "../components/ui/ComingSoon";
import ProjectHome from "../toiv/addons/ProjectHome";
import { RequireSession, ToivLoginPage } from "../toiv/auth/session";
import PrimeStoryboard from "./pages/PrimeStoryboard";
import PrimeEditor from "./pages/PrimeEditor";

export const PRIME_ROUTES = [
    "/", "/studio", "/studio/new", "/studio/:id", "/studio/:id/style", "/studio/:id/editor",
    "/drama", "/drama/assets", "/history", "/settings", "/tools", "/tools/:id", "/auth",
];

function Wip({ label }: { label: string }) {
    return (
        <ToivShell>
            <div className="toiv-wip"><ComingSoon label={label} /></div>
        </ToivShell>
    );
}

export default function ToivBootstrap() {
    return (
        <BrowserRouter>
            <Routes>
                <Route path="/" element={<ProjectHome />} />
                <Route path="/studio" element={<ProjectHome />} />
                <Route path="/auth" element={<ToivLoginPage />} />
                <Route path="/studio/new" element={<RequireSession><Wip label="W2 · 新建向导接线中" /></RequireSession>} />
                <Route path="/studio/:id/style" element={<RequireSession><Wip label="W2 · 场景锚点接线中" /></RequireSession>} />
                <Route path="/studio/:id/editor" element={<RequireSession><PrimeEditor /></RequireSession>} />
                <Route path="/studio/:id" element={<RequireSession><PrimeStoryboard /></RequireSession>} />
                <Route path="/drama" element={<RequireSession><Wip label="W3 · 画布接线中" /></RequireSession>} />
                <Route path="/drama/assets" element={<RequireSession><Wip label="W3 · 资产库接线中" /></RequireSession>} />
                <Route path="/history" element={<RequireSession><Wip label="W4 · 作品库接线中" /></RequireSession>} />
                <Route path="/settings" element={<RequireSession><Wip label="W4 · 设置接线中" /></RequireSession>} />
                <Route path="/tools" element={<RequireSession><Wip label="W4 · 工具中心接线中" /></RequireSession>} />
                <Route path="/tools/:id" element={<RequireSession><Wip label="W4 · 工具详情接线中" /></RequireSession>} />
                <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
        </BrowserRouter>
    );
}
