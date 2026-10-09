import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";

const examplePath = resolve(import.meta.dir, "../../deploy/toiv-staging/gate/model-config.template.example.json");
const livePath = resolve(import.meta.dir, "../../deploy/toiv-staging/gate/model-config.template.json");
const templatePath = livePath; // live is source of truth for prod gate; example must match

describe("model-config template local-first realign", () => {
    const cfg = JSON.parse(readFileSync(templatePath, "utf8"));
    const exampleCfg = JSON.parse(readFileSync(examplePath, "utf8"));

    test("live template matches example (prod gate uses live)", () => {
        expect(cfg.textModel).toBe(exampleCfg.textModel);
        expect(cfg.imageModel).toBe(exampleCfg.imageModel);
        expect(cfg.videoModel).toBe(exampleCfg.videoModel);
        expect(cfg.assistantModel).toBe(exampleCfg.assistantModel);
    });

    test("channels + defaults match真机 ports and NAS basenames", () => {
        const h3 = cfg.channels.find((c: any) => (c.modelProfiles || []).some((p: any) => p.protocol === "toiv-h3"));
        const llm = cfg.channels.find((c: any) => c.id === "toiv-llm");
        const image = cfg.channels.find((c: any) => c.id === "toiv-image");
        const wan = cfg.channels.find((c: any) => c.id === "toiv-video-wan");

        expect(h3?.name).toBe("本地·H3");
        expect(String(h3?.publicAlias || "")).toContain(":8264");
        expect(String(h3?.publicAlias || "")).not.toContain(":8195");
        const h3Profiles = h3?.modelProfiles || [];
        const fl2va = h3Profiles.find((p: any) => p.model === "h3");
        const ref2va = h3Profiles.find((p: any) => p.model === "h3-t2v");
        expect(String(fl2va?.displayName || "")).toBe("minimax_h3_fl2va_pruned_int8_convrot.safetensors");
        expect(String(ref2va?.displayName || "")).toBe("minimax_h3_ref2va_pruned_int8_convrot.safetensors");
        expect(String(fl2va?.displayName || "")).not.toContain("fp8");
        expect(String(ref2va?.displayName || "")).not.toContain("fp8");
        expect(String(fl2va?.displayName || "")).not.toBe("本地·H3视频");
        expect(String(ref2va?.displayName || "")).not.toBe("本地·H3文生视频");
        const workerHints = h3Profiles.map((p: any) => p?.defaultOptions?.toivWorkerLabel);
        expect(workerHints.every((v: string) => v === ":8264")).toBe(true);
        expect(workerHints).not.toContain(":8195");

        expect(llm?.name).toBe("本地·Spark对话");
        expect(llm?.baseUrl).toBe("http://192.168.71.84:8000/v1");
        expect(String(llm?.publicAlias || "")).toContain(":8000");
        expect(cfg.assistantModel).toBe("toiv-llm::deepseek-v4-flash-dspark");
        expect(cfg.textModel).toBe("toiv-llm::deepseek-v4-flash-dspark");
        expect(cfg.textModel).not.toContain("qwen3.8-27b");
        expect(llm?.models || []).toContain("deepseek-v4-flash-dspark");

        expect(image?.name).toBe("本地·出图 Comfy");
        expect(String(image?.publicAlias || "")).toContain(":8196");
        expect(String(image?.publicAlias || "")).toContain("Qwen-Rapid-AIO-SFW-v11");
        const imgProfile = (image?.modelProfiles || []).find((p: any) => p.model === "local-checkpoint");
        expect(String(imgProfile?.displayName || "")).toBe("Qwen-Rapid-AIO-SFW-v11.safetensors");
        expect(imgProfile?.defaultOptions?.toivWorkerLabel).toBe(":8196");
        expect(cfg.imageModel).toBe("toiv-image::local-checkpoint");
        expect(cfg.imageModels || []).toContain("toiv-image::local-checkpoint");
        expect((image?.modelProfiles || []).map((p: any) => p.protocol)).toContain("toiv-comfy-image");

        expect(wan?.name).toBe("本地·出视频");
        expect(String(wan?.publicAlias || "")).toContain(":8197");
        expect(String(wan?.publicAlias || "")).toContain(":8199");
        const animate = (wan?.modelProfiles || []).find((p: any) => p.model === "local-wan-animate");
        expect(animate?.displayName).toBe("本地·Wan Animate2");
        expect(animate?.defaultOptions?.toivWorkerLabel).toBe(":8199");
        expect(cfg.videoModels || []).toEqual(expect.arrayContaining([
            "toiv-video-wan::local-wan",
            "toiv-video-wan::local-longcat",
            "toiv-video-wan::local-vace",
            "toiv-video-wan::local-wan-animate",
            "toiv-video-wan::local-longcat-continue",
            "toiv-video-wan::local-longcat-avatar",
        ]));
        expect((wan?.models || []) as string[]).toEqual(expect.arrayContaining(["local-wan", "local-longcat", "local-vace", "local-wan-animate", "local-longcat-continue", "local-longcat-avatar"]));

        // Default video stays H3 production :8264 (protocol id h3, display = fl2va basename)

        expect(String(cfg.videoModel || "")).toContain("h3");
        expect(String(cfg.videoModel || "")).not.toContain("local-wan");

        // No BeefAPI on local template path
        expect(cfg.channels.some((c: any) => c.id === "beefapi")).toBe(false);
    });
});
