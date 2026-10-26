/**
 * R10 — Vercel-minimal model inventory: list + drawer form (not a full-page wall).
 * NSFW: gray + lock in ordinary; content_mode main switch stays on topbar Light Curtain only.
 */
import { useMemo, useState, useSyncExternalStore } from "react";
import { Bot, ChevronRight, Film, Image as ImageIcon, MessageSquareText, Server } from "lucide-react";

import { AppDrawer } from "@/components/ui/product/app-drawer";
import { NsfwLockBadge } from "@/components/toiv/nsfw-lock-badge";
import { ToivEmptyState } from "@/components/toiv/toiv-empty-state";
import { cn } from "@/lib/utils";
import {
    COPY_MODE_ADULT,
    COPY_MODE_NORMAL,
    COPY_NSFW_LOCK_LABEL,
    getR18ModeSnapshot,
    getServerR18ModeSnapshot,
    isNsfwAssetListable,
    isNsfwAssetSelectable,
    subscribeR18Mode,
    assetLooksNsfw,
} from "@/redline";
import {
    filterModelsByCapability,
    modelDisplayName,
    resolveModelChannel,
    type AiConfig,
    type ModelCapability,
} from "@/stores/use-config-store";

import "./settings-model-inventory.css";

type DefaultKey = "imageModel" | "videoModel" | "textModel" | "assistantModel";

type InventoryRow = {
    id: string;
    capability: ModelCapability | "assistant";
    label: string;
    channelName: string;
    nsfw: boolean;
    locked: boolean;
    defaults: string[];
};

const CAP_ICON = {
    image: ImageIcon,
    video: Film,
    text: MessageSquareText,
    audio: Server,
    assistant: Bot,
} as const;

function capabilityOf(config: AiConfig, model: string): ModelCapability | "assistant" {
    if (model === config.assistantModel) return "assistant";
    for (const cap of ["image", "video", "text", "audio"] as ModelCapability[]) {
        if (filterModelsByCapability([model], cap, config.channels).length) return cap;
    }
    return "text";
}

function defaultLabels(config: AiConfig, model: string): string[] {
    const tags: string[] = [];
    if (config.imageModel === model) tags.push("默认出图");
    if (config.videoModel === model) tags.push("默认视频");
    if (config.textModel === model) tags.push("默认文本");
    if (config.assistantModel === model) tags.push("助手");
    return tags;
}

export function SettingsModelInventory({
    config,
    onChange,
    onOpenCompute,
}: {
    config: AiConfig;
    onChange: (key: DefaultKey, model: string) => void;
    onOpenCompute?: () => void;
}) {
    const adultOn = useSyncExternalStore(subscribeR18Mode, getR18ModeSnapshot, getServerR18ModeSnapshot);
    const [activeId, setActiveId] = useState<string | null>(null);

    const rows = useMemo(() => {
        const seen = new Set<string>();
        const out: InventoryRow[] = [];
        for (const model of config.models || []) {
            const id = String(model || "").trim();
            if (!id || seen.has(id)) continue;
            if (!isNsfwAssetListable(id)) continue; // unknown hidden in ordinary — server/redline rule
            seen.add(id);
            const nsfw = assetLooksNsfw(id);
            const locked = nsfw && !isNsfwAssetSelectable(id);
            out.push({
                id,
                capability: capabilityOf(config, id),
                label: modelDisplayName(config, id),
                channelName: resolveModelChannel(config, id).name || "未命名渠道",
                nsfw,
                locked,
                defaults: defaultLabels(config, id),
            });
        }
        return out.sort((a, b) => a.label.localeCompare(b.label, "zh"));
    }, [config, adultOn]);

    const active = rows.find((r) => r.id === activeId) || null;

    const setDefault = (key: DefaultKey) => {
        if (!active || active.locked) return;
        onChange(key, active.id);
    };

    return (
        <section className="toiv-model-inventory settings-section" data-testid="settings-model-inventory">
            <div className="toiv-model-inventory-head">
                <div>
                    <h3>模型清单</h3>
                    <p>
                        列表点开抽屉设默认基座 · 当前内容模式：{adultOn ? COPY_MODE_ADULT : COPY_MODE_NORMAL}
                        （主切换在顶栏光幕，本页无开关）
                    </p>
                </div>
            </div>

            {rows.length === 0 ? (
                <ToivEmptyState
                    compact
                    title="还没有可列出的模型"
                    description="先在「模型与算力」绑定权重，或到高级渠道添加模型。"
                    action={
                        onOpenCompute ? (
                            <button type="button" className="toiv-empty-cta" onClick={onOpenCompute}>
                                打开模型与算力
                            </button>
                        ) : null
                    }
                />
            ) : (
                <div className="toiv-model-inventory-list" role="list">
                    {rows.map((row) => {
                        const Icon = CAP_ICON[row.capability] || Server;
                        return (
                            <button
                                key={row.id}
                                type="button"
                                role="listitem"
                                className={cn("toiv-model-row", row.locked && "is-nsfw-locked")}
                                onClick={() => setActiveId(row.id)}
                                aria-label={`${row.label}${row.locked ? ` · ${COPY_NSFW_LOCK_LABEL}` : ""}`}
                            >
                                <span className="toiv-model-row-icon" aria-hidden>
                                    <Icon />
                                </span>
                                <span className="toiv-model-row-main">
                                    <p className="toiv-model-row-title">{row.label}</p>
                                    <p className="toiv-model-row-meta">
                                        {row.channelName}
                                        <span className="mx-1 opacity-40">·</span>
                                        {row.capability}
                                    </p>
                                </span>
                                <span className="toiv-model-row-side">
                                    {row.defaults[0] ? <span className="toiv-model-chip">{row.defaults[0]}</span> : null}
                                    {row.locked ? <NsfwLockBadge compact /> : null}
                                    <ChevronRight className="size-3.5 opacity-40" aria-hidden />
                                </span>
                            </button>
                        );
                    })}
                </div>
            )}

            <AppDrawer
                open={Boolean(active)}
                onClose={() => setActiveId(null)}
                title={active?.label || "模型"}
                width="var(--toiv-settings-drawer-w, 420px)"
                rootClassName="toiv-model-drawer"
                destroyOnHidden
            >
                {active ? (
                    <>
                        <div className="toiv-model-drawer-block">
                            <h4>渠道</h4>
                            <p className="toiv-model-drawer-note">{active.channelName}</p>
                            <p className="toiv-model-drawer-note" style={{ wordBreak: "break-all" }}>
                                {active.id}
                            </p>
                        </div>
                        <div className="toiv-model-drawer-block">
                            <h4>设为默认基座</h4>
                            {active.locked ? (
                                <p className="toiv-model-drawer-note">
                                    当前为{COPY_MODE_NORMAL}：该模型已锁定（{COPY_NSFW_LOCK_LABEL}）。请到顶栏光幕切换到「{COPY_MODE_ADULT}」后再设默认。
                                </p>
                            ) : (
                                <div className="toiv-model-drawer-actions">
                                    <button type="button" className="is-primary" onClick={() => setDefault("imageModel")}>
                                        设为默认出图
                                    </button>
                                    <button type="button" onClick={() => setDefault("videoModel")}>
                                        设为默认视频
                                    </button>
                                    <button type="button" onClick={() => setDefault("textModel")}>
                                        设为默认文本
                                    </button>
                                    <button type="button" onClick={() => setDefault("assistantModel")}>
                                        设为助手模型
                                    </button>
                                </div>
                            )}
                        </div>
                        <p className="toiv-model-drawer-note">
                            角色槽精细选择仍在上方「角色槽」表。本抽屉只改默认基座，不提供内容模式主开关。
                        </p>
                    </>
                ) : null}
            </AppDrawer>
        </section>
    );
}
