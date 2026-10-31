import { describe, expect, test } from "bun:test";

import { canPickCandidate, candidateConflictMessage, candidateQaVerdict } from "../src/components/toiv/take-compare-panel";
import type { ToivDramaShotCandidate } from "../src/services/toiv/client";

function candidate(partial: Partial<ToivDramaShotCandidate>): ToivDramaShotCandidate {
    return { id: "candidate-1", status: "done", url: "/candidate.mp4", ...partial };
}

describe("D1b 候选准入选", () => {
    test("只有 done + 非空 url 可选", () => {
        expect(canPickCandidate(candidate({}))).toBe(true);
        for (const status of ["queued", "generating", "error", "superseded", "rendered"]) {
            expect(canPickCandidate(candidate({ status })), status).toBe(false);
        }
        expect(canPickCandidate(candidate({ url: undefined }))).toBe(false);
        expect(canPickCandidate(candidate({ url: "  " }))).toBe(false);
    });
});

describe("D1b 候选真实元数据与冲突", () => {
    test("QA verdict 有才显示，未知对象不编造", () => {
        expect(candidateQaVerdict(candidate({ qa: { verdict: "warn", reason: "手部需复核" } }))).toBe("warn");
        expect(candidateQaVerdict(candidate({ qa: {} }))).toBeNull();
        expect(candidateQaVerdict(candidate({}))).toBeNull();
    });

    test("409 detail 透出；其他错误不误判为候选冲突", () => {
        expect(candidateConflictMessage({ response: { status: 409, data: { detail: "候选已被并发拍板" } } })).toBe("候选已被并发拍板");
        expect(candidateConflictMessage({ response: { status: 409 } })).toContain("候选列表已变化");
        expect(candidateConflictMessage({ response: { status: 500 } })).toBeNull();
        expect(candidateConflictMessage(new Error("network"))).toBeNull();
    });
});
