export type CapabilityOption = { value: string; label: string; available: boolean; reason: string };
export type CapabilitySize = CapabilityOption & { width: number; height: number };
export type CapabilityDuration = CapabilityOption & { seconds: number; default: boolean };
export type CapabilityModel = { value: string; label: string; default: boolean; nsfw: boolean; desc: string };
export type CapabilityParamOption = {
    value: string;
    label: string;
    desc: string;
    nsfw: boolean;
    disabled: boolean;
};
export type CapabilityParam = {
    key: string;
    label: string;
    type: string;
    default: unknown;
    min: number | null;
    max: number | null;
    step: number | null;
    options: CapabilityParamOption[];
    hint: string;
};
export type CapabilityEngine = {
    id: string;
    label: string;
    kind: string;
    nsfw: boolean;
    description: string;
    route: string | null;
    available: boolean;
    unavailableReason: string;
    params: CapabilityParam[];
    limits: Record<string, number | null>;
};
export type CapabilitySlot = {
    id: string;
    label: string;
    available: boolean;
    unavailableReason: string;
    affects: string[];
    engines: CapabilityEngine[];
};
export type CapabilityIssue = {
    id: string;
    severity: string;
    title: string;
    reason: string;
    affects: string[];
};

export type ToolCapability = {
    id: string;
    label: string;
    engineId: string;
    engineLabel: string;
    route: string | null;
    available: boolean;
    unavailableReason: string;
    modelParam: string | null;
    models: CapabilityModel[];
    sizes: CapabilitySize[];
    sizeHint: string;
    durationParam: string | null;
    durationHint: string;
    durations: CapabilityDuration[];
    limits: Record<string, number | null>;
    affects: string[];
};

export type ToolCapabilities = {
    schemaVersion: number;
    tools: { image: ToolCapability; video: ToolCapability };
    slots: CapabilitySlot[];
    issues: CapabilityIssue[];
};

export type EngineProbe = {
    id: string;
    label: string;
    kind: string;
    route: string;
    available: boolean;
    reason: string;
};

export type EngineProbeResult = {
    count: number;
    availableCount: number;
    engines: EngineProbe[];
};

type Raw = Record<string, unknown>;

const asRecord = (value: unknown): Raw => (value && typeof value === "object" ? value as Raw : {});
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const text = (value: unknown, fallback = ""): string => (typeof value === "string" ? value : fallback);
const number = (value: unknown, fallback = 0): number => (typeof value === "number" && Number.isFinite(value) ? value : fallback);
const flag = (value: unknown, fallback = false): boolean => (typeof value === "boolean" ? value : fallback);

function authHeaders(): Record<string, string> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const token = typeof localStorage !== "undefined" ? localStorage.getItem("toiv_token") : null;
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
}

function normalizeModel(raw: unknown): CapabilityModel {
    const item = asRecord(raw);
    return {
        value: text(item.value),
        label: text(item.label, text(item.value)),
        default: flag(item.default),
        nsfw: flag(item.nsfw),
        desc: text(item.desc),
    };
}

function normalizeSize(raw: unknown): CapabilitySize {
    const item = asRecord(raw);
    return {
        value: text(item.value),
        label: text(item.label, text(item.value)),
        width: number(item.width),
        height: number(item.height),
        available: flag(item.available, true),
        reason: text(item.reason),
    };
}

function normalizeDuration(raw: unknown): CapabilityDuration {
    const item = asRecord(raw);
    return {
        value: text(item.value),
        label: text(item.label, text(item.value)),
        seconds: number(item.seconds),
        default: flag(item.default),
        available: flag(item.available, true),
        reason: text(item.reason),
    };
}

function normalizeParam(raw: unknown): CapabilityParam {
    const item = asRecord(raw);
    return {
        key: text(item.key),
        label: text(item.label, text(item.key)),
        type: text(item.type),
        default: item.default,
        min: typeof item.min === "number" ? item.min : null,
        max: typeof item.max === "number" ? item.max : null,
        step: typeof item.step === "number" ? item.step : null,
        options: asArray(item.options).map((option) => {
            const entry = asRecord(option);
            return {
                value: text(entry.value),
                label: text(entry.label, text(entry.value)),
                desc: text(entry.desc),
                nsfw: flag(entry.nsfw),
                disabled: flag(entry.disabled),
            };
        }),
        hint: text(item.hint),
    };
}

function normalizeLimits(raw: unknown): Record<string, number | null> {
    const limits: Record<string, number | null> = {};
    for (const [key, value] of Object.entries(asRecord(raw))) {
        limits[key] = typeof value === "number" ? value : null;
    }
    return limits;
}

function emptyTool(id: "image" | "video", label: string): ToolCapability {
    return {
        id, label, engineId: "", engineLabel: "", route: null,
        available: false, unavailableReason: "生成能力未就绪",
        modelParam: null, models: [], sizes: [], sizeHint: "",
        durationParam: null, durationHint: "", durations: [], limits: {}, affects: [],
    };
}

function normalizeTool(raw: unknown, id: "image" | "video", label: string): ToolCapability {
    if (!raw || typeof raw !== "object") return emptyTool(id, label);
    const item = asRecord(raw);
    const available = flag(item.available);
    return {
        id: text(item.id, id),
        label: text(item.label, label),
        engineId: text(item.engine_id),
        engineLabel: text(item.engine_label),
        route: typeof item.route === "string" ? item.route : null,
        available,
        unavailableReason: text(item.unavailable_reason, available ? "" : "生成能力未就绪"),
        modelParam: typeof item.model_param === "string" ? item.model_param : null,
        models: asArray(item.models).map(normalizeModel),
        sizes: asArray(item.sizes).map(normalizeSize),
        sizeHint: text(item.size_hint),
        durationParam: typeof item.duration_param === "string" ? item.duration_param : null,
        durationHint: text(item.duration_hint),
        durations: asArray(item.durations).map(normalizeDuration),
        limits: normalizeLimits(item.limits),
        affects: asArray(item.affects).map((entry) => text(entry)).filter(Boolean),
    };
}

function normalizeEngine(raw: unknown): CapabilityEngine {
    const item = asRecord(raw);
    return {
        id: text(item.id),
        label: text(item.label, text(item.id)),
        kind: text(item.kind),
        nsfw: flag(item.nsfw),
        description: text(item.description),
        route: typeof item.route === "string" ? item.route : null,
        available: flag(item.available),
        unavailableReason: text(item.unavailable_reason),
        params: asArray(item.params).map(normalizeParam),
        limits: normalizeLimits(item.limits),
    };
}

function normalizeSlot(raw: unknown): CapabilitySlot {
    const item = asRecord(raw);
    return {
        id: text(item.id),
        label: text(item.label, text(item.id)),
        available: flag(item.available),
        unavailableReason: text(item.unavailable_reason),
        affects: asArray(item.affects).map((entry) => text(entry)).filter(Boolean),
        engines: asArray(item.engines).map(normalizeEngine),
    };
}

function normalizeIssue(raw: unknown): CapabilityIssue {
    const item = asRecord(raw);
    return {
        id: text(item.id),
        severity: text(item.severity, "error"),
        title: text(item.title),
        reason: text(item.reason),
        affects: asArray(item.affects).map((entry) => text(entry)).filter(Boolean),
    };
}

export function normalizeCapabilities(raw: unknown): ToolCapabilities {
    const payload = asRecord(raw);
    const tools = asRecord(payload.tools);
    return {
        schemaVersion: number(payload.schema_version, 1),
        tools: {
            image: normalizeTool(tools.image, "image", "文生图"),
            video: normalizeTool(tools.video, "video", "文生视频"),
        },
        slots: asArray(payload.slots).map(normalizeSlot),
        issues: asArray(payload.issues).map(normalizeIssue),
    };
}

export async function fetchToolCapabilities(): Promise<ToolCapabilities> {
    const response = await fetch("/api/models/capabilities", { headers: authHeaders() });
    const payload = await response.json().catch(() => null) as Raw | null;
    if (!response.ok) {
        const detail = payload && typeof payload.detail === "string" ? payload.detail : "";
        throw new Error(detail || `生成能力读取失败 (${response.status})`);
    }
    if (!payload || typeof payload !== "object") throw new Error("生成能力响应无效");
    return normalizeCapabilities(payload);
}

export async function refreshModelEndpoints(): Promise<EngineProbeResult> {
    const response = await fetch("/api/models/engines/refresh", { method: "POST", headers: authHeaders() });
    const payload = await response.json().catch(() => null) as Raw | null;
    if (!response.ok) {
        const detail = payload && typeof payload.detail === "string" ? payload.detail : "";
        throw new Error(detail || `端点探测失败 (${response.status})`);
    }
    if (!payload || typeof payload !== "object") throw new Error("端点探测响应无效");
    const engines = asArray(payload.engines).map((entry) => {
        const item = asRecord(entry);
        const submit = asRecord(item.submit);
        return {
            id: text(item.id),
            label: text(item.label, text(item.id)),
            kind: text(item.kind),
            route: text(submit.route, text(item.route)),
            available: flag(item.available),
            reason: text(item.unavailable_reason),
        };
    });
    return {
        count: number(payload.count, engines.length),
        availableCount: engines.filter((engine) => engine.available).length,
        engines,
    };
}

export function defaultSizeValue(tool: ToolCapability, preferred?: string): string {
    const preferredSize = preferred ? tool.sizes.find((size) => size.value === preferred && size.available) : undefined;
    return preferredSize?.value
        ?? tool.sizes.find((size) => size.available)?.value
        ?? tool.sizes[0]?.value
        ?? "";
}

export function defaultDurationValue(tool: ToolCapability): string {
    return tool.durations.find((duration) => duration.default && duration.available)?.value
        ?? tool.durations.find((duration) => duration.available)?.value
        ?? tool.durations[0]?.value
        ?? "";
}

export function defaultModelValue(tool: ToolCapability): string {
    return tool.models.find((model) => model.default)?.value ?? tool.models[0]?.value ?? "";
}
