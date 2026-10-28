import { useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import { App, ConfigProvider } from "antd";
import zhCN from "antd/locale/zh_CN";

import { CreationStageTrack, StageBlockNotice } from "@/components/toiv/creation-stage-track";
import type { ToivDramaDetail, ToivStageId, ToivStageStateValue } from "@/services/toiv/client";
import { getAntThemeConfig } from "@/lib/app-theme";

declare global {
    interface Window {
        __toivStub?: {
            transitionMode?: "ok" | "conflict" | "slow";
            historyMode?: "fast" | "slow";
            revision: number;
            states: Record<string, ToivStageStateValue>;
            blockers?: Record<string, string[]>;
        };
        __toivCalls?: { kind: string; [key: string]: unknown }[];
        __reloadCount?: number;
        __navCalls?: string[];
        __openStageCalls?: string[];
    }
}

const params = new URLSearchParams(window.location.search);
// 与生产 AppProviders 同一暗色主题:ConfigProvider(getAntThemeConfig(true)) + html.dark + 完整 CSS 链。
document.documentElement.classList.toggle("dark", !params.has("light"));

window.__toivCalls = [];
window.__reloadCount = 0;
window.__navCalls = [];
window.__openStageCalls = [];
window.__toivStub = {
    transitionMode: "ok",
    historyMode: "fast",
    revision: 3,
    states: {
        script: "pending_confirmation",
        assets: "draft",
        storyboard: "confirmed",
        generate: "needs_review",
        voice: "skipped",
        timeline: "draft",
    },
    blockers: { assets: ["角色定妆未完成"] },
};

function buildDetail(pid = "p1", withRevision = true): ToivDramaDetail {
    const stub = window.__toivStub!;
    const stageStates = Object.fromEntries(
        (Object.keys(stub.states) as ToivStageId[]).map((id) => [
            id,
            {
                state: stub.states[id],
                ready: stub.states[id] === "confirmed",
                blockers: stub.blockers?.[id] ?? [],
            },
        ]),
    );
    return {
        id: pid,
        title: "雨夜",
        status: "draft",
        ...(withRevision ? { stage_revision: stub.revision } : {}),
        stage_states: stageStates,
    } as ToivDramaDetail;
}

const LEGACY_DETAIL: ToivDramaDetail = { id: "p2", title: "旧项目", status: "draft" } as ToivDramaDetail;

function TrackCase({
    testId,
    detail,
    section,
    reloadMode = "derive",
}: {
    testId: string;
    detail: ToivDramaDetail | null;
    section?: string | null;
    /** derive:模拟 parent load() 从 stub 真值重派生;null:模拟 load() 返回 null(刷新未确认) */
    reloadMode?: "derive" | "null";
}) {
    const [current, setCurrent] = useState(detail);
    const reload = useCallback(async (): Promise<ToivDramaDetail | null> => {
        window.__reloadCount = (window.__reloadCount ?? 0) + 1;
        if (reloadMode === "null") return null;
        // 模拟 drama-workspace 的 load():从服务端真值(此处为 stub)重新派生阶段,组件不得本地伪造
        const next = buildDetail(current?.id ?? "p1");
        setCurrent(next);
        return next;
    }, [reloadMode, current?.id]);
    return (
        <section
            data-testid={testId}
            style={{ borderRadius: 12, border: "1px solid var(--border, #26262e)", background: "var(--card, #141419)", padding: 12 }}
        >
            <CreationStageTrack
                detail={current}
                section={section ?? null}
                onNavigate={(nav) => {
                    window.__navCalls?.push(nav);
                }}
                onReload={reload}
            />
            {testId === "stage-track-switch" ? (
                <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                    <button type="button" onClick={() => setCurrent(buildDetail("p1"))}>切到 p1(六阶段)</button>
                    <button type="button" onClick={() => setCurrent(LEGACY_DETAIL)}>切到 p2(旧服务端)</button>
                </div>
            ) : null}
            {testId === "stage-track-switch-six" ? (
                <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                    <button type="button" onClick={() => setCurrent(buildDetail("p1"))}>切到 p1(六阶段)</button>
                    <button type="button" onClick={() => setCurrent(buildDetail("p2"))}>切到 p2(六阶段)</button>
                </div>
            ) : null}
        </section>
    );
}

function AppInner() {
    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 16, padding: 16, minHeight: "100vh", background: "var(--background, #0b0b0f)" }}>
            <TrackCase testId="stage-track" detail={buildDetail("p1")} section="shots" />
            <div data-testid="block-notice-slot">
                <StageBlockNotice
                    message="批量渲染被阶段闸拦截:分镜阶段尚未确认(stage_revision=3)"
                    stageId="storyboard"
                    onOpenStage={(stage) => {
                        window.__openStageCalls?.push(stage);
                    }}
                />
            </div>
            <TrackCase testId="stage-track-nullreload" detail={buildDetail("p1")} section="shots" reloadMode="null" />
            <TrackCase testId="stage-track-norev" detail={buildDetail("p1", false)} section="shots" />
            <TrackCase testId="stage-track-switch" detail={buildDetail("p1")} section="shots" />
            <TrackCase testId="stage-track-switch-six" detail={buildDetail("p1")} section="shots" />
            <TrackCase testId="stage-track-legacy" detail={LEGACY_DETAIL} section="storyboard" />
            <TrackCase testId="stage-track-noproject" detail={null} section={null} />
        </div>
    );
}

createRoot(document.getElementById("root")!).render(
    <ConfigProvider locale={zhCN} theme={getAntThemeConfig(true)}>
        <App>
            <AppInner />
        </App>
    </ConfigProvider>,
);
