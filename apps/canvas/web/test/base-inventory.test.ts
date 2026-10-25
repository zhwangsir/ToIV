import { describe, expect, it } from "vitest";
import {
    baseInventoryFooter,
    baseInventoryMeta,
    baseInventoryModelRef,
    familyOfBaseInventory,
    listBaseInventory,
    mergeSlotOptionsWithBaseInventory,
} from "@/lib/base-inventory";

describe("base-inventory P1b", () => {
    it("loads NAS seed with family honesty fields", () => {
        const meta = baseInventoryMeta();
        expect(meta.count).toBeGreaterThan(50);
        expect(meta.live).toBe(false);
        expect(meta.note).toMatch(/非实时|种子/);
        const items = listBaseInventory();
        expect(items.length).toBe(meta.count);
        const unknown = items.filter((i) => !i.familyResolved);
        expect(unknown.length).toBe(meta.familyUnknown);
        for (const u of unknown.slice(0, 5)) {
            expect(u.family).toBeNull();
        }
    });

    it("filters by slot and merges options without dupes", () => {
        const image = listBaseInventory({ slot: "image" });
        expect(image.length).toBeGreaterThan(10);
        const existing = [
            {
                value: `toiv-image::${image[0].basename}`,
                label: "already",
            },
        ];
        const merged = mergeSlotOptionsWithBaseInventory(existing, "image");
        expect(merged[0].value).toBe(existing[0].value);
        expect(merged.length).toBeGreaterThan(existing.length);
        const values = merged.map((o) => o.value.toLowerCase());
        expect(new Set(values).size).toBe(values.length);
    });

    it("H3 refs use H3 channel prefix", () => {
        const h3 = listBaseInventory({ slot: "video-primary" });
        expect(h3.length).toBeGreaterThan(0);
        const ref = baseInventoryModelRef(h3[0]);
        expect(ref.startsWith("MZt9ON1JvbabJ2GS-PvXR::")).toBe(true);
        expect(baseInventoryFooter("video-primary")).toMatch(/基座库存/);
    });

    it("familyOfBaseInventory resolves known basenames", () => {
        const qwen = listBaseInventory({ slot: "image" }).find((i) => i.family === "qwen-image");
        expect(qwen).toBeTruthy();
        expect(familyOfBaseInventory(qwen!.basename)).toBe("qwen-image");
        expect(familyOfBaseInventory(`toiv-image::${qwen!.basename}`)).toBe("qwen-image");
    });
});
