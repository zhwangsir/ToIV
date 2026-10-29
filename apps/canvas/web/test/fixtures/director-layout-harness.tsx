import { useState } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { App as AntApp } from "antd";

import CreationWorkbenchPage from "@/pages/create/creation-workbench";
import { CreationStudioPreviewTimeline } from "@/components/create/creation-studio-preview-timeline";
import { CreationStudioThreePane } from "@/components/create/creation-studio-three-pane";

const params = new URLSearchParams(window.location.search);
document.documentElement.classList.toggle("dark", !params.has("light"));

function App() {
    const [inspectorVisible, setInspectorVisible] = useState(false);
    return (
        <main className="toiv-creation-workbench" style={{ height: "100vh" }}>
            <CreationStudioThreePane
                inspectorVisible={inspectorVisible}
                onToggleInspector={() => setInspectorVisible((current) => !current)}
                rail={<div style={{ padding: 16 }}>项目与资产</div>}
                stage={<div style={{ padding: 24 }}>导演主舞台</div>}
                inspector={<div style={{ padding: 16 }}>镜头参数</div>}
            />
            <CreationStudioPreviewTimeline />
        </main>
    );
}

createRoot(document.getElementById("root")!).render(
    params.has("view")
        ? <MemoryRouter initialEntries={[{ pathname: "/create", search: window.location.search }]}><AntApp><CreationWorkbenchPage /></AntApp></MemoryRouter>
        : <App />,
);
