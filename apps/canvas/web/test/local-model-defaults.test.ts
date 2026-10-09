import { describe, expect, test } from "bun:test";

import {
    CLOUD_MODEL_SERVICE_PRESET_IDS,
    CLOUD_OPTIONAL_CHANNEL_LABEL,
    LOCAL_AUDIO_HAS_SENSEVOICE,
    LOCAL_AUDIO_UNAVAILABLE_LABEL,
    LOCAL_CHAT_ALIAS,
    LOCAL_CHAT_BASE_URL,
    LOCAL_CHAT_WORKER_LABEL,
    LOCAL_H3_CHANNEL_NAME,
    LOCAL_H3_FL2VA_BASENAME,
    LOCAL_H3_FORBIDDEN_DEFAULT_WORKER,
    LOCAL_H3_REF2VA_BASENAME,
    LOCAL_H3_WORKER_LABEL,
    LOCAL_IMAGE_CHANNEL_NAME,
    LOCAL_IMAGE_CHECKPOINT_BASENAME,
    LOCAL_IMAGE_MODEL_REF,
    LOCAL_IMAGE_WORKER_LABEL,
    LOCAL_VIDEO_ANIMATE_WORKER_LABEL,
    LOCAL_VIDEO_CHANNEL_NAME,
    LOCAL_VIDEO_WORKER_LABEL,
    MODEL_PICKER_EMPTY_CTA,
    classifyLocalVideoEngine,
    filterH3PickerEntries,
    filterImagePickerEntries,
    filterVideoPickerEntries,
    isCloudModelServicePreset,
    localChannelProtocolLabel,
    localComputeDefaults,
} from "@/lib/local-model-defaults";

describe("local model defaults (realign)", () => {
    test("local defaults: H3 :8264 + Spark :8000 + image/video workers; never :8195", () => {
        const d = localComputeDefaults();
        expect(d.videoChannelName).toBe(LOCAL_H3_CHANNEL_NAME);
        expect(d.videoChannelName).toBe("本地·H3");
        expect(d.h3Worker).toBe(LOCAL_H3_WORKER_LABEL);
        expect(d.h3Worker).toBe(":8264");
        expect(d.h3Worker).not.toBe(LOCAL_H3_FORBIDDEN_DEFAULT_WORKER);
        expect(d.h3Fl2vaBasename).toBe(LOCAL_H3_FL2VA_BASENAME);
        expect(d.h3Fl2vaBasename).toContain("fl2va");
        expect(d.h3Ref2vaBasename).toBe(LOCAL_H3_REF2VA_BASENAME);
        expect(d.h3Ref2vaBasename).toContain("ref2va");
        expect(d.videoWanChannelName).toBe(LOCAL_VIDEO_CHANNEL_NAME);
        expect(d.videoWanChannelName).toBe("本地·出视频");
        expect(d.videoWorker).toBe(LOCAL_VIDEO_WORKER_LABEL);
        expect(d.videoWorker).toBe(":8197");
        expect(d.videoAnimateWorker).toBe(LOCAL_VIDEO_ANIMATE_WORKER_LABEL);
        expect(d.videoAnimateWorker).toBe(":8199");
        expect(d.imageChannelName).toBe(LOCAL_IMAGE_CHANNEL_NAME);
        expect(d.imageChannelName).toBe("本地·出图 Comfy");
        expect(d.imageWorker).toBe(LOCAL_IMAGE_WORKER_LABEL);
        expect(d.imageWorker).toBe(":8196");
        expect(d.imageCheckpointBasename).toBe(LOCAL_IMAGE_CHECKPOINT_BASENAME);
        expect(d.imageCheckpointBasename).toContain("Qwen");
        expect(d.imageModelRef).toBe(LOCAL_IMAGE_MODEL_REF);
        expect(d.chatAlias).toBe(LOCAL_CHAT_ALIAS);
        expect(d.chatAlias).toBe("deepseek-v4-flash-dspark");
        expect(d.chatBaseUrl).toBe(LOCAL_CHAT_BASE_URL);
        expect(d.chatBaseUrl).toBe("http://192.168.71.84:8000/v1");
        expect(d.chatWorker).toBe(LOCAL_CHAT_WORKER_LABEL);
        expect(d.cloudPresetsDefaultOpen).toBe(false);
        expect(d.cloudOptionalLabel).toBe(CLOUD_OPTIONAL_CHANNEL_LABEL);
        expect(d.audioHasSenseVoice).toBe(LOCAL_AUDIO_HAS_SENSEVOICE);
        expect(d.audioHasSenseVoice).toBe(false);
        expect(d.audioUnavailableLabel).toBe(LOCAL_AUDIO_UNAVAILABLE_LABEL);
        expect(d.audioUnavailableLabel).toContain("未接");
        expect(d.nasRootDefault).toBe("toiv/comfyui-models");
    });

    test("localChannelProtocolLabel prefers worker ports over OpenAI-compat", () => {
        expect(localChannelProtocolLabel({
            id: "toiv-image",
            modelProfiles: [{ protocol: "toiv-comfy-image", defaultOptions: { toivWorkerLabel: ":8196" } }],
        })).toContain(":8196");
        expect(localChannelProtocolLabel({
            id: "MZt9ON1JvbabJ2GS-PvXR",
            modelProfiles: [{ protocol: "toiv-h3", defaultOptions: { toivWorkerLabel: ":8264" } }],
        })).toContain(":8264");
        expect(localChannelProtocolLabel({ id: "toiv-llm", name: "本地·Spark对话" })).toContain(":8000");
    });

    test("h3/ filter keeps only h3 prefix", () => {
        const filtered = filterH3PickerEntries([
            { rel_path: "h3/diffusion_models/a.safetensors" },
            { rel_path: "checkpoints/b.safetensors" },
            { rel_path: "h3/loras/c.safetensors" },
            { rel_path: "LLM/qwen.gguf" },
        ]);
        expect(filtered.map((e) => e.rel_path)).toEqual([
            "h3/diffusion_models/a.safetensors",
            "h3/loras/c.safetensors",
        ]);
    });

    test("image filter keeps 用途 containing 出图", () => {
        const filtered = filterImagePickerEntries([
            { rel_path: "checkpoints/a.safetensors", 用途: "出图主线·checkpoint" },
            { rel_path: "diffusion_models/b.safetensors", 用途: "出图/出视频·diffusion" },
            { rel_path: "loras/c.safetensors", 用途: "LoRA" },
            { rel_path: "h3/diffusion_models/d.safetensors", 用途: "出图主线·checkpoint" },
            { rel_path: "wan2.2-animate-2-14b/x.safetensors", 用途: "出视频·Wan Animate" },
        ]);
        expect(filtered.map((e) => e.rel_path)).toEqual([
            "checkpoints/a.safetensors",
            "diffusion_models/b.safetensors",
        ]);
    });

    test("video filter keeps 用途 containing 出视频 and excludes h3/", () => {
        const filtered = filterVideoPickerEntries([
            { rel_path: "checkpoints/a.safetensors", 用途: "出图主线·checkpoint" },
            { rel_path: "diffusion_models/b.safetensors", 用途: "出图/出视频·diffusion" },
            { rel_path: "loras/c.safetensors", 用途: "LoRA" },
            { rel_path: "h3/diffusion_models/d.safetensors", 用途: "出视频·Wan Animate" },
            { rel_path: "wan2.2-animate-2-14b/x.safetensors", 用途: "出视频·Wan Animate" },
            { rel_path: "unet/Wan2.2-Animate-14B-Q4_K_M.gguf", 用途: "出图/出视频·unet" },
            { rel_path: "视频修复/seedvr.safetensors", 用途: "视频修复 SEEDVR2" },
        ]);
        expect(filtered.map((e) => e.rel_path)).toEqual([
            "diffusion_models/b.safetensors",
            "wan2.2-animate-2-14b/x.safetensors",
            "unet/Wan2.2-Animate-14B-Q4_K_M.gguf",
        ]);
    });

    test("cloud presets are demoted and not treated as local-first", () => {
        expect(CLOUD_MODEL_SERVICE_PRESET_IDS).toEqual(["openai", "gemini", "ark"]);
        expect(isCloudModelServicePreset("compatible")).toBe(false);
        expect(isCloudModelServicePreset("openai")).toBe(true);
        expect(localComputeDefaults().cloudPresetsDefaultOpen).toBe(false);
    });

    test("ModelPicker empty CTA points to 模型与算力", () => {
        expect(MODEL_PICKER_EMPTY_CTA).toContain("模型与算力");
        expect(MODEL_PICKER_EMPTY_CTA).not.toContain("管理员");
        expect(MODEL_PICKER_EMPTY_CTA).not.toMatch(/API Key/i);
    });

    test("classifyLocalVideoEngine routes Wan/LongCat/Continue/Avatar/VACE/Animate", () => {
        expect(classifyLocalVideoEngine("local-wan")).toBe("wan");
        expect(classifyLocalVideoEngine("Wan2_2-T2V.safetensors")).toBe("wan");
        expect(classifyLocalVideoEngine("local-longcat-continue")).toBe("continue");
        expect(classifyLocalVideoEngine("longcat-continue")).toBe("continue");
        expect(classifyLocalVideoEngine("local-longcat-avatar")).toBe("avatar");
        expect(classifyLocalVideoEngine("LongCat-Avatar-15_comfy-Q8_0.gguf")).toBe("avatar");
        expect(classifyLocalVideoEngine("local-longcat")).toBe("longcat");
        expect(classifyLocalVideoEngine("LongCat_TI2V_comfy.safetensors")).toBe("longcat");
        expect(classifyLocalVideoEngine("local-vace")).toBe("vace");
        expect(classifyLocalVideoEngine("Wan2_1-VACE_module_14B.safetensors")).toBe("vace");
        expect(classifyLocalVideoEngine("local-wan-animate")).toBe("animate");
        expect(classifyLocalVideoEngine("wan2.2-animate-2-14b.safetensors")).toBe("animate");
        expect(classifyLocalVideoEngine("Wan2.2-Animate-14B-Q4_K_M.gguf")).toBe("animate");
    });
});
