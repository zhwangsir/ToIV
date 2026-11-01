import { afterEach, describe, expect, test } from "bun:test";

const realFetch = globalThis.fetch;
const realStorage = (globalThis as { localStorage?: unknown }).localStorage;
afterEach(() => {
    globalThis.fetch = realFetch;
    if (realStorage === undefined) delete (globalThis as { localStorage?: unknown }).localStorage;
    else (globalThis as { localStorage?: unknown }).localStorage = realStorage;
});

const ledger = {
    project_id: "p1",
    project_title: "第一集",
    episodes: [{
        project_id: "p1", title: "第一集", is_current: true, created_at: "2026-11-01T00:00:00+00:00",
        characters: [{ id: "c1", name: "林夏", ref_count: 2, refs: ["/r/a.png", "/r/b.png"], visual_prompt: "lin xia" }],
    }],
    assets: [{
        key: "character:林夏", kind: "character", name: "林夏", status: "outdated",
        canonical_entity_id: "e1", canonical_refs: ["/r/canon.png"],
        episodes: [{ project_id: "p1", character_id: "c1", ref_count: 2, refs: ["/r/a.png", "/r/b.png"], matches_canonical: false }],
        used_in_shot_ids: ["s1"],
    }],
    shots: [{
        shot_id: "s1", project_id: "p1", episode_title: "第一集", idx: 0, scene: "便利店",
        prompt: "推门而入", render_mode: "video",
        characters: [{ name: "林夏", ref_epoch: 0, ref_count: 1 }],
        scene_anchor: { anchor_id: "a1" },
        media: { visual: "none", audio: "none", final: "none" },
    }],
    drifts: [
        { code: "ASSET_MULTI_VERSION", severity: "warning", asset_key: "character:林夏", episode_ids: ["p1", "p2"], message: "两组参考图" },
        { code: "SHOT_MEDIA_STALE", severity: "warning", asset_key: "", shot_id: "s1", project_id: "p1", message: "镜头过期" },
    ],
    suggestions: [{ asset_key: "character:林夏", action: "merge", entity_id: "e1", confidence: 1, reason: "补进正典空槽" }],
    receipts: [{ receipt_id: "r1", action: "merge", asset_key: "character:林夏", entity_id: "e1", created_at: "2026-11-01T01:00:00+00:00" }],
};

describe("prime asset ledger adapter", () => {
    test("maps the ledger contract into camelCase and keeps shot drift targets", async () => {
        (globalThis as { localStorage?: unknown }).localStorage = { getItem: () => "session" };
        let seenUrl = "";
        globalThis.fetch = (async (input: RequestInfo | URL) => {
            seenUrl = String(input);
            return new Response(JSON.stringify(ledger), { status: 200 });
        }) as typeof fetch;
        const { loadPrimeAssetLedger } = await import("../src/toiv/adapters/assetLedger");
        const model = await loadPrimeAssetLedger("p1");
        expect(seenUrl).toBe("/api/studio/projects/p1/asset-ledger");
        expect(model.projectTitle).toBe("第一集");
        expect(model.episodes[0]).toMatchObject({ projectId: "p1", isCurrent: true });
        expect(model.assets[0]).toMatchObject({
            key: "character:林夏", status: "outdated", canonicalEntityId: "e1",
            episodes: [{ projectId: "p1", characterId: "c1", matchesCanonical: false }],
            usedInShotIds: ["s1"],
        });
        expect(model.shots[0]).toMatchObject({
            shotId: "s1", projectId: "p1", media: { visual: "none", audio: "none", final: "none" },
        });
        expect(model.shots[0].characters[0]).toEqual({ name: "林夏", refEpoch: 0, refCount: 1 });
        expect(model.shots[0].sceneAnchor).toEqual({ anchor_id: "a1" });
        expect(model.drifts[1]).toMatchObject({ code: "SHOT_MEDIA_STALE", shotId: "s1", projectId: "p1", severity: "warning" });
        expect(model.suggestions[0]).toEqual({
            assetKey: "character:林夏", action: "merge", entityId: "e1", confidence: 1, reason: "补进正典空槽",
        });
        expect(model.receipts[0]).toMatchObject({ receiptId: "r1", action: "merge", assetKey: "character:林夏" });
    });

    test("rejects an unknown asset status instead of pretending it is synced", async () => {
        (globalThis as { localStorage?: unknown }).localStorage = undefined;
        globalThis.fetch = (async () => new Response(JSON.stringify({
            ...ledger, assets: [{ ...ledger.assets[0], status: "probably_fine" }],
        }), { status: 200 })) as unknown as typeof fetch;
        const { loadPrimeAssetLedger } = await import("../src/toiv/adapters/assetLedger");
        await expect(loadPrimeAssetLedger("p1")).rejects.toThrow("probably_fine");
    });

    test("applies with snake_case receipt payload and maps replay", async () => {
        let body: Record<string, unknown> = {};
        globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
            body = JSON.parse(String(init?.body));
            return new Response(JSON.stringify({
                applied: true, replayed: true, entity: { id: "e1", name: "林夏" },
                receipt: { receipt_id: "r-1", action: "merge", asset_key: "character:林夏", entity_id: "e1", created_at: "" },
            }), { status: 200 });
        }) as typeof fetch;
        const { applyPrimeLedgerAction } = await import("../src/toiv/adapters/assetLedger");
        const out = await applyPrimeLedgerAction("p1", {
            receiptId: "r-1", action: "merge", assetKey: "character:林夏", entityId: "e1",
        });
        expect(body).toEqual({ receipt_id: "r-1", action: "merge", asset_key: "character:林夏", entity_id: "e1" });
        expect(out).toMatchObject({ applied: true, replayed: true, entity: { id: "e1", name: "林夏" } });
        expect(out.receipt).toMatchObject({ receiptId: "r-1", action: "merge" });
    });

    test("surfaces the backend guard message", async () => {
        globalThis.fetch = (async () => new Response(JSON.stringify({ detail: "仅角色资产支持对账应用" }), { status: 422 })) as unknown as typeof fetch;
        const { applyPrimeLedgerAction } = await import("../src/toiv/adapters/assetLedger");
        await expect(applyPrimeLedgerAction("p1", {
            receiptId: "r-2", action: "create", assetKey: "scene:便利店",
        })).rejects.toThrow("仅角色资产支持对账应用");
    });
});
