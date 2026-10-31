import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import PrimeSettings from "@/toiv/pages/PrimeSettings";
import { applyStoredTheme } from "@/toiv/theme/apply";

applyStoredTheme();

createRoot(document.getElementById("root")!).render(
    <MemoryRouter initialEntries={["/settings"]}>
        <PrimeSettings />
        <div className="toiv-canvas-flow" data-testid="canvas-probe" style={{ position: "relative", inset: "auto", height: 96, margin: 24 }}>
            <div className="react-flow__node selected">
                <div className="toiv-node">场景</div>
            </div>
        </div>
    </MemoryRouter>,
);
