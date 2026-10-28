import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, useLocation, useNavigate, useSearchParams } from "react-router";
import { App, ConfigProvider } from "antd";
import zhCN from "antd/locale/zh_CN";

import { CreationStudioInspector } from "@/components/create/creation-studio-inspector";
import { CreationStudioSlotsProvider, useCreationStudioSlots } from "@/components/create/creation-studio-slots";
import { CreationStudioThreePane } from "@/components/create/creation-studio-three-pane";
import { StageBlockNotice } from "@/components/toiv/creation-stage-track";
import { firstBlockingStage } from "@/lib/studio-stage-progress";
import type { ToivDramaDetail, ToivStageId, ToivStageStateValue } from "@/services/toiv/client";
import { getAntThemeConfig } from "@/lib/app-theme";

declare global {
    interface Window {
        __toivStub?: {
            transitionMode?: "ok" | "conflict";
            batchMode?: "ok" | "conflict";
            revision: number;
            states: Record<string, ToivStageStateValue>;
            statesP2: Record<string, ToivStageStateValue>;
        };
        __wsStub?: { loadMode?: "ok" | "null" };
        __toivCalls?: { kind: string; [key: string]: unknown }[];
        __workspaceReloads?: number;
        __openStageCalls?: string[];
        __reloadProbe?: string;
    }
}

const params = new URLSearchParams(window.location.search);
// 与生产 AppProviders 同一暗色主题:ConfigProvider(getAntThemeConfig(true)) + html.dark + 完整 CSS 链。
document.documentElement.classList.toggle("dark", !params.has("light"));

window.__toivCalls = [];
window.__workspaceReloads = 0;
window.__openStageCalls = [];
window.__wsStub = { loadMode: "ok" };
window.__toivStub = {
    transitionMode: "ok",
    batchMode: "ok",
    revision: 3,
    states: {
        script: "pending_confirmation",
        assets: "draft",
        storyboard: "confirmed",
        generate: "needs_review",
        voice: "skipped",
        timeline: "draft",
    },
    // p2:首个阻断阶段是「生成」,与 p1(剧本)区分,验证 stageFocus 的 pid 隔离
    statesP2: {
        script: "confirmed",
        assets: "confirmed",
        storyboard: "confirmed",
        generate: "pending_confirmation",
        voice: "confirmed",
        timeline: "confirmed",
    },
};

function buildDetail(pid: string): ToivDramaDetail {
    const stub = window.__toivStub!;
    const states = pid === "p2" ? stub.statesP2 : stub.states;
    const stageStates = Object.fromEntries(
        (Object.keys(states) as ToivStageId[]).map((id) => [
            id,
            { state: states[id], ready: states[id] === "confirmed", blockers: [] },
        ]),
    );
    return {
        id: pid,
        title: pid === "p2" ? "雨夜 II" : "雨夜",
        status: "draft",
        stage_revision: stub.revision,
        stage_states: stageStates,
    } as ToivDramaDetail;
}

/** 模拟 drama-workspace:持有项目真源(p1/p2 可切),注册进 slots;真实卸载时 effect 清理 */
function FakeWorkspace({ onSwitchProject }: { onSwitchProject: (pid: string) => void }) {
    // 只取稳定回调(不依赖 slots 对象 identity,避免 register/clear 抖动)
    const registerProject = useCreationStudioSlots()?.registerProject;
    const clearProject = useCreationStudioSlots()?.clearProject;
    const requestStageFocus = useCreationStudioSlots()?.requestStageFocus;
    const [pid, setPid] = useState("p1");
    const [detail, setDetail] = useState<ToivDramaDetail>(() => buildDetail("p1"));
    const [batchBlock, setBatchBlock] = useState<{ message: string; stageId: ToivStageId | null } | null>(null);

    const load = useCallback(async (): Promise<ToivDramaDetail | null> => {
        window.__workspaceReloads = (window.__workspaceReloads ?? 0) + 1;
        if ((window.__wsStub ?? {}).loadMode === "null") return null;
        const next = buildDetail(pid);
        setDetail(next);
        return next;
    }, [pid]);

    // 注册/清理:与 drama-workspace 同纪律(卸载或项目切换时不得把旧真源留给 Inspector)
    useEffect(() => {
        registerProject?.(detail?.id === pid ? detail : null, load);
        return () => clearProject?.(pid);
    }, [registerProject, clearProject, pid, detail, load]);

    const runBatch = useCallback(async () => {
        window.__toivCalls?.push({ kind: "batch-render", pid });
        const stub = window.__toivStub ?? {};
        if (stub.batchMode === "conflict") {
            // 与 drama-workspace 同顺序:先刷新真源,再置阻断引导
            await load();
            setBatchBlock({ message: "批量渲染被阶段闸拦截:分镜阶段尚未确认", stageId: firstBlockingStage(buildDetail(pid)) });
            return;
        }
        setBatchBlock(null);
        await load();
    }, [load, pid]);

    const switchTo = (next: string) => {
        setPid(next);
        setDetail(buildDetail(next));
        onSwitchProject(next);
    };

    return (
        <div data-testid="fake-middle-stage">
            <p style={{ margin: "0 0 8px", fontSize: 12, color: "var(--muted-foreground, #888)" }}>中舞台 · 旧 StageRail 保留位</p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
                <button type="button" onClick={() => void runBatch()}>批量渲染</button>
                <button type="button" onClick={() => switchTo("p1")}>项目切换到 p1</button>
                <button type="button" onClick={() => switchTo("p2")}>项目切换到 p2</button>
                <button type="button" onClick={() => { window.__openStageCalls = [...(window.__openStageCalls ?? []), "focus:p1:storyboard"]; requestStageFocus?.("p1", "storyboard"); }}>聚焦p1·分镜</button>
                <button type="button" onClick={() => { window.__openStageCalls = [...(window.__openStageCalls ?? []), "focus:p2:storyboard"]; requestStageFocus?.("p2", "storyboard"); }}>聚焦p2·分镜</button>
            </div>
            {batchBlock && (
                <StageBlockNotice
                    message={batchBlock.message}
                    stageId={batchBlock.stageId}
                    onOpenStage={(stage) => { window.__openStageCalls = [...(window.__openStageCalls ?? []), `open:${stage}`]; requestStageFocus?.(pid, stage); }}
                />
            )}
        </div>
    );
}

/** 模拟 creation-workbench:真实 CreationStudioThreePane 壳,负责 inspector 开合 */
function Shell() {
    const slots = useCreationStudioSlots();
    const [searchParams] = useSearchParams();
    const location = useLocation();
    const navigate = useNavigate();
    const [inspectorOverride, setInspectorOverride] = useState<boolean | null>(false);
    const [workspaceMounted, setWorkspaceMounted] = useState(true);
    useEffect(() => {
        // 阶段阻断定位 → 明确打开右栏 Inspector(workbench 职权)
        if (slots?.stageFocus) setInspectorOverride(true);
    }, [slots?.stageFocus]);
    const inspectorVisible = inspectorOverride ?? Boolean(slots?.inspector || slots?.shotSelected);

    const probeReload = useCallback(async () => {
        const r = await slots?.reloadProject();
        window.__reloadProbe = r?.id ?? "null";
    }, [slots]);

    return (
        <div style={{ display: "flex", flexDirection: "column", height: 760, padding: 12, gap: 8, background: "var(--background, #0b0b0f)" }}>
            <CreationStudioThreePane
                rail={(
                    <div data-testid="harness-rail" style={{ display: "flex", flexDirection: "column", gap: 6, padding: 8 }}>
                        <span style={{ fontSize: 12, color: "var(--muted-foreground)" }}>资产栏</span>
                        <button type="button" onClick={() => setWorkspaceMounted(false)}>卸载工作区(模拟项目切换)</button>
                        <button type="button" onClick={() => void probeReload()}>探针reloadProject</button>
                    </div>
                )}
                stage={workspaceMounted ? (
                    <FakeWorkspace onSwitchProject={(next) => navigate(`/create?project=${next}&section=shots`)} />
                ) : (
                    <div data-testid="ws-unmounted" style={{ padding: 8 }}>工作区已卸载</div>
                )}
                inspector={(
                    <CreationStudioInspector
                        projectId={(searchParams.get("project") || "").trim() || null}
                        section={(searchParams.get("section") || "").trim() || null}
                    />
                )}
                inspectorVisible={inspectorVisible}
                onToggleInspector={() => setInspectorOverride((v) => !(v ?? true))}
            />
            <span data-testid="url-readout" style={{ fontSize: 10, color: "var(--muted-foreground)" }}>
                {location.pathname}{location.search}
            </span>
        </div>
    );
}

createRoot(document.getElementById("root")!).render(
    <ConfigProvider locale={zhCN} theme={getAntThemeConfig(true)}>
        <App>
            <MemoryRouter initialEntries={["/create?project=p1&section=shots"]}>
                <CreationStudioSlotsProvider>
                    <Shell />
                </CreationStudioSlotsProvider>
            </MemoryRouter>
        </App>
    </ConfigProvider>,
);
