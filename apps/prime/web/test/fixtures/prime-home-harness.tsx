import { createRoot } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";
import { I18nProvider } from "@/i18n/context";
import ProjectHome from "@/toiv/addons/ProjectHome";

declare global {
    interface Window { __loc: string; }
}

function LocationProbe() {
    window.__loc = useLocation().pathname;
    return null;
}

createRoot(document.getElementById("root")!).render(
    <MemoryRouter initialEntries={["/"]}>
        <I18nProvider>
            <LocationProbe />
            <ProjectHome />
        </I18nProvider>
    </MemoryRouter>,
);
