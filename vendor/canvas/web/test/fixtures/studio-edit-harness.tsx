import { createRoot } from "react-dom/client";
import { StudioShell } from "@/studio/shell/StudioShell";
import { EditFace } from "@/studio/faces/edit/EditFace";
import { useStudioToast } from "@/studio/ui/toast-store";
import type { EditModel } from "@/studio/faces/edit/model";
import "@/studio/studio.css";

const model: EditModel = {
    projectId: "p1",
    projectName: "草船借箭",
    totalSec: 7.5,
    hasBgm: false,
    shots: [
        { id: "sh1", title: "镜01", durationSec: 4.5, status: "done", stillSeed: 88213 },
        { id: "sh2", title: "镜02", durationSec: 3, status: "done", stillSeed: 40122 },
    ],
    clips: [
        { id: "v1", label: "SHOT01 · 4.5s", track: "v1", startSec: 0, durationSec: 4.5, kind: "video", status: "done" },
        { id: "v2", label: "SHOT02 · 3.0s", track: "v1", startSec: 4.5, durationSec: 3, kind: "video", status: "done" },
        { id: "a1", label: "对白 · 镜01", track: "a1", startSec: 0, durationSec: 4.5, kind: "dialogue", status: "done" },
    ],
};

createRoot(document.getElementById("root")!).render(
    <StudioShell face="edit" projectLabel="草船借箭 / 成片剪辑" runningCount={0}
        onFaceChange={() => {}}>
        <EditFace model={model} onResult={(text, warn) => useStudioToast.getState().push(text, warn)} />
    </StudioShell>,
);
