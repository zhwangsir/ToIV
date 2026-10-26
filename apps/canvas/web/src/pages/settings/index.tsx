import { App, Button, Collapse } from "antd";
import { ArrowLeft, RadioTower, Settings2, Sparkles } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router";

import { SegmentedControl } from "@/components/ui/base/segmented-control";
import { ComputeStatusStrip } from "@/components/toiv/compute-status-strip";
import { useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";
import { ChannelSettingsPane, channelValidationError, focusInvalidChannelField, isChannelReady } from "./channel-settings-pane";
import DiagnosticsPanel from "./diagnostics-panel";
import { LlmMutexBanner } from "./llm-mutex-banner";
import { LocalComputePane } from "./local-compute-pane";
import { ModelMixPresetsBar } from "./model-mix-presets-bar";
import { ModelSlotTable } from "./model-slot-table";
import { SettingsModelInventory } from "./settings-model-inventory";
import { PromptPreferencesPane } from "./prompt-preferences-pane";
import { R18SettingsPane } from "./r18-settings-pane";
import { RunningHubSettingsPane } from "./runninghub-settings-pane";
import "./settings-visual.css";
import "@/styles/toiv-freezone-desk.css";

/** Product IA: 常用 / 模型与算力 / 高级. Legacy URL aliases map in resolveSettingsSection. */
export type ConfigSectionKey = "common" | "compute" | "advanced";

const configSections: Array<{ key: ConfigSectionKey; label: string; description: string; icon: ReactNode }> = [
    { key: "common", label: "常用", description: "自选角色槽、算力与内容模式", icon: <Sparkles className="size-4" /> },
    { key: "compute", label: "模型与算力", description: "库存与 NAS 换权重", icon: <RadioTower className="size-4" /> },
    { key: "advanced", label: "高级", description: "自定义渠道、云端与诊断", icon: <Settings2 className="size-4" /> },
];

const LEGACY_SECTION_MAP: Record<string, ConfigSectionKey> = {
    channels: "compute",
    models: "common",
    runninghub: "advanced",
    diagnostics: "advanced",
    prompts: "advanced",
    preferences: "advanced",
    storage: "advanced",
};

export function resolveSettingsSection(value: string | null): ConfigSectionKey {
    if (!value) return "common";
    if (value === "common" || value === "compute" || value === "advanced") return value;
    return LEGACY_SECTION_MAP[value] || "common";
}

export function isConfigSection(value: string | null): value is ConfigSectionKey {
    return value === "common" || value === "compute" || value === "advanced";
}

function advancedCollapseKeys(requested: string | null): string[] {
    if (requested === "runninghub") return ["runninghub"];
    if (requested === "diagnostics") return ["diagnostics"];
    if (requested === "prompts" || requested === "preferences") return ["prompts"];
    if (requested === "channels") return ["channels"];
    return [];
}

export default function SettingsPage() {
    const { message } = App.useApp();
    const navigate = useNavigate();
    const [searchParams, setSearchParams] = useSearchParams();
    const requestedSection = searchParams.get("section");
    const customChannelsEnabled = useUserStore((state) => state.features.customChannelsEnabled);
    const [activeTab, setActiveTab] = useState<ConfigSectionKey>(() => resolveSettingsSection(requestedSection));
    const [slotEpoch, setSlotEpoch] = useState(0);
    const effectiveConfig = useEffectiveConfig();
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const shouldPromptContinue = searchParams.get("continue") === "1";
    const userChannels = useConfigStore((state) => state.config.channels).filter((channel) => channel.scope !== "system");
    const diagnosticTaskId = searchParams.get("taskId") || undefined;
    const diagnosticProjectId = searchParams.get("projectId") || undefined;

    const advancedDefaultOpen = useMemo(() => advancedCollapseKeys(requestedSection), [requestedSection]);

    useLayoutEffect(() => {
        document.body.classList.add("app-user-overlays");
        return () => document.body.classList.remove("app-user-overlays");
    }, []);

    useEffect(() => {
        // focus=r18 必须落在「常用」段（R18SettingsPane 挂载处）
        if (searchParams.get("focus") === "r18") {
            setActiveTab("common");
            return;
        }
        setActiveTab(resolveSettingsSection(requestedSection));
    }, [requestedSection, searchParams]);

    const selectSection = (section: ConfigSectionKey) => {
        setActiveTab(section);
        const next = new URLSearchParams(searchParams);
        next.set("section", section);
        setSearchParams(next, { replace: true });
    };

    const finishConfig = () => {
        const invalidChannel = customChannelsEnabled ? userChannels.find((channel) => channelValidationError(channel)) : undefined;
        if (invalidChannel) {
            selectSection("advanced");
            message.warning(`${invalidChannel.name || "未命名渠道"}：${channelValidationError(invalidChannel)}`);
            focusInvalidChannelField(invalidChannel);
            return;
        }
        if (!effectiveConfig.channels.some(isChannelReady)) {
            selectSection("compute");
            message.error(customChannelsEnabled ? (shouldPromptContinue ? "请先完成至少一个渠道的 Base URL、API Key 和模型配置" : "当前没有可用渠道，请先完成连接信息和模型配置") : "当前没有可用的系统模型，请联系管理员配置系统渠道");
            return;
        }
        message.success("配置已保存，正在返回创作页面");
        navigate(-1);
    };

    const panes: Record<ConfigSectionKey, ReactNode> = {
        common: (
            <SettingsPane>
                <div className="settings-pane-header">
                    <div className="min-w-0">
                        <h2>常用</h2>
                        <p>逐槽自选底模；出图 / 视频可挂 LoRA。快捷示例可折叠预填，不保证最优。</p>
                    </div>
                </div>
                <div className="settings-common-stack">
                    <section className="settings-section" data-testid="settings-common-compute">
                        <p className="settings-block-label">算力</p>
                        <div className="settings-compute-strip-wrap">
                            <ComputeStatusStrip variant="compact" hideLink />
                        </div>
                    </section>
                    <section className="settings-section">
                        <p className="settings-block-label">角色槽</p>
                        <div className="settings-slot-surface">
                            <ModelSlotTable
                                key={`slots-${slotEpoch}`}
                                config={effectiveConfig}
                                onChange={(key, model) => updateConfig(key, model)}
                                onOpenChannels={customChannelsEnabled ? () => selectSection("advanced") : () => selectSection("compute")}
                                onOpenCompute={() => selectSection("compute")}
                            />
                        </div>
                    </section>
                    <ModelMixPresetsBar onApplied={() => setSlotEpoch((n) => n + 1)} />
                    <LlmMutexBanner config={effectiveConfig} />
                    <SettingsModelInventory
                        config={effectiveConfig}
                        onChange={(key, model) => updateConfig(key, model)}
                        onOpenCompute={() => selectSection("compute")}
                    />
                    <section className="settings-section" data-testid="settings-content-mode-note">
                        <p className="settings-block-label">内容模式说明</p>
                        <R18SettingsPane />
                    </section>
                </div>
            </SettingsPane>
        ),
        compute: (
            <SettingsPane>
                <LocalComputePane onBackToCommon={() => selectSection("common")} />
            </SettingsPane>
        ),
        advanced: (
            <SettingsPane>
                <div className="settings-pane-header">
                    <div className="min-w-0">
                        <h2>高级</h2>
                        <p>渠道 / 云端 / Prompt / 诊断 — 默认收起。</p>
                    </div>
                </div>
                <div className="settings-advanced-stack">
                <Collapse
                    key={`advanced:${advancedDefaultOpen.join(",") || "none"}`}
                    className="settings-advanced-collapse"
                    bordered={false}
                    defaultActiveKey={advancedDefaultOpen}
                    items={[
                        {
                            key: "channels",
                            label: <span className="text-sm font-semibold">自定义渠道</span>,
                            children: (
                                <ChannelSettingsPane
                                    onOpenModels={() => selectSection("common")}
                                    onOpenRunningHub={() => {
                                        const next = new URLSearchParams(searchParams);
                                        next.set("section", "runninghub");
                                        setSearchParams(next, { replace: true });
                                    }}
                                />
                            ),
                        },
                        {
                            key: "runninghub",
                            label: <span className="text-sm font-semibold">云端可选 / RunningHub</span>,
                            children: <RunningHubSettingsPane />,
                        },
                        {
                            key: "prompts",
                            label: <span className="text-sm font-semibold">Prompt 偏好</span>,
                            children: <PromptPreferencesPane />,
                        },
                        {
                            key: "diagnostics",
                            label: <span className="text-sm font-semibold">诊断</span>,
                            children: <DiagnosticsPanel taskId={diagnosticTaskId} projectId={diagnosticProjectId} />,
                        },
                    ]}
                />
                </div>
            </SettingsPane>
        ),
    };

    return (
        <main className="settings-page fz-desk app-workspace-page app-user-workspace app-section-page flex h-full min-h-0 flex-col text-foreground">
            {shouldPromptContinue ? (
                <div className="settings-topbar shrink-0">
                    <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
                        <Button icon={<ArrowLeft className="size-4" />} onClick={() => navigate(-1)}>返回创作</Button>
                        <Button type="primary" onClick={finishConfig}>保存并返回</Button>
                    </div>
                </div>
            ) : null}
            <div className="settings-library-frame flex min-h-0 flex-1 flex-col md:flex-row">
                <section className="settings-content flex min-h-0 min-w-0 flex-1 flex-col">
                    <div className="app-workspace-scroll app-section-page-content min-h-0 flex-1 overflow-y-auto overscroll-contain">
                        <div className="settings-pane-root mx-auto w-full max-w-none">
                            <div className="mb-4 flex flex-wrap items-center justify-between gap-3" data-testid="settings-section-nav">
                                <SegmentedControl
                                    ariaLabel="设置分区"
                                    block
                                    value={activeTab}
                                    onChange={(value) => selectSection(value)}
                                    options={configSections.map((section) => ({
                                        value: section.key,
                                        label: section.label,
                                        title: section.description,
                                        icon: section.icon,
                                    }))}
                                />
                            </div>
                            {panes[activeTab]}
                        </div>
                    </div>
                </section>
            </div>
        </main>
    );
}

function SettingsPane({ children, fill = false }: { children: ReactNode; fill?: boolean }) {
    return <div className={fill ? "settings-pane h-full" : "settings-pane"}>{children}</div>;
}
