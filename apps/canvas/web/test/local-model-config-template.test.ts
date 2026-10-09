import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";

const templatePath = resolve(import.meta.dir, "../../deploy/toiv-staging/gate/model-config.template.example.json");

describe("model-config template local-first", () => {
    const cfg = JSON.parse(readFileSync(templatePath, "utf8"));

    test("video + chat + image local defaults use real Comfy protocols", () => {
        const h3 = cfg.channels.find((c: any) => (c.modelProfiles || []).some((p: any) => p.protocol === "toiv-h3"));
        const llm = cfg.channels.find((c: any) => c.id === "toiv-llm");
        const image = cfg.channels.find((c: any) => c.id === "toiv-image" || c.name === "本地·生图");
        const wan = cfg.channels.find((c: any) => c.id === "toiv-video-wan" || String(c.name || "").includes("Wan/LongCat"));

        expect(h3?.name).toBe("本地·H3视频");
        expect(String(h3?.publicAlias || "")).toContain(":8264");
        expect(String(h3?.publicAlias || "")).not.toContain(":8195");
        expect(llm?.name).toBe("本地·Spark对话");
        expect(cfg.assistantModel).toBe("toiv-llm::deepseek-v4-flash-dspark");
        expect(cfg.textModel).toBe("toiv-llm::deepseek-v4-flash-dspark");
        expect(llm?.models || []).toContain("deepseek-v4-flash-dspark");
        const workerHints = (h3?.modelProfiles || []).map((p: any) => p?.defaultOptions?.toivWorkerLabel);
        expect(workerHints.every((v: string) => v === ":8264")).toBe(true);

        expect(image?.name).toBe("本地·生图");
        expect(String(image?.publicAlias || "")).toContain(":8196");
        expect(String(image?.publicAlias || "")).not.toContain(":8205");
        const imgWorkers = (image?.modelProfiles || []).map((p: any) => p?.defaultOptions?.toivWorkerLabel);
        expect(imgWorkers.every((v: string) => v === ":8196")).toBe(true);
        expect(cfg.imageModel).toBe("toiv-image::local-checkpoint");
        expect(cfg.imageModels || []).toContain("toiv-image::local-checkpoint");
        const imgProtocols = (image?.modelProfiles || []).map((p: any) => p.protocol);
        expect(imgProtocols).toContain("toiv-comfy-image");
        expect(imgProtocols).not.toContain("openai-images");

        // Comfy protocol knife: Wan/LongCat channel uses toiv-comfy-video → :8197
        expect(wan).toBeDefined();
        expect(wan?.id).toBe("toiv-video-wan");
        expect(String(wan?.publicAlias || "")).toContain(":8197");
        const wanProtocols = (wan?.modelProfiles || []).map((p: any) => p.protocol);
        expect(wanProtocols).toContain("toiv-comfy-video");
        expect(wanProtocols).not.toContain("openai-videos");
        expect(cfg.videoModels || []).toEqual(expect.arrayContaining([
            "toiv-video-wan::local-wan",
            "toiv-video-wan::local-longcat",
            "toiv-video-wan::local-vace",
        ]));
        expect((wan?.models || []) as string[]).toEqual(expect.arrayContaining(["local-wan", "local-longcat", "local-vace"]));
        // Default video stays H3
        expect(String(cfg.videoModel || "")).toContain("h3");
    });
});
