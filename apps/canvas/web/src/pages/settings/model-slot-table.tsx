import { AudioLines, Bot, Eye, Film, Image, MessageSquareText, Mic2 } from "lucide-react";
import { Button } from "antd";
import { useMemo, useState, type ReactNode } from "react";

import { Select } from "@/components/ui/base/select";
import { assistantModelOptions, normalizeAssistantModel } from "@/lib/assistant-model";
import {
    isMotionVideoModelRef,
    isPrimaryVideoModelRef,
    LOCAL_TTS_PRODUCT_HINT,
    LOCAL_TTS_PRODUCT_LABEL,
    LOCAL_VLM_PRODUCT_HINT,
    LOCAL_VLM_PRODUCT_LABEL,
    readMotionModel,
    writeActivePresetId,
    writeMotionModel,
} from "@/lib/model-mix-presets";
import { LOCAL_AUDIO_HAS_SENSEVOICE, LOCAL_AUDIO_UNAVAILABLE_LABEL } from "@/lib/local-model-defaults";
import {
    filterModelsByCapability,
    modelDisplayName,
    resolveModelChannel,
    type AiConfig,
} from "@/stores/use-config-store";
import { workspaceCapabilities } from "@/services/workspace-mode";
import { SlotLoraRow } from "./slot-lora-row";
import {
    baseInventoryFooter,
    baseInventoryMeta,
    mergeSlotOptionsWithBaseInventory,
} from "@/lib/base-inventory";

export type SlotModelKey = "imageModel" | "videoModel" | "textModel" | "assistantModel";

type Props = {
    config: AiConfig;
    onChange: (key: SlotModelKey, model: string) => void;
    onMotionChange?: (model: string) => void;
    onOpenChannels?: () => void;
    onOpenCompute?: () => void;
};

/** 用户手改任一槽后，清掉「快捷示例」高亮——主控是自选，不是配方。 */
function markManualMix() {
    writeActivePresetId(null);
}

export function ModelSlotTable({ config, onChange, onMotionChange, onOpenChannels, onOpenCompute }: Props) {
    const localMode = workspaceCapabilities().local;
    const assistantModel = normalizeAssistantModel(config, config.assistantModel);
    const assistantOptions = assistantModelOptions(config);
    const followsDefaultText = config.textModel ? modelDisplayName(config, config.textModel) : "尚未选择对话模型";
    const [motionSelected, setMotionSelected] = useState(() => readMotionModel(""));

    const textModels = useMemo(() => filterModelsByCapability(config.models, "text", config.channels), [config]);
    const imageModels = useMemo(() => filterModelsByCapability(config.models, "image", config.channels), [config]);
    const videoModels = useMemo(() => filterModelsByCapability(config.models, "video", config.channels), [config]);
    const primaryVideoModels = useMemo(() => {
        const list = videoModels.filter((m) => isPrimaryVideoModelRef(config, m));
        if (config.videoModel && isPrimaryVideoModelRef(config, config.videoModel) && !list.includes(config.videoModel)) {
            return [config.videoModel, ...list];
        }
        return list;
    }, [config, videoModels]);
    const motionVideoModels = useMemo(() => {
        const list = videoModels.filter((m) => isMotionVideoModelRef(config, m));
        if (motionSelected && isMotionVideoModelRef(config, motionSelected) && !list.includes(motionSelected)) {
            return [motionSelected, ...list];
        }
        return list;
    }, [config, videoModels, motionSelected]);

    const textOptions = toSelectOptions(config, textModels);
    const imageOptions = useMemo(
        () => (localMode ? mergeSlotOptionsWithBaseInventory(toSelectOptions(config, imageModels), "image") : toSelectOptions(config, imageModels)),
        [config, imageModels, localMode],
    );
    const primaryVideoOptions = useMemo(
        () => (localMode ? mergeSlotOptionsWithBaseInventory(toSelectOptions(config, primaryVideoModels), "video-primary") : toSelectOptions(config, primaryVideoModels)),
        [config, primaryVideoModels, localMode],
    );
    const motionOptions = useMemo(
        () => (localMode ? mergeSlotOptionsWithBaseInventory(toSelectOptions(config, motionVideoModels), "video-motion") : toSelectOptions(config, motionVideoModels)),
        [config, motionVideoModels, localMode],
    );
    const baseInvNote = localMode ? baseInventoryFooter() : "";
    const baseInvLive = localMode ? baseInventoryMeta().live : true;
    const assistantSelectOptions = [
        { value: "__follow__", label: `跟随对话 / 剧本（${followsDefaultText}）` },
        ...assistantOptions.map((model) => ({
            value: model,
            label: `${modelDisplayName(config, model)} · ${resolveModelChannel(config, model).name || "未命名渠道"}`,
        })),
    ];

    return (
        <div className="settings-slot-table" data-testid="model-slot-table">
            {localMode ? (
                <p className="mb-2 text-[11px] leading-relaxed text-foreground/45" data-testid="base-inventory-footer" title={baseInvLive ? "实时 NAS" : "非实时 NAS 种子"}>
                    {baseInvNote}
                    {baseInvLive ? "" : " · 选中后 LoRA 按族过滤；换权重仍建议在「模型与算力」绑定"}
                </p>
            ) : null}

            <SlotRow
                id="llm"
                title="对话 / 剧本"
                icon={MessageSquareText}
                helper="剧本 / Agent / 画布对话"
            >
                <SlotSelect
                    ariaLabel="对话 / 剧本"
                    value={config.textModel || undefined}
                    options={textOptions}
                    empty={localMode ? "暂无候选 — 去「模型与算力」或渠道配置对话模型" : "暂无对话候选"}
                    onOpenEmpty={onOpenChannels}
                    onChange={(m) => {
                        markManualMix();
                        onChange("textModel", m);
                    }}
                />
            </SlotRow>

            <SlotRow id="assistant" title="助手" icon={Bot} helper="可跟随对话槽">
                <Select
                    ariaLabel="助手"
                    size="md"
                    allowClear={false}
                    value={config.assistantModel ? assistantModel || config.assistantModel : "__follow__"}
                    options={assistantSelectOptions}
                    onChange={(v) => {
                        markManualMix();
                        onChange("assistantModel", v === "__follow__" ? "" : v);
                    }}
                    className="w-full max-w-xl"
                />
                {config.assistantModel && !assistantModel ? (
                    <p role="status" className="mt-1 text-xs text-foreground/50">
                        已选模型不可用，请重新选择
                    </p>
                ) : null}
            </SlotRow>

            <ReadonlySlot
                id="vlm"
                title="识图 VLM"
                icon={Eye}
                value={LOCAL_VLM_PRODUCT_LABEL}
                hint="系统绑定 · 只读"
            />

            <SlotRow id="image" title="出图" icon={Image} helper="设定卡 / 分镜参考">
                <SlotSelect
                    ariaLabel="出图"
                    value={config.imageModel || undefined}
                    options={imageOptions}
                    empty={localMode ? "暂无候选 — 去「模型与算力」绑定出图" : "暂无出图候选"}
                    onOpenEmpty={onOpenCompute || onOpenChannels}
                    onChange={(m) => {
                        markManualMix();
                        onChange("imageModel", m);
                    }}
                />
                <SlotLoraRow
                    slot="image"
                    baseLabel={config.imageModel ? modelDisplayName(config, config.imageModel) : undefined}
                    baseHint={config.imageModel || undefined}
                />
            </SlotRow>

            <SlotRow
                id="video-primary"
                title="出视频 · 主（H3）"
                icon={Film}
                helper="短剧默认视频"
            >
                <SlotSelect
                    ariaLabel="出视频 · 主（H3）"
                    value={config.videoModel && isPrimaryVideoModelRef(config, config.videoModel) ? config.videoModel : undefined}
                    options={primaryVideoOptions}
                    empty={localMode ? "暂无候选 — 去「模型与算力」绑定 H3" : "暂无 H3 视频候选"}
                    onOpenEmpty={onOpenCompute || onOpenChannels}
                    onChange={(m) => {
                        markManualMix();
                        onChange("videoModel", m);
                    }}
                />
                <SlotLoraRow
                    slot="video-primary"
                    baseLabel={
                        config.videoModel && isPrimaryVideoModelRef(config, config.videoModel)
                            ? modelDisplayName(config, config.videoModel)
                            : undefined
                    }
                    baseHint={
                        config.videoModel && isPrimaryVideoModelRef(config, config.videoModel)
                            ? config.videoModel
                            : undefined
                    }
                />
            </SlotRow>

            <SlotRow
                id="video-motion"
                title="出视频 · 运动"
                icon={Film}
                helper="Wan / LongCat / Animate"
            >
                <SlotSelect
                    ariaLabel="出视频 · 运动"
                    value={motionSelected || undefined}
                    options={motionOptions}
                    empty={localMode ? "暂无候选 — 去「模型与算力」或渠道配置运动引擎" : "暂无运动视频候选"}
                    onOpenEmpty={onOpenCompute || onOpenChannels}
                    allowClear
                    onChange={(m) => {
                        markManualMix();
                        writeMotionModel(m);
                        setMotionSelected(m);
                        onMotionChange?.(m);
                    }}
                    onClear={() => {
                        markManualMix();
                        writeMotionModel("");
                        setMotionSelected("");
                        onMotionChange?.("");
                    }}
                />
                <SlotLoraRow
                    slot="video-motion"
                    baseLabel={motionSelected ? modelDisplayName(config, motionSelected) : undefined}
                    baseHint={motionSelected || undefined}
                />
            </SlotRow>

            <ReadonlySlot
                id="tts"
                title="配音"
                icon={Mic2}
                value={LOCAL_TTS_PRODUCT_LABEL}
                hint="系统绑定 · 只读"
            />

            {localMode && !LOCAL_AUDIO_HAS_SENSEVOICE ? (
                <div
                    className="settings-slot-row border-0 px-1 py-3 text-xs text-foreground/50"
                    role="status"
                    data-testid="audio-unavailable-notice"
                >
                    <span className="inline-flex items-center gap-2 font-medium text-foreground/80">
                        <AudioLines className="size-3.5" />
                        {LOCAL_AUDIO_UNAVAILABLE_LABEL}
                    </span>
                    <p className="mt-1 leading-relaxed">SenseVoice 未接线；配音请用上方 IndexTTS 系统槽，勿把云端音频渠道当成本地已配置。</p>
                </div>
            ) : null}
        </div>
    );
}

function toSelectOptions(config: AiConfig, models: string[]) {
    return models.map((model) => ({
        value: model,
        label: `${modelDisplayName(config, model)} · ${resolveModelChannel(config, model).name || "未命名渠道"}`,
        title: model,
    }));
}

function SlotSelect({
    ariaLabel,
    value,
    options,
    empty,
    onOpenEmpty,
    onChange,
    allowClear,
    onClear,
}: {
    ariaLabel: string;
    value?: string;
    options: Array<{ value: string; label: string; title?: string }>;
    empty: string;
    onOpenEmpty?: () => void;
    onChange: (model: string) => void;
    allowClear?: boolean;
    onClear?: () => void;
}) {
    if (!options.length) {
        return (
            <div className="rounded-md border border-dashed border-border/60 px-3 py-2.5 text-xs text-foreground/50" data-testid="slot-empty">
                <p>{empty}</p>
                {onOpenEmpty ? (
                    <Button type="link" size="small" className="mt-1 h-auto p-0 text-xs" onClick={onOpenEmpty}>
                        前往模型与算力 / 渠道
                    </Button>
                ) : null}
            </div>
        );
    }
    return (
        <Select
            ariaLabel={ariaLabel}
            size="md"
            allowClear={Boolean(allowClear)}
            placeholder="从候选里自选"
            value={value}
            options={options}
            className="w-full max-w-xl"
            onChange={(v) => {
                if (!v) {
                    onClear?.();
                    return;
                }
                onChange(v);
            }}
        />
    );
}

function SlotRow({
    id,
    title,
    icon: Icon,
    helper,
    children,
}: {
    id: string;
    title: string;
    icon: typeof Image;
    helper?: string;
    children: ReactNode;
}) {
    return (
        <section className="settings-slot-row" aria-labelledby={`slot-${id}-title`} data-slot={id}>
            <div className="settings-slot-row__meta">
                <span className="settings-slot-row__icon" aria-hidden>
                    <Icon className="size-3.5" />
                </span>
                <div className="min-w-0">
                    <h3 id={`slot-${id}-title`} className="settings-slot-row__title">
                        {title}
                    </h3>
                    {helper ? <p className="settings-slot-row__hint">{helper}</p> : null}
                </div>
            </div>
            <div className="settings-slot-row__body">{children}</div>
        </section>
    );
}

function ReadonlySlot({
    id,
    title,
    icon: Icon,
    value,
    hint,
}: {
    id: string;
    title: string;
    icon: typeof Image;
    value: string;
    hint: string;
}) {
    return (
        <section className="settings-slot-row" aria-labelledby={`slot-${id}-title`} data-slot={id} data-testid={`slot-readonly-${id}`}>
            <div className="settings-slot-row__meta">
                <span className="settings-slot-row__icon" aria-hidden>
                    <Icon className="size-3.5" />
                </span>
                <div className="min-w-0">
                    <h3 id={`slot-${id}-title`} className="settings-slot-row__title">
                        {title}
                    </h3>
                    <p className="settings-slot-row__hint">{hint}</p>
                </div>
            </div>
            <div className="settings-slot-row__body">
                <div className="rounded-lg border border-border/50 bg-surface-secondary/25 px-3 py-2 text-xs">
                    <div className="font-medium text-foreground/85">{value}</div>
                    <div className="mt-0.5 text-foreground/40">只读</div>
                </div>
            </div>
        </section>
    );
}
