import { describe, expect, test } from "bun:test";

import {
    generationSourceProjection,
    generationTaskProjection,
    mergeGenerationSourceProjections,
} from "@/lib/generation-task-display";
import type { GenerationTask } from "@/services/api/task-center";
import type { ToivJob } from "@/services/toiv/client";

function canvasTask(patch: Partial<GenerationTask> = {}): GenerationTask {
    return {
        id: "shared-id",
        projectId: "p1",
        type: "canvas_video",
        status: "running",
        progress: 42,
        stage: "render",
        prompt: "Canvas 雨夜镜头",
        attempts: 1,
        createdAt: "2026-10-28T00:00:00Z",
        updatedAt: "2026-10-28T00:01:00Z",
        ...patch,
    };
}

function toivJob(patch: Partial<ToivJob> = {}): ToivJob {
    return {
        id: "shared-id",
        project_id: "p1",
        kind: "studio_batch_render",
        status: "running",
        prompt: "FastAPI 雨夜镜头",
        created_at: "2026-10-28T00:00:00Z",
        progress: { pct: 63, step: 5, total: 8, updated_at: 1793148060, phase: "render", phase_label: "批量渲染" },
        runtime: {
            state: "stalled",
            label: "进度待核查",
            reason: "进度快照 120 秒未更新",
            last_evidence_at: 1793148060,
            age_seconds: 120,
            evidence: "progress_snapshot",
        },
        ...patch,
    };
}

describe("D1a generationSourceProjection", () => {
    test("adapts Toiv progress/runtime and real result media through the shared artifact algorithm", () => {
        const running = generationSourceProjection({ source: "toiv-job", task: toivJob() });
        expect(running.sourceId).toBe("toiv-job:shared-id");
        expect(running.id).toBe("shared-id");
        expect(running.status).toBe("running");
        expect(running.statusLabel).toBe("运行中");
        expect(running.stageLabel).toBe("批量渲染");
        expect(running.progressPct).toBe(63);
        expect(running.isActive).toBe(true);
        expect(running.canCancel).toBe(true);
        expect(running.health).toMatchObject({
            state: "stalled",
            label: "进度待核查",
            reason: "进度快照 120 秒未更新",
            evidence: "progress_snapshot",
            lastEvidenceAt: 1793148060,
        });
        expect(running.artifactState).toBe("pending");
        expect(running.nextAction).toBe("cancel");

        const done = generationSourceProjection({ source: "toiv-job", task: toivJob({
            status: "done",
            results: ["/api/results/shot.png"],
            runtime: { state: "terminal", label: "终态", reason: "作业已完成", last_evidence_at: 1793148061, age_seconds: 0, evidence: "terminal" },
        }) });
        expect(done.status).toBe("succeeded");
        expect(done.isActive).toBe(false);
        expect(done.canCancel).toBe(false);
        expect(done.artifactState).toBe("ready");
        expect(done.nextAction).toBe("view");
        expect(done.previewUrl).toBe("/api/results/shot.png");
    });

    test("missing runtime is unknown instead of inferred fresh", () => {
        const projection = generationSourceProjection({ source: "toiv-job", task: toivJob({ runtime: undefined }) });
        expect(projection.health.state).toBe("unknown");
        expect(projection.health.label).toBe("健康未知");
        expect(projection.health.reason).toContain("未提供");
        expect(projection.health.evidence).toBe("none");
    });

    test("batch held is active waiting work and stalled never becomes terminal", () => {
        const held = generationSourceProjection({ source: "toiv-job", task: toivJob({
            id: "batch-held",
            status: "held",
            hold_reason: "等待批量渲染资源",
            runtime: { state: "waiting", label: "等待资源", reason: "GPU 资源占用", last_evidence_at: null, age_seconds: null, evidence: "created_at" },
        }) });
        expect(held.status).toBe("queued");
        expect(held.statusLabel).toBe("等待资源");
        expect(held.stageLabel).toContain("等待批量渲染资源");
        expect(held.isActive).toBe(true);
        expect(held.canCancel).toBe(true);

        const stalled = generationSourceProjection({ source: "toiv-job", task: toivJob() });
        expect(stalled.health.state).toBe("stalled");
        expect(stalled.isActive).toBe(true);
    });

    test("Canvas updatedAt is state evidence, not a heartbeat, and artifact/nextAction stay compatible", () => {
        const task = canvasTask({ status: "failed", resultState: "FAILED_RETRYABLE", error: "provider timeout" });
        const legacy = generationTaskProjection(task);
        const projection = generationSourceProjection({ source: "canvas-task", task });
        expect(projection.sourceId).toBe("canvas-task:shared-id");
        expect(projection.artifactState).toBe(legacy.artifactState);
        expect(projection.nextAction).toBe(legacy.nextAction);
        expect(projection.canRetry).toBe(true);
        expect(projection.health.state).toBe("unknown");
        expect(projection.health.evidence).toBe("state_updated_at");
        expect(projection.health.reason).toContain("不是 worker 心跳");
        expect(projection.health.lastEvidenceAt).toBe(Date.UTC(2026, 9, 28, 0, 1, 0));
    });

    test("merge isolates equal IDs and applies the same project filter to Toiv", () => {
        const merged = mergeGenerationSourceProjections(
            [canvasTask()],
            [toivJob(), toivJob({ id: "other-project", project_id: "p2" })],
            { projectId: "p1" },
        );
        expect(merged.map((item) => item.sourceId).sort()).toEqual(["canvas-task:shared-id", "toiv-job:shared-id"]);
        expect(new Set(merged.map((item) => item.sourceId)).size).toBe(2);
    });

    test("artifact and nextAction have the same semantics for both sources", () => {
        const canvas = generationSourceProjection({ source: "canvas-task", task: canvasTask({ status: "succeeded", previewUrl: "/media/a.mp4" }) });
        const toiv = generationSourceProjection({ source: "toiv-job", task: toivJob({ status: "done", results: ["/media/a.mp4"] }) });
        expect(toiv.artifactState).toBe(canvas.artifactState);
        expect(toiv.artifactLabel).toBe(canvas.artifactLabel);
        expect(toiv.nextAction).toBe(canvas.nextAction);
        expect(toiv.nextLabel).toBe(canvas.nextLabel);
    });
});
