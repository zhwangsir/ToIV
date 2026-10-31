import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { I18nProvider } from "@/i18n/context";
import PrimeCanvas from "@/toiv/pages/PrimeCanvas";

declare global {
    interface Window { __loc: string; }
}

function LocationProbe() {
    const location = useLocation();
    window.__loc = location.pathname + location.search;
    return null;
}

const path = new URLSearchParams(window.location.search).get("path") || "/drama/projects/p1/canvas";
createRoot(document.getElementById("root")!).render(
    <MemoryRouter initialEntries={[path]}>
        <I18nProvider>
            <LocationProbe />
            <Routes>
                <Route path="/drama/projects/:projectId/canvas" element={<PrimeCanvas />} />
                <Route path="*" element={<p>导航目标</p>} />
            </Routes>
        </I18nProvider>
    </MemoryRouter>,
);
