import { useState } from "react";
import { createRoot } from "react-dom/client";

import { CreationStudioStoryboardFlow } from "@/components/create/creation-studio-storyboard-flow";
import type { ToivDramaShot } from "@/services/toiv/client";

const params = new URLSearchParams(window.location.search);
document.documentElement.classList.toggle("dark", !params.has("light"));
const image = (color: string) => `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='640' height='360'%3E%3Crect width='100%25' height='100%25' fill='%23${color}'/%3E%3C/svg%3E`;
const shots: ToivDramaShot[] = [
    { id: "s1", idx: 1, status: "rendered", scene: "雨夜天台", camera: "中景 · 缓慢推镜", speaker: "林遥", dialogue: "你早就知道我会回来。", duration_sec: 6, image_url: image("263449"), video_url: image("182636"), seam_to_next: "match_cut" },
    { id: "s2", idx: 2, status: "generating", scene: "便利店门口", camera: "近景 · 手持", prompt: "两个人隔着雨水对视，霓虹映在玻璃上。", duration_sec: 4, image_url: image("303b45") },
    { id: "s3", idx: 3, status: "pending", scene: "末班车站", camera: "远景 · 固定", speaker: "旁白", dialogue: "城市的最后一盏灯熄灭之前。", duration_sec: 5 },
];

function App() {
    const [selectedShotId, setSelectedShotId] = useState<string | null>(null);
    const [scriptOpen, setScriptOpen] = useState(false);
    return <main style={{ width: "100%", background: "var(--toiv-bg)", minHeight: "100vh" }}>
        {scriptOpen ? <p role="status">剧本解析已打开</p> : <CreationStudioStoryboardFlow
            shots={params.has("empty") ? [] : shots}
            selectedShotId={selectedShotId}
            onSelectShot={setSelectedShotId}
            onOpenScript={() => setScriptOpen(true)}
        />}
    </main>;
}

createRoot(document.getElementById("root")!).render(<App />);
