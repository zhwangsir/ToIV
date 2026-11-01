import { afterEach, describe, expect, test } from "bun:test";
import {
    estimateAllowsDirectSubmit, estimatePrimeBatch, estimatePrimeShot, quoteCanConfirm,
    submitPrimeBatch, submitPrimeShot,
} from "../src/toiv/adapters/render";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

type Call = { path: string; method: string; body: any };
function api(handler: (call: Call) => unknown | Response) {
    const calls: Call[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const call = { path: String(input), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined };
        calls.push(call);
        const result = handler(call);
        return result instanceof Response ? result : Response.json(result);
    }) as typeof fetch;
    return calls;
}

function estimate(overrides: Record<string, unknown> = {}) {
    return {
        schema: "toiv_render_estimate_v1",
        scope: "batch",
        project_id: "p1",
        allowed: true,
        blockers: [],
        warnings: ["价格表未启用预算上限"],
        input_fingerprint: "fp-1",
        work: {
            shot_count: 2, candidate_upper_bound: 4, requested_duration_sec: 12,
            requested_frame_count: 288, pixel_frame_upper_bound: 442368, image_motion_count: 0,
        },
        items: [
            { shot_id: "s1", idx: 0, engine: "h3", pipeline: "ref2va", render_mode: "video", candidates: 2, duration_sec: 6, frames: 144, pixel_frame_upper_bound: 221184 },
            { shot_id: "s2", idx: 1, engine: "h3", pipeline: "ref2va", render_mode: "video", candidates: 2, duration_sec: 6, frames: 144, pixel_frame_upper_bound: 221184 },
        ],
        pricing: { status: "estimated", currency: "CNY", total: "12.5000", rate_source: "env", unknowns: [] },
        budget: { status: "disabled", limit: null, currency: null },
        ...overrides,
    };
}

describe("Prime render estimate", () => {
    test("quotes the whole project from server work/items instead of client guesses", async () => {
        const calls = api(() => estimate());
        const result = await estimatePrimeBatch("p1", {});
        expect(calls[0]).toEqual({
            path: "/api/studio/projects/p1/render-estimate", method: "POST",
            body: { accel: "off", pipeline: "ref2va" },
        });
        expect(result.work.shotCount).toBe(2);
        expect(result.items.map(item => item.shotId)).toEqual(["s1", "s2"]);
        expect(result.pricing.status).toBe("estimated");
        expect(result.pricing.total).toBe("12.5000");
        expect(result.budget.status).toBe("disabled");
        expect(result.fingerprint).toBe("fp-1");
    });
    test("keeps every server blocker in order and refuses a confirmable quote from malformed data", async () => {
        api(() => estimate({
            allowed: false,
            blockers: [
                { code: "STORYBOARD_NOT_CONFIRMED", message: "故事板尚未确认", stage: "storyboard" },
                { code: "RENDER_BUDGET_EXCEEDED", message: "超过预算" },
            ],
        }));
        const result = await estimatePrimeBatch("p1", {});
        expect(result.allowed).toBe(false);
        expect(result.blockers.map(blocker => blocker.code)).toEqual(["STORYBOARD_NOT_CONFIRMED", "RENDER_BUDGET_EXCEEDED"]);
        expect(quoteCanConfirm(result)).toBe(false);

        for (const broken of [
            estimate({ input_fingerprint: "" }),
            estimate({ work: { shot_count: "two" } }),
            estimate({ pricing: { status: "free", currency: null, total: null, unknowns: [] } }),
            estimate({ blockers: [{ code: "X" }] }),
            estimate({ scope: "shot" }),
            estimate({ project_id: "other" }),
        ]) {
            api(() => broken);
            await expect(estimatePrimeBatch("p1", {})).rejects.toThrow("报价响应不完整");
        }
    });
    test("quotes a single shot with the same options later sent to render", async () => {
        const calls = api(() => estimate({
            scope: "shot", shot_id: "s1", work: {
                shot_count: 1, candidate_upper_bound: 3, requested_duration_sec: 6,
                requested_frame_count: 216, pixel_frame_upper_bound: 331776, image_motion_count: 0,
            },
        }));
        const result = await estimatePrimeShot("s1", { numCandidates: 3, accel: "balanced" });
        expect(calls[0]).toEqual({
            path: "/api/studio/shots/s1/render-estimate", method: "POST",
            body: { pipeline: "ref2va", accel: "balanced", num_candidates: 3, auto_pick: false },
        });
        expect(result.scope).toBe("shot");
        expect(result.shotId).toBe("s1");
        expect(quoteCanConfirm(result)).toBe(true);
        expect(estimateAllowsDirectSubmit(result, "fp-1")).toBe(true);
        expect(estimateAllowsDirectSubmit(result, "fp-old")).toBe(false);
    });
    test("rejects out-of-range candidate counts before calling the server", async () => {
        const calls = api(() => estimate());
        for (const count of [0, 5, 2.5]) {
            await expect(estimatePrimeShot("s1", { numCandidates: count })).rejects.toThrow("候选数须为 1–4");
        }
        expect(calls).toHaveLength(0);
    });
});

describe("Prime render submission", () => {
    test("batch submit locks wait=false and returns the accepted job id", async () => {
        const calls = api(() => Response.json({ job_id: "job-9", status: "queued", project_id: "p1" }, { status: 202 }));
        const result = await submitPrimeBatch("p1", { accel: "lossless" });
        expect(calls[0]).toEqual({
            path: "/api/studio/projects/p1/render", method: "POST",
            body: { accel: "lossless", pipeline: "ref2va", wait: false },
        });
        expect(result).toEqual({ jobId: "job-9", status: "queued", projectId: "p1" });
    });
    test("shot submit requests manual candidates and verifies the echoed shot", async () => {
        const calls = api(() => ({ job_id: "job-10", prompt_id: "prompt-1", status: "queued", shot_id: "s1" }));
        const result = await submitPrimeShot("s1", { numCandidates: 2 });
        expect(calls[0]).toEqual({
            path: "/api/studio/shots/s1/render", method: "POST",
            body: { pipeline: "ref2va", accel: "off", num_candidates: 2, auto_pick: false, wait: false },
        });
        expect(result).toEqual({ jobId: "job-10", status: "queued", shotId: "s1", promptId: "prompt-1" });
    });
    test("rejects accepted responses without a job or for another shot", async () => {
        api(() => Response.json({ job_id: "", status: "queued", project_id: "p1" }, { status: 202 }));
        await expect(submitPrimeBatch("p1", {})).rejects.toThrow("缺少作业号");
        api(() => ({ job_id: "job-11", status: "queued", shot_id: "other" }));
        await expect(submitPrimeShot("s1", {})).rejects.toThrow("返回的分镜不一致");
    });
    test("surfaces a structured keyframe rejection with status and hint", async () => {
        api(() => Response.json({ detail: {
            code: "KEYFRAME_REQUIRED", message: "按拍镜头需要首帧关键帧", hint: "先生成关键帧或改用直出",
        } }, { status: 422 }));
        let caught: any;
        try { await submitPrimeShot("s1", {}); } catch (error) { caught = error; }
        expect(caught?.status).toBe(422);
        expect(caught?.detail?.code).toBe("KEYFRAME_REQUIRED");
        expect(caught?.message).toContain("KEYFRAME_REQUIRED");
        expect(caught?.message).toContain("先生成关键帧");
    });
});
