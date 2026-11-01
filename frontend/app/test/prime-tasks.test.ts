import { afterEach, describe, expect, test } from "bun:test";
import {
    cancelTask, classifyPrimeFailure, deriveActiveTasks, loadActiveTasks, loadProjectStatus, loadRecentTasks,
    loadTaskCounts, loadTaskHealth, mergePrimeTasks, primeDiagnostics, primeDuration, primeRelativeTime,
    redactPrimeText, rerunTask,
} from "../src/toiv/adapters/tasks";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function respond(body: unknown, status = 200) {
    globalThis.fetch = (async () => Response.json(body, { status })) as typeof fetch;
}

function activeJob(overrides: Record<string, unknown> = {}) {
    return {
        id: "a1", prompt_id: "p1", kind: "h3_t2v", status: "running", prompt: "雨夜追击",
        worker: "http://192.168.71.127:8264", created_at: "2026-11-01T10:00:00+00:00",
        wait_sec: 90, eta_sec: 300, hold_reason: "",
        progress: { pct: 42, step: 2, total: 5, queue_pos: null, phase: "render", phase_label: "生成画面" },
        runtime: { state: "fresh", label: "进度新鲜", reason: "进度持续更新", age_seconds: 12, evidence: "progress_snapshot" },
        nsfw: false, ...overrides,
    };
}

function recentJob(overrides: Record<string, unknown> = {}) {
    return {
        id: "r1", prompt_id: "p2", kind: "wan_t2v", status: "error", prompt: "海边日落",
        created_at: "2026-10-31T10:00:00+00:00", results: [], progress: { pct: null },
        error: "CUDA out of memory", hold_reason: "", post_status: "", project_id: "proj-1",
        seed: 7, has_params: true, nsfw: false,
        runtime: { state: "terminal", label: "已结束", reason: "作业状态为 error", age_seconds: 10, evidence: "progress_snapshot" },
        ...overrides,
    };
}

describe("task adapter: active jobs", () => {
    test("maps progress, runtime evidence and ETA from the active endpoint", async () => {
        respond({ items: [activeJob()], server_time: "2026-11-01T10:01:00Z" });
        const [task] = await loadActiveTasks();
        expect(task.id).toBe("a1");
        expect(task.status).toBe("run");
        expect(task.progress).toBe(42);
        expect(task.step).toBe(2);
        expect(task.total).toBe(5);
        expect(task.phaseLabel).toBe("生成画面");
        expect(task.runtime?.state).toBe("fresh");
        expect(task.etaSec).toBe(300);
        expect(task.cancellable).toBe(true);
        expect(task.scope).toBe("active");
    });
    test("rejects malformed active envelopes instead of presenting an empty queue", async () => {
        respond({ items: [{ id: "" }] });
        await expect(loadActiveTasks()).rejects.toThrow();
        respond({ unexpected: [] });
        await expect(loadActiveTasks()).rejects.toThrow();
    });
    test("forwards AbortSignal to the active request", async () => {
        const controller = new AbortController();
        let signal: AbortSignal | null | undefined;
        globalThis.fetch = (async (_url, init) => { signal = init?.signal; return Response.json({ items: [] }); }) as typeof fetch;
        await loadActiveTasks(controller.signal);
        expect(signal).toBe(controller.signal);
    });
});

describe("task adapter: recent jobs", () => {
    test("classifies failures, keeps results and only allows exact reruns with a snapshot", async () => {
        respond([
            recentJob(),
            recentJob({ id: "r2", status: "done", error: "", has_params: false, results: ["/api/images?filename=shot.MP4"] }),
            recentJob({ id: "r3", status: "running", error: "", results: [] }),
        ]);
        const [failed, done, running] = await loadRecentTasks();
        expect(failed.failure?.kind).toBe("resource");
        expect(failed.canRerun).toBe(true);
        expect(done.mediaKind).toBe("video");
        expect(done.canRerun).toBe(false);
        expect(running.canRerun).toBe(false);
        expect(running.cancellable).toBe(true);
    });
    test("merges active live fields over the recent snapshot without losing results or errors", async () => {
        respond([recentJob({ id: "same", status: "running", error: "", results: ["/api/studio/files/a.png"] })]);
        const recent = await loadRecentTasks();
        respond({ items: [activeJob({ id: "same", progress: { pct: 80, step: 4, total: 5 }, eta_sec: 20 })] });
        const active = await loadActiveTasks();
        const [task] = mergePrimeTasks(active, recent);
        expect(task.progress).toBe(80);
        expect(task.etaSec).toBe(20);
        expect(task.media).toBe("/api/studio/files/a.png");
        expect(task.projectId).toBe("proj-1");
        expect(task.scope).toBe("active");
        expect(mergePrimeTasks(active, recent)).toHaveLength(1);
    });
    test("derives an honest in-flight fallback from recent jobs", async () => {
        respond([recentJob({ id: "x", status: "queued", error: "" }), recentJob({ id: "y", status: "done", error: "" })]);
        const active = deriveActiveTasks(await loadRecentTasks());
        expect(active.map(task => task.id)).toEqual(["x"]);
        expect(active[0].scope).toBe("active");
    });
});

describe("task adapter: supporting reads and actions", () => {
    test("reads counts, deps health and the project next step", async () => {
        respond({ count: 12, failed: 3 });
        expect(await loadTaskCounts()).toEqual({ total: 12, failed: 3 });
        respond({
            overall: "degraded",
            deps: [
                { id: "api", label: "工作站算力", state: "reachable", summary: "可用", block_cta: false, blocked_hint: "" },
                { id: "tts", label: "配音服务", state: "unreachable", summary: "配音服务暂不可用", block_cta: true, blocked_hint: "稍后再配音" },
            ],
        });
        const health = await loadTaskHealth();
        expect(health.overall).toBe("degraded");
        expect(health.deps[1]).toEqual({ id: "tts", label: "配音服务", state: "unreachable", summary: "配音服务暂不可用", blockHint: "稍后再配音" });
        respond({
            total: 6, by_status: { rendered: 4, error: 2 },
            next_step: { step: "voice", label: "分镜配音", action: "/studio/shots/s1/voice", todo: 2, shot_ids: ["s1", "s2"] },
        });
        const status = await loadProjectStatus("proj-1");
        expect(status.total).toBe(6);
        expect(status.byStatus.error).toBe(2);
        expect(status.nextStep.label).toBe("分镜配音");
        expect(status.nextStep.shotIds).toEqual(["s1", "s2"]);
    });
    test("rejects malformed counts and project status", async () => {
        respond({ count: "12" });
        await expect(loadTaskCounts()).rejects.toThrow();
        respond({ total: 1 });
        await expect(loadProjectStatus("p")).rejects.toThrow();
    });
    test("never sends an empty cancellable id and preserves server detail", async () => {
        let requests = 0;
        globalThis.fetch = (async () => { requests++; return Response.json({ ok: true, status: "canceled" }); }) as typeof fetch;
        await expect(cancelTask("")).rejects.toThrow();
        expect(requests).toBe(0);
        respond({ detail: "already terminal" }, 409);
        await expect(cancelTask("r1")).rejects.toThrow("already terminal");
    });
    test("reruns with the keep-seed contract and surfaces unsupported kinds", async () => {
        let body = "";
        globalThis.fetch = (async (_url, init) => {
            body = String(init?.body ?? "");
            return Response.json({ ok: true, job_id: "new-1" });
        }) as typeof fetch;
        expect(await rerunTask("r1")).toBe("new-1");
        expect(JSON.parse(body)).toEqual({ seed_mode: "keep" });
        respond({ detail: "该类型作业暂不支持重新生成：agent_x" }, 400);
        await expect(rerunTask("r2")).rejects.toThrow("暂不支持");
    });
});

describe("task adapter: failure language and diagnostics", () => {
    test("classifies the failure families that need different fixes", () => {
        expect(classifyPrimeFailure("429 Too Many Requests")?.kind).toBe("rate");
        expect(classifyPrimeFailure("额度不足")?.kind).toBe("quota");
        expect(classifyPrimeFailure("模型未配置")?.kind).toBe("config");
        expect(classifyPrimeFailure("blocked by safety policy")?.kind).toBe("content");
        expect(classifyPrimeFailure("ECONNREFUSED")?.kind).toBe("engine");
        expect(classifyPrimeFailure("execution timed out")?.kind).toBe("timeout");
        expect(classifyPrimeFailure("something odd")?.kind).toBe("unknown");
        expect(classifyPrimeFailure("")).toBeUndefined();
    });
    test("diagnostics include identifiers but redact credentials", async () => {
        respond([recentJob({ error: "Authorization: Bearer abc.def.ghi token=secret-123 https://x.test?api_key=k" })]);
        const [task] = await loadRecentTasks();
        const report = primeDiagnostics(task);
        expect(report).toContain("r1");
        expect(report).toContain("proj-1");
        expect(report).not.toContain("abc.def.ghi");
        expect(report).not.toContain("secret-123");
        expect(report).not.toContain("api_key=k");
        expect(redactPrimeText("eyJabcdefgh.abcdefgh.abcdefgh")).toBe("[已隐藏]");
    });
    test("formats relative time and durations without inventing values", () => {
        const now = Date.parse("2026-11-01T12:00:00Z");
        expect(primeRelativeTime("2026-11-01T11:59:40Z", now)).toBe("刚刚");
        expect(primeRelativeTime("2026-11-01T11:20:00Z", now)).toBe("40 分钟前");
        expect(primeRelativeTime("2026-10-31T10:00:00Z", now)).toBe("1 天前");
        expect(primeRelativeTime("", now)).toBe("—");
        expect(primeDuration(9)).toBe("9 秒");
        expect(primeDuration(65)).toBe("1 分 05 秒");
        expect(primeDuration(3720)).toBe("1 小时 02 分");
        expect(primeDuration(null)).toBe("—");
    });
});
