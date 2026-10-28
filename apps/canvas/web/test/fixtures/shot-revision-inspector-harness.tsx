import { createRoot } from "react-dom/client";
import { App, ConfigProvider } from "antd";
import zhCN from "antd/locale/zh_CN";

import { ShotRevisionInspector } from "@/components/toiv/shot-revision-inspector";
import { getAntThemeConfig } from "@/lib/app-theme";

declare global {
    interface Window {
        __toivStub?: {
            saveMode?: "ok" | "conflict";
            revisions?: unknown[];
            diff?: unknown;
        };
        __toivCalls?: { kind: string; [key: string]: unknown }[];
        __savedCount?: number;
    }
}

const params = new URLSearchParams(window.location.search);
// 与生产 AppProviders 同一暗色主题:ConfigProvider(getAntThemeConfig(true)) + html.dark + 完整 CSS 链。
document.documentElement.classList.toggle("dark", !params.has("light"));

window.__toivCalls = [];
window.__savedCount = 0;
window.__toivStub = {
    saveMode: "ok",
    revisions: [
        {
            id: "rev-b2",
            version: 2,
            source: "manual-edit",
            parent_id: "rev-b1",
            visual_fingerprint: "vf2",
            audio_fingerprint: "af1",
            created_by: "u1",
            created_at: "2026-10-26T10:00:00",
        },
        {
            id: "rev-b1",
            version: 1,
            source: "imported",
            parent_id: "",
            visual_fingerprint: "vf1",
            audio_fingerprint: "af1",
            created_by: "u1",
            created_at: "2026-10-25T09:00:00",
        },
    ],
    diff: {
        revision_id: "rev-b2",
        version: 2,
        source: "manual-edit",
        from_version: 1,
        from_unknown: false,
        fields: {
            scene: { from: "便利店门口", to: "便利店" },
            prompt: { from: "雨夜霓虹旧稿", to: "雨夜霓虹" },
        },
    },
};

const shots = [
    {
        id: "shot-a", idx: 1, status: "rendered", scene: "天台", prompt: "a 提示语",
        dialogue: "", speaker: "", camera: "", duration_sec: 5, characters: [],
        render_mode: "video", seam_to_next: "hardcut",
        current_revision_id: "rev-a1", visual_media_status: "current", audio_media_status: "none",
    },
    {
        // final stale:已有 final_clip 但视频/配音输入已落后 → 成片待重合成 + 重对口型入口
        id: "shot-b", idx: 2, status: "voiced", scene: "便利店", prompt: "雨夜霓虹",
        dialogue: "别跟着我", speaker: "林晚", camera: "推近", duration_sec: 6,
        characters: ["林晚"], render_mode: "video", seam_to_next: "hardcut",
        video_url: "/v.mp4", voice_url: "/old.wav", final_clip_url: "/f.mp4",
        current_revision_id: "rev-b2", rendered_revision_id: "rev-b1", voiced_revision_id: "rev-b1",
        visual_media_status: "stale", audio_media_status: "stale", final_media_status: "stale",
    },
    {
        // 普通已配音镜(非 final stale):走 legacy 对口型路径,覆盖 parent 真实分支
        id: "shot-d", idx: 4, status: "voiced", scene: "巷口", prompt: "d 提示语",
        dialogue: "你先走", speaker: "陈默", camera: "", duration_sec: 5,
        characters: ["陈默"], render_mode: "video", seam_to_next: "hardcut",
        video_url: "/d.mp4", voice_url: "/d.wav",
        current_revision_id: "rev-d1", visual_media_status: "current",
        audio_media_status: "current", final_media_status: "none",
    },
    {
        id: "shot-c", idx: 3, status: "draft", scene: "车站", prompt: "c 提示语",
        dialogue: "c 台词", speaker: "", camera: "", duration_sec: 4, characters: [],
        render_mode: "video", seam_to_next: "hardcut",
    },
];

const selected = shots[1];

function InspectorAside({ shot, testId }: { shot: (typeof shots)[number]; testId: string }) {
    return (
        <aside
            data-testid={testId}
            style={{ width: 320, flexShrink: 0, borderRadius: 12, border: "1px solid var(--border, #26262e)", background: "var(--card, #141419)", padding: 12 }}
        >
            <p style={{ margin: "0 0 8px", fontSize: 14, fontWeight: 600, color: "var(--foreground, #f2f2f5)" }}>镜头 #{shot.idx}</p>
            <ShotRevisionInspector
                projectId="p1"
                shot={shot}
                shots={shots}
                makeupReady
                onSaved={() => {
                    window.__savedCount = (window.__savedCount ?? 0) + 1;
                }}
                onRender={(sid) => {
                    window.__toivCalls?.push({ kind: "render", sid });
                }}
                onVoice={(sid) => {
                    window.__toivCalls?.push({ kind: "voice", sid });
                }}
                onLipsync={(sid) => {
                    window.__toivCalls?.push({ kind: "lipsync", sid });
                }}
                onSkipLipsync={(sid) => {
                    window.__toivCalls?.push({ kind: "skip", sid });
                }}
            />
        </aside>
    );
}

createRoot(document.getElementById("root")!).render(
    <ConfigProvider locale={zhCN} theme={getAntThemeConfig(true)}>
        <App>
            {/* 模拟 Freezone 工作台右栏:生成列表留白 + 320px Inspector(与 drama-workspace lg:w-80 同量级) */}
            <div style={{ display: "flex", alignItems: "flex-start", gap: 16, padding: 16, minHeight: "100vh", background: "var(--background, #0b0b0f)" }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{ fontSize: 12, color: "var(--muted-foreground, #888)" }}>生成·配音·口型(列表区占位)</p>
                </div>
                <InspectorAside shot={selected} testId="inspector-aside" />
                <InspectorAside shot={shots[2]} testId="inspector-aside-normal" />
            </div>
        </App>
    </ConfigProvider>,
);
