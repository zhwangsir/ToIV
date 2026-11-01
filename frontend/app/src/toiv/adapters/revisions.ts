import { studioRequest } from "./studioHttp";

export type PrimeRevision = {
    id: string; version: number; source: string; parentId: string;
    visualFingerprint: string; audioFingerprint: string; createdBy: string; createdAt: string;
};
export type PrimeRevisionDiffField = { from: unknown; to: unknown };
export type PrimeRevisionDiff = {
    revisionId: string; version: number; source: string;
    fromVersion: number | null; fromUnknown: boolean;
    fields: Record<string, PrimeRevisionDiffField>;
};

const value = (raw: unknown): Record<string, unknown> | null =>
    raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
const text = (raw: unknown): string | null => typeof raw === "string" ? raw : null;
const integer = (raw: unknown): number | null =>
    typeof raw === "number" && Number.isInteger(raw) && raw >= 0 ? raw : null;

function parseRevision(raw: unknown): PrimeRevision | null {
    const entry = value(raw);
    if (!entry) return null;
    const id = text(entry.id);
    const version = integer(entry.version);
    const source = text(entry.source);
    const parentId = text(entry.parent_id);
    const visualFingerprint = text(entry.visual_fingerprint);
    const audioFingerprint = text(entry.audio_fingerprint);
    const createdBy = text(entry.created_by);
    const createdAt = text(entry.created_at);
    if (!id || version === null || !source || parentId === null || visualFingerprint === null
        || audioFingerprint === null || createdBy === null || createdAt === null) return null;
    return { id, version, source, parentId, visualFingerprint, audioFingerprint, createdBy, createdAt };
}

/** Newest-first history. A list for another shot is treated as a failed request, never merged. */
export async function listPrimeRevisions(shotId: string): Promise<PrimeRevision[]> {
    const payload = value(await studioRequest<unknown>(`/api/studio/shots/${encodeURIComponent(shotId)}/revisions`));
    if (!payload || payload.shot_id !== shotId || !Array.isArray(payload.revisions)) {
        throw new Error("修订列表响应不完整，请刷新后重试");
    }
    const rows = payload.revisions.map(parseRevision);
    if (rows.some(row => row === null)) throw new Error("修订列表响应不完整，请刷新后重试");
    return rows as PrimeRevision[];
}

export async function diffPrimeRevision(shotId: string, revisionId: string): Promise<PrimeRevisionDiff> {
    const payload = value(await studioRequest<unknown>(
        `/api/studio/shots/${encodeURIComponent(shotId)}/revisions/${encodeURIComponent(revisionId)}/diff`));
    const version = payload ? integer(payload.version) : null;
    const source = payload ? text(payload.source) : null;
    const fromVersionRaw = payload?.from_version;
    const fromVersion = fromVersionRaw === null || fromVersionRaw === undefined ? null : integer(fromVersionRaw);
    const fromUnknown = payload?.from_unknown;
    const fieldsRaw = payload ? value(payload.fields) : null;
    const valid = payload && payload.revision_id === revisionId && version !== null && source !== null
        && fromVersionRaw !== undefined && (fromVersionRaw === null || fromVersion !== null)
        && typeof fromUnknown === "boolean" && fieldsRaw !== null;
    if (!valid) throw new Error("修订差异响应不完整，请刷新后重试");
    const fields: Record<string, PrimeRevisionDiffField> = {};
    for (const [name, raw] of Object.entries(fieldsRaw!)) {
        const entry = value(raw);
        if (!entry || !Object.hasOwn(entry, "from") || !Object.hasOwn(entry, "to")) {
            throw new Error("修订差异响应不完整，请刷新后重试");
        }
        fields[name] = { from: entry.from, to: entry.to };
    }
    return { revisionId, version: version!, source: source!, fromVersion, fromUnknown: fromUnknown as boolean, fields };
}

/** Appends a rollback revision; history is never rewritten. Callers must reload stage projections. */
export async function rollbackPrimeShot(shotId: string, revisionId: string, expectedRevision: string): Promise<void> {
    const saved = value(await studioRequest<unknown>(`/api/studio/shots/${encodeURIComponent(shotId)}/rollback`, "POST", {
        revision_id: revisionId,
        ...(expectedRevision ? { expected_revision: expectedRevision } : {}),
    }));
    if (!saved || saved.id !== shotId) {
        throw new Error("回滚已提交，但返回的分镜不一致，请刷新核对");
    }
}
