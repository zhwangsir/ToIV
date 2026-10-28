import { App, ConfigProvider } from "antd";
import zhCN from "antd/locale/zh_CN";
import { createRoot } from "react-dom/client";
import { Link, MemoryRouter, useLocation } from "react-router";

import { CreationStudioQueueDock } from "@/components/create/creation-studio-queue-dock";
import { getAntThemeConfig } from "@/lib/app-theme";
import TasksPage from "@/pages/toiv/tasks-page";

const params = new URLSearchParams(window.location.search);
const view = params.get("view") === "tasks" ? "tasks" : "dock";
const race = params.has("race");
if (race) (window as unknown as { __d1aRequests: unknown[] }).__d1aRequests = [];
document.documentElement.classList.add("dark");

function DockHarness() {
    const { search } = useLocation();
    if (race) {
        (window as unknown as { __d1aProject: string }).__d1aProject = new URLSearchParams(search).get("project") || "p1";
    }
    return (
        <main style={{ minHeight: "100vh", padding: 24, background: "var(--background)" }}>
            {race ? <nav><Link data-testid="race-p1" to="/create?project=p1">p1</Link><Link data-testid="race-p2" to="/create?project=p2">p2</Link></nav> : null}
            <div style={{ width: 420, marginLeft: 720 }}><CreationStudioQueueDock /></div>
        </main>
    );
}

createRoot(document.getElementById("root")!).render(
    <ConfigProvider locale={zhCN} theme={getAntThemeConfig(true)}>
        <App>
            <MemoryRouter initialEntries={[view === "tasks" ? "/tasks" : "/create?project=p1"]}>
                {view === "tasks" ? <TasksPage /> : <DockHarness />}
            </MemoryRouter>
        </App>
    </ConfigProvider>,
);
