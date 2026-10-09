/**
 * Studio 市场/首页/create-menu 本地能力露出（刀 studio-market-local-capability-surface）。
 * 硬编码本地 7 件套 + Canvas 预置引擎；不接线任意 RH 应用。
 */
import {
    LOCAL_AUDIO_HAS_SENSEVOICE,
    LOCAL_AUDIO_UNAVAILABLE_LABEL,
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

/** 首页意图条条目（对齐 apps/web/lib/intentMap.ts INTENT_ENTRIES keepers）。 */
export type HomeIntentMarketLink = {
    id: string;
    appId: string;
    label: string;
    detail: string;
    to: string;
};

function homeIntentLink(id: string, appId: string, label: string, detail: string): HomeIntentMarketLink {
    return { id, appId, label, detail, to: `/toiv/market?app=${appId}` };
}

/**
 * 首页意图条完整 keepers（顺序/id/appId 与 intentMap INTENT_ENTRIES 一致）。
 * 点击 → `/toiv/market?app=<keeperId>`（市场页已支持 ?app= 深链）。
 */
export const HOME_INTENT_ENTRIES: readonly HomeIntentMarketLink[] = [
    homeIntentLink("outfit", "rh-acc-3051342849-5d0a1c", "换装", "打开市场最佳换装应用"),
    homeIntentLink("bg", "rh-acc-0017330178-cb700a", "换背景", "打开市场最佳换背景应用"),
    homeIntentLink("i2v", "rh-acc-1833790465-924e7f", "图生视频", "打开市场最佳图生视频应用"),
    homeIntentLink("t2v", "rh-acc-8490907650-9066b5", "文生视频", "打开市场最佳文生视频应用"),
    homeIntentLink("lipsync", "rh-acc-0520274945-8fa1b4", "对口型", "打开市场最佳对口型应用"),
    homeIntentLink("voice", "h3-r2v-voice", "配音", "打开市场 H3 声音参考应用"),
    homeIntentLink("cutout", "removebg", "抠图", "打开市场抠图应用"),
    homeIntentLink("upscale", "upscale", "放大", "打开市场放大应用"),
    homeIntentLink("vfi", "rh-acc-8235642881-d2b7ba", "补帧", "打开市场补帧应用"),
    homeIntentLink("line", "rh-acc-4520427522-dfb012", "线稿上色", "打开市场线稿上色应用"),
    homeIntentLink("vace", "vace-edit", "视频换装", "打开市场视频换装应用"),
    homeIntentLink("music", "ace-music", "音乐", "打开市场音乐应用"),
    homeIntentLink("t2i", "rh-acc-4888229889-d922f7", "文生图", "打开市场文生图应用"),
    homeIntentLink("restore", "rh-acc-5353125890-0e3695", "老照片修复", "打开市场老照片修复应用"),
    homeIntentLink("inpaint", "rh-acc-1967241218-76fc32", "局部重绘", "打开市场局部重绘应用"),
    homeIntentLink("portrait", "rh-acc-6626592769-075f0c", "人像写真", "打开市场人像写真应用"),
    homeIntentLink("product", "rh-acc-5532266497-a8b665", "产品图", "打开市场产品图应用"),
    homeIntentLink("edit", "rh-acc-3722891266-720f7b", "图像编辑", "打开市场图像编辑应用"),
    homeIntentLink("style", "rh-acc-0466103297-947a01", "风格化", "打开市场风格化应用"),
    homeIntentLink("3d", "rh-acc-1922543617-0d4e78", "3D", "打开市场 3D 应用"),
];

/**
 * 按 id 索引；`dub` 为 `voice`（配音）别名，兼容 tip 30357bfc 旧接线。
 */
export const HOME_INTENT_MARKET_LINKS = {
    outfit: HOME_INTENT_ENTRIES[0],
    bg: HOME_INTENT_ENTRIES[1],
    i2v: HOME_INTENT_ENTRIES[2],
    t2v: HOME_INTENT_ENTRIES[3],
    lipsync: HOME_INTENT_ENTRIES[4],
    voice: HOME_INTENT_ENTRIES[5],
    /** @deprecated 用 voice；保留给旧 home 接线 */
    dub: HOME_INTENT_ENTRIES[5],
    cutout: HOME_INTENT_ENTRIES[6],
    upscale: HOME_INTENT_ENTRIES[7],
    vfi: HOME_INTENT_ENTRIES[8],
    line: HOME_INTENT_ENTRIES[9],
    vace: HOME_INTENT_ENTRIES[10],
    music: HOME_INTENT_ENTRIES[11],
    t2i: HOME_INTENT_ENTRIES[12],
    restore: HOME_INTENT_ENTRIES[13],
    inpaint: HOME_INTENT_ENTRIES[14],
    portrait: HOME_INTENT_ENTRIES[15],
    product: HOME_INTENT_ENTRIES[16],
    edit: HOME_INTENT_ENTRIES[17],
    style: HOME_INTENT_ENTRIES[18],
    "3d": HOME_INTENT_ENTRIES[19],
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

/** SenseVoice / 音频反推相关市场应用：本地未接时标明不可用，勿假入口。 */
const AUDIO_UNAVAILABLE_ID_RE = /(sensevoice|sense-voice|asr|stt|whisper|audio-reverse|reverse-audio|反推)/i;
const AUDIO_UNAVAILABLE_NAME_RE = /(sensevoice|音频反推|语音识别|听写|asr|stt)/i;

export function isMarketAudioUnavailableApp(app: {
    id?: string;
    name?: string;
    category?: string;
    description?: string;
    guide_purpose?: string;
}): boolean {
    if (LOCAL_AUDIO_HAS_SENSEVOICE) return false;
    const id = String(app.id || "");
    const name = String(app.name || "");
    const blob = `${name} ${app.description || ""} ${app.guide_purpose || ""}`;
    if (AUDIO_UNAVAILABLE_ID_RE.test(id) || AUDIO_UNAVAILABLE_NAME_RE.test(blob)) return true;
    if ((app.category || "") === "audio" && /(反推|识别|听写|转写)/.test(blob)) return true;
    return false;
}

export function marketAudioUnavailableLabel(): string {
    return LOCAL_AUDIO_UNAVAILABLE_LABEL;
}
