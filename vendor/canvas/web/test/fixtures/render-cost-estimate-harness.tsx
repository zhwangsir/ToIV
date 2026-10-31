import { useState } from "react";
import { createRoot } from "react-dom/client";
import { App, ConfigProvider } from "antd";
import zhCN from "antd/locale/zh_CN";

import { RenderCostEstimate } from "@/components/toiv/render-cost-estimate";
import { ShotRevisionInspector } from "@/components/toiv/shot-revision-inspector";
import { getAntThemeConfig } from "@/lib/app-theme";
import type { ToivRenderPipeline } from "@/services/toiv/client";
import { batchEstimate, shotEstimate } from "./render-estimate-fixtures";


declare global {
    interface Window {
        __d0Calls?: { kind: string; [key: string]: unknown }[];
        __d0Queue?: unknown[];
        __d0Pending?: { call: { kind: string; [key: string]: unknown }; resolve: (value: unknown) => void }[];
        __d0Stage?: string;
        __d0Keyframe?: boolean;
    }
}

const params = new URLSearchParams(window.location.search);
document.documentElement.classList.add("dark");
window.__d0Calls = [];
window.__d0Queue = [];
window.__d0Pending = [];

function BatchHarness() {
    const [open, setOpen] = useState(false);
    const [projectId, setProjectId] = useState("p1");
    const [accel, setAccel] = useState("off");
    const [pipeline, setPipeline] = useState<ToivRenderPipeline>("ref2va");
    const [revision, setRevision] = useState(0);
    return (
        <main style={{ width: 720, margin: "24px auto", padding: 20, border: "1px solid var(--border)", borderRadius: 12, background: "var(--card)" }}>
            <h1 style={{ marginTop: 0, fontSize: 18 }}>生成前确认</h1>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
                <label>项目
                    <select aria-label="项目" value={projectId} onChange={(event) => setProjectId(event.target.value)}>
                        <option value="p1">p1</option><option value="p2">p2</option>
                    </select>
                </label>
                <label>加速
                    <select aria-label="加速" value={accel} onChange={(event) => setAccel(event.target.value)}>
                        <option value="off">off</option><option value="turbo">turbo</option>
                    </select>
                </label>
                <label>管线
                    <select aria-label="管线" value={pipeline} onChange={(event) => setPipeline(event.target.value as ToivRenderPipeline)}>
                        <option value="ref2va">ref2va</option><option value="c">c</option>
                    </select>
                </label>
                <button onClick={() => setRevision((value) => value + 1)}>修改分镜</button>
                <button onClick={() => setOpen(true)}>打开整批确认</button>
            </div>
            {open && (
                <RenderCostEstimate
                    scope="batch"
                    projectId={projectId}
                    open={open}
                    accel={accel}
                    pipeline={pipeline}
                    detail={{ revision }}
                    onConfirm={() => window.__d0Calls?.push({ kind: "confirm", projectId })}
                    onCancel={() => setOpen(false)}
                    onStageFocus={(stage) => { window.__d0Stage = stage; }}
                    onKeyframeFocus={() => { window.__d0Keyframe = true; }}
                />
            )}
        </main>
    );
}

const baseShot = {
    id: "shot-1", idx: 1, status: "draft", scene: "雨夜", prompt: "旧提示", dialogue: "旧台词",
    duration_sec: 6, seam_to_next: "hardcut", render_mode: "video", video_model: "h3-shot",
    num_candidates: 3, ref_images: ["/character.png"], scene_images: ["/scene.png"],
    current_revision_id: "rev-1", image_url: "/frame-1.png",
};

function SingleHarness() {
    const [shot, setShot] = useState(baseShot);
    return (
        <main style={{ width: 360, margin: "24px auto", padding: 16, border: "1px solid var(--border)", borderRadius: 12, background: "var(--card)" }}>
            <h1 style={{ marginTop: 0, fontSize: 16 }}>镜头 #1</h1>
            <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                <button onClick={() => setShot((current) => ({ ...current, current_revision_id: "rev-2" }))}>更换修订</button>
                <button onClick={() => setShot((current) => ({ ...current, image_url: "/frame-2.png" }))}>更换关键帧</button>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10, fontSize: 12 }}>
                <ShotRevisionInspector
                    projectId="p1"
                    shot={shot}
                    shots={[shot]}
                    renderOptions={{ accel: "off", pipeline: "ref2va", video_model: shot.video_model, num_candidates: shot.num_candidates, ref_images: shot.ref_images, scene_images: shot.scene_images }}
                    onSaved={() => undefined}
                    onRender={(sid, options) => window.__d0Calls?.push({ kind: "render", sid, options })}
                    onKeyframeFocus={() => { window.__d0Keyframe = true; }}
                />
            </div>
        </main>
    );
}

createRoot(document.getElementById("root")!).render(
    <ConfigProvider locale={zhCN} theme={getAntThemeConfig(true)}>
        <App>
            <div style={{ minHeight: "100vh", background: "var(--background)" }}>
                {params.get("mode") === "single" ? <SingleHarness /> : <BatchHarness />}
            </div>
        </App>
    </ConfigProvider>,
);
