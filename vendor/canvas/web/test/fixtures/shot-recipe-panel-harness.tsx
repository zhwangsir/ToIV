import { createRoot } from "react-dom/client";
import { App, ConfigProvider } from "antd";
import zhCN from "antd/locale/zh_CN";

import { ShotRevisionInspector } from "@/components/toiv/shot-revision-inspector";
import { getAntThemeConfig } from "@/lib/app-theme";

// C1b 配方 harness:真实 ShotRevisionInspector + ShotRecipePanel;client 由测试插件
// stub 成内存实现(可断言调用),删除走 App 上下文 modal(真实 antd Modal)。
declare global {
    interface Window {
        __recipeStub?: {
            applyMode?: "ok" | "conflict";
            importMode?: "ok" | "invalid";
        };
        __recipeCalls?: { kind: string; [key: string]: unknown }[];
        __applyRenderCalls?: { sid: string; params: unknown }[];
        __savedCount?: number;
    }
}

const params = new URLSearchParams(window.location.search);
document.documentElement.classList.toggle("dark", !params.has("light"));

window.__recipeCalls = [];
window.__applyRenderCalls = [];
window.__savedCount = 0;
window.__recipeStub = { applyMode: "ok", importMode: "ok" };

const shots = [
    {
        id: "shot-b", idx: 2, status: "voiced", scene: "便利店", prompt: "雨夜霓虹",
        dialogue: "别跟着我", speaker: "林晚", camera: "推近", duration_sec: 6,
        characters: ["林晚"], render_mode: "video", seam_to_next: "hardcut",
        video_url: "/v.mp4", voice_url: "/old.wav", final_clip_url: "/f.mp4",
        current_revision_id: "rev-b2", rendered_revision_id: "rev-b1",
        visual_media_status: "stale", audio_media_status: "stale", final_media_status: "stale",
    },
];

createRoot(document.getElementById("root")!).render(
    <ConfigProvider locale={zhCN} theme={getAntThemeConfig(true)}>
        <App>
            <div style={{ display: "flex", alignItems: "flex-start", gap: 16, padding: 16, minHeight: "100vh", background: "var(--background, #0b0b0f)" }}>
                <aside
                    data-testid="inspector-aside"
                    style={{ width: 320, flexShrink: 0, borderRadius: 12, border: "1px solid var(--border, #26262e)", background: "var(--card, #141419)", padding: 12 }}
                >
                    <ShotRevisionInspector
                        projectId="p1"
                        shot={shots[0]}
                        shots={shots}
                        makeupReady
                        onSaved={() => {
                            window.__savedCount = (window.__savedCount ?? 0) + 1;
                        }}
                        onApplyRender={(sid, p) => {
                            window.__applyRenderCalls?.push({ sid, params: p });
                        }}
                    />
                </aside>
            </div>
        </App>
    </ConfigProvider>,
);
