import { expect, test } from "bun:test";

import { generationTaskProjection } from "@/lib/generation-task-display";
import type { GenerationTask } from "@/services/api/task-center";

function task(patch: Partial<GenerationTask>): GenerationTask {
    return {
        id: "task-1",
        type: "canvas_video",
        status: "running",
        prompt: "雨夜镜头",
        attempts: 1,
        createdAt: "2026-10-27T00:00:00Z",
        updatedAt: "2026-10-27T00:00:00Z",
        ...patch,
    };
}

test("failed artifact keeps a real retry and provider diagnostics", () => {
    const projection = generationTaskProjection(task({
        status: "failed",
        resultState: "FAILED_RETRYABLE",
        error: "provider timeout",
        providerRequestId: "provider-request-1",
    }));
    expect(projection.artifactState).toBe("failed");
    expect(projection.nextAction).toBe("retry");
    expect(projection.nextReason).toBe("provider timeout");
    expect(projection.providerRequestId).toBe("provider-request-1");
});

test("running task exposes cancellation without claiming an artifact", () => {
    const projection = generationTaskProjection(task({ status: "running" }));
    expect(projection.artifactState).toBe("pending");
    expect(projection.nextAction).toBe("cancel");
});

test("successful media is viewable and absent media leads to logs", () => {
    expect(generationTaskProjection(task({ status: "succeeded", previewUrl: "/media/1.mp4" })).nextAction).toBe("view");
    const missing = generationTaskProjection(task({ status: "succeeded", resultState: "NOT_AVAILABLE" }));
    expect(missing.artifactState).toBe("missing");
    expect(missing.nextAction).toBe("logs");
});

test("materialization and uncertain submission stay distinct", () => {
    expect(generationTaskProjection(task({ resultState: "MATERIALIZING" })).artifactState).toBe("materializing");
    const uncertain = generationTaskProjection(task({ stage: "submission_unknown", status: "running" }));
    expect(uncertain.nextAction).toBe("diagnose");
    expect(uncertain.nextReason).toContain("未自动重试");
});
