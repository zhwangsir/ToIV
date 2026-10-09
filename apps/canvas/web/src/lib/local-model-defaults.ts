/** Local-first model/compute defaults for Studio「模型与算力」— aligned to真机. */

/** NAS picker truth (docs/NAS_MODEL_PICKER.json). Protocol ids stay h3/h3-t2v; UI shows these. */
export const LOCAL_H3_FL2VA_BASENAME = "minimax_h3_fl2va_fp8_e4m3fn.safetensors";
export const LOCAL_H3_REF2VA_BASENAME = "minimax_h3_ref2va_pruned_fp8_scaled.safetensors";
export const LOCAL_IMAGE_CHECKPOINT_BASENAME = "Qwen-Rapid-AIO-SFW-v11.safetensors";
export const LOCAL_IMAGE_CHECKPOINT_REL = `checkpoints/${LOCAL_IMAGE_CHECKPOINT_BASENAME}`;

export const LOCAL_H3_CHANNEL_NAME = "本地·H3";
export const LOCAL_H3_WORKER_LABEL = ":8264";
/** Never put :8195 (试验口) in defaults. */
export const LOCAL_H3_FORBIDDEN_DEFAULT_WORKER = ":8195";

export const LOCAL_VIDEO_CHANNEL_ID = "toiv-video-wan";
export const LOCAL_VIDEO_CHANNEL_NAME = "本地·出视频";
export const LOCAL_VIDEO_WORKER_LABEL = ":8197";
export const LOCAL_VIDEO_MODEL = "local-wan";
export const LOCAL_VIDEO_MODEL_REF = `${LOCAL_VIDEO_CHANNEL_ID}::${LOCAL_VIDEO_MODEL}`;

export const LOCAL_VIDEO_MODEL_LONGCAT = "local-longcat";
export const LOCAL_VIDEO_MODEL_VACE = "local-vace";
export const LOCAL_VIDEO_MODEL_ANIMATE = "local-wan-animate";
export const LOCAL_VIDEO_MODEL_CONTINUE = "local-longcat-continue";
export const LOCAL_VIDEO_MODEL_AVATAR = "local-longcat-avatar";
export const LOCAL_VIDEO_ANIMATE_NAME = "本地·Wan Animate2";
export const LOCAL_VIDEO_ANIMATE_WORKER_LABEL = ":8199";

/** Route NAS video basename / alias → Wan | LongCat | Continue | Avatar | VACE (:8197) | Animate (:8199). */
export type LocalVideoEngine = "wan" | "longcat" | "continue" | "avatar" | "vace" | "animate";

export function classifyLocalVideoEngine(modelOrBasename: string): LocalVideoEngine {
    const raw = String(modelOrBasename || "").trim();
    const lower = raw.toLowerCase();
    if (!lower) return "wan";
    // continue/avatar before generic longcat (names contain "longcat")
    if (
        lower === LOCAL_VIDEO_MODEL_CONTINUE ||
        lower === "longcat-continue" ||
        lower.includes("longcat-continue") ||
        lower.includes("longcat_continue")
    ) {
        return "continue";
    }
    if (
        lower === LOCAL_VIDEO_MODEL_AVATAR ||
        lower === "longcat-avatar" ||
        lower === "local-avatar" ||
        lower === "avatar-talk" ||
        lower === "avatar" ||
        lower.includes("longcat-avatar") ||
        lower.includes("longcat_avatar") ||
        lower.includes("avatar-talk") ||
        lower.includes("avatar")
    ) {
        return "avatar";
    }
    if (lower === LOCAL_VIDEO_MODEL_LONGCAT || lower === "longcat" || lower.includes("longcat")) {
        return "longcat";
    }
    if (lower === LOCAL_VIDEO_MODEL_VACE || lower === "vace" || lower.includes("vace")) {
        return "vace";
    }
    if (
        lower === LOCAL_VIDEO_MODEL_ANIMATE ||
        lower === "wan-animate" ||
        lower === "wan-animate-2" ||
        lower === "local-wan-animate-2" ||
        lower === "animate2" ||
        lower === "local-animate2" ||
        lower.includes("animate")
    ) {
        return "animate";
    }
    return "wan";
}

export const LOCAL_IMAGE_CHANNEL_ID = "toiv-image";
export const LOCAL_IMAGE_CHANNEL_NAME = "本地·出图 Comfy";
export const LOCAL_IMAGE_WORKER_LABEL = ":8196";
export const LOCAL_IMAGE_LB_LABEL = ":8188";
export const LOCAL_IMAGE_MODEL = "local-checkpoint";
export const LOCAL_IMAGE_MODEL_REF = `${LOCAL_IMAGE_CHANNEL_ID}::${LOCAL_IMAGE_MODEL}`;

export const LOCAL_CHAT_CHANNEL_ID = "toiv-llm";
export const LOCAL_CHAT_CHANNEL_NAME = "本地·Spark对话";
export const LOCAL_CHAT_ALIAS = "deepseek-v4-flash-dspark";
export const LOCAL_CHAT_MODEL_REF = `${LOCAL_CHAT_CHANNEL_ID}::${LOCAL_CHAT_ALIAS}`;
/** Direct Spark OpenAI-compat base (LAN). Gate may still rewrite via TOIV_LLM_BASE. */
export const LOCAL_CHAT_BASE_URL = "http://192.168.71.84:8000/v1";
export const LOCAL_CHAT_WORKER_LABEL = ":8000";

export const LOCAL_NAS_ROOT_DEFAULT = "toiv/comfyui-models";
/** @deprecated use LOCAL_IMAGE_WORKER_LABEL */
export const LOCAL_IMAGE_WORKER_PLACEHOLDER = LOCAL_IMAGE_WORKER_LABEL;

/** Cloud/third-party presets demoted under「高级/云」; not default-open. */
export const CLOUD_MODEL_SERVICE_PRESET_IDS = ["openai", "gemini", "ark"] as const;
export type CloudModelServicePresetId = (typeof CLOUD_MODEL_SERVICE_PRESET_IDS)[number];

export function isCloudModelServicePreset(id: string): id is CloudModelServicePresetId {
    return (CLOUD_MODEL_SERVICE_PRESET_IDS as readonly string[]).includes(id);
}

/** BeefAPI / cloud channels — not on local main path; UI labels as 云端可选. */
export const CLOUD_OPTIONAL_CHANNEL_LABEL = "云端可选";

export function isLocalToivChannelId(id: string): boolean {
    return id === LOCAL_IMAGE_CHANNEL_ID
        || id === LOCAL_VIDEO_CHANNEL_ID
        || id === LOCAL_CHAT_CHANNEL_ID
        || id === "MZt9ON1JvbabJ2GS-PvXR"
        || id.startsWith("toiv-");
}

export function localChannelProtocolLabel(channel: { id?: string; name?: string; publicAlias?: string; modelProfiles?: Array<{ protocol?: string; defaultOptions?: Record<string, unknown> }> }): string {
    const profiles = channel.modelProfiles || [];
    const worker = profiles.map((p) => p?.defaultOptions?.toivWorkerLabel).find((v) => typeof v === "string" && v.startsWith(":"));
    if (profiles.some((p) => p.protocol === "toiv-h3")) return `本地 H3 · ${LOCAL_H3_WORKER_LABEL}`;
    if (profiles.some((p) => p.protocol === "toiv-comfy-image")) return `本地出图 · ${LOCAL_IMAGE_WORKER_LABEL}`;
    if (profiles.some((p) => p.protocol === "toiv-comfy-video")) {
        const animate = profiles.some((p) => p?.defaultOptions?.toivWorkerLabel === LOCAL_VIDEO_ANIMATE_WORKER_LABEL);
        return animate
            ? `本地出视频 · ${LOCAL_VIDEO_WORKER_LABEL}/${LOCAL_VIDEO_ANIMATE_WORKER_LABEL}`
            : `本地出视频 · ${LOCAL_VIDEO_WORKER_LABEL}`;
    }
    if (channel.id === LOCAL_CHAT_CHANNEL_ID || String(channel.name || "").includes("Spark")) {
        return `本地 Spark · ${LOCAL_CHAT_WORKER_LABEL}`;
    }
    if (typeof worker === "string") return `本地 · ${worker}`;
    return "本地渠道";
}

/** Audio: no SenseVoice on NAS picker → explicit 未接 (do not fake configured). */
export const LOCAL_AUDIO_UNAVAILABLE_LABEL = "未接（无 SenseVoice）";
export const LOCAL_AUDIO_HAS_SENSEVOICE = false;

export function localComputeDefaults() {
    return {
        videoChannelName: LOCAL_H3_CHANNEL_NAME,
        h3Worker: LOCAL_H3_WORKER_LABEL,
        h3Fl2vaBasename: LOCAL_H3_FL2VA_BASENAME,
        h3Ref2vaBasename: LOCAL_H3_REF2VA_BASENAME,
        videoWanChannelId: LOCAL_VIDEO_CHANNEL_ID,
        videoWanChannelName: LOCAL_VIDEO_CHANNEL_NAME,
        videoWorker: LOCAL_VIDEO_WORKER_LABEL,
        videoAnimateWorker: LOCAL_VIDEO_ANIMATE_WORKER_LABEL,
        videoAnimateName: LOCAL_VIDEO_ANIMATE_NAME,
        videoModelRef: LOCAL_VIDEO_MODEL_REF,
        imageChannelId: LOCAL_IMAGE_CHANNEL_ID,
        imageChannelName: LOCAL_IMAGE_CHANNEL_NAME,
        imageWorker: LOCAL_IMAGE_WORKER_LABEL,
        imageLb: LOCAL_IMAGE_LB_LABEL,
        imageModelRef: LOCAL_IMAGE_MODEL_REF,
        imageCheckpointBasename: LOCAL_IMAGE_CHECKPOINT_BASENAME,
        chatChannelId: LOCAL_CHAT_CHANNEL_ID,
        chatChannelName: LOCAL_CHAT_CHANNEL_NAME,
        chatAlias: LOCAL_CHAT_ALIAS,
        chatModelRef: LOCAL_CHAT_MODEL_REF,
        chatBaseUrl: LOCAL_CHAT_BASE_URL,
        chatWorker: LOCAL_CHAT_WORKER_LABEL,
        nasRootDefault: LOCAL_NAS_ROOT_DEFAULT,
        imageWorkerPlaceholder: LOCAL_IMAGE_WORKER_LABEL,
        cloudPresetsDefaultOpen: false as const,
        cloudOptionalLabel: CLOUD_OPTIONAL_CHANNEL_LABEL,
        audioUnavailableLabel: LOCAL_AUDIO_UNAVAILABLE_LABEL,
        audioHasSenseVoice: LOCAL_AUDIO_HAS_SENSEVOICE,
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
