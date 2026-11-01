import { afterEach, describe, expect, test } from "bun:test";
import {
    PRIME_STAGES, firstBlockingStage, parsePrimeStageProjection, stageActions, transitionPrimeStage,
} from "../src/toiv/adapters/stages";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function projection(overrides: Record<string, unknown> = {}) {
    return {
        script: { state: "confirmed", ready: true, blockers: [] },
        assets: { state: "skipped", ready: false, blockers: ["尚未创建角色卡"] },
        storyboard: { state: "pending_confirmation", ready: true, blockers: [] },
        generate: { state: "draft", ready: false, blockers: ["镜0 视觉产物未就绪(none)"] },
        voice: { state: "needs_review", ready: false, blockers: ["镜0 配音未就绪(none)"] },
        timeline: { state: "pending_confirmation", ready: true, blockers: [] },
        ...overrides,
    };
}
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

describe("Prime stage projection", () => {
    test("accepts only a complete six-stage projection and keeps a missing CAS revision explicit", () => {
        const parsed = parsePrimeStageProjection(projection(), 7);
        expect(parsed?.revision).toBe(7);
        expect(parsed?.states.storyboard).toEqual({ state: "pending_confirmation", ready: true, blockers: [] });
        expect(PRIME_STAGES.map(stage => stage.id)).toEqual(["script", "assets", "storyboard", "generate", "voice", "timeline"]);
        const withoutRevision = parsePrimeStageProjection(projection(), undefined);
        expect(withoutRevision?.revision).toBeNull();
        expect(withoutRevision?.states.script.state).toBe("confirmed");
    });
    test("rejects partial, mistyped or unknown projections instead of guessing stage state", () => {
        const missing = projection();
        delete (missing as Record<string, unknown>).voice;
        expect(parsePrimeStageProjection(missing, 1)).toBeNull();
        expect(parsePrimeStageProjection(projection({ generate: { state: "flying", ready: true, blockers: [] } }), 1)).toBeNull();
        expect(parsePrimeStageProjection(projection({ voice: { state: "confirmed", blockers: [] } }), 1)).toBeNull();
        expect(parsePrimeStageProjection(projection({ timeline: { state: "confirmed", ready: "yes", blockers: [] } }), 1)).toBeNull();
        expect(parsePrimeStageProjection([], 1)).toBeNull();
        expect(parsePrimeStageProjection(projection(), -1)).toBeNull();
    });
    test("drops non-text blockers while preserving every text blocker in server order", () => {
        const parsed = parsePrimeStageProjection(projection({
            generate: { state: "draft", ready: false, blockers: ["第一", 42, "", null, "第二"] },
        }), 0);
        expect(parsed?.states.generate.blockers).toEqual(["第一", "第二"]);
    });
    test("derives actions from server state: needs_review must reopen before confirm", () => {
        expect(stageActions({ state: "pending_confirmation", ready: true, blockers: [] })).toEqual({ canConfirm: true, canSkip: true, canReopen: false });
        expect(stageActions({ state: "needs_review", ready: true, blockers: [] })).toEqual({ canConfirm: false, canSkip: true, canReopen: true });
        expect(stageActions({ state: "confirmed", ready: true, blockers: [] })).toEqual({ canConfirm: false, canSkip: false, canReopen: true });
        expect(stageActions({ state: "skipped", ready: false, blockers: [] })).toEqual({ canConfirm: false, canSkip: false, canReopen: true });
        expect(stageActions({ state: "draft", ready: false, blockers: ["尚无分镜"] })).toEqual({ canConfirm: false, canSkip: true, canReopen: false });
        expect(stageActions({ state: "generating", ready: false, blockers: [] })).toEqual({ canConfirm: false, canSkip: false, canReopen: false });
        expect(stageActions({ state: "failed", ready: false, blockers: [] })).toEqual({ canConfirm: false, canSkip: false, canReopen: false });
    });
    test("finds the first stage that is neither confirmed nor skipped", () => {
        expect(firstBlockingStage(projection())).toBe("storyboard");
        expect(firstBlockingStage(projection({ script: { state: "confirmed", ready: true, blockers: [] }, assets: { state: "confirmed", ready: true, blockers: [] } }))).toBe("storyboard");
        expect(firstBlockingStage(projection({
            storyboard: { state: "confirmed", ready: true, blockers: [] },
            generate: { state: "confirmed", ready: true, blockers: [] },
            voice: { state: "skipped", ready: false, blockers: [] },
            timeline: { state: "confirmed", ready: true, blockers: [] },
        }))).toBeNull();
    });
});

describe("Prime stage transitions", () => {
    test("skip requires a real note before any request is sent", async () => {
        const calls = api(() => projection());
        for (const note of ["", " ", "x"]) {
            await expect(transitionPrimeStage("p1", { stage: "storyboard", action: "skip", note, expectingRevision: 7 })).rejects.toThrow("跳过阶段须填写说明");
        }
        expect(calls).toHaveLength(0);
    });
    test("posts the CAS baseline and returns the server projection, not a local guess", async () => {
        const next = projection({ storyboard: { state: "confirmed", ready: true, blockers: [] } });
        const calls = api(() => ({ project_id: "p1", stage: "storyboard", stage_states: next, stage_revision: 8 }));
        const result = await transitionPrimeStage("p1", { stage: "storyboard", action: "confirm", note: "", expectingRevision: 7 });
        expect(calls[0]).toEqual({ path: "/api/studio/projects/p1/stage-transition", method: "POST",
            body: { stage: "storyboard", action: "confirm", expected_stage_revision: 7 } });
        expect(result.revision).toBe(8);
        expect(result.states.storyboard.state).toBe("confirmed");
    });
    test("rejects an incomplete transition response instead of assuming success", async () => {
        const partial = projection();
        delete (partial as Record<string, unknown>).timeline;
        api(() => ({ project_id: "p1", stage: "storyboard", stage_states: partial, stage_revision: 8 }));
        await expect(transitionPrimeStage("p1", { stage: "storyboard", action: "confirm", note: "", expectingRevision: 7 }))
            .rejects.toThrow("阶段已提交");
    });
    test("keeps the backend 409 conflict text and status for a stale revision", async () => {
        api(() => Response.json({ detail: "阶段已被其他修改更新(stage_revision=9)" }, { status: 409 }));
        let caught: any;
        try { await transitionPrimeStage("p1", { stage: "storyboard", action: "confirm", note: "", expectingRevision: 7 }); }
        catch (error) { caught = error; }
        expect(caught?.status).toBe(409);
        expect(caught?.message).toContain("stage_revision=9");
    });
});
