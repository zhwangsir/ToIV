import { createRoot } from "react-dom/client";

import { LightCurtainPaddle } from "@/components/content-mode/light-curtain-paddle";

const params = new URLSearchParams(window.location.search);
document.documentElement.classList.toggle("dark", !params.has("light"));
createRoot(document.getElementById("root")!).render(<div className="app-workspace-topbar-actions"><LightCurtainPaddle compact={params.has("compact")} /></div>);
