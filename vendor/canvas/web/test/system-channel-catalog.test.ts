import { afterEach, describe, expect, test } from "bun:test";

import { hydrateSystemModelCatalog } from "../src/components/layout/system-catalog-bootstrap";
import { systemChannelsFromCatalog } from "../src/lib/system-channel-catalog";
import { modelCompatibilityError, modelPromptLengthError } from "../src/lib/model-selection";
import { fetchModelCatalog } from "../src/services/api/model-catalog";
import { apiClient } from "../src/services/api/request";
import { createModelChannel, defaultConfig, useConfigStore, type ModelChannel } from "../src/stores/use-config-store";

const originalApiRequest = apiClient.request;

afterEach(() => {
    apiClient.request = originalApiRequest;
    useConfigStore.getState().replaceConfig(structuredClone(defaultConfig));
});

// 与 Go `ModelCapabilityConfig`（backend/internal/modelcatalog/types.go）对齐的完整服务端能力配置。
const serverVideoConfig = {
    references: {
        promptMaxChars: 8000,
        minImages: 0,
        maxImages: 1,
        maxImageBytes: 10 * 1024 * 1024,
        maxVideos: 0,
        maxVideoBytes: 0,
        maxVideoDurationSeconds: 0,
        maxAudios: 0,
        maxAudioBytes: 0,
        maxAudioDurationSeconds: 0,
    },
    duration: { selection: "enum", values: [5, 10], default: 5 },
    ratios: ["16:9"],
    defaultRatio: "16:9",
    resolutions: ["1080p"],
    defaultResolution: "1080p",
    generateAudio: { supported: false, default: false },
    watermark: { supported: false, default: false },
    operations: ["text_to_video", "image_to_video"],
    defaultOperation: "text_to_video",
};

const serverImageConfig = {
    references: { promptMaxChars: 4000, maxImages: 3, maxImageBytes: 20 * 1024 * 1024, maskSupported: true },
    size: {
        parameter: "size",
        values: ["1024x1024", "2048x2048"],
        default: "1024x1024",
        allowCustom: false,
        presets: [{ tier: "1k", ratio: "1:1", size: "1024x1024", width: 1024, height: 1024 }],
    },
    quality: { supported: true, values: ["auto", "high"], default: "auto" },
    transparentBackground: { supported: false, default: false },
    responseFormat: { supported: true },
    outputFormat: { supported: false },
    maxOutputs: 4,
};

const serverTextConfig = {
    streaming: true,
    references: { promptMaxChars: 32000, maxImages: 0, maxImageBytes: 0, maxVideos: 0, maxVideoBytes: 0 },
};

function systemCatalogPayload() {
    return {
        source: "system",
        models: [],
        channels: [
            {
                id: "sys-video",
                name: "Video Hub",
                displayName: "视频枢纽",
                sortOrder: 2,
                models: [
                    { id: "m1", modelKey: "seedance-lite", displayName: "Seedance Lite", capability: "video", protocol: "newapi-channel-2", available: true, capabilityConfig: { version: 1, video: serverVideoConfig } },
                    { id: "m-off", modelKey: "seedance-off", capability: "video", protocol: "newapi-channel-2", available: false, capabilityConfig: { version: 1, video: serverVideoConfig } },
                    { id: "m-broken", modelKey: "seedance-broken", capability: "video", protocol: "newapi-channel-2", available: true, capabilityConfig: { version: 1, video: { ratios: "not-an-object" } } },
                    { id: "m-badcap", modelKey: "hologram-9000", capability: "hologram", protocol: "newapi-channel-2", available: true },
                    { id: "m-nokey", capability: "video", protocol: "newapi-channel-2", available: true },
                    { id: "m-unknown-protocol", modelKey: "future-model", capability: "video", protocol: "future-protocol-9", available: true, capabilityConfig: { version: 1, video: serverVideoConfig } },
                    { id: "m-weird-protocol", modelKey: "numeric-protocol", capability: "video", protocol: 42, available: true, capabilityConfig: { version: 1, video: serverVideoConfig } },
                ],
            },
            {
                id: "sys-text",
                name: "Text Hub",
                sortOrder: 1,
                models: [
                    { id: "t1", modelKey: "deep-chat", displayName: "Deep Chat", capability: "text", protocol: "chat-completion", available: true, capabilityConfig: { version: 1, text: serverTextConfig } },
                    { id: "t-broken", modelKey: "deep-chat-broken", capability: "text", protocol: "chat-completion", available: true, capabilityConfig: { version: 1, text: { references: { promptMaxChars: "many" } } } },
                ],
            },
            {
                id: "sys-image",
                name: "Image Hub",
                models: [{ id: "i1", modelKey: "imagine-1", capability: "image", protocol: "openai-image", available: true, capabilityConfig: { version: 1, image: serverImageConfig } }],
            },
            {
                id: "sys-empty",
                name: "Empty Hub",
                models: [{ id: "x1", modelKey: "ghost", capability: "hologram", protocol: "p", available: true }],
            },
            { id: "sys-malformed" },
        ],
    };
}

const visualInput = { textCount: 0, imageCount: 0, videoCount: 0, audioCount: 0, characterCount: 0 };

describe("system channel catalog mapper", () => {
    test("maps online system channels into modelProfiles without merging TS defaults", () => {
        const channels = systemChannelsFromCatalog(systemCatalogPayload());

        expect(channels.map((channel) => channel.id)).toEqual(["sys-video", "sys-text", "sys-image"]);
        const video = channels[0]!;
        expect(video.scope).toBe("system");
        expect(video.name).toBe("视频枢纽");
        expect(video.baseUrl).toBe("/api/ai/system/sys-video");
        // 下架、缺 key、未知能力的模型被隔离；字符串协议原样保留、非字符串协议忽略。
        // 能力配置畸形的模型保留但丢弃该配置（读时回退协议模板），不让单项畸形拖垮整个模型。
        expect(video.models).toEqual(["seedance-lite", "seedance-broken", "future-model", "numeric-protocol"]);
        const lite = video.modelProfiles?.find((item) => item.model === "seedance-lite");
        expect(lite).toMatchObject({ capability: "video", protocol: "newapi-channel-2", displayName: "Seedance Lite" });
        // 关键断言：capabilityConfig 是服务端值的规范化拷贝，不能与 TS defaultModelCapabilityConfig 合并。
        expect(lite?.capabilityConfig).toEqual({ version: 1, video: serverVideoConfig });
        expect(lite?.capabilityConfig).not.toHaveProperty("image");
        expect(lite?.capabilityConfig).not.toHaveProperty("text");
        expect(video.modelProfiles?.find((item) => item.model === "future-model")?.protocol).toBe("future-protocol-9");
        expect(video.modelProfiles?.find((item) => item.model === "numeric-protocol")?.protocol).toBeUndefined();
        expect(video.modelProfiles?.find((item) => item.model === "seedance-broken")).toMatchObject({ capability: "video", protocol: "newapi-channel-2" });
        expect(video.modelProfiles?.find((item) => item.model === "seedance-broken")?.capabilityConfig).toBeUndefined();

        const text = channels[1]!;
        expect(text.models).toEqual(["deep-chat", "deep-chat-broken"]);
        expect(text.modelProfiles?.[0]?.capabilityConfig).toEqual({ version: 1, text: serverTextConfig });
        expect(text.modelProfiles?.find((item) => item.model === "deep-chat-broken")?.capabilityConfig).toBeUndefined();

        const image = channels[2]!;
        expect(image.modelProfiles?.[0]?.capabilityConfig).toEqual({ version: 1, image: serverImageConfig });
    });

    test("drops channels whose models are all malformed instead of emitting placeholders", () => {
        const channels = systemChannelsFromCatalog(systemCatalogPayload());
        expect(channels.some((channel) => channel.id === "sys-empty")).toBe(false);
        expect(channels.some((channel) => channel.id === "sys-malformed")).toBe(false);
    });

    test("frontend source logical models are not mapped and do not act as an empty catalog", () => {
        expect(systemChannelsFromCatalog({ source: "frontend", models: [{ id: "lm-1" }], channels: [] })).toEqual([]);
        expect(systemChannelsFromCatalog({ source: "system", channels: "not-an-array" })).toEqual([]);
        expect(systemChannelsFromCatalog(null)).toEqual([]);
    });
});

describe("config store mergeSystemChannels", () => {
    function seedStore() {
        const custom = createModelChannel({
            id: "custom-1",
            name: "我的渠道",
            baseUrl: "https://custom.example.com",
            apiKey: "synthetic-key",
            models: ["custom-image"],
            modelProfiles: [{ model: "custom-image", capability: "image", protocol: "openai-image" }],
        });
        const staleSystem = createModelChannel({ id: "sys-old", name: "旧系统渠道", scope: "system", apiKey: "system", models: ["legacy"], modelProfiles: [{ model: "legacy", capability: "text", protocol: "chat-completion" }] });
        useConfigStore.getState().replaceConfig(structuredClone({ ...defaultConfig, channels: [custom, staleSystem] }));
    }

    test("replaces system channels while keeping user custom channels untouched", () => {
        seedStore();
        const incoming = systemChannelsFromCatalog(systemCatalogPayload());
        useConfigStore.getState().mergeSystemChannels(incoming);
        const config = useConfigStore.getState().config;

        const custom = config.channels.find((channel) => channel.id === "custom-1");
        expect(custom?.models).toEqual(["custom-image"]);
        expect(custom?.scope).not.toBe("system");
        expect(config.channels.some((channel) => channel.id === "sys-old")).toBe(false);
        expect(config.channels.filter((channel) => channel.scope === "system").map((channel) => channel.id)).toEqual(["sys-video", "sys-text", "sys-image"]);

        // 二次拉取（目录更新/账号重登）同样只替换 system 段。
        useConfigStore.getState().mergeSystemChannels(incoming.slice(0, 1));
        const next = useConfigStore.getState().config;
        expect(next.channels.filter((channel) => channel.scope === "system").map((channel) => channel.id)).toEqual(["sys-video"]);
        expect(next.channels.find((channel) => channel.id === "custom-1")?.models).toEqual(["custom-image"]);
    });

    test("modelCompatibilityError evaluates inputs against server capability values", () => {
        useConfigStore.getState().mergeSystemChannels(systemChannelsFromCatalog(systemCatalogPayload()));
        const config = useConfigStore.getState().config;
        const model = "sys-video::seedance-lite";

        // 服务端 maxImages=1：默认 TS 配置（9 张）不会放行 5 张参考图。
        expect(modelCompatibilityError(config, model, { capability: "video", input: { ...visualInput, imageCount: 5 } })).toBe("最多支持 1 张参考图");
        expect(modelCompatibilityError(config, model, { capability: "video", input: { ...visualInput, imageCount: 1 } })).toBe("");
        // 服务端 duration values=[5,10]：默认 range 1-15 不会拦 8 秒。
        expect(modelCompatibilityError(config, model, { capability: "video", videoSeconds: "8", input: visualInput })).toBe("不支持当前视频时长");
        expect(modelCompatibilityError(config, model, { capability: "video", videoSeconds: "10", input: visualInput })).toBe("");

        // 服务端 promptMaxChars=32000 用于调用前长度校验。
        expect(modelPromptLengthError(config, "sys-text::deep-chat", "text", "长".repeat(32001))).toContain("最多 32000");
        expect(modelPromptLengthError(config, "sys-text::deep-chat", "text", "长".repeat(32000))).toBe("");
    });

    test("system channels are generation-ready without a browser-cached API key", () => {
        useConfigStore.getState().mergeSystemChannels(systemChannelsFromCatalog(systemCatalogPayload()));
        const config = useConfigStore.getState().config;
        // 模拟持久化后密钥被剥离的场景。
        const stripped = { ...config, channels: config.channels.map((channel) => ({ ...channel, apiKey: "" })) };
        const ready = useConfigStore.getState().isAiConfigReady;
        expect(ready(stripped, "sys-video::seedance-lite")).toBe(true);
        expect(ready(stripped, "sys-text::deep-chat")).toBe(true);
    });
});

describe("model catalog http client", () => {
    test("fetchModelCatalog unwraps the backend envelope", async () => {
        const payload = systemCatalogPayload();
        apiClient.request = (async () => ({ data: { code: 0, data: payload, msg: "" } })) as typeof apiClient.request;
        const catalog = await fetchModelCatalog();
        expect(catalog.source).toBe("system");
        expect(catalog.channels).toHaveLength(5);
    });

    test("fetchModelCatalog surfaces business failures instead of faking success", async () => {
        apiClient.request = (async () => ({ status: 502, data: { code: 502, data: null, msg: "后端服务暂时不可用，请稍后重试", reason: "bad_gateway" } })) as typeof apiClient.request;
        await expect(fetchModelCatalog()).rejects.toThrow("后端服务暂时不可用，请稍后重试");
    });
});

describe("system catalog hydration orchestrator", () => {
    test("merges mapped system channels for the current user", async () => {
        const merged: ModelChannel[][] = [];
        const result = await hydrateSystemModelCatalog({
            userId: "user-a",
            fetchCatalog: async () => systemCatalogPayload(),
            isCurrentUser: () => true,
            mergeSystemChannels: (channels) => { merged.push(channels); },
        });
        expect(result).toBe("merged");
        expect(merged).toHaveLength(1);
        expect(merged[0]!.map((channel) => channel.id)).toEqual(["sys-video", "sys-text", "sys-image"]);
    });

    test("a late response after account switch never merges into the new account", async () => {
        const merged: ModelChannel[][] = [];
        const result = await hydrateSystemModelCatalog({
            userId: "user-a",
            fetchCatalog: async () => systemCatalogPayload(),
            isCurrentUser: (id) => id === "user-b",
            mergeSystemChannels: (channels) => { merged.push(channels); },
        });
        expect(result).toBe("stale-user");
        expect(merged).toEqual([]);
    });

    test("frontend logical-model source is skipped without clearing channels", async () => {
        const merged: ModelChannel[][] = [];
        const result = await hydrateSystemModelCatalog({
            userId: "user-a",
            fetchCatalog: async () => ({ source: "frontend", models: [{ id: "lm-1" }], channels: [] }),
            isCurrentUser: () => true,
            mergeSystemChannels: (channels) => { merged.push(channels); },
        });
        expect(result).toBe("skipped-frontend");
        expect(merged).toEqual([]);
    });

    test("fetch failure keeps the existing config and reports the error", async () => {
        const merged: ModelChannel[][] = [];
        const failures: unknown[] = [];
        const result = await hydrateSystemModelCatalog({
            userId: "user-a",
            fetchCatalog: async () => { throw new Error("backend down"); },
            isCurrentUser: () => true,
            mergeSystemChannels: (channels) => { merged.push(channels); },
            onFailure: (error) => { failures.push(error); },
        });
        expect(result).toBe("failed");
        expect(merged).toEqual([]);
        expect(failures).toHaveLength(1);
    });
});
