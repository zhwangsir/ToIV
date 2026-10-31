import { useState } from "react";
import { createRoot } from "react-dom/client";
import { App, ConfigProvider } from "antd";
import zhCN from "antd/locale/zh_CN";

import { ChannelModelSettings } from "@/pages/settings/channel-model-settings";
import { getAntThemeConfig } from "@/lib/app-theme";
import { systemChannelsFromCatalog } from "@/lib/system-channel-catalog";
import { createModelChannel } from "@/stores/use-config-store";

// 真实验收 harness：ChannelModelSettings × 真实 CSS。
// system fixture 的服务端 capabilityConfig 与 TS defaultModelCapabilityConfig 默认值差异明显：
// 默认 video maxImages=9 / promptMaxChars=8000 / duration range 1-15 default 6 / resolutions 480p-2160p。
const systemVideoConfig = {
    references: {
        promptMaxChars: 1234,
        minImages: 0,
        maxImages: 1,
        maxImageBytes: 5 * 1024 * 1024,
        maxVideos: 0,
        maxVideoBytes: 0,
        maxVideoDurationSeconds: 0,
        maxAudios: 0,
        maxAudioBytes: 0,
        maxAudioDurationSeconds: 0,
    },
    duration: { selection: "enum", values: [3, 7], default: 7 },
    ratios: ["21:9"],
    defaultRatio: "21:9",
    resolutions: ["540p"],
    defaultResolution: "540p",
    generateAudio: { supported: true, default: true },
    watermark: { supported: true, default: true },
    operations: ["text_to_video", "image_to_video"],
    defaultOperation: "image_to_video",
};

const customVideoConfig = {
    ...systemVideoConfig,
    references: { ...systemVideoConfig.references, promptMaxChars: 9999, maxImages: 4 },
    duration: { selection: "enum", values: [4, 8], default: 4 },
    resolutions: ["720p", "1080p"],
    defaultResolution: "720p",
};

const systemCatalog = {
    source: "system",
    models: [],
    channels: [
        {
            id: "sys-hub",
            name: "平台视频枢纽",
            displayName: "平台视频枢纽",
            sortOrder: 1,
            models: [
                { id: "v1", modelKey: "sys-vid", displayName: "系统视频模型", capability: "video", protocol: "newapi-channel-2", available: true, capabilityConfig: { version: 1, video: systemVideoConfig } },
                { id: "t1", modelKey: "sys-txt", displayName: "系统文本模型", capability: "text", protocol: "chat-completion", available: true, capabilityConfig: { version: 1, text: { streaming: true, references: { promptMaxChars: 4321, maxImages: 0, maxImageBytes: 0, maxVideos: 0, maxVideoBytes: 0 } } } },
                // 协议目录（/api/plugins/catalog stub）未安装 future-protocol-9：诚实的「待配置请求协议」。
                { id: "u1", modelKey: "sys-future", displayName: "未来协议模型", capability: "text", protocol: "future-protocol-9", available: true },
            ],
        },
    ],
};

const [systemChannel] = systemChannelsFromCatalog(systemCatalog);

const customChannel = createModelChannel({
    id: "custom-hub",
    name: "我的渠道",
    baseUrl: "https://custom.example.com",
    apiKey: "synthetic-key",
    models: ["my-vid"],
    modelProfiles: [{ model: "my-vid", displayName: "自定义视频模型", capability: "video", protocol: "newapi-channel-2", capabilityConfig: { version: 1, video: customVideoConfig } }],
});

declare global {
    interface Window {
        __changes: { system: number; custom: number };
    }
}

window.__changes = { system: 0, custom: 0 };

function Harness() {
    const [systemProfiles, setSystemProfiles] = useState(systemChannel?.modelProfiles || []);
    const [customProfiles, setCustomProfiles] = useState(customChannel.modelProfiles || []);
    if (!systemChannel) return <p data-testid="fixture-error">system fixture 未映射成功</p>;
    // 与生产 AppProviders 同一暗色主题：ConfigProvider(getAntThemeConfig(true)) + html.dark + 完整 CSS 链。
    return (
        <ConfigProvider locale={zhCN} theme={getAntThemeConfig(true)}>
            <App>
                <div data-testid="system-settings" className="p-4">
                    <ChannelModelSettings
                        channel={{ ...systemChannel, modelProfiles: systemProfiles }}
                        onChange={(modelProfiles) => {
                            window.__changes.system += 1;
                            setSystemProfiles(modelProfiles);
                        }}
                    />
                </div>
                <div data-testid="custom-settings" className="p-4">
                    <ChannelModelSettings
                        channel={{ ...customChannel, modelProfiles: customProfiles }}
                        onChange={(modelProfiles) => {
                            window.__changes.custom += 1;
                            setCustomProfiles(modelProfiles);
                        }}
                    />
                </div>
            </App>
        </ConfigProvider>
    );
}

createRoot(document.getElementById("root")!).render(<Harness />);
