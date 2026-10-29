import { describe, expect, mock, test } from "bun:test";

mock.module("@/services/toiv/client", () => ({
    fetchDramaProject: async () => ({
        id: "p1", title: "草船借箭",
        shots: [
            { id: "sh1", idx: 0, status: "done", duration_sec: 4.5, dialogue: "或许我真不适合修仙", audio_media_status: "done", candidates: [{ id: "c1", is_picked: true }] },
            { id: "sh2", idx: 1, status: "done", duration_sec: 3, dialogue: "", candidates: [{ id: "c2", is_picked: true }] },
        ],
    }),
}));

const { loadEditModel } = await import("@/studio/faces/edit/model");

describe("loadEditModel", () => {
    test("builds v1 clips sequentially from shots", async () => {
        const model = await loadEditModel("p1");
        const v1 = model.clips.filter((clip) => clip.track === "v1");
        expect(v1.map((clip) => clip.startSec)).toEqual([0, 4.5]);
        expect(v1[0].durationSec).toBe(4.5);
        expect(model.totalSec).toBe(7.5);
    });
    test("dialogue becomes a1 clip aligned to its shot", async () => {
        const model = await loadEditModel("p1");
        const a1 = model.clips.filter((clip) => clip.track === "a1");
        expect(a1).toHaveLength(1);
        expect(a1[0].startSec).toBe(0);
        expect(a1[0].durationSec).toBe(4.5);
    });
    test("exposes shot strip entries", async () => {
        const model = await loadEditModel("p1");
        expect(model.shots.map((shot) => shot.title)).toEqual(["镜01", "镜02"]);
        expect(model.projectName).toBe("草船借箭");
    });
});
