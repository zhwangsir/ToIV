import { describe, expect, test } from "bun:test";

import graph from "@/generated/model-compat-graph.json";
import {
    LOCAL_H3_FL2VA_BASENAME,
    LOCAL_IMAGE_CHECKPOINT_BASENAME,
} from "@/lib/local-model-defaults";
import {
    assertLoraCompatible,
    assertLorasCompatible,
    compatStatus,
    familyOfBase,
    listCompatCandidatesForSlot,
    modelCompatStats,
    queryCompat,
    resolveFamilyHint,
} from "@/lib/model-compat";
import { isH3ExclusiveLora } from "@/lib/model-compat";
import { listLoraInventory } from "@/lib/lora-inventory";

describe("model-compat graph ledger", () => {
    test("schema and join stay parallel to inventory", () => {
        expect(graph.schemaVersion).toBe(1);
        expect(graph.joinKey).toBe("basename");
        expect(graph.decisions?.D1).toBe("gray-force-heuristic");
        expect(graph.decisions?.D2).toBe("h3-strict-family");
        expect(graph.decisions?.D4).toBe("parallel-join");
        const stats = modelCompatStats();
        expect(stats.nodeCount).toBeGreaterThan(100);
        expect(stats.edgeCount).toBeGreaterThan(100);
        expect(stats.loraIndexed).toBe(listLoraInventory().length);
    });

    test("seed base models resolve to product families", () => {
        expect(familyOfBase(LOCAL_IMAGE_CHECKPOINT_BASENAME)).toBe("qwen-image");
        expect(familyOfBase(LOCAL_H3_FL2VA_BASENAME)).toBe("minimax-h3");
        expect(resolveFamilyHint("toiv-h3::local", "video-primary")).toBe("minimax-h3");
        expect(resolveFamilyHint("toiv-image::local-checkpoint", "image")).toBe("qwen-image");
    });

    test("D2: H3 exclusive never appears in image/motion A/B lists", () => {
        const img = listCompatCandidatesForSlot({
            slot: "image",
            baseHint: LOCAL_IMAGE_CHECKPOINT_BASENAME,
        });
        const motion = listCompatCandidatesForSlot({
            slot: "video-motion",
            baseHint: "local-wan",
        });
        for (const item of [...img.items, ...motion.items]) {
            const inv = listLoraInventory().find((i) => i.id === item.loraId);
            expect(isH3ExclusiveLora(item.loraId, inv)).toBe(false);
        }
        const h3 = listCompatCandidatesForSlot({
            slot: "video-primary",
            baseHint: LOCAL_H3_FL2VA_BASENAME,
        });
        expect(h3.baseFamily).toBe("minimax-h3");
        expect(h3.items.length).toBeGreaterThan(10);
        expect(h3.items.every((i) => compatStatus(i.loraId, "minimax-h3") !== "incompatible")).toBe(true);
    });

    test("D1: C items are marked heuristic; agent minConfidence B drops them", () => {
        // Prefer a family that still has naming-only C edges (e.g. motion/Wan).
        // After P1 Qwen HF→B upgrade, image/qwen may be A/B-only — that is OK.
        const motion = listCompatCandidatesForSlot({
            slot: "video-motion",
            baseHint: "local-wan",
        });
        const image = listCompatCandidatesForSlot({
            slot: "image",
            baseHint: LOCAL_IMAGE_CHECKPOINT_BASENAME,
        });
        const cPool = [...motion.items, ...image.items].filter((i) => i.confidence === "C");
        expect(cPool.length).toBeGreaterThan(0);
        expect(cPool.every((i) => i.heuristic)).toBe(true);

        const agent = queryCompat({
            baseId: LOCAL_IMAGE_CHECKPOINT_BASENAME,
            slot: "image",
            minConfidence: "B",
        });
        expect(agent.items.every((i) => i.confidence === "A" || i.confidence === "B")).toBe(true);
        expect(agent.items.every((i) => i.confidence !== "C")).toBe(true);
        // P1: Qwen green zone should be A/B-heavy
        expect(agent.items.length).toBeGreaterThan(10);
    });

    test("catalog H3 card is compatible with minimax-h3 and incompatible with qwen", () => {
        expect(compatStatus("HMNSFW_AIO_V2.safetensors", "minimax-h3")).toBe("compatible");
        expect(compatStatus("HMNSFW_AIO_V2.safetensors", "qwen-image")).toBe("incompatible");
    });

    test("sorting sinks C below A/B", () => {
        const ui = listCompatCandidatesForSlot({
            slot: "video-primary",
            baseHint: LOCAL_H3_FL2VA_BASENAME,
        });
        const ranks = ui.items.map((i) => (i.confidence === "A" ? 3 : i.confidence === "B" ? 2 : 1));
        for (let i = 1; i < ranks.length; i++) {
            expect(ranks[i]! <= ranks[i - 1]!).toBe(true);
        }
    });
});

describe("model-compat P1 usage + assert", () => {
    test("queryCompat returns strength and triggers fields", () => {
        const h3 = queryCompat({
            family: "minimax-h3",
            slot: "video-primary",
            minConfidence: "A",
            includeTriggers: true,
        });
        expect(h3.items.length).toBeGreaterThan(0);
        expect(h3.items.every((i) => typeof i.strength.default === "number")).toBe(true);
        const withTrig = h3.items.filter((i) => i.triggers.length > 0);
        expect(withTrig.length).toBeGreaterThan(0);
    });

    test("Qwen-image A/B green zone is much larger than P0 (~3)", () => {
        const q = queryCompat({
            baseId: LOCAL_IMAGE_CHECKPOINT_BASENAME,
            slot: "image",
            minConfidence: "B",
        });
        expect(q.baseFamily).toBe("qwen-image");
        expect(q.items.length).toBeGreaterThanOrEqual(20);
        expect(q.items.every((i) => i.confidence === "A" || i.confidence === "B")).toBe(true);
        expect(q.items.every((i) => !i.heuristic)).toBe(true);
    });

    test("assert blocks incompatible cross-family pin", () => {
        const bad = assertLoraCompatible({
            loraId: "HMNSFW_AIO_V2.safetensors",
            family: "qwen-image",
            slot: "image",
        });
        expect(bad.ok).toBe(false);
        expect(bad.status).toBe("incompatible");

        const good = assertLoraCompatible({
            loraId: "HMNSFW_AIO_V2.safetensors",
            family: "minimax-h3",
            slot: "video-primary",
        });
        expect(good.ok).toBe(true);
        expect(good.strength?.default).toBeGreaterThan(0);

        const batch = assertLorasCompatible({
            loraIds: ["HMNSFW_AIO_V2.safetensors", "Qwen-Image-Lightning-4steps-V2.0.safetensors"],
            family: "qwen-image",
            slot: "image",
        });
        expect(batch.ok).toBe(false);
        expect(batch.errors.length).toBeGreaterThan(0);
    });
});

describe("model-compat P2 conflicts + substitutes", () => {
    test("phase is P2 and file-level conflicts_with exist", () => {
        expect(graph.phase).toBe("P2");
        const fileConflicts = (graph.edges || []).filter(
            (e: { type?: string; scope?: string }) => e.type === "conflicts_with" && e.scope === "file",
        );
        expect(fileConflicts.length).toBeGreaterThan(0);
        const subs = (graph.edges || []).filter((e: { type?: string }) => e.type === "substitutes");
        expect(subs.length).toBeGreaterThan(0);
    });

    test("queryCompat exposes conflicts/substitutes; catalog edge is A; no P-C", () => {
        const h3 = queryCompat({
            family: "minimax-h3",
            slot: "video-primary",
            minConfidence: "A",
        });
        expect(h3.items.every((i) => i.purposeGrade !== "P-C")).toBe(true);
        const catalogish = h3.items.filter((i) => i.confidence === "A");
        expect(catalogish.length).toBeGreaterThan(0);
        // at least one catalog card should carry file conflict or substitute when role-mutex group ≥2
        const withExtra = h3.items.filter((i) => (i.conflicts?.length || 0) > 0 || (i.substitutes?.length || 0) > 0);
        expect(withExtra.length).toBeGreaterThan(0);
    });

    test("stats.phase reports P2", () => {
        expect(modelCompatStats().phase).toBe("P2");
    });
});
