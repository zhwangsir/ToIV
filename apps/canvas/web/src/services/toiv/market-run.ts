/**
 * 市场运行纯函数（无 axios）：默认值 / 提交归一 / 必填缺口。
 * 供 market-page 与单测共用；网络调用仍在 client.ts。
 */
export type ToivAppParamType = "text" | "textarea" | "number" | "select" | "switch" | "images" | "audio" | "video";

export type ToivAppParam = {
    key: string;
    label: string;
    type: ToivAppParamType;
    default: unknown;
    options?: Array<{ value: string; label: string }>;
    min?: number;
    max?: number;
    step?: number;
    hint?: string;
    required?: boolean;
};

const MEDIA_PARAM_TYPES = new Set<ToivAppParamType>(["images", "audio", "video"]);
const PARAM_TYPES = new Set<ToivAppParamType>(["text", "textarea", "number", "select", "switch", "images", "audio", "video"]);

export function normalizeToivAppParam(raw: unknown): ToivAppParam {
    const p = (raw ?? {}) as Record<string, unknown>;
    const type = PARAM_TYPES.has(p.type as ToivAppParamType) ? (p.type as ToivAppParamType) : "text";
    const out: ToivAppParam = {
        key: String(p.key ?? ""),
        label: String(p.label ?? p.key ?? ""),
        type,
        default: p.default === undefined ? null : p.default,
    };
    if (Array.isArray(p.options)) {
        out.options = p.options
            .map((o) => {
                const r = (o ?? {}) as Record<string, unknown>;
                return { value: String(r.value ?? ""), label: String(r.label ?? r.value ?? "") };
            })
            .filter((o) => o.value !== "" || o.label !== "");
    }
    for (const k of ["min", "max", "step"] as const) {
        const n = Number(p[k]);
        if (Number.isFinite(n)) out[k] = n;
    }
    if (typeof p.hint === "string" && p.hint) out.hint = p.hint;
    if (p.required === true) out.required = true;
    else if (p.required === false) out.required = false;
    return out;
}

/** 用 schema 默认值填表；switch 缺省 false；媒体槽空数组 */
export function buildDefaultRunValues(schema: ToivAppParam[]): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const p of schema) {
        if (!p.key) continue;
        if (p.type === "switch") {
            out[p.key] = p.default === true || p.default === 1;
            continue;
        }
        if (MEDIA_PARAM_TYPES.has(p.type)) {
            out[p.key] = Array.isArray(p.default) ? p.default : [];
            continue;
        }
        if (p.type === "number") {
            out[p.key] = typeof p.default === "number" && Number.isFinite(p.default) ? p.default : "";
            continue;
        }
        out[p.key] = p.default == null ? "" : String(p.default);
    }
    return out;
}

/** 提交载荷归一（对齐主站 buildRunValues；媒体本页仅传文件名数组） */
export function buildToivRunValues(schema: ToivAppParam[], values: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const p of schema) {
        if (!p.key) continue;
        const v = values[p.key];
        if (p.type === "number") {
            if (typeof v === "number" && Number.isFinite(v)) {
                out[p.key] = v;
                continue;
            }
            const raw = String(v ?? "").trim();
            if (!raw) continue;
            const n = Number(raw);
            if (Number.isFinite(n)) out[p.key] = n;
            continue;
        }
        if (p.type === "switch") {
            out[p.key] = Boolean(v);
            continue;
        }
        if (MEDIA_PARAM_TYPES.has(p.type)) {
            out[p.key] = Array.isArray(v) ? v.map(String).filter(Boolean) : [];
            continue;
        }
        if (Array.isArray(v)) {
            out[p.key] = v;
            continue;
        }
        out[p.key] = String(v ?? "");
    }
    return out;
}

/** 必填缺口 label；无缺口返回 null */
export function requiredToivParamLabel(schema: ToivAppParam[], values: Record<string, unknown>): string | null {
    for (const p of schema) {
        if (!p.key) continue;
        if (p.type === "switch") continue;
        if (p.required === false) continue;
        const v = values[p.key];
        if (MEDIA_PARAM_TYPES.has(p.type)) {
            const list = Array.isArray(v) ? v : [];
            if (list.length === 0) return p.label || p.key;
            continue;
        }
        if (p.default != null) continue;
        if (v == null || String(v).trim() === "") return p.label || p.key;
    }
    return null;
}
