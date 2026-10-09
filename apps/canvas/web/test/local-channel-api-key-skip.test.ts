import { describe, expect, test } from "bun:test";

import { channelHasGenerationCredential, createModelChannel } from "@/stores/use-config-store";

describe("local ToIV channels skip API Key gate", () => {
    test("toiv-image / toiv-llm / H3 id are ready without apiKey", () => {
        for (const id of ["toiv-image", "toiv-llm", "toiv-video-wan", "MZt9ON1JvbabJ2GS-PvXR"]) {
            const ch = createModelChannel({ id, apiKey: "", baseUrl: "http://127.0.0.1:8196" });
            expect(channelHasGenerationCredential(ch)).toBe(true);
        }
    });

    test("cloud-style channel still needs apiKey", () => {
        const ch = createModelChannel({ id: "openai-custom", apiKey: "", baseUrl: "https://api.openai.com/v1" });
        expect(channelHasGenerationCredential(ch)).toBe(false);
        const keyed = createModelChannel({ id: "openai-custom", apiKey: "sk-test", baseUrl: "https://api.openai.com/v1" });
        expect(channelHasGenerationCredential(keyed)).toBe(true);
    });
});
