/**
 * 市场运行纯函数（无 axios）：默认值 / 提交归一 / 必填缺口。
 * 供 market-page 与单测共用；网络调用仍在 client.ts。
 */
export type ToivAppParamType = "text" | "textarea" | "number" | "select" | "switch" | "images" | "audio" | "video" | "loras";

export type ToivAppParam = {
    key: string;
    label: string;
    type: ToivAppParamType;
    default: unknown;
    options?: Array<{ value: string; label: string; nsfw?: boolean }>;
    min?: number;
    max?: number;
    step?: number;
    hint?: string;
    required?: boolean;
};

const MEDIA_PARAM_TYPES = new Set<ToivAppParamType>(["images", "audio", "video"]);
const PARAM_TYPES = new Set<ToivAppParamType>(["text", "textarea", "number", "select", "switch", "images", "audio", "video", "loras"]);

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
                const item: { value: string; label: string; nsfw?: boolean } = {
                    value: String(r.value ?? ""),
                    label: String(r.label ?? r.value ?? ""),
                };
                if (r.nsfw === true) item.nsfw = true;
                return item;
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
        if (p.type === "loras") {
            // []=关闭; null=AI; 非空=钉选。市场默认关闭。
            if (p.default === null) out[p.key] = null;
            else if (Array.isArray(p.default)) out[p.key] = p.default;
            else out[p.key] = [];
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
        if (p.type === "loras") {
            // 透传 null=AI / []=关闭 / [{name,strength}]=钉选；勿 String 化
            if (v === null) {
                out[p.key] = null;
                continue;
            }
            if (v === undefined) {
                continue;
            }
            if (Array.isArray(v)) {
                out[p.key] = v
                    .filter((item) => item && typeof item === "object")
                    .map((item) => {
                        const r = item as { name?: unknown; strength?: unknown };
                        const name = String(r.name ?? "").trim();
                        const strength = Number(r.strength);
                        return {
                            name,
                            strength: Number.isFinite(strength) ? strength : 0.6,
                        };
                    })
                    .filter((item) => item.name !== "")
                    .slice(0, 3);
                continue;
            }
            out[p.key] = [];
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

/** 核心参数正则：媒体槽 + 尺寸/时长/分辨率类直接外露。 */
const MARKET_CORE_PARAM_RE =
    /(size|count|num|ratio|length|frames|duration|resolution|width|height|positive|prompt|尺寸|张数|比例|时长|分辨率|帧数|宽度|高度|提示词)/i;

/** 明确划进「常用高级」的键（经典引擎台同款 knobs）。 */
/** 更深参数：仅当 schema/后端真支持时出现（LoRA / 输出超分）。 */
const MARKET_DEEP_KEYS = new Set([
    "loras",
    "lora",
    "resolution_target",
    "segment_extend", // 若后端某卡声明了才显示；市场 run 当前不接续段链
]);

const MARKET_ADVANCED_KEYS = new Set([
    "steps",
    "seed",
    "cfg",
    "guidance",
    "denoise",
    "strength",
    "sampler",
    "negative",
    "use_upscale",
    "use_rife",
    "fps",
    ...MARKET_DEEP_KEYS,
]);

export function isMarketDeepParam(p: Pick<ToivAppParam, "key" | "type">): boolean {
    if (p.type === "loras") return true;
    return MARKET_DEEP_KEYS.has(String(p.key || ""));
}

export function isMarketCoreParam(p: Pick<ToivAppParam, "key" | "label" | "type">): boolean {
    if (MEDIA_PARAM_TYPES.has(p.type)) return true;
    const key = String(p.key || "");
    if (MARKET_ADVANCED_KEYS.has(key)) return false;
    if (MARKET_CORE_PARAM_RE.test(key) || MARKET_CORE_PARAM_RE.test(p.label ?? "")) return true;
    // 提示词类 textarea 外露；其余 textarea（如负向）走高级
    if (p.type === "textarea" && /(positive|prompt|提示)/i.test(key + (p.label ?? ""))) return true;
    return false;
}

export function splitMarketRunParams(schema: ToivAppParam[]): {
    core: ToivAppParam[];
    advanced: ToivAppParam[];
    deep: ToivAppParam[];
} {
    const core: ToivAppParam[] = [];
    const advanced: ToivAppParam[] = [];
    const deep: ToivAppParam[] = [];
    for (const p of schema) {
        if (!p.key) continue;
        if (isMarketDeepParam(p)) deep.push(p);
        else if (isMarketCoreParam(p)) core.push(p);
        else advanced.push(p);
    }
    return { core, advanced, deep };
}

/** 扩展卡捷径：父卡 modes 未列时补齐（15s-fast / 配音）。 */
export const MARKET_EXTENSION_SHORTCUTS: ReadonlyArray<{
    parentIds: readonly string[];
    mode: { label: string; desc: string; app_id: string };
}> = [
    {
        parentIds: ["h3-t2v", "h3-nsfw-t2v"],
        mode: { label: "15秒加速", desc: "约 15 秒单段加速预设", app_id: "h3-t2v-15s-fast" },
    },
    {
        parentIds: ["h3-i2v", "h3-nsfw-i2v"],
        mode: { label: "15秒加速", desc: "约 15 秒单段加速预设", app_id: "h3-i2v-15s-fast" },
    },
    {
        parentIds: ["h3-r2v", "h3-nsfw-r2v", "h3-r2v-voice", "h3-nsfw-r2v-voice"],
        mode: { label: "配音", desc: "声音参考 / 配音（须参考音频）", app_id: "h3-r2v-voice" },
    },
];

export type MarketModeChip = { label: string; desc?: string; app_id: string };

/** 合并后端 variants.modes 与本地扩展捷径（按 app_id 去重，后端优先）。 */
export function mergeMarketModeChips(
    appId: string | null | undefined,
    backendModes: ReadonlyArray<MarketModeChip>,
): MarketModeChip[] {
    const id = String(appId || "").trim();
    const out: MarketModeChip[] = [];
    const seen = new Set<string>();
    for (const m of backendModes) {
        const aid = String(m.app_id || "").trim();
        if (!aid || seen.has(aid)) continue;
        seen.add(aid);
        out.push({ label: m.label || aid, desc: m.desc || "", app_id: aid });
    }
    for (const ext of MARKET_EXTENSION_SHORTCUTS) {
        if (!ext.parentIds.includes(id) && id !== ext.mode.app_id) continue;
        if (seen.has(ext.mode.app_id)) continue;
        // 当前已是该扩展卡时仍展示，便于回看父卡 sibling
        seen.add(ext.mode.app_id);
        out.push({ ...ext.mode });
    }
    return out;
}

const UI_RESOLUTION_KEY = "_ui_resolution";
const UI_DURATION_KEY = "_ui_duration";

const MARKET_RES_PRESETS: Array<{ value: string; label: string }> = [
    { value: "832x480", label: "480p 横 (832×480)" },
    { value: "1280x736", label: "720p 横 (1280×736)" },
    { value: "1344x768", label: "768p 横 (1344×768)" },
    { value: "1024x1024", label: "1:1 (1024×1024)" },
    { value: "480x832", label: "480p 竖 (480×832)" },
    { value: "736x1280", label: "720p 竖 (736×1280)" },
    { value: "768x1344", label: "768p 竖 (768×1344)" },
];

const MARKET_DUR_PRESETS: Array<{ value: string; label: string }> = [
    { value: "4", label: "4 秒" },
    { value: "5", label: "5 秒" },
    { value: "6", label: "6 秒" },
    { value: "8", label: "8 秒" },
    { value: "10", label: "10 秒" },
    { value: "15", label: "15 秒" },
];

function schemaHasKey(schema: ToivAppParam[], key: string): boolean {
    return schema.some((p) => p.key === key);
}

/** H3：秒 → 17k+5 @24fps 帧数，夹在 [17,362]。 */
export function h3LengthFromSeconds(sec: number): number {
    const s = Number.isFinite(sec) && sec > 0 ? sec : 5;
    const raw = s * 24;
    const k = Math.round((raw - 5) / 17);
    const length = k * 17 + 5;
    return Math.max(17, Math.min(362, length));
}

/** LTX：秒 → 8k+1 @16fps 帧数，夹在 [9,257]。 */
export function ltxFramesFromSeconds(sec: number, fps = 16): number {
    const s = Number.isFinite(sec) && sec > 0 ? sec : 6;
    const raw = Math.round(s * fps);
    const k = Math.round((raw - 1) / 8);
    const frames = k * 8 + 1;
    return Math.max(9, Math.min(257, frames));
}

export function parseResolutionPreset(value: string): { width: number; height: number } | null {
    const m = /^(\d+)x(\d+)$/i.exec(String(value || "").trim());
    if (!m) return null;
    const width = Number(m[1]);
    const height = Number(m[2]);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 64 || height < 64) return null;
    return { width, height };
}

/**
 * 当 schema 只有 width/height（或 length/frames）而无 resolution/duration 下拉时，
 * 注入 UI 便捷项；改值时写回真实键，run payload 仍只含 schema 键（易透传、非假 UI）。
 */
export function marketConvenienceParams(schema: ToivAppParam[]): ToivAppParam[] {
    const out: ToivAppParam[] = [];
    const hasWH = schemaHasKey(schema, "width") && schemaHasKey(schema, "height");
    const hasRes = schemaHasKey(schema, "resolution");
    if (hasWH && !hasRes) {
        out.push({
            key: UI_RESOLUTION_KEY,
            label: "分辨率预设",
            type: "select",
            default: "1280x736",
            options: MARKET_RES_PRESETS,
            hint: "写入宽度/高度；亦可在常用高级里细调",
        });
    }
    const hasLength = schemaHasKey(schema, "length");
    const hasFrames = schemaHasKey(schema, "frames");
    const hasDur = schemaHasKey(schema, "duration");
    if ((hasLength || hasFrames) && !hasDur) {
        out.push({
            key: UI_DURATION_KEY,
            label: "时长预设",
            type: "select",
            default: hasLength ? "5" : "6",
            options: MARKET_DUR_PRESETS,
            hint: hasLength
                ? "按 24fps 写入帧数 length（17k+5 网格）"
                : "按 16fps 写入帧数 frames（8k+1 网格）",
        });
    }
    return out;
}

/** 应用便捷控件改动 → 更新真实 schema 值；UI 键本身也保留在 values 便于回显。 */
export function applyMarketConvenienceChange(
    schema: ToivAppParam[],
    key: string,
    next: unknown,
    values: Record<string, unknown>,
): Record<string, unknown> {
    const out = { ...values, [key]: next };
    if (key === UI_RESOLUTION_KEY) {
        const parsed = parseResolutionPreset(String(next ?? ""));
        if (parsed && schemaHasKey(schema, "width") && schemaHasKey(schema, "height")) {
            out.width = parsed.width;
            out.height = parsed.height;
        }
        return out;
    }
    if (key === UI_DURATION_KEY) {
        const sec = Number(String(next ?? "").trim());
        if (!Number.isFinite(sec) || sec <= 0) return out;
        if (schemaHasKey(schema, "length")) out.length = h3LengthFromSeconds(sec);
        else if (schemaHasKey(schema, "frames")) out.frames = ltxFramesFromSeconds(sec);
        return out;
    }
    return out;
}

export function isMarketConvenienceKey(key: string): boolean {
    return key === UI_RESOLUTION_KEY || key === UI_DURATION_KEY;
}

/** 拆分时：有分辨率预设则把原始 width/height 挪进高级；有时长预设则把 length/frames 挪进高级。 */
export function splitMarketRunParamsWithConvenience(schema: ToivAppParam[]): {
    core: ToivAppParam[];
    advanced: ToivAppParam[];
    deep: ToivAppParam[];
    convenience: ToivAppParam[];
} {
    const convenience = marketConvenienceParams(schema);
    const hideWH = convenience.some((p) => p.key === UI_RESOLUTION_KEY);
    const hideLen = convenience.some((p) => p.key === UI_DURATION_KEY);
    const { core: rawCore, advanced: rawAdv, deep } = splitMarketRunParams(schema);
    const core: ToivAppParam[] = [];
    const advanced: ToivAppParam[] = [...rawAdv];
    for (const p of rawCore) {
        if (hideWH && (p.key === "width" || p.key === "height")) {
            advanced.push(p);
            continue;
        }
        if (hideLen && (p.key === "length" || p.key === "frames")) {
            advanced.push(p);
            continue;
        }
        core.push(p);
    }
    return { core, advanced, deep, convenience };
}

/** 家族是否可接市场更深参数（与后端 app_deep_knobs 对齐）。 */
export function marketAppSupportsLoras(appId: string | null | undefined): boolean {
    const id = String(appId || "").trim().toLowerCase();
    return id.startsWith("h3-") || id.startsWith("ltx");
}

export function marketAppSupportsResolutionTarget(appId: string | null | undefined): boolean {
    const id = String(appId || "").trim().toLowerCase();
    return (
        id.startsWith("h3-") ||
        id.startsWith("ltx") ||
        id.startsWith("longcat-") ||
        id.startsWith("wan-")
    );
}

const MARKET_RES_TARGET_OPTIONS: Array<{ value: string; label: string }> = [
    { value: "", label: "原生直出(不超分)" },
    { value: "720p", label: "720P (二次超分)" },
    { value: "1080p", label: "1080P (二次超分)" },
    { value: "2k", label: "2K (二次超分)" },
    { value: "4k", label: "4K (二次超分)" },
];

/**
 * 详情 schema 缺更深 knobs 时本地补齐（后端 get_app 也会 enrich；双保险防未热更）。
 * 不伪造 segment_extend。
 */
export function enrichMarketSchemaWithDeepParams(
    appId: string | null | undefined,
    schema: ToivAppParam[],
): ToivAppParam[] {
    const out = [...schema];
    const keys = new Set(out.map((p) => p.key));
    if (marketAppSupportsLoras(appId) && !keys.has("loras")) {
        out.push(
            normalizeToivAppParam({
                key: "loras",
                label: "LoRA 叠加",
                type: "loras",
                default: [],
                min: 0.5,
                max: 1.0,
                step: 0.05,
                hint: "默认关闭；可选 AI 选配或钉选最多 3 个",
                options: [],
                required: false,
            }),
        );
        keys.add("loras");
    }
    if (marketAppSupportsResolutionTarget(appId) && !keys.has("resolution_target")) {
        out.push(
            normalizeToivAppParam({
                key: "resolution_target",
                label: "输出超分",
                type: "select",
                default: "",
                options: MARKET_RES_TARGET_OPTIONS,
                hint: "生成完成后自动挂二次超分链",
                required: false,
            }),
        );
    }
    return out;
}

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
