import { describe, expect, test } from "bun:test";

import {
    cellStateToLampState,
    controlLampStateLabel,
    controlLampTone,
    projectControlReadinessLamps,
} from "../src/services/toiv/control-readiness";

describe("control-readiness F1", () => {
    test("empty project lamps are off / blocked makeup", () => {
        const lamps = projectControlReadinessLamps({
            shots: [],
            charactersWithMakeup: 0,
            characterCount: 2,
        });
        expect(lamps.map((l) => l.id)).toEqual([
            "makeup",
            "frame",
            "video",
            "voice",
            "lipsync",
            "assemble",
        ]);
        expect(lamps.find((l) => l.id === "makeup")?.state).toBe("blocked");
        expect(lamps.find((l) => l.id === "frame")?.state).toBe("off");
        expect(controlLampStateLabel("ready")).toBe("亮");
        expect(controlLampTone("failed")).toBe("error");
    });

    test("aggregates frame/video readiness from shots", () => {
        const lamps = projectControlReadinessLamps({
            shots: [
                {
                    id: "1",
                    idx: 1,
                    status: "draft",
                    prompt: "雨夜",
                    image_url: "/f.png",
                } as any,
                {
                    id: "2",
                    idx: 2,
                    status: "rendered",
                    prompt: "便利店",
                    image_url: "/f2.png",
                    video_url: "/v.mp4",
                    dialogue: "别跟着我",
                } as any,
            ],
            charactersWithMakeup: 1,
            characterCount: 1,
        });
        expect(lamps.find((l) => l.id === "makeup")?.state).toBe("ready");
        expect(lamps.find((l) => l.id === "frame")?.state).toBe("ready");
        expect(lamps.find((l) => l.id === "video")?.state).toBe("partial");
        expect(cellStateToLampState("busy")).toBe("busy");
    });

    test("videoBlocked forces video lamp blocked", () => {
        const lamps = projectControlReadinessLamps({
            shots: [{ id: "1", idx: 1, status: "rendered", video_url: "/v.mp4" } as any],
            charactersWithMakeup: 1,
            characterCount: 1,
            videoBlocked: true,
        });
        expect(lamps.find((l) => l.id === "video")?.state).toBe("blocked");
    });
});
