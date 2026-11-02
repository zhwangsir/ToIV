import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { I18nProvider } from "@/i18n/context";
import ProjectHome from "@/toiv/addons/ProjectHome";
import { TaskCenterProvider } from "@/toiv/addons/TaskCenterProvider";
import AssetsHub from "@/toiv/pages/AssetsHub";
import CanvasHub from "@/toiv/pages/CanvasHub";
import ToivShell from "@/toiv/shell/ToivShell";

declare global {
    interface Window { __loc: string; }
}

function LocationProbe() {
    const location = useLocation();
    window.__loc = location.pathname + location.search;
    return null;
}

const path = new URLSearchParams(window.location.search).get("path") || "/";
createRoot(document.getElementById("root")!).render(
    <MemoryRouter initialEntries={[path]}>
        <I18nProvider>
            <TaskCenterProvider>
                <LocationProbe />
                <Routes>
                    <Route path="/" element={<ProjectHome />} />
                    <Route path="/studio" element={<ProjectHome />} />
                    <Route path="/drama" element={<CanvasHub />} />
                    <Route path="/edit-library" element={<ProjectHome face="edit" />} />
                    <Route path="/drama/assets" element={<AssetsHub />} />
                    <Route path="*" element={<ToivShell><h1>项目上下文</h1></ToivShell>} />
                </Routes>
            </TaskCenterProvider>
        </I18nProvider>
    </MemoryRouter>,
);
