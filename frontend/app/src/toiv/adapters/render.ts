import { studioRequest } from "./studioHttp";

export type PrimeRenderScope = "batch" | "shot";
export type PrimeRenderOptions = { accel?: string; pipeline?: string; numCandidates?: number; autoPick?: boolean };
export type PrimeRenderBlocker = { code: string; message: string; stage?: string };
export type PrimeRenderWork = {
    shotCount: number; candidateUpperBound: number; requestedDurationSec: number;
    requestedFrameCount: number; pixelFrameUpperBound: number; imageMotionCount: number;
};
export type PrimeRenderItem = {
    shotId: string; idx: number; engine: string; pipeline: string; renderMode: string;
    candidates: number; durationSec: number; frames: number; pixelFrameUpperBound: number;
};
export type PrimeRenderPricing = {
    status: "estimated" | "unpriced"; currency: string | null; total: string | null; unknowns: string[];
};
export type PrimeRenderBudget = { status: "disabled" | "within" | "exceeded" | "unpriced"; limit: string | null; currency: string | null };
export type PrimeRenderEstimate = {
    scope: PrimeRenderScope; projectId: string; shotId?: string; allowed: boolean;
    blockers: PrimeRenderBlocker[]; warnings: string[]; fingerprint: string;
    work: PrimeRenderWork; items: PrimeRenderItem[];
    pricing: PrimeRenderPricing; budget: PrimeRenderBudget;
};
export type PrimeRenderSubmission = { jobId: string; status: string; projectId?: string; shotId?: string; promptId?: string };

const SCHEMA = "toiv_render_estimate_v1";
const PIPELINES = ["ref2va", "c", "c_hybrid", "legacy"];
const BUDGET_STATUSES = ["disabled", "within", "exceeded", "unpriced"];

function record(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function count(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
function text(value: unknown): string | null {
    return typeof value === "string" && value.trim() ? value : null;
}
function parseWork(raw: unknown): PrimeRenderWork | null {
    const value = record(raw);
    if (!value) return null;
    const shotCount = count(value.shot_count);
    const candidateUpperBound = count(value.candidate_upper_bound);
    const requestedDurationSec = count(value.requested_duration_sec);
    const requestedFrameCount = count(value.requested_frame_count);
    const pixelFrameUpperBound = count(value.pixel_frame_upper_bound);
    const imageMotionCount = count(value.image_motion_count);
    if ([shotCount, candidateUpperBound, requestedDurationSec, requestedFrameCount, pixelFrameUpperBound, imageMotionCount]
        .some(item => item === null)) return null;
    return {
        shotCount: shotCount!, candidateUpperBound: candidateUpperBound!, requestedDurationSec: requestedDurationSec!,
        requestedFrameCount: requestedFrameCount!, pixelFrameUpperBound: pixelFrameUpperBound!, imageMotionCount: imageMotionCount!,
    };
}
function parseItems(raw: unknown): PrimeRenderItem[] | null {
    if (!Array.isArray(raw)) return null;
    const items: PrimeRenderItem[] = [];
    for (const entry of raw) {
        const value = record(entry);
        if (!value) return null;
        const shotId = text(value.shot_id);
        const engine = text(value.engine);
        const pipeline = text(value.pipeline);
        const renderMode = text(value.render_mode);
        const idx = count(value.idx);
        const candidates = count(value.candidates);
        const durationSec = count(value.duration_sec);
        const frames = count(value.frames);
        const pixelFrameUpperBound = count(value.pixel_frame_upper_bound);
        if (!shotId || !engine || !pipeline || !renderMode
            || [idx, candidates, durationSec, frames, pixelFrameUpperBound].some(item => item === null)) return null;
        items.push({
            shotId, engine, pipeline, renderMode, idx: idx!, candidates: candidates!,
            durationSec: durationSec!, frames: frames!, pixelFrameUpperBound: pixelFrameUpperBound!,
        });
    }
    return items;
}
function parseBlockers(raw: unknown): PrimeRenderBlocker[] | null {
    if (!Array.isArray(raw)) return null;
    const blockers: PrimeRenderBlocker[] = [];
    for (const entry of raw) {
        const value = record(entry);
        const code = value ? text(value.code) : null;
        const message = value ? text(value.message) : null;
        if (!code || !message) return null;
        const stage = text(value!.stage);
        blockers.push({ code, message, ...(stage ? { stage } : {}) });
    }
    return blockers;
}
function parsePricing(raw: unknown): PrimeRenderPricing | null {
    const value = record(raw);
    if (!value) return null;
    const status = value.status;
    if (status !== "estimated" && status !== "unpriced") return null;
    const unknowns = Array.isArray(value.unknowns) ? value.unknowns.filter((item): item is string => typeof item === "string") : null;
    if (!unknowns) return null;
    if (status === "estimated") {
        const currency = text(value.currency);
        const total = text(value.total);
        return currency && total ? { status, currency, total, unknowns } : null;
    }
    return { status, currency: null, total: null, unknowns };
}
function parseBudget(raw: unknown): PrimeRenderBudget | null {
    const value = record(raw);
    if (!value || typeof value.status !== "string" || !BUDGET_STATUSES.includes(value.status)) return null;
    if (value.status === "disabled") return { status: "disabled", limit: null, currency: null };
    const limit = text(value.limit);
    const currency = text(value.currency);
    if (!limit || !currency) return null;
    return { status: value.status as PrimeRenderBudget["status"], limit, currency };
}

/** Money-facing estimate: identity, work and price must all be present before the UI can confirm. */
export function parsePrimeRenderEstimate(raw: unknown, expected: { scope: PrimeRenderScope; projectId: string; shotId?: string }): PrimeRenderEstimate {
    const payload = record(raw);
    const work = payload ? parseWork(payload.work) : null;
    const items = payload ? parseItems(payload.items) : null;
    const blockers = payload ? parseBlockers(payload.blockers) : null;
    const pricing = payload ? parsePricing(payload.pricing) : null;
    const budget = payload ? parseBudget(payload.budget) : null;
    const fingerprint = payload ? text(payload.input_fingerprint) : null;
    const projectId = payload ? text(payload.project_id) : null;
    const identityOk = payload?.schema === SCHEMA && payload.scope === expected.scope && projectId !== null
        && (expected.scope === "shot" || projectId === expected.projectId)
        && typeof payload.allowed === "boolean"
        && (expected.scope !== "shot" || (typeof payload.shot_id === "string" && payload.shot_id === expected.shotId));
    if (!payload || !identityOk || !work || !items || !blockers || !pricing || !budget || !fingerprint
        || !Array.isArray(payload.warnings)) {
        throw new Error("报价响应不完整，请刷新后重试；未提交渲染");
    }
    return {
        scope: expected.scope, projectId: projectId!,
        ...(expected.shotId ? { shotId: expected.shotId } : {}),
        allowed: payload.allowed as boolean,
        blockers, warnings: payload.warnings.filter((item): item is string => typeof item === "string"),
        fingerprint, work, items, pricing, budget,
    };
}

function optionsOf(options: PrimeRenderOptions, withCandidates: boolean) {
    const accel = (options.accel ?? "off").trim().toLowerCase() || "off";
    const pipeline = (options.pipeline ?? "ref2va").trim().toLowerCase() || "ref2va";
    if (!PIPELINES.includes(pipeline)) throw new Error("渲染管线仅支持 ref2va / c / c_hybrid / legacy");
    if (!withCandidates) return { accel, pipeline };
    const numCandidates = options.numCandidates ?? 2;
    if (!Number.isInteger(numCandidates) || numCandidates < 1 || numCandidates > 4) throw new Error("候选数须为 1–4 的整数");
    return { pipeline, accel, num_candidates: numCandidates, auto_pick: options.autoPick ?? false };
}

export async function estimatePrimeBatch(projectId: string, options: PrimeRenderOptions, signal?: AbortSignal): Promise<PrimeRenderEstimate> {
    const raw = await studioRequest<unknown>(
        `/api/studio/projects/${encodeURIComponent(projectId)}/render-estimate`, "POST", optionsOf(options, false), signal);
    return parsePrimeRenderEstimate(raw, { scope: "batch", projectId });
}

export async function estimatePrimeShot(shotId: string, options: PrimeRenderOptions, signal?: AbortSignal): Promise<PrimeRenderEstimate> {
    const raw = await studioRequest<unknown>(
        `/api/studio/shots/${encodeURIComponent(shotId)}/render-estimate`, "POST", optionsOf(options, true), signal);
    return parsePrimeRenderEstimate(raw, { scope: "shot", projectId: "", shotId });
}

export function quoteCanConfirm(estimate: PrimeRenderEstimate): boolean {
    return estimate.allowed && estimate.work.shotCount > 0;
}

/** A confirmed quote only skips the dialog while the server fingerprint is unchanged. */
export function estimateAllowsDirectSubmit(estimate: PrimeRenderEstimate, lockedFingerprint: string | null): boolean {
    return Boolean(lockedFingerprint) && estimate.fingerprint === lockedFingerprint && quoteCanConfirm(estimate);
}

export async function submitPrimeBatch(projectId: string, options: PrimeRenderOptions): Promise<PrimeRenderSubmission> {
    const body = { ...optionsOf(options, false), wait: false };
    const payload = record(await studioRequest<unknown>(
        `/api/studio/projects/${encodeURIComponent(projectId)}/render`, "POST", body));
    const jobId = payload ? text(payload.job_id) : null;
    if (!jobId) throw new Error("渲染请求已提交，但返回缺少作业号，请刷新核对");
    if (payload!.project_id !== undefined && payload!.project_id !== projectId) {
        throw new Error("渲染请求已提交，但返回的项目不一致，请刷新核对");
    }
    return { jobId, status: text(payload!.status) ?? "queued", projectId };
}

export async function submitPrimeShot(shotId: string, options: PrimeRenderOptions): Promise<PrimeRenderSubmission> {
    const body = { ...optionsOf(options, true), wait: false };
    const payload = record(await studioRequest<unknown>(
        `/api/studio/shots/${encodeURIComponent(shotId)}/render`, "POST", body));
    const jobId = payload ? text(payload.job_id) : null;
    if (!jobId) throw new Error("渲染请求已提交，但返回缺少作业号，请刷新核对");
    if (payload!.shot_id !== undefined && payload!.shot_id !== shotId) {
        throw new Error("渲染请求已提交，但返回的分镜不一致，请刷新核对");
    }
    const promptId = text(payload!.prompt_id);
    return { jobId, status: text(payload!.status) ?? "queued", shotId, ...(promptId ? { promptId } : {}) };
}
