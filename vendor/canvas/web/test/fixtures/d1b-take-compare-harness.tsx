import { useState } from "react";
import { createRoot } from "react-dom/client";
import { App, ConfigProvider } from "antd";
import zhCN from "antd/locale/zh_CN";

import { ShotRevisionInspector } from "@/components/toiv/shot-revision-inspector";
import { getAntThemeConfig } from "@/lib/app-theme";
import type { ToivDramaShot } from "@/services/toiv/client";

declare global {
    interface Window {
        __d1bCalls?: { kind: string; [key: string]: unknown }[];
        __d1bStub?: { pickMode?: "ok" | "conflict" | "pending" };
        __d1bSavedCount?: number;
        __d1bRefreshedShot?: ToivDramaShot;
        __d1bPendingResolve?: () => void;
        __d1bSetShot?: (shot: ToivDramaShot) => void;
    }
}

const initialShot: ToivDramaShot = {
    id: "shot-b",
    idx: 2,
    status: "rendered",
    scene: "便利店",
    prompt: "雨夜霓虹",
    dialogue: "别跟着我",
    candidates_digest: "digest-1",
    candidates: [
        {
            id: "cand-a",
            url: "/media/neutral.mp4?candidate=a",
            seed: 101,
            status: "done",
            is_picked: true,
            video_model: "h3-neutral-a",
            pipeline: "ref2va",
            revision_id: "rev-a",
            job_id: "job-a",
            qa: { verdict: "pass", reason: "本地测试通过" },
        },
        {
            id: "cand-b",
            url: "/media/neutral.mp4?candidate=b",
            seed: 202,
            status: "done",
            is_picked: false,
            video_model: "h3-neutral-b",
            pipeline: "c",
            qa: { verdict: "warn", reason: "本地测试提示" },
        },
        {
            id: "cand-error",
            seed: 303,
            status: "error",
            is_picked: false,
            error: "本地产物缺失",
        },
        {
            id: "cand-queued",
            seed: 404,
            status: "queued",
            is_picked: false,
            db_job_id: "db-job-queued",
        },
    ],
};

window.__d1bCalls = [];
window.__d1bSavedCount = 0;
window.__d1bStub = { pickMode: "ok" };

document.documentElement.classList.add("dark");

function Harness() {
    const [shot, setShot] = useState(initialShot);
    window.__d1bSetShot = setShot;
    return (
        <main style={{ minHeight: "100vh", padding: 16, background: "var(--background)" }}>
            <aside
                data-testid="d1b-inspector"
                style={{ width: 360, marginLeft: "auto", border: "1px solid var(--border)", borderRadius: 12, background: "var(--card)", padding: 12 }}
            >
                <ShotRevisionInspector
                    projectId="p1"
                    shot={shot}
                    shots={[shot]}
                    onSaved={() => {
                        window.__d1bSavedCount = (window.__d1bSavedCount ?? 0) + 1;
                        if (window.__d1bRefreshedShot) setShot(window.__d1bRefreshedShot);
                    }}
                />
            </aside>
        </main>
    );
}

createRoot(document.getElementById("root")!).render(
    <ConfigProvider locale={zhCN} theme={getAntThemeConfig(true)}>
        <App>
            <Harness />
        </App>
    </ConfigProvider>,
);
