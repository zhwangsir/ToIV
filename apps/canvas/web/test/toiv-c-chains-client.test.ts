import { describe, expect, test } from "bun:test";

import {
    assertCChainMakeupOnly,
    buildMakeupCChainFromDrama,
    type DramaLikeForCChain,
} from "../src/services/toiv/c-chains";

function drama(partial: Partial<DramaLikeForCChain> & { id: string }): DramaLikeForCChain {
    return {
        shots: [],
        characters: [],
        ...partial,
    };
}

describe("toiv c-chains pure guards (no axios / localforage)", () => {
    test("buildMakeup rejects drama with no usable shot prompts", () => {
        expect(() =>
            buildMakeupCChainFromDrama(
                drama({
                    id: "p1",
                    shots: [
                        { prompt: "  ", scene: "" },
                        {},
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
                characters: [{ id: "c1" }],
                shots: [
                    {
                        prompt: "走进店里",
                        dialogue: "你好",
                        speaker: "林夏",
                        camera: "中景",
                        scene: "便利店",
                        duration_sec: 8,
                    },
                    { scene: "仅场景当 prompt" },
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

    test("assertCChainMakeupOnly rejects non-makeup", () => {
        expect(() => assertCChainMakeupOnly({ type: "video" })).toThrow(/仅支持 start.type=makeup/);
        expect(() => assertCChainMakeupOnly({ type: "makeup" })).not.toThrow();
        expect(() => assertCChainMakeupOnly(undefined)).not.toThrow();
    });
});
