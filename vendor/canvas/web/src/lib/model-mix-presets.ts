/**
 * 多模型搭配：用户自选为主；快捷示例仅预填，不保证最优，不自动起停 docker。
 */
import {
    LOCAL_CHAT_ALIAS,
    LOCAL_CHAT_MODEL_REF,
    LOCAL_CHAT_PRODUCT_LABEL,
    LOCAL_IMAGE_CHECKPOINT_BASENAME,
    LOCAL_IMAGE_MODEL_REF,
    LOCAL_VIDEO_CHANNEL_ID,
    LOCAL_VIDEO_MODEL_REF,
    classifyLocalVideoEngine,
} from "@/lib/local-model-defaults";
import { queryCompat } from "@/lib/model-compat";
import { writeSlotLoras, type SlotLoraKey, type SlotLoraPick } from "@/lib/slot-lora";
import { LOCAL_H3_MODEL_REF } from "@/services/toiv/local-capability-surface";
import { modelOptionName, resolveModelChannel, type AiConfig } from "@/stores/use-config-store";

export const MODEL_MIX_PRESET_STORAGE_KEY = "toiv.model-mix.activePreset";
export const MODEL_MIX_MOTION_STORAGE_KEY = "toiv.model-mix.motionModel";

export type ModelMixPresetId = "drama-default" | "quality-slow" | "vram-save";

export type ModelMixPreset = {
    id: ModelMixPresetId;
    label: string;
    /** 芯片旁短说明 */
    hint: string;
    /** 确认框/toast 正文（无端口）；必须写明「示例预填、可再改、非最优保证」 */
    confirmBody: string;
};

export const MODEL_MIX_PRESETS: readonly ModelMixPreset[] = [
    {
        id: "drama-default",
        label: "短剧起点",
        hint: "示例",
        confirmBody: `仅预填一组常用起点（可再逐槽改，不保证最优）：${LOCAL_CHAT_PRODUCT_LABEL} + 本地 H3（主视频）+ 本地出图（${LOCAL_IMAGE_CHECKPOINT_BASENAME}）+ 运动备选 Wan。不自动起停对话容器。`,
    },
    {
        id: "quality-slow",
        label: "偏质量",
        hint: "示例",
        confirmBody: `仅预填「偏质量」示例起点（可再逐槽改，不保证最优）：本地主路同上，并记下少并行、多等成片的偏好文案。不自动起停对话容器。`,
    },
    {
        id: "vram-save",
        label: "偏省显存",
        hint: "示例",
        confirmBody: `仅预填「偏省显存」示例起点（可再逐槽改，不保证最优）：本地主路同上，并记下避免出图/H3/配音同时猛跑的偏好文案。不自动起停对话容器。`,
    },
] as const;

/** 产品面互斥提示（无端口、不承诺自动切卡）。 */
export const LLM_MUTEX_BANNER =
    "对话 LLM：Mia 与旧版 dsv4 占用同一块 GPU，不能同时运行。当前默认走 Mia。若要换家族，需运维起停容器——本页不会自动操作。";

export const LOCAL_VLM_PRODUCT_LABEL = "识图 · toiv-vlm（系统）";
export const LOCAL_VLM_PRODUCT_HINT = "设定卡 / 识图走工作站 VLM；与对话 LLM 不是同一路。";
export const LOCAL_TTS_PRODUCT_LABEL = "配音 · IndexTTS（系统）";
export const LOCAL_TTS_PRODUCT_HINT = "短剧配音主路；勿与未接的 SenseVoice 云端音频渠道混淆。";

export type ModelMixPatch = {
    textModel: string;
    imageModel: string;
    videoModel: string;
    assistantModel: string;
    motionModel: string;
};

export function dramaDefaultPatch(): ModelMixPatch {
    return {
        textModel: LOCAL_CHAT_MODEL_REF,
        imageModel: LOCAL_IMAGE_MODEL_REF,
        videoModel: LOCAL_H3_MODEL_REF,
        assistantModel: "",
        motionModel: LOCAL_VIDEO_MODEL_REF,
    };
}

/** 从兼容图谱取配方预填 LoRA（A/B + strength/triggers）；点配方仍可手改。 */
export function presetLorasFromGraph(slot: SlotLoraKey, baseHint: string, limit = 1): SlotLoraPick[] {
    const q = queryCompat({
        baseId: baseHint,
        slot,
        minConfidence: "B",
        includeTriggers: true,
    });
    const out: SlotLoraPick[] = [];
    for (const item of q.items) {
        if (item.heuristic) continue;
        out.push({
            name: item.loraId,
            strength: item.strength.default,
            label: item.label,
            triggers: item.triggers.length ? item.triggers : undefined,
        });
        if (out.length >= limit) break;
    }
    return out;
}

/** 应用配方时写入各槽图谱边预填（可再改；非最优）。 */
export function applyPresetLoraPins(_id: ModelMixPresetId) {
    const image = presetLorasFromGraph("image", LOCAL_IMAGE_CHECKPOINT_BASENAME, 1);
    const videoPrimary = presetLorasFromGraph("video-primary", "minimax_h3_fl2va_pruned_int8_convrot.safetensors", 1);
    const motion = presetLorasFromGraph("video-motion", LOCAL_VIDEO_MODEL_REF, 1);
    if (image.length) writeSlotLoras("image", image);
    if (videoPrimary.length) writeSlotLoras("video-primary", videoPrimary);
    if (motion.length) writeSlotLoras("video-motion", motion);
    return { image, videoPrimary, motion };
}

/** 三条快捷示例 P0 写入同一套本地起点；差异只在偏好文案 + activePreset 标记。非最优保证。 */
export function patchForPreset(_id: ModelMixPresetId): ModelMixPatch {
    return dramaDefaultPatch();
}

export function applyMixPatchToConfig(config: AiConfig, patch: ModelMixPatch): AiConfig {
    const textModels = Array.from(new Set([...(config.textModels || []), patch.textModel].filter(Boolean)));
    const imageModels = Array.from(new Set([...(config.imageModels || []), patch.imageModel].filter(Boolean)));
    const videoModels = Array.from(
        new Set([...(config.videoModels || []), patch.videoModel, patch.motionModel].filter(Boolean)),
    );
    return {
        ...config,
        textModel: patch.textModel,
        imageModel: patch.imageModel,
        videoModel: patch.videoModel,
        assistantModel: patch.assistantModel,
        textModels,
        imageModels,
        videoModels,
    };
}

export function readActivePresetId(): ModelMixPresetId | null {
    if (typeof window === "undefined") return null;
    try {
        const raw = window.localStorage.getItem(MODEL_MIX_PRESET_STORAGE_KEY);
        if (raw === "drama-default" || raw === "quality-slow" || raw === "vram-save") return raw;
    } catch {
        /* ignore */
    }
    return null;
}

export function writeActivePresetId(id: ModelMixPresetId | null) {
    if (typeof window === "undefined") return;
    try {
        if (!id) window.localStorage.removeItem(MODEL_MIX_PRESET_STORAGE_KEY);
        else window.localStorage.setItem(MODEL_MIX_PRESET_STORAGE_KEY, id);
    } catch {
        /* ignore */
    }
}

export function readMotionModel(fallback = LOCAL_VIDEO_MODEL_REF): string {
    if (typeof window === "undefined") return fallback;
    try {
        const raw = window.localStorage.getItem(MODEL_MIX_MOTION_STORAGE_KEY);
        if (raw === "") return "";
        if (raw && raw.trim()) return raw.trim();
    } catch {
        /* ignore */
    }
    return fallback;
}

export function writeMotionModel(model: string) {
    if (typeof window === "undefined") return;
    try {
        window.localStorage.setItem(MODEL_MIX_MOTION_STORAGE_KEY, model);
    } catch {
        /* ignore */
    }
}

export function isPrimaryVideoModelRef(config: AiConfig, model: string): boolean {
    const raw = String(model || "").trim();
    if (!raw) return false;
    if (raw === LOCAL_H3_MODEL_REF || raw.startsWith("MZt9ON1JvbabJ2GS-PvXR::")) return true;
    const name = modelOptionName(raw).toLowerCase();
    if (name === "h3" || name === "h3-t2v") return true;
    const channel = resolveModelChannel(config, raw);
    const profiles = channel.modelProfiles || [];
    if (profiles.some((p) => p.protocol === "toiv-h3" || p.model === "h3" || p.model === "h3-t2v")) return true;
    if (String(channel.name || "").includes("H3")) return true;
    return false;
}

export function isMotionVideoModelRef(config: AiConfig, model: string): boolean {
    const raw = String(model || "").trim();
    if (!raw) return false;
    if (isPrimaryVideoModelRef(config, raw)) return false;
    const channel = resolveModelChannel(config, raw);
    if (channel.id === LOCAL_VIDEO_CHANNEL_ID) return true;
    if (String(channel.name || "").includes("出视频") || String(channel.name || "").includes("Animate")) return true;
    const name = modelOptionName(raw);
    const engine = classifyLocalVideoEngine(name);
    return Boolean(engine);
}

/** 当前对话是否像 Mia 主路（产品提示用，不探测真机）。 */
export function textModelLooksLikeMia(config: AiConfig): boolean {
    const ref = String(config.textModel || "");
    const name = modelOptionName(ref);
    if (ref.includes(LOCAL_CHAT_ALIAS) || name === LOCAL_CHAT_ALIAS) return true;
    if (ref.includes("toiv-llm") && (name.includes("DeepSeek-V4.1") || name.toLowerCase().includes("mia"))) return true;
    const channel = resolveModelChannel(config, ref);
    const label = `${channel.name || ""} ${channel.publicAlias || ""}`;
    return label.includes("Mia") || label.includes("本机 LLM");
}

export function textModelLooksLikeLegacyDsv4(config: AiConfig): boolean {
    const name = modelOptionName(config.textModel || "").toLowerCase();
    return name.includes("deepseek-v4-flash-dspark") || name.includes("dsv4") || name.includes("dspark");
}

export { LOCAL_H3_MODEL_REF, LOCAL_CHAT_MODEL_REF, LOCAL_IMAGE_MODEL_REF, LOCAL_VIDEO_MODEL_REF };
