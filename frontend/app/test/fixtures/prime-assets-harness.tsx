import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { I18nProvider } from "../../src/i18n";
import PrimeAssets from "../../src/toiv/pages/PrimeAssets";
import { applyStoredAppearance } from "../../src/toiv/theme/appearance";

declare global {
    interface Window { __loc: string; }
}

function LocationProbe() {
    const location = useLocation();
    window.__loc = location.pathname + location.search;
    return null;
}
function ShotStub() {
    const location = useLocation();
    return <p>镜头页 {location.pathname}{location.search}</p>;
}

const path = new URLSearchParams(window.location.search).get("path") || "/drama/projects/p1/assets";
applyStoredAppearance();

createRoot(document.getElementById("root")!).render(
    <MemoryRouter initialEntries={[path]}>
        <I18nProvider>
            <LocationProbe />
            <Routes>
                <Route path="/drama/projects/:projectId/assets" element={<PrimeAssets />} />
                <Route path="/studio/:id" element={<ShotStub />} />
                <Route path="*" element={<p>导航目标</p>} />
            </Routes>
        </I18nProvider>
    </MemoryRouter>,
);
