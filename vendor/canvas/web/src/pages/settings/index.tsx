import { App, Button, Collapse } from "antd";
import { ArrowLeft, Boxes, Cpu, HardDrive, Info, Settings2 } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";

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

/** Product IA (R10补 TL): 模型｜引擎｜存储｜通用｜关于. Legacy aliases in resolveSettingsSection. */
export type ConfigSectionKey = "models" | "engines" | "storage" | "general" | "about";

const configSections: Array<{ key: ConfigSectionKey; label: string; description: string; icon: ReactNode }> = [
    { key: "models", label: "模型", description: "清单、默认基座与角色槽", icon: <Boxes className="size-4" /> },
    { key: "engines", label: "引擎", description: "库存与 NAS 换权重", icon: <Cpu className="size-4" /> },
    { key: "storage", label: "存储", description: "素材库与占用", icon: <HardDrive className="size-4" /> },
    { key: "general", label: "通用", description: "渠道、云端、Prompt 与内容模式说明", icon: <Settings2 className="size-4" /> },
    { key: "about", label: "关于", description: "诊断与运行信息", icon: <Info className="size-4" /> },
];

const LEGACY_SECTION_MAP: Record<string, ConfigSectionKey> = {
    common: "models",
    compute: "engines",
    advanced: "general",
    channels: "general",
    models: "models",
    runninghub: "general",
    diagnostics: "about",
    prompts: "general",
    preferences: "general",
    storage: "storage",
    engines: "engines",
    general: "general",
    about: "about",
};

export function resolveSettingsSection(value: string | null): ConfigSectionKey {
    if (!value) return "models";
    if (value === "models" || value === "engines" || value === "storage" || value === "general" || value === "about") return value;
    return LEGACY_SECTION_MAP[value] || "models";
}

export function isConfigSection(value: string | null): value is ConfigSectionKey {
    return value === "models" || value === "engines" || value === "storage" || value === "general" || value === "about";
}

function generalCollapseKeys(requested: string | null): string[] {
    if (requested === "runninghub") return ["runninghub"];
    if (requested === "prompts" || requested === "preferences") return ["prompts"];
    if (requested === "channels" || requested === "advanced") return ["channels"];
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

    const generalDefaultOpen = useMemo(() => generalCollapseKeys(requestedSection), [requestedSection]);

    useLayoutEffect(() => {
        document.body.classList.add("app-user-overlays");
        return () => document.body.classList.remove("app-user-overlays");
    }, []);

    useEffect(() => {
        // focus=r18 落在「通用」（R18SettingsPane 挂载处；无主开关）
        if (searchParams.get("focus") === "r18") {
            setActiveTab("general");
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
            selectSection("general");
            message.warning(`${invalidChannel.name || "未命名渠道"}：${channelValidationError(invalidChannel)}`);
            focusInvalidChannelField(invalidChannel);
            return;
        }
        if (!effectiveConfig.channels.some(isChannelReady)) {
            selectSection("engines");
            message.error(customChannelsEnabled ? (shouldPromptContinue ? "请先完成至少一个渠道的 Base URL、API Key 和模型配置" : "当前没有可用渠道，请先完成连接信息和模型配置") : "当前没有可用的系统模型，请联系管理员配置系统渠道");
            return;
        }
        message.success("配置已保存，正在返回创作页面");
        navigate(-1);
    };

    const panes: Record<ConfigSectionKey, ReactNode> = {
        models: (
            <SettingsPane>
                <div className="settings-pane-header">
                    <div className="min-w-0">
                        <h2>模型</h2>
                        <p>清单 + 抽屉设默认基座；角色槽精细选择。内容模式主开关只在顶栏光幕。</p>
                    </div>
                </div>
                <div className="settings-common-stack">
                    <section className="settings-section">
                        <p className="settings-block-label">角色槽</p>
                        <div className="settings-slot-surface">
                            <ModelSlotTable
                                key={`slots-${slotEpoch}`}
                                config={effectiveConfig}
                                onChange={(key, model) => updateConfig(key, model)}
                                onOpenChannels={customChannelsEnabled ? () => selectSection("general") : () => selectSection("engines")}
                                onOpenCompute={() => selectSection("engines")}
                            />
                        </div>
                    </section>
                    <ModelMixPresetsBar onApplied={() => setSlotEpoch((n) => n + 1)} />
                    <LlmMutexBanner config={effectiveConfig} />
                    <SettingsModelInventory
                        config={effectiveConfig}
                        onChange={(key, model) => updateConfig(key, model)}
                        onOpenCompute={() => selectSection("engines")}
                    />
                </div>
            </SettingsPane>
        ),
        engines: (
            <SettingsPane>
                <LocalComputePane onBackToCommon={() => selectSection("models")} />
            </SettingsPane>
        ),
        storage: (
            <SettingsPane>
                <div className="settings-pane-header">
                    <div className="min-w-0">
                        <h2>存储</h2>
                        <p>素材与占用概览；媒体库仍是正式素材入口（非第二创作壳）。</p>
                    </div>
                </div>
                <div className="settings-common-stack">
                    <section className="settings-section" data-testid="settings-storage-compute">
                        <p className="settings-block-label">算力与占用</p>
                        <div className="settings-compute-strip-wrap">
                            <ComputeStatusStrip variant="compact" hideLink />
                        </div>
                    </section>
                    <section className="settings-section" data-testid="settings-storage-library">
                        <p className="settings-block-label">媒体库</p>
                        <p className="settings-pane-header" style={{ marginBottom: 0 }}>
                            <span style={{ fontSize: 12, color: "color-mix(in srgb, var(--foreground) 55%, transparent)" }}>
                                管理本机素材、作品与回收站。不嵌旧页，不使用 iframe 第二壳。
                            </span>
                        </p>
                        <div style={{ marginTop: 12 }}>
                            <Link to="/library?source=materials" className="text-sm text-primary underline-offset-2 hover:underline">
                                打开媒体库
                            </Link>
                        </div>
                    </section>
                </div>
            </SettingsPane>
        ),
        general: (
            <SettingsPane>
                <div className="settings-pane-header">
                    <div className="min-w-0">
                        <h2>通用</h2>
                        <p>渠道 / 云端 / Prompt / 内容模式说明 — 主开关仍只在顶栏光幕。</p>
                    </div>
                </div>
                <div className="settings-advanced-stack">
                    <section className="settings-section" data-testid="settings-content-mode-note">
                        <p className="settings-block-label">内容模式说明</p>
                        <R18SettingsPane />
                    </section>
                    <Collapse
                        key={`general:${generalDefaultOpen.join(",") || "none"}`}
                        className="settings-advanced-collapse"
                        bordered={false}
                        defaultActiveKey={generalDefaultOpen}
                        items={[
                            {
                                key: "channels",
                                label: <span className="text-sm font-semibold">自定义渠道</span>,
                                children: (
                                    <ChannelSettingsPane
                                        onOpenModels={() => selectSection("models")}
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
                        ]}
                    />
                </div>
            </SettingsPane>
        ),
        about: (
            <SettingsPane>
                <div className="settings-pane-header">
                    <div className="min-w-0">
                        <h2>关于</h2>
                        <p>诊断与运行信息。</p>
                    </div>
                </div>
                <DiagnosticsPanel taskId={diagnosticTaskId} projectId={diagnosticProjectId} />
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
