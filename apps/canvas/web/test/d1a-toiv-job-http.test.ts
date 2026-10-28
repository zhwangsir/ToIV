import { afterAll, beforeAll, expect, test } from "bun:test";

import { generationSourceProjection } from "@/lib/generation-task-display";
import { fetchJobs, toivHttp } from "@/services/toiv/client";

const server = Bun.serve({
    port: 0,
    fetch(request) {
        const url = new URL(request.url);
        if (url.pathname !== "/api/jobs") return new Response("not found", { status: 404 });
        if (url.searchParams.get("limit") === "13") return Response.json({ unexpected: true });
        return Response.json([{
            id: "timezone-job",
            status: "running",
            prompt: "真实 HTTP 进度",
            created_at: "2026-10-28T00:30:00",
            progress: { pct: 37, step: 3, total: 8, updated_at: 1793147400, phase_label: "采样" },
            runtime: {
                state: "fresh",
                label: "进度持续更新",
                reason: "最近进度快照持续更新",
                last_evidence_at: 1793147400,
                age_seconds: 2,
                evidence: "progress_snapshot",
            },
        }]);
    },
});

const originalBaseURL = toivHttp.defaults.baseURL;

beforeAll(() => {
    toivHttp.defaults.baseURL = `${server.url.origin}/api`;
});

afterAll(() => {
    toivHttp.defaults.baseURL = originalBaseURL;
    server.stop(true);
});

test("real axios HTTP wrapper preserves numeric evidence and parses naive backend ISO as UTC", async () => {
    const [job] = await fetchJobs();
    expect(job.progress?.updated_at).toBe(1793147400);
    const projection = generationSourceProjection({ source: "toiv-job", task: job });
    expect(projection.progressPct).toBe(37);
    expect(projection.health.lastEvidenceAt).toBe(1793147400);
    expect(projection.progressUpdatedAt).toBe(1793147400);
    expect(projection.createdAt).toBe("2026-10-28T00:30:00");
    expect(projection.sortTimestamp).toBe(Date.UTC(2026, 9, 28, 0, 30, 0));
});

test("real HTTP malformed 200 job list rejects instead of becoming an empty source", async () => {
    await expect(fetchJobs(13)).rejects.toThrow("作业列表响应形状异常");
});
