import { StudioHttpError, studioRequest } from "./studioHttp";

export const PRIME_STAGES = [
    { id: "script", label: "剧本" },
    { id: "assets", label: "资产" },
    { id: "storyboard", label: "分镜" },
    { id: "generate", label: "生成" },
    { id: "voice", label: "配音" },
    { id: "timeline", label: "合成" },
] as const;

export type PrimeStageId = typeof PRIME_STAGES[number]["id"];
export type PrimeStageState =
    | "draft" | "pending_confirmation" | "confirmed" | "generating" | "failed" | "needs_review" | "skipped";
export type PrimeStageEntry = { state: PrimeStageState; ready: boolean; blockers: string[] };
export type PrimeStageStates = Record<PrimeStageId, PrimeStageEntry>;
export type PrimeStageProjection = { states: PrimeStageStates; revision: number | null };
export type PrimeStageAction = "confirm" | "skip" | "reopen";
export type PrimeStageActions = { canConfirm: boolean; canSkip: boolean; canReopen: boolean };

const STATES: readonly PrimeStageState[] = [
    "draft", "pending_confirmation", "confirmed", "generating", "failed", "needs_review", "skipped",
];

function isEntry(raw: unknown): raw is { state: PrimeStageState; ready: boolean; blockers: string[] } {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
    const record = raw as Record<string, unknown>;
    if (typeof record.state !== "string" || !STATES.includes(record.state as PrimeStageState)) return false;
    if (typeof record.ready !== "boolean") return false;
    if (!Array.isArray(record.blockers)) return false;
    return true;
}

/** Complete six-stage projection only. Undefined revision stays explicit; an invalid one rejects the payload. */
export function parsePrimeStageProjection(rawStates: unknown, rawRevision: unknown): PrimeStageProjection | null {
    if (!rawStates || typeof rawStates !== "object" || Array.isArray(rawStates)) return null;
    let revision: number | null = null;
    if (rawRevision !== undefined && rawRevision !== null) {
        if (typeof rawRevision !== "number" || !Number.isInteger(rawRevision) || rawRevision < 0) return null;
        revision = rawRevision;
    }
    const states = {} as PrimeStageStates;
    for (const stage of PRIME_STAGES) {
        const entry = (rawStates as Record<string, unknown>)[stage.id];
        if (!isEntry(entry)) return null;
        states[stage.id] = {
            state: entry.state,
            ready: entry.ready,
            blockers: entry.blockers.filter((blocker): blocker is string =>
                typeof blocker === "string" && blocker.trim().length > 0),
        };
    }
    return { states, revision };
}

export function stageActions(entry: PrimeStageEntry): PrimeStageActions {
    return {
        canConfirm: entry.state === "pending_confirmation",
        canSkip: entry.state === "pending_confirmation" || entry.state === "needs_review" || entry.state === "draft",
        canReopen: entry.state === "needs_review" || entry.state === "confirmed" || entry.state === "skipped",
    };
}

export function firstBlockingStage(states: PrimeStageStates): PrimeStageId | null {
    for (const stage of PRIME_STAGES) {
        const state = states[stage.id].state;
        if (state !== "confirmed" && state !== "skipped") return stage.id;
    }
    return null;
}

export type PrimeStageTransition = {
    stage: PrimeStageId;
    action: PrimeStageAction;
    note?: string;
    expectingRevision: number;
};

type TransitionResponse = {
    project_id?: unknown;
    stage?: unknown;
    stage_states?: unknown;
    stage_revision?: unknown;
};

export async function transitionPrimeStage(projectId: string, transition: PrimeStageTransition): Promise<PrimeStageProjection> {
    const note = transition.note ?? "";
    if (transition.action === "skip" && note.trim().length < 2) throw new Error("跳过阶段须填写说明（至少 2 个字）");
    if (!Number.isInteger(transition.expectingRevision) || transition.expectingRevision < 0) {
        throw new Error("缺少阶段修订号，请刷新后重试");
    }
    const body: Record<string, unknown> = {
        stage: transition.stage,
        action: transition.action,
        expected_stage_revision: transition.expectingRevision,
    };
    if (note.trim()) body.note = note;
    const payload = await studioRequest<TransitionResponse>(
        `/api/studio/projects/${encodeURIComponent(projectId)}/stage-transition`, "POST", body);

    if (payload.project_id !== undefined && payload.project_id !== projectId) {
        throw new Error("阶段已提交，但返回的项目不一致，请刷新核对");
    }
    if (payload.stage !== undefined && payload.stage !== transition.stage) {
        throw new Error("阶段已提交，但返回的阶段不一致，请刷新核对");
    }
    const parsed = parsePrimeStageProjection(payload.stage_states, payload.stage_revision);
    if (!parsed || parsed.revision === null) {
        throw new Error("阶段已提交，但服务端返回不完整，请刷新核对");
    }
    return parsed;
}

export { StudioHttpError };
