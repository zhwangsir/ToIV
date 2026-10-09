/** Local-first model/compute defaults for Studio「模型与算力」(slice 1+2+3). */

export const LOCAL_H3_CHANNEL_NAME = "本地·H3视频";
export const LOCAL_H3_WORKER_LABEL = ":8264";
export const LOCAL_VIDEO_CHANNEL_ID = "toiv-video-wan";
export const LOCAL_VIDEO_CHANNEL_NAME = "本地·视频(Wan/LongCat)";
export const LOCAL_VIDEO_WORKER_LABEL = ":8197";
export const LOCAL_VIDEO_MODEL = "local-wan";
export const LOCAL_VIDEO_MODEL_REF = `${LOCAL_VIDEO_CHANNEL_ID}::${LOCAL_VIDEO_MODEL}`;

export const LOCAL_VIDEO_MODEL_LONGCAT = "local-longcat";
export const LOCAL_VIDEO_MODEL_VACE = "local-vace";

/** Route NAS video basename / alias → Wan | LongCat | VACE (Comfy :8197). */
export type LocalVideoEngine = "wan" | "longcat" | "vace";

export function classifyLocalVideoEngine(modelOrBasename: string): LocalVideoEngine {
    const raw = String(modelOrBasename || "").trim();
    const lower = raw.toLowerCase();
    if (!lower) return "wan";
    if (lower === LOCAL_VIDEO_MODEL_LONGCAT || lower === "longcat" || lower.includes("longcat")) {
        return "longcat";
    }
    if (lower === LOCAL_VIDEO_MODEL_VACE || lower === "vace" || lower.includes("vace")) {
        return "vace";
    }
    return "wan";
}

export const LOCAL_IMAGE_CHANNEL_ID = "toiv-image";
export const LOCAL_IMAGE_CHANNEL_NAME = "本地·生图";
export const LOCAL_IMAGE_WORKER_LABEL = ":8196";
export const LOCAL_IMAGE_LB_LABEL = ":8188";
export const LOCAL_IMAGE_MODEL = "local-checkpoint";
export const LOCAL_IMAGE_MODEL_REF = `${LOCAL_IMAGE_CHANNEL_ID}::${LOCAL_IMAGE_MODEL}`;
export const LOCAL_CHAT_CHANNEL_ID = "toiv-llm";
export const LOCAL_CHAT_CHANNEL_NAME = "本地·Spark对话";
export const LOCAL_CHAT_ALIAS = "deepseek-v4-flash-dspark";
export const LOCAL_CHAT_MODEL_REF = `${LOCAL_CHAT_CHANNEL_ID}::${LOCAL_CHAT_ALIAS}`;
export const LOCAL_NAS_ROOT_DEFAULT = "toiv/comfyui-models";
/** @deprecated use LOCAL_IMAGE_WORKER_LABEL */
export const LOCAL_IMAGE_WORKER_PLACEHOLDER = LOCAL_IMAGE_WORKER_LABEL;

/** Cloud/third-party presets demoted under「高级/云」; not default-open. */
export const CLOUD_MODEL_SERVICE_PRESET_IDS = ["openai", "gemini", "ark"] as const;
export type CloudModelServicePresetId = (typeof CLOUD_MODEL_SERVICE_PRESET_IDS)[number];

export function isCloudModelServicePreset(id: string): id is CloudModelServicePresetId {
    return (CLOUD_MODEL_SERVICE_PRESET_IDS as readonly string[]).includes(id);
}

export function localComputeDefaults() {
    return {
        videoChannelName: LOCAL_H3_CHANNEL_NAME,
        h3Worker: LOCAL_H3_WORKER_LABEL,
        videoWanChannelId: LOCAL_VIDEO_CHANNEL_ID,
        videoWanChannelName: LOCAL_VIDEO_CHANNEL_NAME,
        videoWorker: LOCAL_VIDEO_WORKER_LABEL,
        videoModelRef: LOCAL_VIDEO_MODEL_REF,
        imageChannelId: LOCAL_IMAGE_CHANNEL_ID,
        imageChannelName: LOCAL_IMAGE_CHANNEL_NAME,
        imageWorker: LOCAL_IMAGE_WORKER_LABEL,
        imageLb: LOCAL_IMAGE_LB_LABEL,
        imageModelRef: LOCAL_IMAGE_MODEL_REF,
        chatChannelId: LOCAL_CHAT_CHANNEL_ID,
        chatChannelName: LOCAL_CHAT_CHANNEL_NAME,
        chatAlias: LOCAL_CHAT_ALIAS,
        chatModelRef: LOCAL_CHAT_MODEL_REF,
        nasRootDefault: LOCAL_NAS_ROOT_DEFAULT,
        imageWorkerPlaceholder: LOCAL_IMAGE_WORKER_LABEL,
        cloudPresetsDefaultOpen: false as const,
        swapStages: ["validate", "refresh/bind", "done"] as const,
        swapHint: "落盘后 refresh 列表；仍不见再重启该 worker",
    };
}

/** Empty ModelPicker CTA — never "联系管理员/API Key". */
export const MODEL_PICKER_EMPTY_CTA = "去模型与算力配置";

export function filterH3PickerEntries<T extends { rel_path: string }>(entries: T[]): T[] {
    return entries.filter((e) => String(e.rel_path || "").startsWith("h3/"));
}

/** NAS main[] 出图权重：用途含「出图」（含 出图主线·checkpoint / 出图/出视频·diffusion 等）. */
export function filterImagePickerEntries<T extends { rel_path?: string; 用途?: string }>(entries: T[]): T[] {
    return entries.filter((e) => {
        const purpose = String(e.用途 || "");
        const rel = String(e.rel_path || "");
        if (rel.startsWith("h3/")) return false;
        return purpose.includes("出图");
    });
}

/** NAS main[] 出视频权重（非 H3）：用途含「出视频」且 rel_path 不在 h3/ 下 → worker :8197. */
export function filterVideoPickerEntries<T extends { rel_path?: string; 用途?: string }>(entries: T[]): T[] {
    return entries.filter((e) => {
        const purpose = String(e.用途 || "");
        const rel = String(e.rel_path || "");
        if (rel.startsWith("h3/")) return false;
        return purpose.includes("出视频");
    });
}
