import { describe, expect, test } from "bun:test";

import {
    DRAMA_BOARD_COLUMNS,
    DRAMA_PIPELINE_STAGES,
    dramaPipelineCellState,
    dramaShotBoardColumn,
    groupShotsByBoardColumn,
    toDramaPipelineRows,
    toDramaShotProjection,
} from "../src/pages/toiv/drama-shot-board";

describe("drama-shot-board projection", () => {
    test("columns cover pending→done/failed", () => {
        expect(DRAMA_BOARD_COLUMNS.map((c) => c.id)).toEqual([
            "pending",
            "generating",
            "rendered",
            "audio",
            "done",
            "failed",
        ]);
    });

    test("maps status/voice/final into board columns", () => {
        expect(dramaShotBoardColumn({ status: "draft" })).toBe("pending");
        expect(dramaShotBoardColumn({ status: "queued" })).toBe("generating");
        expect(dramaShotBoardColumn({ status: "rendering" })).toBe("generating");
        expect(dramaShotBoardColumn({ status: "rendered" })).toBe("rendered");
        expect(dramaShotBoardColumn({ status: "rendered", voice_url: "/v.wav" })).toBe("audio");
        expect(dramaShotBoardColumn({ status: "voiced" })).toBe("audio");
        expect(dramaShotBoardColumn({ status: "done" })).toBe("done");
        expect(dramaShotBoardColumn({ status: "rendered", final_clip_url: "/f.mp4" })).toBe("done");
        expect(dramaShotBoardColumn({ status: "failed" })).toBe("failed");
    });

    test("groupShotsByBoardColumn keeps all ids", () => {
        const shots = [
            { id: "a", status: "draft" },
            { id: "b", status: "rendered" },
            { id: "c", status: "error" },
        ];
        const g = groupShotsByBoardColumn(shots);
        expect(g.pending.map((s) => s.id)).toEqual(["a"]);
        expect(g.rendered.map((s) => s.id)).toEqual(["b"]);
        expect(g.failed.map((s) => s.id)).toEqual(["c"]);
    });

    test("toDramaShotProjection exposes同源字段", () => {
        const proj = toDramaShotProjection(
            {
                id: "shot-1",
                idx: 3,
                status: "rendered",
                prompt: "雨夜",
                dialogue: "别跟着我",
                video_url: "/x.mp4",
            } as any,
            "ref2va",
        );
        expect(proj.shotId).toBe("shot-1");
        expect(proj.idx).toBe(3);
        expect(proj.pipeline).toBe("ref2va");
        expect(proj.videoUrl).toBe("/x.mp4");
        expect(proj.dialogue).toBe("别跟着我");
    });

    test("pipeline stages are 文→帧→视频→配音→口型", () => {
        expect(DRAMA_PIPELINE_STAGES.map((s) => s.id)).toEqual([
            "text",
            "frame",
            "video",
            "voice",
            "lipsync",
        ]);
    });

    test("dramaPipelineCellState projects同源字段", () => {
        const draft = { status: "draft", prompt: "雨夜", dialogue: "" };
        expect(dramaPipelineCellState(draft, "text")).toBe("ready");
        expect(dramaPipelineCellState(draft, "frame")).toBe("empty");
        expect(dramaPipelineCellState(draft, "voice")).toBe("skipped");

        const rendered = {
            status: "rendered",
            prompt: "雨夜",
            dialogue: "别跟着我",
            image_url: "/i.png",
            video_url: "/v.mp4",
        };
        expect(dramaPipelineCellState(rendered, "frame")).toBe("ready");
        expect(dramaPipelineCellState(rendered, "video")).toBe("ready");
        expect(dramaPipelineCellState(rendered, "voice")).toBe("empty");
        expect(dramaPipelineCellState({ ...rendered, voice_url: "/a.wav" }, "voice")).toBe("ready");
        expect(dramaPipelineCellState({ status: "queued", prompt: "x" }, "video")).toBe("busy");
        expect(dramaPipelineCellState({ status: "failed", prompt: "x" }, "video")).toBe("failed");
    });

    test("toDramaPipelineRows keeps shot ids and projection", () => {
        const rows = toDramaPipelineRows(
            [
                {
                    id: "s1",
                    idx: 1,
                    status: "rendered",
                    prompt: "雨夜",
                    dialogue: "走",
                    video_url: "/v.mp4",
                } as any,
            ],
            "ref2va",
        );
        expect(rows).toHaveLength(1);
        expect(rows[0].shotId).toBe("s1");
        expect(rows[0].projection.pipeline).toBe("ref2va");
        expect(rows[0].cells.video).toBe("ready");
        expect(rows[0].cells.voice).toBe("empty");
    });

});
