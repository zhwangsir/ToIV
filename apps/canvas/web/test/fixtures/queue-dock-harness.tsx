import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";

import { CreationStudioQueueDock } from "@/components/create/creation-studio-queue-dock";

const params = new URLSearchParams(window.location.search);
document.documentElement.classList.toggle("dark", !params.has("light"));
createRoot(document.getElementById("root")!).render(
    <MemoryRouter initialEntries={["/create"]}>
        <div style={{ width: 420, marginLeft: 720, padding: 16 }}><CreationStudioQueueDock /></div>
    </MemoryRouter>,
);
