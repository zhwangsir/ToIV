import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
    assetDriftKindLabel,
    assetsMatchingCategory,
    buildReconcileDecisions,
    chapterShotHref,
    chunkReconcileDecisions,
    defaultReconcileDecision,
    incompleteReconcileGroupKeys,
    isCandidateGroupComplete,
    pendingDecisionCandidateId,
    RECONCILE_APPLY_MAX_DECISIONS,
    reconcileCandidateStatusLabel,
    reconcileOutcomeLabel,
    resolveReconcileDecision,
    suggestionMatchLabel,
} from "@/lib/asset-reconciliation";
import type { AssetReconciliationGroup, ReconcileDecision } from "@/services/api/projects";

function group(partial: Partial<AssetReconciliationGroup> & Pick<AssetReconciliationGroup, "key">): AssetReconciliationGroup {
    return {
        name: "林遥",
        category: "character",
        appearances: [],
        suggestion: { action: "merge", assetId: "asset-a", assetTitle: "林遥", match: "asset_name", reason: "候选与资产《林遥》名称一致，建议合并" },
        ...partial,
    };
}

describe("drift kind labels stay readable without inventing meanings", () => {
    test("covers every machine drift kind the backend emits", () => {
        expect(assetDriftKindLabel("shot_missing_reference")).toBe("镜头缺少资产引用");
        expect(assetDriftKindLabel("reference_version_behind_primary")).toBe("引用版本落后主版本");
        expect(assetDriftKindLabel("asset_multi_version_reference")).toBe("跨集多版本引用");
        expect(assetDriftKindLabel("stale_artifact")).toBe("产物已失效待重渲");
        expect(assetDriftKindLabel("character_reference_missing_representation")).toBe("角色缺少定妆表现");
        expect(assetDriftKindLabel("reference_asset_unlinked")).toBe("引用资产已不在项目");
    });

    test("unknown kinds fall back to the raw machine kind", () => {
        expect(assetDriftKindLabel("brand_new_kind")).toBe("brand_new_kind");
        expect(assetDriftKindLabel("")).toBe("");
    });
});

describe("suggestion match and outcome labels", () => {
    test("match labels cover deterministic name/alias matching only", () => {
        expect(suggestionMatchLabel("resolved")).toBe("已有归并结果");
        expect(suggestionMatchLabel("asset_name")).toBe("名称一致");
        expect(suggestionMatchLabel("asset_alias")).toBe("别名一致");
        expect(suggestionMatchLabel("none")).toBe("无同名资产");
        expect(suggestionMatchLabel("surprise")).toBe("surprise");
    });

    test("outcome labels cover apply receipts", () => {
        expect(reconcileOutcomeLabel("applied")).toBe("已应用");
        expect(reconcileOutcomeLabel("already_confirmed")).toBe("此前已确认");
        expect(reconcileOutcomeLabel("auto_linked")).toBe("同实体其他集已自动归并");
        expect(reconcileOutcomeLabel("mystery")).toBe("mystery");
    });
});

describe("candidate identity group visibility", () => {
    test("groups whose appearances are all confirmed stay hidden", () => {
        expect(isCandidateGroupComplete(group({
            key: "k1",
            appearances: [
                { candidateId: "c1", status: "confirmed", resolvedAssetId: "asset-a" },
                { candidateId: "c2", status: "confirmed", resolvedAssetId: "asset-a" },
            ],
        }))).toBe(true);
    });

    test("groups with pending or ignored appearances remain visible", () => {
        expect(isCandidateGroupComplete(group({
            key: "k2",
            appearances: [{ candidateId: "c1", status: "pending_confirmation" }],
        }))).toBe(false);
        expect(isCandidateGroupComplete(group({
            key: "k3",
            appearances: [{ candidateId: "c1", status: "ignored" }],
        }))).toBe(false);
        expect(isCandidateGroupComplete(group({ key: "k4", appearances: [] }))).toBe(false);
    });
});

describe("one pending decision per entity", () => {
    test("the decision lands on the first pending appearance of the entity", () => {
        const entity = group({
            key: "character:linyao",
            appearances: [
                { candidateId: "c-1-1", unitId: "u1", status: "pending_confirmation" },
                { candidateId: "c-2-1", unitId: "u2", status: "pending_confirmation" },
                { candidateId: "c-3-1", unitId: "u3", status: "confirmed", resolvedAssetId: "asset-a" },
            ],
        });
        expect(pendingDecisionCandidateId(entity)).toBe("c-1-1");
    });

    test("entities without a pending appearance contribute no decision", () => {
        const resolved = group({
            key: "character:done",
            appearances: [{ candidateId: "c1", status: "confirmed", resolvedAssetId: "asset-a" }],
        });
        expect(pendingDecisionCandidateId(resolved)).toBe("");
        expect(buildReconcileDecisions([resolved], {})).toEqual([]);
    });
});

describe("default and overridden merge/create decisions", () => {
    test("merge suggestion defaults to merge with its target asset", () => {
        const entity = group({
            key: "k",
            suggestion: { action: "merge", assetId: "asset-a", assetTitle: "林遥", match: "asset_name", reason: "名称一致" },
            appearances: [{ candidateId: "c1", status: "pending_confirmation" }],
        });
        expect(defaultReconcileDecision(entity)).toEqual({ action: "merge", assetId: "asset-a" });
    });

    test("create suggestion defaults to create without a target asset", () => {
        const entity = group({
            key: "k",
            suggestion: { action: "create", match: "none", reason: "未找到同名资产" },
            appearances: [{ candidateId: "c1", status: "pending_confirmation" }],
        });
        expect(defaultReconcileDecision(entity)).toEqual({ action: "create", assetId: undefined });
    });

    test("inline override wins over the suggestion", () => {
        const entity = group({
            key: "k",
            suggestion: { action: "create", match: "none", reason: "未找到同名资产" },
            appearances: [{ candidateId: "c1", status: "pending_confirmation" }],
        });
        expect(resolveReconcileDecision(entity, { k: { action: "merge", assetId: "asset-b" } })).toEqual({ action: "merge", assetId: "asset-b" });
        expect(resolveReconcileDecision(entity, {})).toEqual({ action: "create", assetId: undefined });
    });

    test("merge without a target asset is incomplete and is not submitted", () => {
        const entity = group({
            key: "k",
            appearances: [{ candidateId: "c1", status: "pending_confirmation" }],
        });
        expect(incompleteReconcileGroupKeys([entity], { k: { action: "merge" } })).toEqual(["k"]);
        expect(buildReconcileDecisions([entity], { k: { action: "merge" } })).toEqual([]);
        expect(buildReconcileDecisions([entity], { k: { action: "merge", assetId: "asset-b" } })).toEqual([
            { candidateId: "c1", action: "merge", assetId: "asset-b" },
        ]);
    });

    test("batch keeps exactly one decision per entity even with multi-episode pending appearances", () => {
        const linYao = group({
            key: "character:linyao",
            appearances: [
                { candidateId: "c-1-1", status: "pending_confirmation" },
                { candidateId: "c-2-1", status: "pending_confirmation" },
            ],
        });
        const umbrella = group({
            key: "prop:heisan",
            name: "黑伞",
            category: "prop",
            suggestion: { action: "create", match: "none", reason: "未找到同名资产" },
            appearances: [{ candidateId: "c-1-2", status: "pending_confirmation" }],
        });
        expect(buildReconcileDecisions([linYao, umbrella], { "prop:heisan": { action: "merge", assetId: "asset-shop" } })).toEqual([
            { candidateId: "c-1-1", action: "merge", assetId: "asset-a" },
            { candidateId: "c-1-2", action: "merge", assetId: "asset-shop" },
        ]);
    });
});

describe("reconciliation API modules stay on the http channel", () => {
    const source = readFileSync(resolve(import.meta.dir, "../src/services/api/projects.ts"), "utf8");

    test("GET and POST reconciliation wrappers use http with the backend routes", () => {
        expect(source).toContain("asset-reconciliation");
        expect(source).toContain("asset-reconciliation/apply");
        expect(/http\.get<[^>]+>\(`\/projects\/\$\{encodeURIComponent\(projectId\)\}\/asset-reconciliation`/.test(source)).toBe(true);
        expect(/http\.post<[^>]+>\(`\/projects\/\$\{encodeURIComponent\(projectId\)\}\/asset-reconciliation\/apply`, \{ decisions \}\)/.test(source)).toBe(true);
    });
});

describe("no fabricated confidence or ref_epoch in the reconciliation surface", () => {
    for (const file of ["src/lib/asset-reconciliation.ts", "src/pages/projects/detail/project-asset-reconciliation.tsx"]) {
        test(`${file} must not invent AI confidence or ref epochs`, () => {
            const source = readFileSync(resolve(import.meta.dir, "..", file), "utf8");
            expect(/confidence|置信|ref_epoch|refEpoch/i.test(source)).toBe(false);
        });
    }
});

describe("decision batches never exceed the backend cap", () => {
    const many = (count: number): ReconcileDecision[] => Array.from({ length: count }, (_, index) => ({ candidateId: `c-${index}`, action: "create" as const }));

    test("over-cap decision lists split into safe batches without dropping any decision", () => {
        const batches = chunkReconcileDecisions(many(120));
        expect(batches.map((batch) => batch.length)).toEqual([50, 50, 20]);
        expect(batches.flat().map((decision) => decision.candidateId)).toEqual(many(120).map((decision) => decision.candidateId));
    });

    test("exactly the cap and below stay a single batch", () => {
        expect(chunkReconcileDecisions(many(RECONCILE_APPLY_MAX_DECISIONS)).map((batch) => batch.length)).toEqual([50]);
        expect(chunkReconcileDecisions(many(3))).toHaveLength(1);
    });

    test("no decisions means no batch to submit", () => {
        expect(chunkReconcileDecisions([])).toEqual([]);
    });
});

describe("receipt labels map statuses to Chinese without inventing new states", () => {
    test("known candidate statuses get readable labels", () => {
        expect(reconcileCandidateStatusLabel("confirmed")).toBe("已确认");
        expect(reconcileCandidateStatusLabel("pending_confirmation")).toBe("待确认");
        expect(reconcileCandidateStatusLabel("ignored")).toBe("已忽略");
    });

    test("unknown statuses fall back to the raw backend value", () => {
        expect(reconcileCandidateStatusLabel("weird_state")).toBe("weird_state");
    });
});

describe("merge targets stay inside the entity category", () => {
    test("only same-category assets are offered as merge targets", () => {
        const assets = [
            { id: "a1", category: "character" },
            { id: "a2", category: "prop" },
            { id: "a3", category: "character" },
            { id: "a4", category: "environment" },
        ];
        expect(assetsMatchingCategory(assets, "character").map((asset) => asset.id)).toEqual(["a1", "a3"]);
        expect(assetsMatchingCategory(assets, "prop").map((asset) => asset.id)).toEqual(["a2"]);
        expect(assetsMatchingCategory(assets, "material")).toEqual([]);
    });
});

describe("drift deep links target the chapter workspace", () => {
    test("unit with shot links to the chapter workspace with the shot query", () => {
        expect(chapterShotHref("proj-1", "unit-1", "shot-1-1")).toBe("/projects/proj-1/chapters/unit-1?shot=shot-1-1");
    });

    test("unit without shot links to the chapter workspace plain", () => {
        expect(chapterShotHref("proj-1", "unit-2")).toBe("/projects/proj-1/chapters/unit-2");
    });

    test("shot without unit cannot form a chapter link and stays text", () => {
        expect(chapterShotHref("proj-1", "", "shot-9")).toBe("");
    });
});
