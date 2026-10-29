import { describe, expect, mock, test } from "bun:test";

mock.module("@/services/toiv/client", () => ({
    fetchDramaProjects: async () => [
        { id: "p1", title: "草船借箭", status: "active" },
        { id: "p2", title: "空项目", status: "draft" },
    ],
}));

const { loadCanvasHomeModel } = await import("@/studio/faces/canvas/model");

describe("loadCanvasHomeModel", () => {
    test("maps projects to cards with deterministic still seed", async () => {
        const model = await loadCanvasHomeModel();
        expect(model.cards.map((card) => card.title)).toEqual(["草船借箭", "空项目"]);
        for (const card of model.cards) {
            expect(card.stillSeed).toBeGreaterThanOrEqual(0);
            expect(card.stillSeed).toBeLessThan(4);
            expect(card.shotCount).toBe(0);
        }
        expect(model.empty).toBe(false);
    });
    test("same id yields same seed", async () => {
        const first = await loadCanvasHomeModel();
        const second = await loadCanvasHomeModel();
        expect(first.cards[0].stillSeed).toBe(second.cards[0].stillSeed);
    });
});
