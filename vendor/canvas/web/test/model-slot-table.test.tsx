import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { ModelSlotTable } from "@/pages/settings/model-slot-table";
import { LlmMutexBanner } from "@/pages/settings/llm-mutex-banner";
import { LOCAL_CHAT_MODEL_REF } from "@/lib/local-model-defaults";
import { createModelChannel, defaultConfig, normalizeConfigSnapshot } from "@/stores/use-config-store";

describe("model-slot-table user-driven mix", () => {
    test("renders selectable role slots + LoRA rows + readonly VLM/TTS", () => {
        const channels = [
            createModelChannel({
                id: "toiv-llm",
                name: "本机 LLM · Mia V4.1",
                models: ["DeepSeek-V4.1-Flash-1017"],
                modelProfiles: [{ model: "DeepSeek-V4.1-Flash-1017", capability: "text", protocol: "chat-completion" }],
            }),
        ];
        const config = normalizeConfigSnapshot({
            config: { ...defaultConfig, channels, textModel: LOCAL_CHAT_MODEL_REF },
        }).config;
        const markup = renderToStaticMarkup(<ModelSlotTable config={config} onChange={() => {}} />);
        expect(markup).toContain('data-testid="model-slot-table"');
        expect(markup).toContain("对话 / 剧本");
        expect(markup).toContain("剧本 / Agent / 画布对话");
        expect(markup).toContain("出视频 · 主（H3）");
        expect(markup).toContain("出视频 · 运动");
        expect(markup).toContain("识图 VLM");
        expect(markup).toContain("配音");
        expect(markup).toContain("toiv-vlm");
        expect(markup).toContain("IndexTTS");
        expect(markup).toContain('data-testid="slot-lora-image"');
        expect(markup).toContain('data-testid="slot-lora-video-primary"');
        expect(markup).toContain('data-testid="slot-lora-video-motion"');
        expect(markup.match(/class="settings-lora-chip"/g)).toHaveLength(3);
        expect(markup).not.toMatch(/>:\d{3,5}</);
        const banner = renderToStaticMarkup(<LlmMutexBanner config={config} />);
        expect(banner).toContain("同卡互斥");
        expect(banner).toContain("不会自动操作");
        expect(banner).not.toMatch(/:\d{3,5}/);
    });
});
