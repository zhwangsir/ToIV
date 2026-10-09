import { describe, expect, test } from "bun:test";

import {
    CLOUD_MODEL_SERVICE_PRESET_IDS,
    LOCAL_CHAT_ALIAS,
    LOCAL_H3_CHANNEL_NAME,
    LOCAL_H3_WORKER_LABEL,
    MODEL_PICKER_EMPTY_CTA,
    filterH3PickerEntries,
    isCloudModelServicePreset,
    localComputeDefaults,
} from "@/lib/local-model-defaults";

describe("local model defaults (slice-1)", () => {
    test("local defaults present with H3 :8264 and Spark chat alias", () => {
        const d = localComputeDefaults();
        expect(d.videoChannelName).toBe(LOCAL_H3_CHANNEL_NAME);
        expect(d.h3Worker).toBe(LOCAL_H3_WORKER_LABEL);
        expect(d.h3Worker).toBe(":8264");
        expect(d.h3Worker).not.toBe(":8195");
        expect(d.chatAlias).toBe(LOCAL_CHAT_ALIAS);
        expect(d.chatAlias).toBe("deepseek-v4-flash-dspark");
        expect(d.cloudPresetsDefaultOpen).toBe(false);
        expect(d.nasRootDefault).toBe("toiv/comfyui-models");
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
