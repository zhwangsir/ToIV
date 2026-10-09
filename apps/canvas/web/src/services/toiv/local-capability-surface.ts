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
import {
    INTENT_ENTRIES as WEB_INTENT_ENTRIES,
    INTENT_RH_DISPLAY_DEMOTE_IDS,
    intentMarketPath,
    resolveIntentAppId,
    type IntentKeeper,
} from "@toiv-web/lib/intentKeepers";

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
        label: "本地·出图",
        worker: LOCAL_IMAGE_WORKER_LABEL,
        engine: "Comfy",
        protocol: "toiv-comfy-image",
        canvasTo: "/canvas?mode=new&add=image",
    },
    {
        id: "local-h3",
        kind: "h3",
        label: "本地·H3",
        worker: LOCAL_H3_WORKER_LABEL,
        engine: "H3",
        protocol: "toiv-h3",
        appId: "h3-t2v",
    },
    {
        id: "local-longcat",
        kind: "longcat",
        label: "本地·LongCat",
        worker: LOCAL_VIDEO_WORKER_LABEL,
        engine: "LongCat",
        protocol: "toiv-comfy-video",
        appId: "longcat-t2v",
    },
    {
        id: "local-vace",
        kind: "vace",
        label: "本地·VACE",
        worker: LOCAL_VIDEO_WORKER_LABEL,
        engine: "VACE",
        protocol: "toiv-comfy-video",
        appId: "vace-edit",
    },
    {
        id: "local-animate2",
        kind: "animate",
        label: "本地·Animate2",
        worker: LOCAL_VIDEO_ANIMATE_WORKER_LABEL,
        engine: "Animate2",
        protocol: "toiv-comfy-video",
        appId: "wan-animate-2",
    },
    {
        id: "local-continue",
        kind: "continue",
        label: "本地·Continue",
        worker: LOCAL_VIDEO_WORKER_LABEL,
        engine: "Continue",
        protocol: "toiv-comfy-video",
        appId: "longcat-continue",
    },
    {
        id: "local-avatar",
        kind: "avatar",
        label: "本地·Avatar",
        worker: LOCAL_VIDEO_WORKER_LABEL,
        engine: "Avatar",
        protocol: "toiv-comfy-video",
        appId: "avatar-talk",
    },
    {
        id: "local-wan",
        kind: "wan",
        label: "本地·Wan",
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

/** 首页意图条：从 apps/web/lib/intentKeepers 单源灌入（优先本地 altAppId）。 */
export type HomeIntentMarketLink = {
    id: string;
    appId: string;
    label: string;
    detail: string;
    to: string;
};

function toHomeLink(entry: IntentKeeper): HomeIntentMarketLink {
    const appId = resolveIntentAppId(entry);
    return {
        id: entry.id,
        appId,
        label: entry.label,
        detail: `打开市场「${entry.label}」应用`,
        to: intentMarketPath(entry),
    };
}

/** 顺序/id 与 intentKeepers INTENT_ENTRIES 一致；深链已解析本地优先。 */
export const HOME_INTENT_ENTRIES: readonly HomeIntentMarketLink[] = WEB_INTENT_ENTRIES.map(toHomeLink);

function linkById(id: string): HomeIntentMarketLink {
    const hit = HOME_INTENT_ENTRIES.find((e) => e.id === id);
    if (!hit) throw new Error(`missing home intent: ${id}`);
    return hit;
}

/**
 * 按 id 索引；`dub` 为 `voice`（配音）别名，兼容 tip 30357bfc 旧接线。
 * lipsync → ovi-i2v；avatar → avatar-talk（与对口型分轨）。
 */
export const HOME_INTENT_MARKET_LINKS = {
    outfit: linkById("outfit"),
    bg: linkById("bg"),
    i2v: linkById("i2v"),
    t2v: linkById("t2v"),
    lipsync: linkById("lipsync"),
    avatar: linkById("avatar"),
    voice: linkById("voice"),
    /** @deprecated 用 voice；保留给旧 home 接线 */
    dub: linkById("voice"),
    cutout: linkById("cutout"),
    upscale: linkById("upscale"),
    vfi: linkById("vfi"),
    line: linkById("line"),
    vace: linkById("vace"),
    music: linkById("music"),
    t2i: linkById("t2i"),
    restore: linkById("restore"),
    inpaint: linkById("inpaint"),
    portrait: linkById("portrait"),
    product: linkById("product"),
    edit: linkById("edit"),
    style: linkById("style"),
    "3d": linkById("3d"),
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
        label: "本地·出图",
        badge: "本地",
        nodeType: "image",
        modelRef: LOCAL_IMAGE_MODEL_REF,
        protocol: "toiv-comfy-image",
        defaultOrder: 21,
    },
    {
        id: "local-preset-h3",
        label: "本地·H3",
        badge: "本地",
        nodeType: "video",
        modelRef: LOCAL_H3_MODEL_REF,
        protocol: "toiv-h3",
        engine: "h3",
        defaultOrder: 31,
    },
    {
        id: "local-preset-wan",
        label: "本地·Wan",
        badge: "本地",
        nodeType: "video",
        modelRef: `${LOCAL_VIDEO_CHANNEL_ID}::${LOCAL_VIDEO_MODEL}`,
        protocol: "toiv-comfy-video",
        engine: "wan",
        defaultOrder: 32,
    },
    {
        id: "local-preset-longcat",
        label: "本地·LongCat",
        badge: "本地",
        nodeType: "video",
        modelRef: `${LOCAL_VIDEO_CHANNEL_ID}::${LOCAL_VIDEO_MODEL_LONGCAT}`,
        protocol: "toiv-comfy-video",
        engine: "longcat",
        defaultOrder: 33,
    },
    {
        id: "local-preset-vace",
        label: "本地·VACE",
        badge: "本地",
        nodeType: "video",
        modelRef: `${LOCAL_VIDEO_CHANNEL_ID}::${LOCAL_VIDEO_MODEL_VACE}`,
        protocol: "toiv-comfy-video",
        engine: "vace",
        defaultOrder: 34,
    },
    {
        id: "local-preset-animate",
        label: "本地·Animate2",
        badge: "本地",
        nodeType: "video",
        modelRef: `${LOCAL_VIDEO_CHANNEL_ID}::${LOCAL_VIDEO_MODEL_ANIMATE}`,
        protocol: "toiv-comfy-video",
        engine: "animate",
        defaultOrder: 35,
    },
    {
        id: "local-preset-continue",
        label: "本地·Continue",
        badge: "本地",
        nodeType: "video",
        modelRef: `${LOCAL_VIDEO_CHANNEL_ID}::${LOCAL_VIDEO_MODEL_CONTINUE}`,
        protocol: "toiv-comfy-video",
        engine: "continue",
        defaultOrder: 36,
    },
    {
        id: "local-preset-avatar",
        label: "本地·Avatar",
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

/** RH 云备选展示降权（similar-merge P1 #1/#2）；不改 resolve 默认。 */
export function sortAppsDemotingIds<T extends { id: string }>(apps: T[], demoteIds: readonly string[]): T[] {
    if (!demoteIds.length) return apps;
    const demote = new Set(demoteIds);
    return [...apps].sort((a, b) => {
        const da = demote.has(a.id) ? 1 : 0;
        const db = demote.has(b.id) ? 1 : 0;
        return da - db;
    });
}

/** 市场默认列表：精选置顶 + RH i2v/t2v 展示降权。 */
export function sortMarketAppsDefault<T extends { id: string }>(apps: T[]): T[] {
    return sortAppsDemotingIds(
        sortAppsWithFeaturedIds(apps, localMarketFeaturedAppIds()),
        INTENT_RH_DISPLAY_DEMOTE_IDS,
    );
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
