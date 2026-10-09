import { describe, expect, test } from "bun:test";

import {
    buildMakeupCChainFromDrama,
    createCChain,
    type ToivDramaDetail,
} from "../src/services/toiv/client";

function drama(partial: Partial<ToivDramaDetail> & { id: string }): ToivDramaDetail {
    return {
        status: "draft",
        shots: [],
        characters: [],
        ...partial,
    };
}

describe("toiv c-chains client guards (align da2dd223)", () => {
    test("buildMakeup rejects drama with no usable shot prompts", () => {
        expect(() =>
            buildMakeupCChainFromDrama(
                drama({
                    id: "p1",
                    shots: [
                        { id: "s1", idx: 0, status: "draft", prompt: "  ", scene: "" },
                        { id: "s2", idx: 1, status: "draft" },
                    ],
                }),
            ),
        ).toThrow(/没有可用分镜文案/);
    });

    test("buildMakeup maps shots to makeup body with project_id", () => {
        const body = buildMakeupCChainFromDrama(
            drama({
                id: "proj-a",
                width: 768,
                height: 1344,
                characters: [{ id: "c1", name: "林夏" }],
                shots: [
                    {
                        id: "s1",
                        idx: 0,
                        status: "draft",
                        prompt: "走进店里",
                        dialogue: "你好",
                        speaker: "林夏",
                        camera: "中景",
                        scene: "便利店",
                        duration_sec: 8,
                    },
                    { id: "s2", idx: 1, status: "draft", scene: "仅场景当 prompt" },
                ],
            }),
            { num_candidates: 1, auto_assemble: false },
        );
        expect(body.start).toEqual({ type: "makeup" });
        expect(body.project_id).toBe("proj-a");
        expect(body.pipeline).toBe("c_hybrid");
        expect(body.aspect_ratio).toBe("9:16");
        expect(body.num_candidates).toBe(1);
        expect(body.auto_assemble).toBe(false);
        expect(body.character_ids).toEqual(["c1"]);
        expect(body.resolution).toEqual({ width: 768, height: 1344 });
        expect(body.segments).toHaveLength(2);
        expect(body.segments[0]).toMatchObject({
            prompt: "走进店里",
            duration_sec: 8,
            dialogue: "你好",
            speaker: "林夏",
            camera: "中景",
            scene: "便利店",
        });
        expect(body.segments[1].prompt).toBe("仅场景当 prompt");
        expect(body.segments[1].duration_sec).toBe(6);
    });

    test("createCChain rejects non-makeup before POST", async () => {
        await expect(
            createCChain({
                start: { type: "video" },
                segments: [{ prompt: "x", duration_sec: 6 }],
            }),
        ).rejects.toThrow(/仅支持 start.type=makeup/);
    });
});
