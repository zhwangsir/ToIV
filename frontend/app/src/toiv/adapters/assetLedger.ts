import type { PrimeMediaStatus } from "./storyboard";

export const LEDGER_ASSET_STATUSES = ["synced", "outdated", "local_only", "missing_reference"] as const;
export type PrimeLedgerAssetStatus = (typeof LEDGER_ASSET_STATUSES)[number];
export type PrimeLedgerAction = "merge" | "import" | "create";
export type PrimeLedgerSeverity = "info" | "warning";

export type PrimeLedgerCharacter = {
    id: string; name: string; refCount: number; refs: string[]; visualPrompt: string;
};
export type PrimeLedgerEpisode = {
    projectId: string; title: string; isCurrent: boolean; createdAt: string;
    characters: PrimeLedgerCharacter[];
};
export type PrimeLedgerAssetEpisode = {
    projectId: string; characterId: string | null; refCount: number; refs: string[];
    matchesCanonical: boolean | null;
};
export type PrimeLedgerAsset = {
    key: string; kind: string; name: string; status: PrimeLedgerAssetStatus;
    canonicalEntityId: string | null; canonicalRefs: string[];
    episodes: PrimeLedgerAssetEpisode[]; usedInShotIds: string[];
};
export type PrimeLedgerShotCharacter = { name: string; refEpoch: number; refCount: number };
export type PrimeLedgerShot = {
    shotId: string; projectId: string; episodeTitle: string; idx: number;
    scene: string; prompt: string; renderMode: string;
    characters: PrimeLedgerShotCharacter[]; sceneAnchor: Record<string, unknown> | null;
    media: { visual: PrimeMediaStatus; audio: PrimeMediaStatus; final: PrimeMediaStatus };
};
export type PrimeLedgerDrift = {
    code: string; severity: PrimeLedgerSeverity; assetKey: string; message: string;
    shotId?: string; projectId?: string; episodeIds?: string[]; shotIds?: string[];
};
export type PrimeLedgerSuggestion = {
    assetKey: string; action: PrimeLedgerAction; entityId: string | null;
    confidence: number; reason: string;
};
export type PrimeLedgerReceipt = {
    receiptId: string; action: string; assetKey: string; entityId: string; createdAt: string;
};
export type PrimeAssetLedger = {
    projectId: string; projectTitle: string; episodes: PrimeLedgerEpisode[];
    assets: PrimeLedgerAsset[]; shots: PrimeLedgerShot[]; drifts: PrimeLedgerDrift[];
    suggestions: PrimeLedgerSuggestion[]; receipts: PrimeLedgerReceipt[];
};
export type PrimeLedgerApplyInput = {
    receiptId: string; action: PrimeLedgerAction; assetKey: string; entityId?: string | null;
};
export type PrimeLedgerApplyResult = {
    applied: boolean; replayed: boolean;
    entity: { id: string; name: string } | null;
    receipt: PrimeLedgerReceipt;
};

const MEDIA_STATES: readonly PrimeMediaStatus[] = ["none", "unknown", "current", "stale"];
const ACTIONS: readonly PrimeLedgerAction[] = ["merge", "import", "create"];
const SEVERITIES: readonly PrimeLedgerSeverity[] = ["info", "warning"];

function text(value: unknown, fallback = ""): string {
    return typeof value === "string" ? value : fallback;
}
function count(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
function list(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
}
function record(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function refs(value: unknown): string[] {
    return list(value).filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}
function mediaState(value: unknown): PrimeMediaStatus {
    return MEDIA_STATES.includes(value as PrimeMediaStatus) ? value as PrimeMediaStatus : "unknown";
}
function assetStatus(value: unknown, key: string): PrimeLedgerAssetStatus {
    if (!LEDGER_ASSET_STATUSES.includes(value as PrimeLedgerAssetStatus)) {
        throw new Error(`资产对账状态无效：${String(value)}（${key}）`);
    }
    return value as PrimeLedgerAssetStatus;
}
function suggestionAction(value: unknown, key: string): PrimeLedgerAction {
    if (!ACTIONS.includes(value as PrimeLedgerAction)) {
        throw new Error(`资产对账建议动作无效：${String(value)}（${key}）`);
    }
    return value as PrimeLedgerAction;
}

function parseCharacter(raw: unknown): PrimeLedgerCharacter {
    const item = record(raw);
    return {
        id: text(item.id), name: text(item.name, "未命名角色"),
        refCount: count(item.ref_count), refs: refs(item.refs),
        visualPrompt: text(item.visual_prompt),
    };
}

function parseEpisode(raw: unknown): PrimeLedgerEpisode {
    const item = record(raw);
    return {
        projectId: text(item.project_id), title: text(item.title), isCurrent: item.is_current === true,
        createdAt: text(item.created_at),
        characters: list(item.characters).map(parseCharacter),
    };
}

function parseAsset(raw: unknown): PrimeLedgerAsset {
    const item = record(raw);
    const key = text(item.key);
    return {
        key, kind: text(item.kind, "character"), name: text(item.name),
        status: assetStatus(item.status, key),
        canonicalEntityId: text(item.canonical_entity_id) || null,
        canonicalRefs: refs(item.canonical_refs),
        episodes: list(item.episodes).map((entry) => {
            const row = record(entry);
            return {
                projectId: text(row.project_id),
                characterId: text(row.character_id) || null,
                refCount: count(row.ref_count), refs: refs(row.refs),
                matchesCanonical: typeof row.matches_canonical === "boolean" ? row.matches_canonical : null,
            };
        }),
        usedInShotIds: refs(item.used_in_shot_ids),
    };
}

function parseShot(raw: unknown): PrimeLedgerShot {
    const item = record(raw);
    const media = record(item.media);
    const anchor = record(item.scene_anchor);
    return {
        shotId: text(item.shot_id), projectId: text(item.project_id), episodeTitle: text(item.episode_title),
        idx: count(item.idx), scene: text(item.scene), prompt: text(item.prompt),
        renderMode: text(item.render_mode, "video"),
        characters: list(item.characters).map((entry) => {
            const row = record(entry);
            return { name: text(row.name), refEpoch: count(row.ref_epoch), refCount: count(row.ref_count) };
        }),
        sceneAnchor: Object.keys(anchor).length ? anchor : null,
        media: { visual: mediaState(media.visual), audio: mediaState(media.audio), final: mediaState(media.final) },
    };
}

function parseDrift(raw: unknown): PrimeLedgerDrift {
    const item = record(raw);
    return {
        code: text(item.code), severity: SEVERITIES.includes(item.severity as PrimeLedgerSeverity)
            ? item.severity as PrimeLedgerSeverity : "warning",
        assetKey: text(item.asset_key), message: text(item.message),
        ...(text(item.shot_id) ? { shotId: text(item.shot_id) } : {}),
        ...(text(item.project_id) ? { projectId: text(item.project_id) } : {}),
        ...(Array.isArray(item.episode_ids) ? { episodeIds: refs(item.episode_ids) } : {}),
        ...(Array.isArray(item.shot_ids) ? { shotIds: refs(item.shot_ids) } : {}),
    };
}

function parseSuggestion(raw: unknown): PrimeLedgerSuggestion {
    const item = record(raw);
    const key = text(item.asset_key);
    return {
        assetKey: key, action: suggestionAction(item.action, key),
        entityId: text(item.entity_id) || null,
        confidence: count(item.confidence), reason: text(item.reason),
    };
}

function parseReceipt(raw: unknown): PrimeLedgerReceipt {
    const item = record(raw);
    return {
        receiptId: text(item.receipt_id), action: text(item.action), assetKey: text(item.asset_key),
        entityId: text(item.entity_id), createdAt: text(item.created_at),
    };
}

function authHeaders(): HeadersInit {
    const token = typeof localStorage !== "undefined" ? localStorage.getItem("toiv_token") : null;
    return token ? { Authorization: `Bearer ${token}` } : {};
}

async function failure(method: string, res: Response): Promise<Error> {
    const detail = await res.json().catch(() => null) as { detail?: unknown } | null;
    const suffix = typeof detail?.detail === "string" ? ` · ${detail.detail}` : "";
    return new Error(`${method} ${res.status}${suffix}`);
}

export async function loadPrimeAssetLedger(projectId: string): Promise<PrimeAssetLedger> {
    const res = await fetch(`/api/studio/projects/${encodeURIComponent(projectId)}/asset-ledger`, { headers: authHeaders() });
    if (!res.ok) throw await failure("GET", res);
    const raw = record(await res.json());
    return {
        projectId: text(raw.project_id), projectTitle: text(raw.project_title),
        episodes: list(raw.episodes).map(parseEpisode),
        assets: list(raw.assets).map(parseAsset),
        shots: list(raw.shots).map(parseShot),
        drifts: list(raw.drifts).map(parseDrift),
        suggestions: list(raw.suggestions).map(parseSuggestion),
        receipts: list(raw.receipts).map(parseReceipt),
    };
}

export async function applyPrimeLedgerAction(
    projectId: string,
    input: PrimeLedgerApplyInput,
): Promise<PrimeLedgerApplyResult> {
    const res = await fetch(`/api/studio/projects/${encodeURIComponent(projectId)}/asset-ledger/apply`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
            receipt_id: input.receiptId,
            action: input.action,
            asset_key: input.assetKey,
            ...(input.entityId ? { entity_id: input.entityId } : {}),
        }),
    });
    if (!res.ok) throw await failure("POST", res);
    const raw = record(await res.json());
    const entity = record(raw.entity);
    return {
        applied: raw.applied === true,
        replayed: raw.replayed === true,
        entity: text(entity.id) ? { id: text(entity.id), name: text(entity.name) } : null,
        receipt: parseReceipt(raw.receipt),
    };
}
