import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { CreationMediaPending, formatPendingElapsed } from "@/pages/create/creation-workspace";

describe("待生成占位的等待计时", () => {
    test("秒数格式化为 分:秒，永不出现负值", () => {
        expect(formatPendingElapsed(0)).toBe("0:00");
        expect(formatPendingElapsed(59)).toBe("0:59");
        expect(formatPendingElapsed(61)).toBe("1:01");
        expect(formatPendingElapsed(600)).toBe("10:00");
        expect(formatPendingElapsed(-3)).toBe("0:00");
    });

    test("视频占位显示计时与本地出片提示，图片占位不显示提示", () => {
        const video = renderToStaticMarkup(<CreationMediaPending mode="video" ratio="16:9" />);
        expect(video).toContain('data-testid="creation-media-pending-elapsed"');
        expect(video).toContain("0:00");
        expect(video).toContain('data-testid="creation-media-pending-hint"');
        expect(video).toContain("本地出片通常需要几分钟");

        const image = renderToStaticMarkup(<CreationMediaPending mode="image" ratio="1:1" />);
        expect(image).toContain('data-testid="creation-media-pending-elapsed"');
        expect(image).not.toContain('data-testid="creation-media-pending-hint"');
    });
});
