/**
 * Wave P3 残余：节点设置内切换本地引擎/预设（一级菜单保持创作语义）。
 */
import { localImageEnginePresets, localVideoEnginePresets, type LocalCreatePreset } from "@/services/toiv/local-capability-surface";
import type { CanvasTheme } from "@/lib/canvas-theme";

type LocalEnginePresetPanelProps = {
    kind: "image" | "video";
    modelRef?: string | null;
    onSelect: (preset: LocalCreatePreset) => void;
    theme: CanvasTheme;
};

export function LocalEnginePresetPanel({ kind, modelRef, onSelect, theme }: LocalEnginePresetPanelProps) {
    const presets = kind === "video" ? localVideoEnginePresets() : localImageEnginePresets();
    const current = String(modelRef || "");
    return (
        <div className="space-y-1.5" data-testid="local-engine-preset-panel" onMouseDown={(event) => event.stopPropagation()}>
            <div className="text-xs font-semibold" style={{ color: theme.node.text }}>
                {kind === "video" ? "引擎预设" : "出图预设"}
            </div>
            <p className="text-[10px] leading-4" style={{ color: theme.node.muted }}>
                创作类型在添加菜单；此处切换本地引擎，不改一级语义。
            </p>
            <div className="grid grid-cols-2 gap-1.5">
                {presets.map((preset) => {
                    const selected = current === preset.modelRef || current.endsWith(`::${preset.modelRef.split("::")[1] || ""}`);
                    return (
                        <button
                            key={preset.id}
                            type="button"
                            aria-pressed={selected}
                            title={preset.label}
                            className="flex h-8 items-center justify-center rounded-md px-2 text-[11px] font-medium transition hover:brightness-110 focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1"
                            style={{
                                background: selected ? theme.toolbar.activeBg : "transparent",
                                color: theme.node.text,
                                outlineColor: theme.node.muted,
                                border: `1px solid ${selected ? theme.accent.primary : theme.node.stroke}`,
                            }}
                            onClick={() => onSelect(preset)}
                        >
                            {preset.label}
                        </button>
                    );
                })}
            </div>
        </div>
    );
}
