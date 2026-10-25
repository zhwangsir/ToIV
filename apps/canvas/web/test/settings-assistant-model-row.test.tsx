import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { ModelSlotTable } from "@/pages/settings/model-slot-table";
import { createModelChannel, defaultConfig, normalizeConfigSnapshot, type AiConfig } from "@/stores/use-config-store";

function configWithTextChannel(overrides: Partial<AiConfig> = {}): AiConfig {
    const channels = [
        createModelChannel({
            id: "a",
            name: "本地渠道",
            models: ["chat-1", "chat-2"],
            modelProfiles: [
                { model: "chat-1", capability: "text", protocol: "chat-completion" },
                { model: "chat-2", capability: "text", protocol: "claude-api" },
            ],
        }),
    ];
    return normalizeConfigSnapshot({ config: { ...defaultConfig, channels, textModel: "a::chat-1", ...overrides } }).config;
}

/** 助手 Select 区块（到 VLM 标题前）里的选中 option value。 */
function assistantSelectedValue(config: AiConfig): string | null {
    const markup = renderToStaticMarkup(<ModelSlotTable config={config} onChange={() => {}} />);
    const start = markup.indexOf('id="slot-assistant-title"');
    const end = markup.indexOf('id="slot-vlm-title"');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const slice = markup.slice(start, end);
    const hit = slice.match(/<option value="([^"]*)" selected=""/);
    return hit?.[1] ?? null;
}

describe("设置页角色槽 · 助手一行", () => {
    test("排在对话/剧本之后、识图 VLM 之前", () => {
        const markup = renderToStaticMarkup(<ModelSlotTable config={configWithTextChannel()} onChange={() => {}} />);
        const textIndex = markup.indexOf("对话 / 剧本");
        const assistantIndex = markup.indexOf(">助手<");
        const vlmIndex = markup.indexOf("识图 VLM");
        expect(textIndex).toBeGreaterThan(-1);
        expect(assistantIndex).toBeGreaterThan(textIndex);
        expect(vlmIndex).toBeGreaterThan(assistantIndex);
    });

    test("默认选中跟随对话，并说明助手会做什么", () => {
        const markup = renderToStaticMarkup(<ModelSlotTable config={configWithTextChannel()} onChange={() => {}} />);
        expect(markup).toContain("跟随对话 / 剧本");
        expect(markup).toContain("画布助手；可跟随对话槽或单独指定。");
        expect(markup).toContain("chat-1");
        expect(markup).toContain("chat-2");
    });

    test("选中态跟着 assistantModel 走：为空选中跟随项，有值选中对应模型", () => {
        expect(assistantSelectedValue(configWithTextChannel())).toBe("__follow__");
        expect(assistantSelectedValue(configWithTextChannel({ assistantModel: "a::chat-2" }))).toBe("a::chat-2");
        // 已选不可用时仍显示原值（Select value），并有提示文案
        const gone = renderToStaticMarkup(
            <ModelSlotTable config={configWithTextChannel({ assistantModel: "gone::chat-1" })} onChange={() => {}} />,
        );
        expect(gone).toContain("已选模型不可用");
    });
});
