import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { I18nProvider } from "@/i18n/context";
import ProjectHome from "@/toiv/addons/ProjectHome";
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
            <LocationProbe />
            <Routes>
                <Route path="/" element={<ProjectHome />} />
                <Route path="/studio" element={<ProjectHome />} />
                <Route path="/drama" element={<ProjectHome face="canvas" />} />
                <Route path="/edit-library" element={<ProjectHome face="edit" />} />
                <Route path="/drama/assets" element={<ProjectHome face="canvas" openHref={(card) => card.source === "canvas" ? `/legacy/canvas/${card.id}` : `/drama/projects/${card.id}/assets`} />} />
                <Route path="*" element={<ToivShell><h1>项目上下文</h1></ToivShell>} />
            </Routes>
        </I18nProvider>
    </MemoryRouter>,
);
