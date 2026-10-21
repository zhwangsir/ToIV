import { describe, expect, test } from "bun:test";

import {
    JIANYING_DRAFT_FORMAT,
    canExportJianyingDraft,
    jianyingExportFilename,
    parseContentDispositionFilename,
} from "../src/services/toiv/jianying-draft";

describe("jianying-draft F4", () => {
    test("format constant", () => {
        expect(JIANYING_DRAFT_FORMAT).toBe("toiv_jianying_draft_v1");
    });

    test("canExport requires a clip url", () => {
        expect(canExportJianyingDraft([])).toBe(false);
        expect(canExportJianyingDraft([{ final_clip_url: "" }])).toBe(false);
        expect(canExportJianyingDraft([{ final_clip_url: "/api/studio/files/a.mp4" }])).toBe(true);
        expect(canExportJianyingDraft([{ video_url: "/api/studio/files/b.mp4" }])).toBe(true);
    });

    test("filename sanitize", () => {
        const name = jianyingExportFilename("雨夜 便利店!", "ABCDEF12-9999");
        expect(name.endsWith(".zip")).toBe(true);
        expect(name.includes("雨夜")).toBe(true);
        expect(name.includes("ABCDEF12")).toBe(true);
    });

    test("content-disposition parse", () => {
        expect(parseContentDispositionFilename('attachment; filename="a.zip"', "x.zip")).toBe("a.zip");
        expect(
            parseContentDispositionFilename("attachment; filename*=UTF-8''%E9%9B%A8%E5%A4%9C.zip", "x.zip"),
        ).toBe("雨夜.zip");
    });
});
