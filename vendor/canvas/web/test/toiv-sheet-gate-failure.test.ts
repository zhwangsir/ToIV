import { describe, expect, test } from "bun:test";

import {
    SheetGateJobError,
    sheetFailureFromCaughtError,
    sheetFailureFromJobResult,
} from "@/services/toiv/sheet-gate-failure";

describe("sheet gate failure UX", () => {
    test("structured job error → preview + 人话 + soft keep", () => {
        const view = sheetFailureFromJobResult(
            {
                status: "error",
                error: "服装颜色未过门禁（常见：板岩灰偏差/过浅过深）",
                reason_code: "slate_color",
                reason_zh: "服装颜色未过门禁（常见：板岩灰偏差/过浅过深）",
                technical_detail: "颜色门禁失败:portrait服装主色过浅近白",
                rejected_preview_url: "/api/studio/files/char_panel_x_anime_rejected_portrait_a.png?sig=abc",
                soft_keep_available: true,
                style: "anime",
                gate_failures: [
                    {
                        code: "slate_color",
                        title: "服装颜色未过门禁（常见：板岩灰偏差/过浅过深）",
                        detail: "颜色门禁失败:portrait服装主色过浅近白",
                        preview_url: "/api/studio/files/char_panel_x_anime_rejected_portrait_a.png?sig=abc",
                    },
                ],
            },
            "anime",
        );
        expect(view.reasonZh).toContain("板岩");
        expect(view.technicalDetail).toContain("颜色门禁");
        expect(view.previewUrl).toContain("rejected_portrait");
        expect(view.softKeepAvailable).toBe(true);
        expect(view.style).toBe("anime");
    });

    test("legacy string-only error still shows reason, no soft keep", () => {
        const view = sheetFailureFromJobResult({ status: "error", error: "一致性门禁失败:主立绘胸口检出贴标/徽标" });
        expect(view.reasonZh).toContain("徽标");
        expect(view.previewUrl).toBeNull();
        expect(view.softKeepAvailable).toBe(false);
    });

    test("SheetGateJobError preserves view via caught helper", () => {
        const view = sheetFailureFromJobResult({
            status: "error",
            reason_zh: "胸口检出徽标/贴标（设定卡要求素面）",
            technical_detail: "一致性门禁失败:主立绘胸口检出贴标/徽标",
            rejected_preview_url: "/api/studio/files/x.png?sig=1",
            soft_keep_available: true,
            style: "anime",
            reason_code: "emblem",
        });
        const err = new SheetGateJobError(view);
        const again = sheetFailureFromCaughtError(err, "anime");
        expect(again.reasonZh).toContain("徽标");
        expect(again.previewUrl).toContain("x.png");
        expect(again.softKeepAvailable).toBe(true);
    });
});
