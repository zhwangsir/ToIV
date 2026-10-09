import { describe, expect, test } from "bun:test";

import {
    CLOUD_MODEL_SERVICE_PRESET_IDS,
    LOCAL_CHAT_ALIAS,
    LOCAL_H3_CHANNEL_NAME,
    LOCAL_H3_WORKER_LABEL,
    LOCAL_IMAGE_CHANNEL_NAME,
    LOCAL_IMAGE_MODEL_REF,
    LOCAL_IMAGE_WORKER_LABEL,
    MODEL_PICKER_EMPTY_CTA,
    filterH3PickerEntries,
    filterImagePickerEntries,
    isCloudModelServicePreset,
    localComputeDefaults,
} from "@/lib/local-model-defaults";

describe("local model defaults (slice 1+2)", () => {
    test("local defaults present with H3 :8264, image :8196, Spark chat alias", () => {
        const d = localComputeDefaults();
        expect(d.videoChannelName).toBe(LOCAL_H3_CHANNEL_NAME);
        expect(d.h3Worker).toBe(LOCAL_H3_WORKER_LABEL);
        expect(d.h3Worker).toBe(":8264");
        expect(d.h3Worker).not.toBe(":8195");
        expect(d.imageChannelName).toBe(LOCAL_IMAGE_CHANNEL_NAME);
        expect(d.imageChannelName).toBe("本地·生图");
        expect(d.imageWorker).toBe(LOCAL_IMAGE_WORKER_LABEL);
        expect(d.imageWorker).toBe(":8196");
        expect(d.imageWorker).not.toBe(":8205");
        expect(d.imageWorker).not.toBe(":8261");
        expect(d.imageModelRef).toBe(LOCAL_IMAGE_MODEL_REF);
        expect(d.chatAlias).toBe(LOCAL_CHAT_ALIAS);
        expect(d.chatAlias).toBe("deepseek-v4-flash-dspark");
        expect(d.cloudPresetsDefaultOpen).toBe(false);
        expect(d.nasRootDefault).toBe("toiv/comfyui-models");
        expect(d.swapHint).toContain("落盘后 refresh");
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
});
