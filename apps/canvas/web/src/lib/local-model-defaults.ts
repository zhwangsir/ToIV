/** Slice-1 local-first model/compute defaults for Studio「模型与算力」. */

export const LOCAL_H3_CHANNEL_NAME = "本地·H3视频";
export const LOCAL_H3_WORKER_LABEL = ":8264";
export const LOCAL_CHAT_CHANNEL_ID = "toiv-llm";
export const LOCAL_CHAT_CHANNEL_NAME = "本地·Spark对话";
export const LOCAL_CHAT_ALIAS = "deepseek-v4-flash-dspark";
export const LOCAL_CHAT_MODEL_REF = `${LOCAL_CHAT_CHANNEL_ID}::${LOCAL_CHAT_ALIAS}`;
export const LOCAL_NAS_ROOT_DEFAULT = "toiv/comfyui-models";
export const LOCAL_IMAGE_WORKER_PLACEHOLDER = ":8196";

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
        chatChannelId: LOCAL_CHAT_CHANNEL_ID,
        chatChannelName: LOCAL_CHAT_CHANNEL_NAME,
        chatAlias: LOCAL_CHAT_ALIAS,
        chatModelRef: LOCAL_CHAT_MODEL_REF,
        nasRootDefault: LOCAL_NAS_ROOT_DEFAULT,
        imageWorkerPlaceholder: LOCAL_IMAGE_WORKER_PLACEHOLDER,
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
