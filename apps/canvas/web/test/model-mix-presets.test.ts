import { describe, expect, test } from "bun:test";

import {
    LLM_MUTEX_BANNER,
    LOCAL_TTS_PRODUCT_LABEL,
    LOCAL_VLM_PRODUCT_LABEL,
    MODEL_MIX_PRESETS,
    applyMixPatchToConfig,
    dramaDefaultPatch,
    isMotionVideoModelRef,
    isPrimaryVideoModelRef,
    patchForPreset,
    textModelLooksLikeLegacyDsv4,
    textModelLooksLikeMia,
} from "@/lib/model-mix-presets";
import { LOCAL_CHAT_ALIAS, LOCAL_CHAT_MODEL_REF, LOCAL_IMAGE_MODEL_REF, LOCAL_VIDEO_MODEL_REF } from "@/lib/local-model-defaults";
import { LOCAL_H3_MODEL_REF } from "@/services/toiv/local-capability-surface";
import { createModelChannel, defaultConfig, normalizeConfigSnapshot } from "@/stores/use-config-store";

describe("model-mix-presets shortcuts (not optimal)", () => {
    test("three optional examples exist; copy denies optimal guarantee and bare ports", () => {
        expect(MODEL_MIX_PRESETS.map((p) => p.id)).toEqual(["drama-default", "quality-slow", "vram-save"]);
        for (const p of MODEL_MIX_PRESETS) {
            expect(p.confirmBody).not.toMatch(/:\d{3,5}/);
            expect(p.confirmBody).toContain("不自动起停");
            expect(p.confirmBody).toMatch(/不保证最优|可再逐槽改/);
            expect(p.hint).toContain("示例");
        }
        expect(LLM_MUTEX_BANNER).not.toMatch(/:\d{3,5}/);
        expect(LOCAL_VLM_PRODUCT_LABEL).not.toMatch(/:\d{3,5}/);
        expect(LOCAL_TTS_PRODUCT_LABEL).not.toMatch(/:\d{3,5}/);
    });

    test("drama patch writes Mia + H3 primary + local image + wan motion", () => {
        const patch = dramaDefaultPatch();
        expect(patch.textModel).toBe(LOCAL_CHAT_MODEL_REF);
        expect(patch.textModel).toContain(LOCAL_CHAT_ALIAS);
        expect(patch.imageModel).toBe(LOCAL_IMAGE_MODEL_REF);
        expect(patch.videoModel).toBe(LOCAL_H3_MODEL_REF);
        expect(patch.motionModel).toBe(LOCAL_VIDEO_MODEL_REF);
        expect(patch.assistantModel).toBe("");
        expect(patchForPreset("vram-save")).toEqual(patch);
    });

    test("applyMixPatchToConfig merges model lists", () => {
        const base = normalizeConfigSnapshot({ config: { ...defaultConfig } }).config;
        const next = applyMixPatchToConfig(base, dramaDefaultPatch());
        expect(next.textModel).toBe(LOCAL_CHAT_MODEL_REF);
        expect(next.imageModel).toBe(LOCAL_IMAGE_MODEL_REF);
        expect(next.videoModel).toBe(LOCAL_H3_MODEL_REF);
        expect(next.videoModels).toContain(LOCAL_H3_MODEL_REF);
        expect(next.videoModels).toContain(LOCAL_VIDEO_MODEL_REF);
    });

    test("classifies H3 vs motion video refs", () => {
        const channels = [
            createModelChannel({
                id: "MZt9ON1JvbabJ2GS-PvXR",
                name: "本地·H3",
                models: ["h3", "h3-t2v"],
                modelProfiles: [
                    { model: "h3", capability: "video", protocol: "toiv-h3" },
                    { model: "h3-t2v", capability: "video", protocol: "toiv-h3" },
                ],
            }),
            createModelChannel({
                id: "toiv-video-wan",
                name: "本地·出视频",
                models: ["local-wan", "local-longcat"],
                modelProfiles: [
                    { model: "local-wan", capability: "video", protocol: "toiv-comfy-video" },
                    { model: "local-longcat", capability: "video", protocol: "toiv-comfy-video" },
                ],
            }),
        ];
        const config = normalizeConfigSnapshot({
            config: {
                ...defaultConfig,
                channels,
                models: [
                    "MZt9ON1JvbabJ2GS-PvXR::h3",
                    "toiv-video-wan::local-wan",
                    "toiv-video-wan::local-longcat",
                ],
            },
        }).config;
        expect(isPrimaryVideoModelRef(config, LOCAL_H3_MODEL_REF)).toBe(true);
        expect(isPrimaryVideoModelRef(config, "toiv-video-wan::local-wan")).toBe(false);
        expect(isMotionVideoModelRef(config, "toiv-video-wan::local-wan")).toBe(true);
        expect(isMotionVideoModelRef(config, LOCAL_H3_MODEL_REF)).toBe(false);
    });

    test("Mia / dsv4 heuristics", () => {
        const channels = [
            createModelChannel({
                id: "toiv-llm",
                name: "本机 LLM · Mia V4.1",
                models: [LOCAL_CHAT_ALIAS, "deepseek-v4-flash-dspark"],
                modelProfiles: [
                    { model: LOCAL_CHAT_ALIAS, capability: "text", protocol: "chat-completion" },
                    { model: "deepseek-v4-flash-dspark", capability: "text", protocol: "chat-completion" },
                ],
            }),
        ];
        const mia = normalizeConfigSnapshot({
            config: { ...defaultConfig, channels, textModel: LOCAL_CHAT_MODEL_REF, models: [LOCAL_CHAT_MODEL_REF] },
        }).config;
        expect(mia.textModel).toContain(LOCAL_CHAT_ALIAS);
        expect(textModelLooksLikeMia(mia)).toBe(true);
        expect(textModelLooksLikeLegacyDsv4(mia)).toBe(false);
        const legacy = normalizeConfigSnapshot({
            config: {
                ...defaultConfig,
                channels,
                textModel: "toiv-llm::deepseek-v4-flash-dspark",
                models: ["toiv-llm::deepseek-v4-flash-dspark"],
            },
        }).config;
        expect(textModelLooksLikeLegacyDsv4(legacy)).toBe(true);
    });
});
