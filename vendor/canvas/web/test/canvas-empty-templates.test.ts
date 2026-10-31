import { describe, expect, test } from "bun:test";

import {
    CANVAS_EMPTY_TEMPLATES,
    CANVAS_TIDY_LAYOUT_LABEL,
    canvasEmptyTemplateById,
} from "../src/lib/canvas/canvas-empty-templates";
import { canvasPortBusinessLabel, canvasPortHoverTitle } from "../src/lib/canvas/canvas-port-business-labels";
import { createImageToVideoTemplate } from "../src/lib/canvas/canvas-image-to-video-template";
import {
    localCapabilityHoverTitle,
    localCapabilityProductLabel,
    localVideoEnginePresets,
} from "../src/services/toiv/local-capability-surface";
import { CanvasNodeType } from "../src/types/canvas";

describe("Wave P3 remaining: empty templates + port labels + engine presets", () => {
    test("empty canvas exposes ≥3 templates", () => {
        expect(CANVAS_EMPTY_TEMPLATES.length).toBeGreaterThanOrEqual(3);
        expect(CANVAS_EMPTY_TEMPLATES.map((t) => t.id)).toEqual(["short-drama", "image-to-video", "blank"]);
        expect(canvasEmptyTemplateById("short-drama").label).toContain("短剧");
        expect(CANVAS_TIDY_LAYOUT_LABEL).toBe("一键整理");
    });

    test("port hover uses business names not in_0 / bare ports", () => {
        expect(canvasPortBusinessLabel("target", CanvasNodeType.Video, "in_0")).toBe("首帧");
        expect(canvasPortBusinessLabel("target", CanvasNodeType.Video, "in_1")).toBe("尾帧");
        expect(canvasPortBusinessLabel("source", CanvasNodeType.Image)).toBe("图像输出");
        expect(canvasPortHoverTitle("left", CanvasNodeType.Text)).toContain("文本");
        expect(canvasPortHoverTitle("right", CanvasNodeType.Video)).not.toMatch(/:\d{4}/);
        expect(canvasPortHoverTitle("source", CanvasNodeType.Video, "in_0")).not.toContain("in_0");
    });

    test("product capability hover omits worker port; admin may include", () => {
        const badge = {
            kind: "h3" as const,
            label: "短剧视频",
            worker: ":8264",
            engine: "H3",
            protocol: "toiv-h3" as const,
        };
        expect(localCapabilityProductLabel(badge)).toBe("短视频引擎");
        expect(localCapabilityHoverTitle(badge)).toBe("本地 · 短视频引擎");
        expect(localCapabilityHoverTitle(badge)).not.toContain(":8264");
        expect(localCapabilityHoverTitle(badge, { admin: true })).toContain(":8264");
    });

    test("image-to-video template creates image→video with H3 default", () => {
        const tpl = createImageToVideoTemplate({ x: 100, y: 100 });
        expect(tpl.nodes).toHaveLength(2);
        expect(tpl.nodes[0].type).toBe(CanvasNodeType.Image);
        expect(tpl.nodes[1].type).toBe(CanvasNodeType.Video);
        expect(tpl.nodes[1].metadata?.model).toContain("::");
        expect(tpl.connections).toHaveLength(1);
        expect(tpl.connections[0].fromNodeId).toBe(tpl.imageNodeId);
        expect(tpl.connections[0].toNodeId).toBe(tpl.videoNodeId);
    });

    test("local video engine presets stay available for settings panel", () => {
        const presets = localVideoEnginePresets();
        expect(presets.length).toBeGreaterThanOrEqual(2);
        expect(presets.some((p) => p.protocol === "toiv-h3")).toBe(true);
        expect(presets.every((p) => !p.label.includes(":8264"))).toBe(true);
    });
});
