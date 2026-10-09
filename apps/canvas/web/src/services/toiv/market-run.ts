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

export type MarketMediaHandle = {
    filename: string;
    worker?: string;
    name?: string;
    previewUrl?: string;
};

export function isRemoteDemoMedia(filename: string): boolean {
    return /^https?:\/\//i.test(String(filename || "").trim());
}

export type MediaFilenamesOpts = {
    /** 是否保留 http(s) 示例 URL；提交/必填校验应 false。默认 true。 */
    includeRemoteDemo?: boolean;
};

/** 媒体表单值 → 非空文件名数组。兼容 string / string[] / {filename}[]。 */
export function mediaFilenames(value: unknown, opts: MediaFilenamesOpts = {}): string[] {
    const includeRemoteDemo = opts.includeRemoteDemo !== false;
    if (value == null || value === "") return [];
    const items = Array.isArray(value) ? value : [value];
    const out: string[] = [];
    for (const item of items) {
        if (typeof item === "string") {
            const f = item.trim();
            if (!f) continue;
            if (!includeRemoteDemo && isRemoteDemoMedia(f)) continue;
            out.push(f);
        } else if (item && typeof item === "object" && "filename" in item) {
            const f = String((item as { filename: unknown }).filename ?? "").trim();
            if (!f) continue;
            if (!includeRemoteDemo && isRemoteDemoMedia(f)) continue;
            out.push(f);
        }
    }
    return out;
}

/** 应用运行页上传 kind（对齐主站 appUploadKind）。 */
export function appUploadKind(appId: string): string {
    const id = String(appId || "");
    if (id.startsWith("h3-")) return "h3_i2v";
    if (id.startsWith("wan-animate-2")) return "wan_animate2";
    if (id.startsWith("wan-animate")) return "wan_animate";
    if (id === "wan-vace" || id === "vace-edit" || id === "wan-transition") return "wan_vace";
    if (id.startsWith("longcat-") || id.startsWith("phantom-") || id.startsWith("ovi-")) return "avatar";
    if (id.startsWith("avatar")) return "avatar";
    if (id.startsWith("ltx")) return id.includes("lipsync") ? "ltx_lipsync" : "ltx_i2v";
    return "img2img";
}

/** 已上传句柄里的首个非空 worker（多槽互钉）。 */
export function firstPinWorker(values: Record<string, unknown>): string | null {
    for (const v of Object.values(values)) {
        const items = Array.isArray(v) ? v : v != null ? [v] : [];
        for (const item of items) {
            if (item && typeof item === "object" && typeof (item as { worker?: unknown }).worker === "string") {
                const w = (item as { worker: string }).worker.trim();
                if (w) return w;
            }
        }
    }
    return null;
}

/** 表单值 → 已上传句柄列表（兼容 string / 句柄对象）。 */
export function asMarketMediaList(value: unknown): MarketMediaHandle[] {
    if (value == null || value === "") return [];
    const items = Array.isArray(value) ? value : [value];
    const out: MarketMediaHandle[] = [];
    for (const item of items) {
        if (typeof item === "string" && item.trim()) {
            const f = item.trim();
            const preview = isRemoteDemoMedia(f) ? f : "";
            out.push({ filename: f, worker: "", name: preview ? "示例素材" : f, previewUrl: preview });
        } else if (item && typeof item === "object" && typeof (item as MarketMediaHandle).filename === "string") {
            const h = item as MarketMediaHandle;
            const preview = (h.previewUrl || "").trim() || (isRemoteDemoMedia(h.filename) ? h.filename : "");
            out.push({
                ...h,
                name: h.name || (preview ? "示例素材" : h.filename),
                previewUrl: preview,
            });
        }
    }
    return out;
}

/** 提交载荷归一（对齐主站 buildRunValues；媒体抽 filename 数组）。 */
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
            out[p.key] = mediaFilenames(v, { includeRemoteDemo: false });
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
            if (mediaFilenames(v, { includeRemoteDemo: false }).length === 0) return p.label || p.key;
            continue;
        }
        if (p.default != null) continue;
        if (v == null || String(v).trim() === "") return p.label || p.key;
    }
    return null;
}
