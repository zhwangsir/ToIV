import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { App, ConfigProvider } from "antd";
import zhCN from "antd/locale/zh_CN";
import { MemoryRouter, Route, Routes, useLocation, useNavigate, useSearchParams } from "react-router";

import { CreationStudioInspector } from "@/components/create/creation-studio-inspector";
import { CreationStudioSlotsProvider, useCreationStudioSlots } from "@/components/create/creation-studio-slots";
import { ShotRevisionInspector, shotInspectorPanelFromQuery } from "@/components/toiv/shot-revision-inspector";
import { getAntThemeConfig } from "@/lib/app-theme";
import { CanvasAssistantTurnView } from "@/pages/canvas/canvas-assistant-turn";
import type { AssistantTurn } from "@/services/api/agent-assistant";
import type { ToivDramaDetail, ToivDramaShot, ToivStageId, ToivStageStateValue } from "@/services/toiv/client";

import "@/pages/canvas/canvas-assistant-sidebar.css";

declare global {
    interface Window {
        __d1b2Calls?: { kind: string; [key: string]: unknown }[];
    }
}

document.documentElement.classList.add("dark");
window.__d1b2Calls = [];

const stageIds: ToivStageId[] = ["script", "assets", "storyboard", "generate", "voice", "timeline"];
const stageStates = Object.fromEntries(stageIds.map((id) => [id, {
    state: (id === "script" ? "pending_confirmation" : "draft") as ToivStageStateValue,
    ready: false,
    blockers: [],
}]));

const detail = {
    id: "project-1",
    title: "雨夜提案",
    status: "draft",
    stage_revision: 7,
    stage_states: stageStates,
} as ToivDramaDetail;

const shots: ToivDramaShot[] = [
    {
        id: "shot-1", idx: 1, status: "rendered", scene: "雨夜巷口", prompt: "霓虹映在积水里",
        dialogue: "你终于来了。", speaker: "林晚", camera: "缓慢推近", duration_sec: 6,
        characters: ["林晚"], render_mode: "video", seam_to_next: "hardcut",
        current_revision_id: "rev-1", candidates_digest: "digest-1",
        candidates: [
            { id: "candidate-a", status: "done", url: "", seed: 101, revision_id: "rev-1", qa: { verdict: "pass" } },
            { id: "candidate-b", status: "done", url: "", seed: 202, revision_id: "rev-1", qa: { verdict: "warn" } },
        ],
    } as ToivDramaShot,
    {
        id: "shot-2", idx: 2, status: "draft", scene: "便利店", prompt: "门口灯光亮起",
        dialogue: "别跟着我。", speaker: "林晚", camera: "固定", duration_sec: 5,
        characters: ["林晚"], render_mode: "video", seam_to_next: "hardcut",
        current_revision_id: "rev-2", candidates_digest: "digest-2",
        candidates: [{ id: "candidate-c", status: "done", url: "", seed: 303, revision_id: "rev-2" }],
    } as ToivDramaShot,
];

const turn: AssistantTurn = {
    turnId: "turn-d1b2",
    userText: "帮我准备下一步制作",
    selectedNodeIds: [],
    reply: "我整理了一份制作建议，请你逐项核对。",
    toolCalls: [],
    change: null,
    proposals: [],
    studioProposals: [{
        proposalId: "studio-proposal-1",
        kind: "studio_production",
        projectId: "project-1",
        summary: "雨夜巷口：请复核分镜、比较候选并确认渲染预估",
        warnings: ["两个候选尚未拍板", "预估不等于实际消耗"],
        source: { projectId: "project-1", stageRevision: 7, shotId: "shot-1", candidatesDigest: "digest-1" },
        nextActions: [
            { kind: "stage_review", stage: "storyboard", label: "复核分镜", section: "storyboard", requiresHuman: true },
            { kind: "render_estimate", shotId: "shot-1", label: "查看渲染预估", section: "shots", requiresHuman: true },
            { kind: "take_compare", shotId: "shot-1", candidateId: "candidate-a", label: "打开候选对比", section: "shots", requiresHuman: true },
            { kind: "take_compare", label: "缺镜头候选对比", section: "shots", requiresHuman: true },
            { kind: "stage_review", stage: "script", label: "不应出现的自动动作", section: "script", requiresHuman: false } as never,
        ],
    }],
    error: null,
    cancelled: false,
    createdAt: "2026-10-28T00:00:00.000Z",
};

function AssistantCard() {
    return (
        <main style={{ minHeight: "100vh", display: "flex", justifyContent: "flex-end", background: "var(--muted)" }}>
            <div className="canvas-assistant-panel" style={{ width: 420 }}>
                <div className="canvas-assistant-log">
                    <CanvasAssistantTurnView
                        turn={turn}
                        handledProposals={new Set()}
                        onLocate={() => {}}
                        onUndo={() => {}}
                        onRunProposal={() => {}}
                        onDismissProposal={() => {}}
                    />
                </div>
            </div>
        </main>
    );
}

function RegisterProject() {
    const slots = useCreationStudioSlots();
    const registerProject = slots?.registerProject;
    const clearProject = slots?.clearProject;
    useEffect(() => {
        registerProject?.(detail, async () => detail);
        return () => clearProject?.(detail.id);
    }, [registerProject, clearProject]);
    return null;
}

function DeepLinkPage() {
    const [searchParams] = useSearchParams();
    const navigate = useNavigate();
    const location = useLocation();
    const shotId = searchParams.get("shot") || "shot-1";
    const shot = shots.find((item) => item.id === shotId) ?? shots[0];
    const initialPanel = shotInspectorPanelFromQuery(searchParams.get("panel"));
    const setParams = (changes: Record<string, string>) => {
        const next = new URLSearchParams(searchParams);
        for (const [key, value] of Object.entries(changes)) next.set(key, value);
        navigate(`/create?${next.toString()}`);
    };
    return (
        <main style={{ minHeight: "100vh", padding: 16, background: "var(--background)", color: "var(--foreground)" }}>
            <RegisterProject />
            <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
                <button type="button" onClick={() => setParams({ shot: "shot-2" })}>切到镜头 2</button>
                <button type="button" onClick={() => setParams({ panel: "compare" })}>切到候选面板</button>
                <button type="button" onClick={() => setParams({ panel: "estimate" })}>切到预估面板</button>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "340px 360px", gap: 16, alignItems: "start" }}>
                <CreationStudioInspector projectId="project-1" section={searchParams.get("section")} />
                <aside data-testid="d1b2-shot-inspector" style={{ padding: 12, border: "1px solid var(--border)", borderRadius: 12, background: "var(--card)" }}>
                    <ShotRevisionInspector
                        projectId="project-1"
                        shot={shot}
                        shots={shots}
                        initialPanel={initialPanel ?? undefined}
                        onSaved={() => {}}
                        onRender={(sid) => window.__d1b2Calls?.push({ kind: "render", sid })}
                    />
                </aside>
            </div>
            <output data-testid="d1b2-url">{location.pathname}{location.search}</output>
        </main>
    );
}

createRoot(document.getElementById("root")!).render(
    <ConfigProvider locale={zhCN} theme={getAntThemeConfig(true)}>
        <App>
            <MemoryRouter initialEntries={[`${window.location.pathname}${window.location.search}`]}>
                <CreationStudioSlotsProvider>
                    <Routes>
                        <Route path="/create" element={<DeepLinkPage />} />
                        <Route path="*" element={<AssistantCard />} />
                    </Routes>
                </CreationStudioSlotsProvider>
            </MemoryRouter>
        </App>
    </ConfigProvider>,
);
