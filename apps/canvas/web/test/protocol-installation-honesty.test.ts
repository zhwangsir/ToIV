import { afterEach, describe, expect, test } from "bun:test";

import { assistantModelOptions, normalizeAssistantModel, resolveAssistantModel } from "../src/lib/assistant-model";
import { systemChannelsFromCatalog } from "../src/lib/system-channel-catalog";
import { runBackendGenerationTask, type GenerationTaskDependencies } from "../src/services/api/generation-task";
import { createModelChannel, defaultConfig, useConfigStore, type AiConfig } from "../src/stores/use-config-store";

afterEach(() => {
    useConfigStore.getState().replaceConfig(structuredClone(defaultConfig));
});

// 协议目录（插件中心）未安装某协议时，已有逻辑必须诚实拒绝提交，而不是静默落到一个错误适配器：
// 1) 助手模型白名单（assistant-model.ts）把未知协议模型排除出可选列表；
// 2) 后端任务提交前的运行时装配校验（generation-task.ts assertBackendRuntimeConfigured）在无可用协议时抛错且不创建任务；
// 3) 设置页对未安装协议显示「待配置请求协议」（channel-model-settings-system.browser.test.ts 已覆盖）。
const catalogWithUnknownProtocol = {
    source: "system",
    models: [],
    channels: [
        {
            id: "sys-hub",
            name: "平台枢纽",
            models: [
                { id: "ok", modelKey: "sys-chat", displayName: "系统对话", capability: "text", protocol: "chat-completion", available: true, capabilityConfig: { version: 1, text: { streaming: true, references: { promptMaxChars: 32000, maxImages: 0, maxImageBytes: 0, maxVideos: 0, maxVideoBytes: 0 } } } },
                { id: "unknown", modelKey: "sys-future", displayName: "未来协议模型", capability: "text", protocol: "future-protocol-9", available: true },
            ],
        },
    ],
};

describe("未知协议在协议目录未安装时的诚实不可提交", () => {
    test("assistantModelOptions 排除未知协议模型，已保存的该模型归一化为空", () => {
        const channels = systemChannelsFromCatalog(catalogWithUnknownProtocol);
        const config: AiConfig = { ...defaultConfig, channels, textModel: "sys-hub::sys-chat", assistantModel: "sys-hub::sys-future" };

        expect(assistantModelOptions(config)).toEqual(["sys-hub::sys-chat"]);
        expect(normalizeAssistantModel(config, "sys-hub::sys-future")).toBe("");
        // 已保存的未知协议助手模型诚实归一化为空；清空后跟随默认文本模型。
        expect(resolveAssistantModel(config)).toBe("");
        expect(resolveAssistantModel({ ...config, assistantModel: "" })).toBe("sys-hub::sys-chat");
    });

    test("后端任务提交前校验拒绝无可用协议的渠道，且绝不创建任务", async () => {
        // Gemini 格式渠道、模型未选协议也未装协议插件：interfaceType 解析为空。
        const channel = createModelChannel({ id: "gem", name: "Gemini 渠道", baseUrl: "https://gemini.example.com", apiKey: "synthetic-key", apiFormat: "gemini", models: ["g-1"], modelProfiles: [{ model: "g-1", capability: "text" }] });
        const config: AiConfig = { ...defaultConfig, channels: [channel], model: "gem::g-1", textModel: "gem::g-1" };
        let createTaskCalls = 0;
        const dependencies: GenerationTaskDependencies = {
            createTask: (async () => {
                createTaskCalls += 1;
                throw new Error("must not be called");
            }) as unknown as GenerationTaskDependencies["createTask"],
            waitTask: (async () => {
                throw new Error("must not be called");
            }) as unknown as GenerationTaskDependencies["waitTask"],
            createId: () => "synthetic-id",
        };

        await expect(runBackendGenerationTask({ mode: "text", prompt: "hi", config }, dependencies)).rejects.toThrow("当前模型未选择可用请求协议");
        expect(createTaskCalls).toBe(0);
    });

    test("已安装协议模型的既有提交路径不受影响", async () => {
        const channel = createModelChannel({ id: "manual", name: "手动渠道", baseUrl: "https://manual.example.com", apiKey: "synthetic-key", apiFormat: "openai", models: ["m-1"], modelProfiles: [{ model: "m-1", capability: "text", protocol: "chat-completion" }] });
        const config: AiConfig = { ...defaultConfig, channels: [channel], model: "manual::m-1", textModel: "manual::m-1" };
        let createTaskCalls = 0;
        const dependencies: GenerationTaskDependencies = {
            createTask: (async () => {
                createTaskCalls += 1;
                // 模拟后端立即拒绝业务信封，证明前端确实走到了创建调用（而非被前置校验误拦）。
                const { ApiError } = await import("../src/services/api/request");
                throw new ApiError("backend refused", { code: 400, reason: "synthetic" });
            }) as unknown as GenerationTaskDependencies["createTask"],
            waitTask: (async () => ({})) as unknown as GenerationTaskDependencies["waitTask"],
            createId: () => "synthetic-id",
        };

        await expect(runBackendGenerationTask({ mode: "text", prompt: "hi", config }, dependencies)).rejects.toThrow("backend refused");
        expect(createTaskCalls).toBe(1);
    });
});
