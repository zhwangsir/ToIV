import { describe, expect, mock, test } from "bun:test";

mock.module("@/services/toiv/client", () => ({
    fetchDramaProject: async () => ({
        id: "p1", name: "草船借箭",
        shots: [
            { id: "sh1", idx: 0, status: "done", prompt: "晨雾悬崖", camera: "STATIC", duration_sec: 4.5,
                candidates: [{ id: "c1", seed: 88213, is_picked: true, url: "/m/1.png" }, { id: "c2", seed: 88214, url: "/m/2.png" }] },
            { id: "sh2", idx: 1, status: "running", prompt: "睁眼特写", camera: "DOLLY IN", duration_sec: 3, candidates: [] },
        ],
    }),
    listToivScenes: async () => ({
        scenes: [{
            id: "s1", project_id: "p1", name: "中军主帅营帐", environment_prompt: "INT / 日",
            master_ref: "/m/a.png", reverse_ref: "/m/b.png", frozen_anchor: { anchor_id: "master" },
            variants: [{ id: "s1v1", name: "左", master_ref: "/m/c.png" }, { id: "s1v2", name: "右", master_ref: null }],
        }],
        orphans: [],
    }),
}));

const { loadPipelineModel } = await import("@/studio/faces/pipeline/model");

describe("loadPipelineModel", () => {
    test("maps scenes to four-view groups with lock and wait padding", async () => {
        const model = await loadPipelineModel("p1");
        const group = model.scenes[0];
        expect(group.views.map((v) => v.label)).toEqual(["主视", "反打", "左立面", "右立面"]);
        expect(group.views[0].locked).toBe(true);
        expect(group.views[3].status).toBe("wait");
        expect(group.views[0].src).toBe("/m/a.png");
        expect(group.slug).toContain("INT");
    });
    test("maps shot candidates to takes with picked active", async () => {
        const model = await loadPipelineModel("p1");
        expect(model.shots[0].takes).toHaveLength(2);
        expect(model.shots[0].activeTakeId).toBe("c1");
        expect(model.shots[0].title).toBe("镜01");
        expect(model.shots[1].status).toBe("run");
    });
    test("exposes running count and companion hint", async () => {
        const model = await loadPipelineModel("p1");
        expect(model.runningCount).toBe(1);
        expect(model.companionHint.length).toBeGreaterThan(0);
        expect(model.stages).toHaveLength(7);
        expect(model.stages[model.stageIndex].label).toBe("素材准备");
    });
});
