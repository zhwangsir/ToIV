import { describe, expect, test } from "bun:test";

import {
    resolveStudioFailure,
    studioFailureQaHint,
    studioQaHumanMessage,
    studioQaMessageWithHint,
} from "../src/services/toiv/studio-qa-failure";

describe("studioQaHumanMessage", () => {
    test("pick candidate failure", () => {
        const msg = studioQaHumanMessage("pick", new Error("候选不存在"), "选用候选失败");
        expect(msg).toContain("候选");
        expect(msg).not.toContain(":8264");
    });

    test("voice 503", () => {
        const err = Object.assign(new Error("TTS 不可达"), { response: { status: 503 } });
        const msg = studioQaHumanMessage("voice", err, "配音失败");
        expect(msg).toContain("配音服务");
        expect(msg).not.toContain("9200");
    });

    test("fallback when unmatched", () => {
        expect(studioQaHumanMessage("generic", new Error("xyz"), "通用失败")).toBe("通用失败");
    });
});

describe("studio failure codes F1", () => {
    test("resolves KEYFRAME_REQUIRED with qa hint", () => {
        const r = resolveStudioFailure("keyframe", { code: "KEYFRAME_REQUIRED" }, "缺关键帧");
        expect(r.code).toBe("KEYFRAME_REQUIRED");
        expect(r.message).toContain("关键帧");
        expect(r.qaHint).toContain("配景");
        expect(studioFailureQaHint("KEYFRAME_REQUIRED")).toContain("配景");
    });

    test("message with hint concatenates next step", () => {
        const msg = studioQaMessageWithHint("render", new Error("请先完成定妆参考图"), "渲染失败");
        expect(msg).toContain("定妆");
        expect(msg).toContain("下一步");
    });

    test("assemble not ready code", () => {
        const r = resolveStudioFailure("assemble", new Error("还有镜头未就绪成片段"), "合成失败");
        expect(r.code).toBe("ASSEMBLE_SHOT_NOT_READY");
    });
});
