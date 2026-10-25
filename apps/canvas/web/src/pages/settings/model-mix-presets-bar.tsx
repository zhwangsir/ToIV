import { App, Collapse, Modal } from "antd";
import { useEffect, useState } from "react";

import {
    MODEL_MIX_PRESETS,
    applyMixPatchToConfig,
    applyPresetLoraPins,
    patchForPreset,
    readActivePresetId,
    type ModelMixPresetId,
    writeActivePresetId,
    writeMotionModel,
} from "@/lib/model-mix-presets";
import { useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";
import { cn } from "@/lib/utils";

/** 次要：快捷示例预填。主控是角色槽自选，不保证最优。 */
export function ModelMixPresetsBar({ onApplied }: { onApplied?: () => void } = {}) {
    const { message } = App.useApp();
    const effectiveConfig = useEffectiveConfig();
    const replaceConfig = useConfigStore((s) => s.replaceConfig);
    const [active, setActive] = useState<ModelMixPresetId | null>(() => readActivePresetId());

    useEffect(() => {
        setActive(readActivePresetId());
    }, []);

    const apply = (id: ModelMixPresetId) => {
        const preset = MODEL_MIX_PRESETS.find((p) => p.id === id);
        if (!preset) return;
        Modal.confirm({
            title: `预填快捷示例：${preset.label}`,
            content: preset.confirmBody,
            okText: "预填（仍可改）",
            cancelText: "取消",
            onOk: () => {
                const patch = patchForPreset(id);
                const next = applyMixPatchToConfig(effectiveConfig, patch);
                replaceConfig(next);
                writeMotionModel(patch.motionModel);
                writeActivePresetId(id);
                const pins = applyPresetLoraPins(id);
                setActive(id);
                onApplied?.();
                const pinN = pins.image.length + pins.videoPrimary.length + pins.motion.length;
                message.success(
                    pinN
                        ? `已预填「${preset.label}」及 ${pinN} 个图谱 LoRA（含强度/触发，可再改）`
                        : `已预填「${preset.label}」，可继续逐槽修改`,
                );
            },
        });
    };

    return (
        <section className="settings-section settings-secondary-card" data-testid="model-mix-presets-bar" aria-label="快捷示例">
            <Collapse
                ghost
                size="small"
                defaultActiveKey={[]}
                items={[
                    {
                        key: "examples",
                        label: (
                            <span className="text-xs font-medium text-foreground/55">
                                快捷示例 · 可改 · 非最优
                            </span>
                        ),
                        children: (
                            <div>
                                <p className="mb-2 text-[11px] text-foreground/45">
                                    一点预填槽位；真正搭配请在上方逐行自选。
                                </p>
                                <div className="flex flex-wrap gap-2" role="group" aria-label="快捷示例芯片">
                                    {MODEL_MIX_PRESETS.map((preset) => {
                                        const selected = active === preset.id;
                                        return (
                                            <button
                                                key={preset.id}
                                                type="button"
                                                data-testid={`mix-preset-${preset.id}`}
                                                aria-pressed={selected}
                                                title={preset.confirmBody}
                                                className={cn(
                                                    "rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
                                                    selected
                                                        ? "border-border bg-surface-secondary/60 text-foreground/80"
                                                        : "border-border/60 bg-background/40 text-foreground/65 hover:border-border hover:bg-surface-secondary/30",
                                                )}
                                                onClick={() => apply(preset.id)}
                                            >
                                                {preset.label}
                                                <span className="ml-1.5 text-foreground/40">{preset.hint}</span>
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>
                        ),
                    },
                ]}
            />
        </section>
    );
}
