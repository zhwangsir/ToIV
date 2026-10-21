import { describe, expect, test } from "bun:test";

import { studioQaHumanMessage } from "../src/services/toiv/studio-qa-failure";

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
