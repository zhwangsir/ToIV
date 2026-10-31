import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { App, ConfigProvider } from "antd";
import zhCN from "antd/locale/zh_CN";

import { RenderCostEstimate } from "@/components/toiv/render-cost-estimate";
import { getAntThemeConfig } from "@/lib/app-theme";
import {
    createStudioProject,
    fetchDramaProject,
    fetchJobById,
    fetchJobs,
    patchStudioProject,
    saveStudioShots,
    transitionProjectStage,
    triggerBatchRender,
    type ToivDramaDetail,
} from "@/services/toiv/client";

const mode = new URLSearchParams(window.location.search).get("mode") === "keyframe" ? "keyframe" : "direct";
document.documentElement.classList.add("dark");

function errorStatus(error: unknown): number {
    return (error as { response?: { status?: number } })?.response?.status ?? 0;
}

function LiveHarness() {
    const [detail, setDetail] = useState<ToivDramaDetail | null>(null);
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);
    const [jobId, setJobId] = useState("");
    const [jobStatus, setJobStatus] = useState("");
    const [shotStatus, setShotStatus] = useState("");
    const [blockedSubmit, setBlockedSubmit] = useState<{ status: number; jobDelta: number } | null>(null);

    useEffect(() => {
        let alive = true;
        void (async () => {
            try {
                const project = await createStudioProject({ title: `D0 live ${mode}`, premise: "真实联调剧本" });
                await patchStudioProject(project.id, { preferred_drive_mode: mode });
                await saveStudioShots(project.id, [{ scene: "雨夜", prompt: "rain night", duration_sec: 2 }]);
                let next = await fetchDramaProject(project.id);
                if (mode === "keyframe") {
                    let revision = next.stage_revision;
                    for (const [stage, action] of [["script", "confirm"], ["assets", "skip"], ["storyboard", "confirm"]] as const) {
                        const result = await transitionProjectStage(project.id, {
                            stage, action, note: "D0 keyframe 前置阶段", expected_stage_revision: revision,
                        });
                        revision = result.stage_revision;
                    }
                    next = await fetchDramaProject(project.id);
                }
                if (alive) setDetail(next);
            } catch (caught) {
                if (alive) setError(caught instanceof Error ? caught.message : "初始化失败");
            }
        })();
        return () => { alive = false; };
    }, []);

    const confirmStages = async () => {
        if (!detail) return;
        setBusy(true);
        setError("");
        try {
            let revision = detail.stage_revision;
            for (const [stage, action] of [["script", "confirm"], ["assets", "skip"], ["storyboard", "confirm"]] as const) {
                const result = await transitionProjectStage(detail.id, {
                    stage,
                    action,
                    note: "D0 真实联调",
                    expected_stage_revision: revision,
                });
                revision = result.stage_revision;
            }
            setDetail(await fetchDramaProject(detail.id));
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : "阶段确认失败");
        } finally {
            setBusy(false);
        }
    };

    const submitBatch = async () => {
        if (!detail) return;
        setBusy(true);
        setError("");
        try {
            const ack = await triggerBatchRender(detail.id, "off", "ref2va");
            setJobId(ack.job_id);
            for (let attempt = 0; attempt < 100; attempt += 1) {
                const [job, next] = await Promise.all([fetchJobById(ack.job_id), fetchDramaProject(detail.id)]);
                setJobStatus(job.status);
                if (["done", "error", "canceled"].includes(job.status)) {
                    setDetail(next);
                    setShotStatus(next.shots?.map((shot) => shot.status).join(",") ?? "");
                    if (job.status !== "done") throw new Error(`作业终态 ${job.status}`);
                    break;
                }
                await new Promise((resolve) => setTimeout(resolve, 50));
            }
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : "批量提交失败");
        } finally {
            setBusy(false);
        }
    };

    const verifyBlockedSubmit = async () => {
        if (!detail) return;
        setBusy(true);
        setError("");
        const batchJobs = async () => (await fetchJobs(100)).filter((job) => job.kind === "studio_batch_render").length;
        try {
            const before = await batchJobs();
            let status = 0;
            try {
                await triggerBatchRender(detail.id, "off", "ref2va");
            } catch (caught) {
                status = errorStatus(caught);
            }
            const after = await batchJobs();
            setBlockedSubmit({ status, jobDelta: after - before });
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : "阻断验证失败");
        } finally {
            setBusy(false);
        }
    };

    return (
        <main style={{ width: 720, margin: "24px auto", padding: 20, border: "1px solid var(--border)", borderRadius: 12, background: "var(--card)" }}>
            <h1 style={{ marginTop: 0, fontSize: 18 }}>D0 真实 FastAPI 联调 · {mode}</h1>
            {error && <p role="alert" style={{ color: "var(--danger)" }}>{error}</p>}
            {!detail && !error && <p>正在通过生产路由创建项目与分镜…</p>}
            {detail && (
                <div data-testid="live-ready" data-project-id={detail.id}>
                    <p>项目 {detail.id} · 驱动 {mode} · 分镜 {detail.shots?.length ?? 0}</p>
                    {mode === "direct" && (
                        <button disabled={busy} onClick={() => void confirmStages()}>真实确认 script / 跳过 assets / 确认 storyboard</button>
                    )}
                    {mode === "keyframe" && (
                        <button disabled={busy} onClick={() => void verifyBlockedSubmit()}>验证真实提交阻断</button>
                    )}
                    <RenderCostEstimate
                        scope="batch"
                        projectId={detail.id}
                        open
                        accel="off"
                        pipeline="ref2va"
                        detail={detail}
                        onConfirm={() => void submitBatch()}
                    />
                    {jobId && <p>job_id <span data-testid="live-job-id">{jobId}</span></p>}
                    <p>作业状态 <strong data-testid="live-job-status">{jobStatus || "—"}</strong></p>
                    <p>分镜状态 <strong data-testid="live-shot-status">{shotStatus || "—"}</strong></p>
                    {blockedSubmit && (
                        <p>真实提交 HTTP <strong data-testid="live-submit-status">{blockedSubmit.status}</strong>
                            · 新增任务 <strong data-testid="live-job-delta">{blockedSubmit.jobDelta}</strong></p>
                    )}
                </div>
            )}
        </main>
    );
}

createRoot(document.getElementById("root")!).render(
    <ConfigProvider locale={zhCN} theme={getAntThemeConfig(true)}>
        <App><div style={{ minHeight: "100vh", background: "var(--background)" }}><LiveHarness /></div></App>
    </ConfigProvider>,
);
