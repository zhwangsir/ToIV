/** Wave2 absorb helpers (Toonflow/LumenX MIT adapted). */
import { describe, expect, test } from "bun:test";

describe("wave2 absorb toonflow", () => {
    test("arrangeSelectionBoxes horizontal keeps origin and gaps", () => {
        const { arrangeSelectionBoxes } = require("../src/lib/absorb/toonflow");
        const out = arrangeSelectionBoxes(
            [
                { id: "a", x: 10, y: 20, width: 100, height: 50 },
                { id: "b", x: 200, y: 40, width: 80, height: 60 },
            ],
            "horizontal",
        );
        expect(out[0].id).toBe("a");
        expect(out[0].x).toBe(10);
        // horizontal mode vertically centers within row height (Toonflow arrangeSelection)
        expect(out[0].y).toBe(20 + (60 - 50) / 2);
        expect(out[1].x).toBe(10 + 100 + 80);
    });

    test("floating agent dock width caps at 45% viewport", () => {
        const { computeFloatingAgentLayout } = require("../src/lib/absorb/toonflow");
        const dock = computeFloatingAgentLayout({
            presentation: "dock",
            viewportWidth: 1000,
            viewportHeight: 800,
            preferredWidth: 600,
        });
        expect(dock.width).toBe(450);
        expect(dock.left).toBe(550);
        expect(dock.height).toBe(800);
    });
});

describe("wave2 absorb lumenx", () => {
    test("derived views lock without master full body", () => {
        const { buildThreeViewLockState } = require("../src/lib/absorb/lumenx");
        const locked = buildThreeViewLockState({ threeView: "x.png" });
        expect(locked.derivedLocked).toBe(true);
        expect(locked.slots.find((s) => s.id === "three_view").locked).toBe(true);
        const open = buildThreeViewLockState({ fullBody: "m.png", threeView: "x.png" });
        expect(open.derivedLocked).toBe(false);
        expect(open.slots.find((s) => s.id === "three_view").locked).toBe(false);
    });
});
