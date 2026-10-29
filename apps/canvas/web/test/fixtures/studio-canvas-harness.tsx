import { createRoot } from "react-dom/client";
import { StudioShell } from "@/studio/shell/StudioShell";
import { CanvasHomeFace } from "@/studio/faces/canvas/CanvasHomeFace";
import { useStudioToast } from "@/studio/ui/toast-store";
import type { CanvasHomeModel } from "@/studio/faces/canvas/model";
import "@/studio/studio.css";

declare global {
    interface Window { __openIds: string[]; }
}
window.__openIds = [];

const model: CanvasHomeModel = {
    empty: false,
    cards: [
        { id: "p1", title: "草船借箭", status: "active", stillSeed: 0, shotCount: 6 },
        { id: "p2", title: "小蝌蚪找妈妈", status: "draft", stillSeed: 2, shotCount: 0 },
    ],
};

createRoot(document.getElementById("root")!).render(
    <StudioShell face="canvas" projectLabel="项目库" runningCount={0} onOpenTasks={() => {}} onFaceChange={() => {}}>
        <CanvasHomeFace model={model}
            onOpen={(id) => window.__openIds.push(id)}
            onCreate={() => useStudioToast.getState().push("新建项目入口在 Plan 3b 接创建向导", true)} />
    </StudioShell>,
);
