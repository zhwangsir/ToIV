/**
 * 市场应用 SFW/R18 content_mode 解析(D-U1=B)。
 * 与后端 app_content_modes / POST /apps/{id}/run 对齐;fail-closed:
 * R18 关或无 X-NSFW 意图时永不提交 nsfw。
 */

export type ContentMode = "sfw" | "nsfw";

export type ContentModeApp = {
    id?: string;
    is_nsfw?: boolean;
    content_modes?: string[];
    nsfw_variant_id?: string | null;
};

/** 经典 EngineStudio NSFW 引擎 → canvas 市场入口(孪生父卡或纯 R18 卡)。 */
export const CLASSIC_NSFW_TO_MARKET: ReadonlyArray<{
    classicEngineId: string;
    marketAppId: string;
    via: "content_mode" | "is_nsfw_app";
}> = [
    { classicEngineId: "nsfw-txt2img", marketAppId: "txt2img-basic", via: "content_mode" },
    { classicEngineId: "nsfw-img2img", marketAppId: "img2img-basic", via: "content_mode" },
    { classicEngineId: "h3-nsfw-t2v", marketAppId: "h3-t2v", via: "content_mode" },
    { classicEngineId: "h3-nsfw-i2v", marketAppId: "h3-i2v", via: "content_mode" },
    { classicEngineId: "h3-nsfw-fl2v", marketAppId: "h3-fl2v", via: "content_mode" },
    { classicEngineId: "h3-nsfw-r2v", marketAppId: "h3-r2v", via: "content_mode" },
    { classicEngineId: "ltx-nsfw-t2v", marketAppId: "ltx-txt2video", via: "is_nsfw_app" },
    { classicEngineId: "ltx-nsfw-i2v", marketAppId: "ltx-img2video", via: "is_nsfw_app" },
    { classicEngineId: "ltx-nsfw-lipsync", marketAppId: "ltx-lipsync", via: "is_nsfw_app" },
    { classicEngineId: "wan-nsfw-i2v", marketAppId: "wan-nsfw-i2v", via: "is_nsfw_app" },
];

export function normalizeContentModes(raw: unknown): ContentMode[] {
    if (!Array.isArray(raw)) return ["sfw"];
    const out: ContentMode[] = [];
    for (const x of raw) {
        const s = String(x).trim().toLowerCase();
        if ((s === "sfw" || s === "nsfw") && !out.includes(s)) out.push(s);
    }
    return out.length ? out : ["sfw"];
}

/** 应用详情/列表字段归一(缺省 fail-closed 为 SFW)。 */
export function normalizeContentModeFields<T extends ContentModeApp>(app: T): T & {
    is_nsfw: boolean;
    content_modes: ContentMode[];
    nsfw_variant_id: string | null;
} {
    const is_nsfw = app.is_nsfw === true;
    let content_modes = normalizeContentModes(app.content_modes);
    if (is_nsfw && !content_modes.includes("nsfw")) {
        content_modes = content_modes.includes("sfw") ? [...content_modes, "nsfw"] : ["nsfw"];
    }
    if (!is_nsfw && content_modes.length === 0) content_modes = ["sfw"];
    const nsfw_variant_id =
        app.nsfw_variant_id == null || app.nsfw_variant_id === ""
            ? null
            : String(app.nsfw_variant_id);
    return { ...app, is_nsfw, content_modes, nsfw_variant_id };
}

/**
 * 是否在抽屉展示 SFW|R18 切换。
 * 须同时:本机 R18 开 + 后端 content_modes 含 nsfw + 非纯 NSFW 单模(纯 NSFW 无需切换)。
 */
export function canShowContentModeToggle(
    app: ContentModeApp | null | undefined,
    r18On: boolean,
): boolean {
    if (!r18On || !app) return false;
    const modes = normalizeContentModes(app.content_modes);
    return modes.includes("sfw") && modes.includes("nsfw");
}

/**
 * 提交用 content_mode。fail-closed:
 * - R18 关 → 永远 sfw(即便卡带 content_modes nsfw)
 * - 纯 is_nsfw 卡 → nsfw(仅当 R18 开;关时本不应拉到详情)
 * - 双模卡 → 用户选择;非法值回落 sfw
 */
export function resolveSubmitContentMode(opts: {
    app: ContentModeApp | null | undefined;
    r18On: boolean;
    selected: ContentMode | string | null | undefined;
}): ContentMode {
    const { app, r18On } = opts;
    if (!r18On) return "sfw";
    if (!app) return "sfw";
    const modes = normalizeContentModes(app.content_modes);
    const selected = String(opts.selected ?? "").trim().toLowerCase();
    if (app.is_nsfw === true && !modes.includes("sfw")) return "nsfw";
    if (selected === "nsfw" && modes.includes("nsfw")) return "nsfw";
    if (selected === "sfw" && modes.includes("sfw")) return "sfw";
    if (modes.includes("nsfw") && !modes.includes("sfw")) return "nsfw";
    return "sfw";
}

/** 列表卡是否显示 R18 徽标(双模或纯 NSFW)。 */
export function appShowsR18Badge(app: ContentModeApp | null | undefined): boolean {
    if (!app) return false;
    if (app.is_nsfw === true) return true;
    return normalizeContentModes(app.content_modes).includes("nsfw");
}

/** 纯成人卡（无普通模式面）：普通模式列表应隐藏，避免漏出。 */
export function appIsPureNsfw(app: ContentModeApp | null | undefined): boolean {
    if (!app) return false;
    const modes = normalizeContentModes(app.content_modes);
    if (app.is_nsfw === true && !modes.includes("sfw")) return true;
    if (modes.includes("nsfw") && !modes.includes("sfw")) return true;
    return false;
}

/** 普通模式隐藏纯成人应用；成人模式全部可见。双模卡始终可见（提交仍 fail-closed）。 */
export function appVisibleForContentMode(app: ContentModeApp | null | undefined, r18On: boolean): boolean {
    if (!app) return false;
    if (r18On) return true;
    return !appIsPureNsfw(app);
}
