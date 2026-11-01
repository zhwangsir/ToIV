import { primeMediaKind, type PrimeMediaKind } from "./media";
import { loadPrimeJobs, primeJobHeaders, primeJobStatus, type PrimeWorkCard } from "./works";

export type PrimeTaskStatus = PrimeWorkCard["status"];
export type PrimeTaskPhase = "idle" | "loading" | "ready" | "error";
export type PrimeRuntimeState = "terminal" | "waiting" | "fresh" | "watch" | "stalled" | "unknown";

export type PrimeRuntime = {
    state: PrimeRuntimeState;
    label: string;
    reason: string;
    ageSeconds: number | null;
    evidence: string;
};

export type PrimeFailureKind = "config" | "rate" | "quota" | "content" | "resource" | "engine" | "timeout" | "unknown";
export type PrimeFailure = { kind: PrimeFailureKind; label: string; hint: string };

export type PrimeTaskItem = {
    id: string;
    title: string;
    status: PrimeTaskStatus;
    progress?: number;
    cancellable: boolean;
};

export type PrimeTask = PrimeTaskItem & {
    promptId: string;
    kind: string;
    rawStatus: string;
    step?: number;
    total?: number;
    queuePos?: number;
    phase?: string;
    phaseLabel?: string;
    runtime?: PrimeRuntime;
    waitSec?: number;
    etaSec?: number | null;
    holdReason: string;
    error: string;
    failure?: PrimeFailure;
    results: string[];
    media?: string;
    mediaKind?: PrimeMediaKind;
    createdAt: string;
    projectId: string;
    worker: string;
    seed?: number;
    hasParams: boolean;
    postStatus: string;
    nsfw: boolean;
    canRerun: boolean;
    scope: "active" | "recent";
};

export type PrimeTaskCounts = { total: number; failed: number };
export type PrimeDependency = {
    id: string;
    label: string;
    state: "reachable" | "degraded" | "unreachable";
    summary: string;
    blockHint: string;
};
export type PrimeHealth = { overall: PrimeDependency["state"]; deps: PrimeDependency[] };
export type PrimeNextStep = { step: string; label: string; action: string; todo: number; shotIds: string[] };
export type PrimeProjectStatus = { total: number; byStatus: Record<string, number>; nextStep: PrimeNextStep };

export const primeStatusLabel: Record<PrimeTaskStatus, string> = {
    run: "生成中", done: "完成", fail: "失败", wait: "排队 / 等待资源", canceled: "已取消",
};

const RUNTIME_STATES: PrimeRuntimeState[] = ["terminal", "waiting", "fresh", "watch", "stalled", "unknown"];

function record(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function text(value: unknown): string {
    return typeof value === "string" ? value : "";
}

function integer(value: unknown): number | undefined {
    return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function finite(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function clampPct(value: unknown): number | undefined {
    const pct = finite(value);
    return pct === undefined ? undefined : Math.max(0, Math.min(100, pct));
}

function runtimeOf(value: unknown): PrimeRuntime | undefined {
    const raw = record(value);
    if (!raw) return;
    const state = RUNTIME_STATES.includes(raw.state as PrimeRuntimeState) ? raw.state as PrimeRuntimeState : "unknown";
    return {
        state,
        label: text(raw.label),
        reason: text(raw.reason),
        ageSeconds: finite(raw.age_seconds) ?? null,
        evidence: text(raw.evidence),
    };
}

function mapActive(raw: unknown): PrimeTask | undefined {
    const item = record(raw);
    const id = text(item?.id).trim();
    if (!item || !id) return;
    const rawStatus = text(item.status);
    const snapshot = record(item.progress);
    const status = primeJobStatus(rawStatus);
    return {
        id,
        title: text(item.prompt).trim().slice(0, 120) || text(item.kind) || id,
        status,
        cancellable: ["running", "queued", "held"].includes(rawStatus),
        progress: clampPct(snapshot?.pct),
        promptId: text(item.prompt_id),
        kind: text(item.kind),
        rawStatus,
        step: integer(snapshot?.step),
        total: integer(snapshot?.total),
        queuePos: integer(snapshot?.queue_pos),
        phase: text(snapshot?.phase) || undefined,
        phaseLabel: text(snapshot?.phase_label) || undefined,
        runtime: runtimeOf(item.runtime),
        waitSec: finite(item.wait_sec),
        etaSec: item.eta_sec === null ? null : finite(item.eta_sec),
        holdReason: text(item.hold_reason),
        error: "",
        results: [],
        createdAt: text(item.created_at),
        projectId: text(item.project_id),
        worker: text(item.worker),
        hasParams: false,
        postStatus: "",
        nsfw: item.nsfw === true,
        canRerun: false,
        scope: "active",
    };
}

function mapRecent(raw: unknown): PrimeTask | undefined {
    const item = record(raw);
    const id = text(item?.id).trim();
    if (!item || !id) return;
    const rawStatus = text(item.status);
    const snapshot = record(item.progress);
    const results = Array.isArray(item.results)
        ? item.results.filter((value): value is string => typeof value === "string")
        : [];
    const media = results.find(result => primeMediaKind(result));
    const error = text(item.error);
    const status = primeJobStatus(rawStatus);
    const hasParams = item.has_params === true;
    return {
        id,
        title: text(item.prompt).trim().slice(0, 120) || text(item.kind) || id,
        status,
        cancellable: ["running", "queued", "held"].includes(rawStatus),
        progress: clampPct(snapshot?.pct),
        promptId: text(item.prompt_id),
        kind: text(item.kind),
        rawStatus,
        step: integer(snapshot?.step),
        total: integer(snapshot?.total),
        queuePos: integer(snapshot?.queue_pos),
        phase: text(snapshot?.phase) || undefined,
        phaseLabel: text(snapshot?.phase_label) || undefined,
        runtime: runtimeOf(item.runtime),
        holdReason: text(item.hold_reason),
        error,
        failure: status === "fail" ? classifyPrimeFailure(error) : undefined,
        results,
        media,
        mediaKind: primeMediaKind(media),
        createdAt: text(item.created_at),
        projectId: text(item.project_id),
        worker: "",
        seed: integer(item.seed),
        hasParams,
        postStatus: text(item.post_status),
        nsfw: item.nsfw === true,
        canRerun: hasParams && ["done", "fail", "canceled"].includes(status),
        scope: "recent",
    };
}

/** Active snapshots win on live fields; the recent list supplies results, errors and project links. */
export function mergePrimeTasks(active: PrimeTask[], recent: PrimeTask[]): PrimeTask[] {
    const recentById = new Map(recent.map(task => [task.id, task]));
    const seen = new Set<string>();
    const head = active.map(task => {
        seen.add(task.id);
        const full = recentById.get(task.id);
        if (!full) return task;
        return {
            ...full,
            status: task.status,
            rawStatus: task.rawStatus,
            progress: task.progress ?? full.progress,
            step: task.step ?? full.step,
            total: task.total ?? full.total,
            queuePos: task.queuePos ?? full.queuePos,
            phase: task.phase ?? full.phase,
            phaseLabel: task.phaseLabel ?? full.phaseLabel,
            runtime: task.runtime ?? full.runtime,
            waitSec: task.waitSec ?? full.waitSec,
            etaSec: task.etaSec === undefined ? full.etaSec : task.etaSec,
            holdReason: task.holdReason || full.holdReason,
            cancellable: task.cancellable,
            scope: "active" as const,
        };
    });
    return [...head, ...recent.filter(task => !seen.has(task.id))];
}

export async function loadActiveTasks(signal?: AbortSignal): Promise<PrimeTask[]> {
    const res = await fetch("/api/jobs/active", { headers: primeJobHeaders(), signal });
    if (!res.ok) throw new Error(`active jobs ${res.status}`);
    const body = record(await res.json());
    const items = body?.items;
    if (!Array.isArray(items)) throw new Error("Invalid active jobs response");
    const tasks = items.map(mapActive);
    if (tasks.some(task => !task)) throw new Error("Invalid active jobs response");
    return tasks.filter((task): task is PrimeTask => Boolean(task));
}

export async function loadRecentTasks(signal?: AbortSignal): Promise<PrimeTask[]> {
    const list = await loadPrimeJobs(50, signal);
    const tasks = list.map(mapRecent);
    if (tasks.some(task => !task)) throw new Error("Invalid jobs response");
    return tasks.filter((task): task is PrimeTask => Boolean(task));
}

export async function loadTaskCounts(signal?: AbortSignal): Promise<PrimeTaskCounts> {
    const res = await fetch("/api/jobs/counts", { headers: primeJobHeaders(), signal });
    if (!res.ok) throw new Error(`job counts ${res.status}`);
    const body = record(await res.json());
    const total = integer(body?.count);
    const failed = integer(body?.failed);
    if (total === undefined || failed === undefined) throw new Error("Invalid job counts response");
    return { total, failed };
}

export async function loadTaskHealth(signal?: AbortSignal): Promise<PrimeHealth> {
    const res = await fetch("/api/studio/deps-status", { headers: primeJobHeaders(), signal });
    if (!res.ok) throw new Error(`deps ${res.status}`);
    const body = record(await res.json());
    if (!body || !Array.isArray(body.deps)) throw new Error("Invalid deps response");
    const deps = body.deps.map((value): PrimeDependency | undefined => {
        const dep = record(value);
        const id = text(dep?.id).trim();
        const state = text(dep?.state);
        if (!dep || !id || !["reachable", "degraded", "unreachable"].includes(state)) return;
        return {
            id,
            label: text(dep.label) || id,
            state: state as PrimeDependency["state"],
            summary: text(dep.summary),
            blockHint: text(dep.blocked_hint),
        };
    });
    if (deps.some(dep => !dep)) throw new Error("Invalid deps response");
    const valid = deps.filter((dep): dep is PrimeDependency => Boolean(dep));
    const overall = ["reachable", "degraded", "unreachable"].includes(text(body.overall))
        ? text(body.overall) as PrimeDependency["state"]
        : valid.some(dep => dep.state === "unreachable") ? "unreachable"
            : valid.some(dep => dep.state === "degraded") ? "degraded" : "reachable";
    return { overall, deps: valid };
}

export async function loadProjectStatus(projectId: string, signal?: AbortSignal): Promise<PrimeProjectStatus> {
    if (!projectId.trim()) throw new Error("Missing project id");
    const res = await fetch(`/api/studio/projects/${encodeURIComponent(projectId)}/status`, {
        headers: primeJobHeaders(), signal,
    });
    if (!res.ok) throw new Error(`project status ${res.status}`);
    const body = record(await res.json());
    const next = record(body?.next_step);
    if (!body || !next || !text(next.step) || !text(next.label)) throw new Error("Invalid project status response");
    const byStatus: Record<string, number> = {};
    const rawCounts = record(body.by_status);
    if (rawCounts) {
        for (const [key, value] of Object.entries(rawCounts)) {
            const count = integer(value);
            if (count !== undefined) byStatus[key] = count;
        }
    }
    return {
        total: integer(body.total) ?? 0,
        byStatus,
        nextStep: {
            step: text(next.step),
            label: text(next.label),
            action: text(next.action),
            todo: integer(next.todo) ?? 0,
            shotIds: Array.isArray(next.shot_ids)
                ? next.shot_ids.filter((value): value is string => typeof value === "string") : [],
        },
    };
}

async function responseMessage(res: Response, prefix: string): Promise<string> {
    try {
        const body = record(await res.json());
        const detail = text(body?.detail).trim();
        if (detail) return detail;
    } catch { /* Non-JSON failures fall back to the status line. */ }
    return `${prefix} ${res.status}`;
}

export async function cancelTask(id: string, signal?: AbortSignal): Promise<void> {
    if (!id.trim()) throw new Error("Missing job id");
    const res = await fetch(`/api/jobs/${encodeURIComponent(id)}/cancel`, {
        method: "POST", headers: primeJobHeaders(), signal,
    });
    if (!res.ok) throw new Error(await responseMessage(res, "cancel"));
    const body = record(await res.json());
    if (!body || body.ok !== true || body.status !== "canceled") throw new Error("Invalid cancellation response");
}

export async function rerunTask(id: string, signal?: AbortSignal): Promise<string> {
    if (!id.trim()) throw new Error("Missing job id");
    const res = await fetch(`/api/jobs/${encodeURIComponent(id)}/rerun`, {
        method: "POST",
        headers: { ...primeJobHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ seed_mode: "keep" }),
        signal,
    });
    if (!res.ok) throw new Error(await responseMessage(res, "rerun"));
    const body = record(await res.json());
    if (!body) throw new Error("Invalid rerun response");
    return text(body.job_id) || text(body.prompt_id);
}

const FAILURE_RULES: { kind: PrimeFailureKind; label: string; hint: string; pattern: RegExp }[] = [
    {
        kind: "content", label: "内容策略拦截",
        hint: "调整提示词、参考图或镜头描述后重试；不要反复提交同一内容。",
        pattern: /(nsfw|safety|content[\s_-]?policy|moderation|审核|敏感|违规|blocked by (?:safety|policy))/i,
    },
    {
        kind: "config", label: "服务未配置",
        hint: "管理员需在设置中补全对应模型端点与凭据后再试。",
        pattern: /(not configured|未配置|missing (?:api|endpoint|token|key)|no (?:api )?key|请先配置|模型未配置)/i,
    },
    {
        kind: "quota", label: "额度不足",
        hint: "检查账户额度、计费或并发配额后重试。",
        pattern: /(quota|额度|余额|insufficient (?:funds?|balance|credit)|billing|欠费)/i,
    },
    {
        kind: "rate", label: "请求被限流",
        hint: "等待约 1 分钟后重试，或降低同时提交的任务数。",
        pattern: /(\b429\b|rate[\s_-]?limit|too many requests|请求过于频繁|限流)/i,
    },
    {
        kind: "resource", label: "队列或资源不足",
        hint: "引擎当前排队或显存不足；稍后重试，或错峰提交更小的任务。",
        pattern: /(\bqueue\b|队列|no (?:available )?worker|资源不足|显存|out of memory|\boom\b|cuda (?:error|out of memory)|capacity)/i,
    },
    {
        kind: "engine", label: "引擎不可达",
        hint: "检查工作站引擎服务与网络后重试；已提交的任务不会被自动重放。",
        pattern: /(econnrefused|connection (?:refused|reset)|unreachable|无法连接|引擎不可达|\b(?:502|503|504)\b|worker (?:offline|down|unavailable))/i,
    },
    {
        kind: "timeout", label: "执行超时或被中断",
        hint: "可直接重试；若反复出现，缩小单次任务规模或错峰提交。",
        pattern: /(timeout|timed out|超时|interrupt|中断|aborted|取消)/i,
    },
];

export function classifyPrimeFailure(error: string): PrimeFailure | undefined {
    const value = error.trim();
    if (!value) return;
    const rule = FAILURE_RULES.find(item => item.pattern.test(value));
    return rule
        ? { kind: rule.kind, label: rule.label, hint: rule.hint }
        : { kind: "unknown", label: "未知错误", hint: "展开原始错误并复制报障信息，便于定位。" };
}

const REDACTIONS: [RegExp, string][] = [
    [/(bearer\s+)[a-z0-9._~+/=-]+/gi, "$1[已隐藏]"],
    [/((?:token|api[_-]?key|password|secret)\s*[=:]\s*)["']?[^\s"'&,;]+/gi, "$1[已隐藏]"],
    [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[已隐藏]"],
];

export function redactPrimeText(value: string): string {
    return REDACTIONS.reduce((result, [pattern, replacement]) => result.replace(pattern, replacement), value);
}

export function primeDiagnostics(task: PrimeTask): string {
    return [
        "## ToIV 任务诊断",
        `- 任务 ID: ${task.id}`,
        `- prompt_id: ${task.promptId || "—"}`,
        `- 类型: ${task.kind || "—"}`,
        `- 状态: ${task.rawStatus || "—"}`,
        `- 创建时间: ${task.createdAt || "—"}`,
        `- 引擎: ${task.worker ? redactPrimeText(task.worker) : "—"}`,
        `- 项目: ${task.projectId || "—"}`,
        `- seed: ${task.seed ?? "—"}`,
        `- 错误: ${task.error ? redactPrimeText(task.error) : "—"}`,
    ].join("\n");
}

export function primeRelativeTime(iso: string, now = Date.now()): string {
    const timestamp = Date.parse(iso);
    if (!Number.isFinite(timestamp)) return "—";
    const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
    if (seconds < 60) return "刚刚";
    if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
    if (seconds < 7 * 86400) return `${Math.floor(seconds / 86400)} 天前`;
    const date = new Date(timestamp);
    return `${date.getMonth() + 1} 月 ${date.getDate()} 日`;
}

export function primeDuration(seconds: number | null | undefined): string {
    if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return "—";
    const whole = Math.round(seconds);
    if (whole < 60) return `${whole} 秒`;
    if (whole < 3600) return `${Math.floor(whole / 60)} 分 ${String(whole % 60).padStart(2, "0")} 秒`;
    return `${Math.floor(whole / 3600)} 小时 ${String(Math.floor((whole % 3600) / 60)).padStart(2, "0")} 分`;
}

/** Derives a usable in-flight list when the active endpoint is unavailable. */
export function deriveActiveTasks(recent: PrimeTask[]): PrimeTask[] {
    return recent
        .filter(task => task.status === "run" || task.status === "wait")
        .map(task => ({ ...task, scope: "active" as const }));
}
