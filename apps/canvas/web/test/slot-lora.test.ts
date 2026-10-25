import { describe, expect, test } from "bun:test";

import inventory from "@/generated/lora-inventory.json";
import { listLoraInventory, loraInventoryStats, inventoryToCandidates } from "@/lib/lora-inventory";
import {
    SLOT_LORA_CAP,
    SLOT_LORA_STORAGE_KEY,
    formatSlotLoraSummary,
    marketAppToLoraSlot,
    mergeLoraCandidates,
    readSlotLoras,
    resolvePinnedLorasForGenerate,
    slotLoraInventoryFooter,
    writeSlotLoras,
} from "@/lib/slot-lora";
import { LOCAL_H3_FL2VA_BASENAME, LOCAL_IMAGE_CHECKPOINT_BASENAME } from "@/lib/local-model-defaults";

describe("lora inventory (settings A+B × P-A/P-B)", () => {
    test("json is present and only ships allowed grades", () => {
        expect(inventory.count).toBeGreaterThan(200);
        expect(Array.isArray(inventory.items)).toBe(true);
        for (const item of inventory.items) {
            expect(["P-A", "P-B"]).toContain(item.purposeGrade);
            expect(["A", "B"]).toContain(item.sourceGrade);
            expect(item.slots.length).toBeGreaterThan(0);
        }
    });

    test("quarantine / P-C names are not in available inventory", () => {
        const ids = new Set(inventory.items.map((i: { id: string }) => i.id));
        // known quarantined basenames from purpose research
        expect(ids.has("30-360-high.safetensors")).toBe(false);
        expect(ids.has("i2l_smoke_20260827.safetensors")).toBe(false);
        expect(listLoraInventory().every((i) => i.purposeGrade === "P-A" || i.purposeGrade === "P-B")).toBe(true);
    });

    test("slot affinity covers image and video hangers", () => {
        const stats = loraInventoryStats();
        expect(stats.bySlot.image).toBeGreaterThan(50);
        expect(stats.bySlot["video-primary"]).toBeGreaterThan(10);
        expect(stats.bySlot["video-motion"]).toBeGreaterThan(50);
        expect(inventoryToCandidates("image").length).toBe(stats.bySlot.image);
        const footer = slotLoraInventoryFooter("image", { baseHint: "Qwen-Rapid-AIO-SFW-v23.safetensors" });
        expect(footer).toContain("兼容");
        expect(footer).toContain("P-A");
    });
});

describe("slot-lora hangers", () => {
    test("merge prefers inventory purpose/type/url onto engine candidates", () => {
        const merged = mergeLoraCandidates(
            [{ value: "foo.safetensors", label: "engine-foo", engineIds: ["h3"] }],
            [
                {
                    value: "foo.safetensors",
                    label: "inv-foo",
                    purposeZh: "测试用途",
                    purposeGrade: "P-A",
                    typeTag: "策划卡",
                    sourceUrl: "https://example.com/x",
                    fromInventory: true,
                },
            ],
        );
        expect(merged).toHaveLength(1);
        expect(merged[0]?.purposeZh).toBe("测试用途");
        expect(merged[0]?.typeTag).toBe("策划卡");
        expect(merged[0]?.sourceUrl).toContain("example.com");
        expect(merged[0]?.engineIds).toContain("h3");
    });

    test("merge falls back to inventory when engines empty", () => {
        const inv = inventoryToCandidates("video-primary").slice(0, 3);
        const merged = mergeLoraCandidates([], inv);
        expect(merged.length).toBe(inv.length);
        expect(merged[0]?.fromInventory).toBe(true);
    });

    test("read/write localStorage picks with cap and strength clamp", () => {
        const store = new Map<string, string>();
        // @ts-expect-error test stub
        globalThis.window = {
            localStorage: {
                getItem: (k: string) => store.get(k) ?? null,
                setItem: (k: string, v: string) => {
                    store.set(k, v);
                },
                removeItem: (k: string) => {
                    store.delete(k);
                },
            },
        };
        writeSlotLoras("image", [
            { name: "a.safetensors", strength: 0.8 },
            { name: "b.safetensors", strength: 9 },
            { name: "c.safetensors", strength: 0.5 },
            { name: "d.safetensors", strength: 0.5 },
        ]);
        const picks = readSlotLoras("image");
        expect(picks).toHaveLength(3);
        expect(picks[1]?.strength).toBe(2);
        expect(formatSlotLoraSummary(picks)).toContain("a.safetensors");
        expect(store.get(SLOT_LORA_STORAGE_KEY)).toContain("image");
        expect(SLOT_LORA_CAP).toBe(3);
    });
});

describe("slot-lora P1 generate resolve", () => {
    test("marketAppToLoraSlot maps h3/ltx/wan", () => {
        expect(marketAppToLoraSlot("h3-i2v")).toBe("video-primary");
        expect(marketAppToLoraSlot("ltx-i2v")).toBe("video-motion");
        expect(marketAppToLoraSlot("wan-animate")).toBe("video-motion");
    });

    test("resolvePinnedLorasForGenerate blocks incompatible settings pin", () => {
        const store = new Map<string, string>();
        // @ts-expect-error test stub
        globalThis.window = {
            localStorage: {
                getItem: (k: string) => store.get(k) ?? null,
                setItem: (k: string, v: string) => {
                    store.set(k, v);
                },
                removeItem: (k: string) => {
                    store.delete(k);
                },
            },
        };
        writeSlotLoras("image", [{ name: "HMNSFW_AIO_V2.safetensors", strength: 0.6 }]);
        const blocked = resolvePinnedLorasForGenerate({
            appId: "qwen-t2i",
            slot: "image",
            baseHint: LOCAL_IMAGE_CHECKPOINT_BASENAME,
            formLoras: [],
            hasLorasParam: true,
        });
        expect(blocked.ok).toBe(false);
        expect(blocked.errors.length).toBeGreaterThan(0);
        expect(blocked.source).toBe("settings");

        writeSlotLoras("video-primary", [{ name: "HMNSFW_AIO_V2.safetensors", strength: 0.6 }]);
        const ok = resolvePinnedLorasForGenerate({
            appId: "h3-i2v",
            slot: "video-primary",
            baseHint: LOCAL_H3_FL2VA_BASENAME,
            formLoras: [],
            hasLorasParam: true,
        });
        expect(ok.ok).toBe(true);
        expect(ok.loras[0]?.name).toContain("HMNSFW");
        expect(ok.source).toBe("settings");
    });

    test("schemaMissingLoras still validates without pretending inject", () => {
        const store = new Map<string, string>();
        // @ts-expect-error test stub
        globalThis.window = {
            localStorage: {
                getItem: (k: string) => store.get(k) ?? null,
                setItem: (k: string, v: string) => {
                    store.set(k, v);
                },
                removeItem: (k: string) => {
                    store.delete(k);
                },
            },
        };
        writeSlotLoras("video-primary", [{ name: "HMNSFW_AIO_V2.safetensors", strength: 0.8 }]);
        const r = resolvePinnedLorasForGenerate({
            appId: "h3-i2v",
            baseHint: LOCAL_H3_FL2VA_BASENAME,
            formLoras: null,
            hasLorasParam: false,
        });
        expect(r.schemaMissingLoras).toBe(true);
        expect(r.ok).toBe(true);
        expect(r.loras.length).toBe(1);
    });
});
