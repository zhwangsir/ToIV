import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { I18nProvider } from "@/i18n/context";
import PrimeToolRun from "@/toiv/pages/PrimeToolRun";
import PrimeTools from "@/toiv/pages/PrimeTools";
import { applyStoredAppearance } from "@/toiv/theme/appearance";

declare global {
    interface Window { __loc: string; }
}

function LocationProbe() {
    const location = useLocation();
    window.__loc = location.pathname;
    return null;
}

const path = new URLSearchParams(window.location.search).get("path") || "/tools";
applyStoredAppearance();

createRoot(document.getElementById("root")!).render(
    <MemoryRouter initialEntries={[path]}>
        <I18nProvider>
            <LocationProbe />
            <Routes>
                <Route path="/tools" element={<PrimeTools />} />
                <Route path="/tools/:id" element={<PrimeToolRun />} />
                <Route path="*" element={<p>导航目标</p>} />
            </Routes>
        </I18nProvider>
    </MemoryRouter>,
);
