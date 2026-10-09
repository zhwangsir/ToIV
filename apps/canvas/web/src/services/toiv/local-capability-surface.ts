/**
 * Studio 市场/首页/create-menu 本地能力露出（刀 studio-market-local-capability-surface）。
 * 硬编码本地 7 件套 + Canvas 预置引擎；不接线任意 RH 应用。
 */
import {
    LOCAL_H3_WORKER_LABEL,
    LOCAL_IMAGE_CHANNEL_ID,
    LOCAL_IMAGE_MODEL,
    LOCAL_IMAGE_MODEL_REF,
    LOCAL_IMAGE_WORKER_LABEL,
    LOCAL_VIDEO_ANIMATE_WORKER_LABEL,
    LOCAL_VIDEO_CHANNEL_ID,
    LOCAL_VIDEO_MODEL,
    LOCAL_VIDEO_MODEL_ANIMATE,
    LOCAL_VIDEO_MODEL_AVATAR,
    LOCAL_VIDEO_MODEL_CONTINUE,
    LOCAL_VIDEO_MODEL_LONGCAT,
    LOCAL_VIDEO_MODEL_VACE,
    LOCAL_VIDEO_WORKER_LABEL,
} from "@/lib/local-model-defaults";

/** Gate template 稳定 id（与 model-config.template.json 一致）。 */
export const LOCAL_H3_CHANNEL_ID = "MZt9ON1JvbabJ2GS-PvXR";
export const LOCAL_H3_MODEL_REF = `${LOCAL_H3_CHANNEL_ID}::h3`;

export type LocalCapabilityKind = "image" | "h3" | "wan" | "longcat" | "vace" | "animate" | "continue" | "avatar";

export type LocalCapabilityBadge = {
    kind: LocalCapabilityKind;
    /** 产品短名 */
    label: string;
    /** worker 口，如 :8264 */
    worker: string;
    /** 引擎短标签 */
    engine: string;
    /** Canvas 协议 id */
    protocol: "toiv-comfy-image" | "toiv-comfy-video" | "toiv-h3";
};

/** 市场精选置顶：本地 7 件套（+ Wan 作补充）。appId 为市场 keeper；空=非市场卡（仅 Canvas）。 */
export type LocalMarketFeaturedEntry = LocalCapabilityBadge & {
    id: string;
    /** 市场 app id；无则走 Canvas 深链 */
    appId?: string;
    canvasTo?: string;
};

export const LOCAL_MARKET_FEATURED: readonly LocalMarketFeaturedEntry[] = [
    {
        id: "local-image",
        kind: "image",
        label: "本地出图",
        worker: LOCAL_IMAGE_WORKER_LABEL,
        engine: "Comfy",
        protocol: "toiv-comfy-image",
        canvasTo: "/canvas?mode=new&add=image",
    },
    {
        id: "local-h3",
        kind: "h3",
        label: "H3",
        worker: LOCAL_H3_WORKER_LABEL,
        engine: "H3",
        protocol: "toiv-h3",
        appId: "h3-t2v",
    },
    {
        id: "local-longcat",
        kind: "longcat",
        label: "LongCat",
        worker: LOCAL_VIDEO_WORKER_LABEL,
        engine: "LongCat",
        protocol: "toiv-comfy-video",
        appId: "longcat-t2v",
    },
    {
        id: "local-vace",
        kind: "vace",
        label: "VACE",
        worker: LOCAL_VIDEO_WORKER_LABEL,
        engine: "VACE",
        protocol: "toiv-comfy-video",
        appId: "vace-edit",
    },
    {
        id: "local-animate2",
        kind: "animate",
        label: "Animate2",
        worker: LOCAL_VIDEO_ANIMATE_WORKER_LABEL,
        engine: "Animate2",
        protocol: "toiv-comfy-video",
        appId: "wan-animate-2",
    },
    {
        id: "local-continue",
        kind: "continue",
        label: "Continue",
        worker: LOCAL_VIDEO_WORKER_LABEL,
        engine: "Continue",
        protocol: "toiv-comfy-video",
        appId: "longcat-continue",
    },
    {
        id: "local-avatar",
        kind: "avatar",
        label: "Avatar",
        worker: LOCAL_VIDEO_WORKER_LABEL,
        engine: "Avatar",
        protocol: "toiv-comfy-video",
        appId: "avatar-talk",
    },
    {
        id: "local-wan",
        kind: "wan",
        label: "Wan",
        worker: LOCAL_VIDEO_WORKER_LABEL,
        engine: "Wan",
        protocol: "toiv-comfy-video",
        // Wan 主路径在 Canvas；市场无稳定短名时仅作补充位
        canvasTo: "/canvas?mode=new&add=video",
    },
] as const;

/** app id → 本地徽标（含模式变体前缀匹配）。 */
const APP_ID_BADGES: Array<{ match: (id: string) => boolean; badge: LocalCapabilityBadge }> = [
    {
        match: (id) => id.startsWith("h3-"),
        badge: {
            kind: "h3",
            label: "本地",
            worker: LOCAL_H3_WORKER_LABEL,
            engine: "H3",
            protocol: "toiv-h3",
        },
    },
    {
        match: (id) => id === "longcat-continue" || id.startsWith("longcat-continue"),
        badge: {
            kind: "continue",
            label: "本地",
            worker: LOCAL_VIDEO_WORKER_LABEL,
            engine: "Continue",
            protocol: "toiv-comfy-video",
        },
    },
    {
        match: (id) => id === "avatar-talk" || id.includes("avatar"),
        badge: {
            kind: "avatar",
            label: "本地",
            worker: LOCAL_VIDEO_WORKER_LABEL,
            engine: "Avatar",
            protocol: "toiv-comfy-video",
        },
    },
    {
        match: (id) => id.startsWith("longcat-"),
        badge: {
            kind: "longcat",
            label: "本地",
            worker: LOCAL_VIDEO_WORKER_LABEL,
            engine: "LongCat",
            protocol: "toiv-comfy-video",
        },
    },
    {
        match: (id) => id === "vace-edit" || id.startsWith("vace-") || id.includes("vace"),
        badge: {
            kind: "vace",
            label: "本地",
            worker: LOCAL_VIDEO_WORKER_LABEL,
            engine: "VACE",
            protocol: "toiv-comfy-video",
        },
    },
    {
        match: (id) => id === "wan-animate-2" || id === "wan-animate" || id.includes("animate"),
        badge: {
            kind: "animate",
            label: "本地",
            worker: LOCAL_VIDEO_ANIMATE_WORKER_LABEL,
            engine: "Animate2",
            protocol: "toiv-comfy-video",
        },
    },
];

export function resolveLocalCapabilityBadge(app: {
    id?: string;
    is_builtin?: boolean;
    submit_kind?: string;
}): LocalCapabilityBadge | null {
    const id = String(app.id || "").trim();
    if (!id) return null;
    for (const row of APP_ID_BADGES) {
        if (row.match(id)) return row.badge;
    }
    // 内置短名且 submit_kind 像引擎作业 → 标本地（保守）
    const kind = String(app.submit_kind || "").toLowerCase();
    if (app.is_builtin && (kind.includes("h3") || kind.includes("longcat") || kind.includes("vace") || kind.includes("animate") || kind.includes("avatar"))) {
        return {
            kind: "wan",
            label: "本地",
            worker: LOCAL_VIDEO_WORKER_LABEL,
            engine: kind.split("_")[0] || "本地",
            protocol: "toiv-comfy-video",
        };
    }
    return null;
}

/** 首页对口型/配音/重绘 → 市场 keeper（对齐 apps/web/lib/intentMap.ts）。 */
export const HOME_INTENT_MARKET_LINKS = {
    lipsync: {
        appId: "rh-acc-0520274945-8fa1b4",
        label: "对口型",
        detail: "打开市场最佳对口型应用",
        to: "/toiv/market?app=rh-acc-0520274945-8fa1b4",
    },
    dub: {
        appId: "h3-r2v-voice",
        label: "配音",
        detail: "打开市场 H3 声音参考应用",
        to: "/toiv/market?app=h3-r2v-voice",
    },
    inpaint: {
        appId: "rh-acc-1967241218-76fc32",
        label: "局部重绘",
        detail: "打开市场局部重绘应用",
        to: "/toiv/market?app=rh-acc-1967241218-76fc32",
    },
} as const;

export type LocalCreatePreset = {
    id: string;
    label: string;
    badge: string;
    nodeType: "image" | "video";
    /** channel::model */
    modelRef: string;
    protocol: "toiv-comfy-image" | "toiv-comfy-video" | "toiv-h3";
    engine?: string;
    defaultOrder: number;
};

/** create-menu 预置：出图 + H3 + 出视频 6 引擎。 */
export const LOCAL_CREATE_PRESETS: readonly LocalCreatePreset[] = [
    {
        id: "local-preset-comfy-image",
        label: "本地出图",
        badge: "本地",
        nodeType: "image",
        modelRef: LOCAL_IMAGE_MODEL_REF,
        protocol: "toiv-comfy-image",
        defaultOrder: 21,
    },
    {
        id: "local-preset-h3",
        label: "本地 H3",
        badge: "本地",
        nodeType: "video",
        modelRef: LOCAL_H3_MODEL_REF,
        protocol: "toiv-h3",
        engine: "h3",
        defaultOrder: 31,
    },
    {
        id: "local-preset-wan",
        label: "本地 Wan",
        badge: "本地",
        nodeType: "video",
        modelRef: `${LOCAL_VIDEO_CHANNEL_ID}::${LOCAL_VIDEO_MODEL}`,
        protocol: "toiv-comfy-video",
        engine: "wan",
        defaultOrder: 32,
    },
    {
        id: "local-preset-longcat",
        label: "本地 LongCat",
        badge: "本地",
        nodeType: "video",
        modelRef: `${LOCAL_VIDEO_CHANNEL_ID}::${LOCAL_VIDEO_MODEL_LONGCAT}`,
        protocol: "toiv-comfy-video",
        engine: "longcat",
        defaultOrder: 33,
    },
    {
        id: "local-preset-vace",
        label: "本地 VACE",
        badge: "本地",
        nodeType: "video",
        modelRef: `${LOCAL_VIDEO_CHANNEL_ID}::${LOCAL_VIDEO_MODEL_VACE}`,
        protocol: "toiv-comfy-video",
        engine: "vace",
        defaultOrder: 34,
    },
    {
        id: "local-preset-animate",
        label: "本地 Animate2",
        badge: "本地",
        nodeType: "video",
        modelRef: `${LOCAL_VIDEO_CHANNEL_ID}::${LOCAL_VIDEO_MODEL_ANIMATE}`,
        protocol: "toiv-comfy-video",
        engine: "animate",
        defaultOrder: 35,
    },
    {
        id: "local-preset-continue",
        label: "本地 Continue",
        badge: "本地",
        nodeType: "video",
        modelRef: `${LOCAL_VIDEO_CHANNEL_ID}::${LOCAL_VIDEO_MODEL_CONTINUE}`,
        protocol: "toiv-comfy-video",
        engine: "continue",
        defaultOrder: 36,
    },
    {
        id: "local-preset-avatar",
        label: "本地 Avatar",
        badge: "本地",
        nodeType: "video",
        modelRef: `${LOCAL_VIDEO_CHANNEL_ID}::${LOCAL_VIDEO_MODEL_AVATAR}`,
        protocol: "toiv-comfy-video",
        engine: "avatar",
        defaultOrder: 37,
    },
] as const;

/** 精选 id 稳定置顶（有则靠前；无则保持相对序）。 */
export function sortAppsWithFeaturedIds<T extends { id: string }>(apps: T[], featuredIds: readonly string[]): T[] {
    if (!featuredIds.length) return apps;
    const rank = new Map(featuredIds.map((id, i) => [id, i]));
    return [...apps].sort((a, b) => {
        const ra = rank.get(a.id);
        const rb = rank.get(b.id);
        if (ra != null && rb != null) return ra - rb;
        if (ra != null) return -1;
        if (rb != null) return 1;
        return 0;
    });
}

export function localMarketFeaturedAppIds(): string[] {
    return LOCAL_MARKET_FEATURED.map((e) => e.appId).filter((id): id is string => Boolean(id));
}

// re-export channel ids used by tests / UI
export { LOCAL_IMAGE_CHANNEL_ID, LOCAL_IMAGE_MODEL, LOCAL_VIDEO_CHANNEL_ID };
