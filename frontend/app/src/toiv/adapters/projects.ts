export type PrimeProjectPipeline = {
    totalShots: number;
    byStatus: Record<string, number>;
    nextStep: { step: string; label: string; todo: number } | null;
};

export type PrimeProjectCard = {
    id: string;
    title: string;
    source: "studio" | "canvas";
    status: string;
    shotCount: number;
    shotsKnown: boolean;
    coverUrl: string;
    coverKind: "image" | "video" | "";
    updatedAt: string;
    pipeline: PrimeProjectPipeline | null;
};

export type PrimeProjectsModel = {
    cards: PrimeProjectCard[];
    degraded: "none" | "studio" | "canvas" | "both";
};

export type ProjectStatusFilter = "all" | "draft" | "active" | "repair" | "done";
export type ProjectBucket = Exclude<ProjectStatusFilter, "all"> | "canvas";
export type ProjectView = "gallery" | "list";

const VIEW_KEY = "toiv_projects_view";
const STAGE_DEFS = [
    { key: "render", label: "画面" },
    { key: "voice", label: "配音" },
    { key: "lipsync", label: "口型" },
    { key: "assemble", label: "成片" },
] as const;
export type ProjectStage = { key: typeof STAGE_DEFS[number]["key"]; label: string; state: "done" | "current" | "todo" };

function authHeaders(): HeadersInit {
    const token = typeof localStorage !== "undefined" ? localStorage.getItem("toiv_token") : null;
    return token ? { Authorization: `Bearer ${token}` } : {};
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function asNumber(value: unknown): number {
    const parsed = typeof value === "number" ? value : Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

function normalizePipeline(raw: unknown): PrimeProjectPipeline | null {
    const pipeline = asRecord(raw);
    if (!pipeline) return null;
    const byStatusRaw = asRecord(pipeline.by_status ?? pipeline.byStatus) ?? {};
    const byStatus: Record<string, number> = {};
    for (const [key, value] of Object.entries(byStatusRaw)) byStatus[key] = asNumber(value);
    const nextRaw = asRecord(pipeline.next_step ?? pipeline.nextStep);
    return {
        totalShots: asNumber(pipeline.total_shots ?? pipeline.totalShots),
        byStatus,
        nextStep: nextRaw
            ? { step: String(nextRaw.step ?? ""), label: String(nextRaw.label ?? ""), todo: asNumber(nextRaw.todo) }
            : null,
    };
}

type StudioProjectJson = {
    id: string;
    title?: string;
    status?: string;
    shots_count?: number;
    updated_at?: string;
    updatedAt?: string;
    pipeline?: unknown;
};

function toStudioCard(project: StudioProjectJson): PrimeProjectCard {
    const rawPipeline = asRecord(project.pipeline);
    const pipeline = normalizePipeline(project.pipeline);
    const shotsCount = typeof project.shots_count === "number" ? project.shots_count : null;
    const coverUrlRaw = rawPipeline?.cover_url ?? rawPipeline?.coverUrl;
    const coverKindRaw = rawPipeline?.cover_kind ?? rawPipeline?.coverKind;
    return {
        id: project.id,
        title: project.title || project.id,
        source: "studio",
        status: project.status ?? "draft",
        shotCount: pipeline ? pipeline.totalShots : (shotsCount ?? 0),
        shotsKnown: pipeline !== null || shotsCount !== null,
        coverUrl: typeof coverUrlRaw === "string" ? coverUrlRaw : "",
        coverKind: coverKindRaw === "image" || coverKindRaw === "video" ? coverKindRaw : "",
        updatedAt: project.updated_at ?? project.updatedAt ?? "",
        pipeline,
    };
}

async function fetchStudioProjects(): Promise<PrimeProjectCard[]> {
    const res = await fetch("/api/studio/projects?limit=200", { headers: authHeaders() });
    if (!res.ok) throw new Error(`studio projects ${res.status}`);
    const body = await res.json();
    const list: StudioProjectJson[] = Array.isArray(body) ? body : (body.projects ?? []);
    return list.map(toStudioCard);
}

async function fetchCanvasProjects(): Promise<PrimeProjectCard[]> {
    const res = await fetch("/studio/api/canvas-projects", { credentials: "include", headers: authHeaders() });
    if (!res.ok) throw new Error(`canvas projects ${res.status}`);
    const body = await res.json();
    if (body.code !== 0 || !Array.isArray(body.data?.projects)) throw new Error("画布项目响应异常");
    return body.data.projects.map((project: { id: string; title?: string; updatedAt?: string; updated_at?: string }) => ({
        id: project.id,
        title: project.title || project.id,
        source: "canvas" as const,
        status: "canvas",
        shotCount: 0,
        shotsKnown: false,
        coverUrl: "",
        coverKind: "" as const,
        updatedAt: project.updatedAt ?? project.updated_at ?? "",
        pipeline: null,
    }));
}

export async function loadPrimeProjects(): Promise<PrimeProjectsModel> {
    const [studio, canvas] = await Promise.allSettled([fetchStudioProjects(), fetchCanvasProjects()]);
    const cards = [
        ...(studio.status === "fulfilled" ? studio.value : []),
        ...(canvas.status === "fulfilled" ? canvas.value : []),
    ];
    const degraded: PrimeProjectsModel["degraded"] =
        studio.status === "rejected" && canvas.status === "rejected" ? "both"
            : studio.status === "rejected" ? "studio" : canvas.status === "rejected" ? "canvas" : "none";
    return { cards, degraded };
}

export function projectStages(card: PrimeProjectCard): ProjectStage[] {
    const step = card.pipeline?.nextStep?.step;
    if (!step) return [];
    const current = step === "done" ? STAGE_DEFS.length : STAGE_DEFS.findIndex((stage) => stage.key === step);
    if (current < 0) return [];
    return STAGE_DEFS.map((stage, index) => ({
        ...stage,
        state: index < current ? "done" : index === current ? "current" : "todo",
    }));
}

export function projectBucket(card: PrimeProjectCard): ProjectBucket {
    const status = card.status.toLowerCase();
    if (!card.pipeline) {
        if (card.source === "canvas") return "canvas";
        if (status === "error" || status === "failed") return "repair";
        if (status === "done" || status === "succeeded" || status === "ready") return "done";
        if (status === "draft" && card.shotCount === 0) return "draft";
        return "active";
    }
    if ((card.pipeline.byStatus.error ?? 0) > 0) return "repair";
    if (status === "error" || status === "failed") return "repair";
    if (card.pipeline.nextStep?.step === "done") return "done";
    if (card.shotCount === 0) return "draft";
    return "active";
}

export function statusCounts(cards: PrimeProjectCard[]): Record<ProjectStatusFilter, number> {
    const counts: Record<ProjectStatusFilter, number> = { all: cards.length, draft: 0, active: 0, repair: 0, done: 0 };
    for (const card of cards) {
        const bucket = projectBucket(card);
        if (bucket !== "canvas") counts[bucket] += 1;
    }
    return counts;
}

export function matchesStatusFilter(card: PrimeProjectCard, filter: ProjectStatusFilter): boolean {
    return filter === "all" || projectBucket(card) === filter;
}

export function formatRelativeTime(iso: string, now = Date.now()): string {
    if (!iso) return "";
    const timestamp = Date.parse(iso);
    if (Number.isNaN(timestamp)) return "";
    const diff = Math.max(0, now - timestamp);
    const minute = 60_000;
    const hour = 60 * minute;
    const day = 24 * hour;
    if (diff < minute) return "刚刚";
    if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
    if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
    if (diff < 2 * day) return "昨天";
    if (diff < 30 * day) return `${Math.floor(diff / day)} 天前`;
    const date = new Date(timestamp);
    const pad = (value: number) => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function defaultStorage(): Storage | null {
    try {
        return typeof localStorage === "undefined" ? null : localStorage;
    } catch {
        return null;
    }
}

export function loadProjectView(storage: Pick<Storage, "getItem"> | null = defaultStorage()): ProjectView {
    try {
        return storage?.getItem(VIEW_KEY) === "list" ? "list" : "gallery";
    } catch {
        return "gallery";
    }
}

export function saveProjectView(view: ProjectView, storage: Pick<Storage, "setItem"> | null = defaultStorage()): void {
    try {
        storage?.setItem(VIEW_KEY, view);
    } catch {
        // 无痕模式下 localStorage 写入会抛;视图偏好只是锦上添花
    }
}
