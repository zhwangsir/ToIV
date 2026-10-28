import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";

import TasksPage from "@/pages/toiv/tasks-page";

createRoot(document.getElementById("root")!).render(
    <MemoryRouter initialEntries={["/tasks"]}>
        <TasksPage />
    </MemoryRouter>,
);
