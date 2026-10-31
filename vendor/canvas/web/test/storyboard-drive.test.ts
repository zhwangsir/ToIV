import { describe, expect, test } from "bun:test";

import {
    DEFAULT_STORYBOARD_DRIVE_MODE,
    defaultShotViewModeForDrive,
    isKeyframeDriveMode,
    normalizeStoryboardDriveMode,
    shotHasKeyframe,
    videoRenderGate,
} from "../src/services/toiv/storyboard-drive";

describe("storyboard-drive F1", () => {
    test("default is keyframe", () => {
        expect(DEFAULT_STORYBOARD_DRIVE_MODE).toBe("keyframe");
        expect(normalizeStoryboardDriveMode(undefined)).toBe("keyframe");
        expect(normalizeStoryboardDriveMode("DIRECT")).toBe("direct");
        expect(isKeyframeDriveMode("keyframe")).toBe(true);
        expect(isKeyframeDriveMode("direct")).toBe(false);
    });

    test("default view is pipeline under keyframe", () => {
        expect(defaultShotViewModeForDrive("keyframe")).toBe("pipeline");
        expect(defaultShotViewModeForDrive("direct")).toBe("list");
    });

    test("videoRenderGate blocks without image_url in keyframe mode", () => {
        const g = videoRenderGate({ status: "draft" }, "keyframe");
        expect(g.allowed).toBe(false);
        expect(g.code).toBe("KEYFRAME_REQUIRED");
        expect(g.hint).toContain("关键帧");
    });

    test("videoRenderGate allows with keyframe or direct mode", () => {
        expect(shotHasKeyframe({ image_url: "/api/studio/files/a.png" })).toBe(true);
        expect(videoRenderGate({ status: "draft", image_url: "/x.png" }, "keyframe").allowed).toBe(true);
        expect(videoRenderGate({ status: "draft" }, "direct").allowed).toBe(true);
        expect(videoRenderGate({ status: "rendered" }, "keyframe").allowed).toBe(true);
        expect(videoRenderGate({ status: "draft", video_url: "/v.mp4" }, "keyframe").allowed).toBe(true);
    });
});
