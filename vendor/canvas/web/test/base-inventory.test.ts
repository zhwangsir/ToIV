import { describe, expect, it } from "vitest";
import {
    baseInventoryFooter,
    baseInventoryMeta,
    baseInventoryModelRef,
    familyOfBaseInventory,
    listBaseInventory,
    mergeSlotOptionsWithBaseInventory,
} from "@/lib/base-inventory";
import { isNsfwAssetMarker } from "@/redline";

describe("base-inventory P1b", () => {
    it("loads NAS seed with family honesty fields", () => {
        const meta = baseInventoryMeta();
        expect(meta.count).toBeGreaterThan(50);
        // seed 可能标 live=true（实时 NAS 生成）或 false（离线种子）
        expect(typeof meta.live).toBe("boolean");
        if (!meta.live) expect(meta.note).toMatch(/非实时|种子/);
        const items = listBaseInventory({ includeNsfw: true });
        expect(items.length).toBe(meta.count);
        const unknown = items.filter((i) => !i.familyResolved);
        expect(unknown.length).toBe(meta.familyUnknown);
        // includeNsfw:false → 强制不含 NSFW；默认列表则保留已知 NSFW（灰化锁定由 UI）
        const sfwOnly = listBaseInventory({ includeNsfw: false });
        expect(sfwOnly.every((i) => !/nsfw/i.test(i.basename))).toBe(true);
        expect(sfwOnly.length).toBeLessThan(items.length);
        const defaultList = listBaseInventory();
        const nsfwInDefault = defaultList.filter((i) => /nsfw/i.test(i.basename));
        expect(nsfwInDefault.length).toBeGreaterThan(0);
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
    it("includeNsfw:false strips NSFW; default keeps known NSFW listable; mega naming marker", () => {
        const all = listBaseInventory({ includeNsfw: true });
        const nsfw = all.filter((i) => /nsfw/i.test(i.basename));
        expect(nsfw.length).toBeGreaterThan(0);
        const sfw = listBaseInventory({ includeNsfw: false });
        for (const item of nsfw) {
            expect(sfw.some((i) => i.basename === item.basename)).toBe(false);
        }
        // mega v12.2 may not be in seed yet; naming rule must still catch it
        expect(isNsfwAssetMarker("wan2.2-rapid-mega-aio-nsfw-v12.2.safetensors")).toBe(true);
        expect(isNsfwAssetMarker("wan2.2-rapid-mega-aio-v12.safetensors")).toBe(false);
    });
});

