import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Settings2 } from "lucide-react";
import { Button } from "antd";

import { VideoSettingsPanel, videoResolutionLabel, videoSecondsLabel, videoSizeLabel } from "@/components/video-settings-panel";
import { canvasThemes } from "@/lib/canvas-theme";
import { modelCapabilityConfigFor, resolveVideoRatioValue, resolveVideoResolutionValue } from "@/lib/model-capabilities";
import { useActiveTheme } from "@/stores/canvas/use-canvas-theme-store";
import type { AiConfig } from "@/stores/use-config-store";
import type { SeedanceSettingsConstraints } from "@/lib/seedance-task-constraints";
import { LocalEnginePresetPanel } from "@/components/canvas/local-engine-preset-panel";

type CanvasVideoSettingsPopoverProps = {
    taskConstraints?: SeedanceSettingsConstraints;
    config: AiConfig;
    onConfigChange: (key: keyof AiConfig, value: string) => void;
    buttonClassName?: string;
    placement?: "topLeft" | "top" | "topRight" | "bottomLeft" | "bottom" | "bottomRight";
    /** Wave P3 / G5：end=右侧停靠检视，减少盖住节点端口 */
    dock?: "anchor" | "end";
    summaryOverride?: string;
};

export function CanvasVideoSettingsPopover({ config, onConfigChange, buttonClassName, placement = "topLeft", dock = "end", summaryOverride, taskConstraints }: CanvasVideoSettingsPopoverProps) {
    const theme = canvasThemes[useActiveTheme()];
    const buttonRef = useRef<HTMLSpanElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const [open, setOpen] = useState(false);
    const [buttonRect, setButtonRect] = useState<DOMRect | null>(null);
    const videoProfile = modelCapabilityConfigFor(config, config.model).video;
    const resolutionSupported = Boolean(videoProfile?.resolutions.length);
    const sizeSupported = Boolean(videoProfile?.ratios.length);
    const resolution = videoProfile ? resolveVideoResolutionValue(videoProfile, config.vquality) : "";
    const size = videoProfile ? resolveVideoRatioValue(videoProfile, config.size) : "";
    const summary = [
        ...(resolutionSupported ? [videoResolutionLabel(resolution)] : []),
        ...(sizeSupported ? [taskConstraints?.ratioLabel || videoSizeLabel(size)] : []),
        taskConstraints?.durationLocked ? "随原视频时长" : videoSecondsLabel(config.videoSeconds),
    ].join(" · ");
    const displaySummary = summaryOverride || summary;

    useEffect(() => {
        if (!open) return;
        const syncPosition = () => setButtonRect(buttonRef.current?.getBoundingClientRect() || null);
        const closeOnOutsidePointer = (event: PointerEvent) => {
            const target = event.target;
            if (!(target instanceof Node)) return;
            if (buttonRef.current?.contains(target) || panelRef.current?.contains(target)) return;
            setOpen(false);
        };

        syncPosition();
        window.addEventListener("resize", syncPosition);
        window.addEventListener("scroll", syncPosition, true);
        window.addEventListener("pointerdown", closeOnOutsidePointer, true);
        return () => {
            window.removeEventListener("resize", syncPosition);
            window.removeEventListener("scroll", syncPosition, true);
            window.removeEventListener("pointerdown", closeOnOutsidePointer, true);
        };
    }, [open]);

    const panel = open && buttonRect ? <VideoSettingsPortal buttonRect={buttonRect} panelRef={panelRef} placement={placement} dock={dock} theme={theme} config={config} onConfigChange={onConfigChange} taskConstraints={taskConstraints} /> : null;

    return (
        <>
            <span ref={buttonRef} className="inline-flex min-w-0">
                <Button size="small" type="text" className={`canvas-generation-settings-trigger ${buttonClassName || "!h-8 !max-w-[170px] !justify-start !rounded-full !px-2.5"}`} style={{ background: theme.node.fill, color: theme.node.text }} icon={<Settings2 className="size-3.5" />} aria-expanded={open} aria-label={`高级设置：${displaySummary}`} title={`高级设置 · ${displaySummary}`} onClick={() => setOpen((current) => !current)}>
                    <span className="truncate">{displaySummary}</span>
                </Button>
            </span>
            {panel}
        </>
    );
}

function VideoSettingsPortal({
    buttonRect,
    panelRef,
    placement,
    dock = "end",
    theme,
    config,
    onConfigChange,
    taskConstraints,
}: {
    taskConstraints?: SeedanceSettingsConstraints;
    buttonRect: DOMRect;
    panelRef: RefObject<HTMLDivElement | null>;
    placement: CanvasVideoSettingsPopoverProps["placement"];
    dock?: "anchor" | "end";
    theme: (typeof canvasThemes)[keyof typeof canvasThemes];
    config: AiConfig;
    onConfigChange: (key: keyof AiConfig, value: string) => void;
}) {
    const gap = 8;
    const margin = 12;
    const width = Math.min(356, window.innerWidth - margin * 2);
    const alignRight = placement?.endsWith("Right");
    const alignCenter = placement === "top" || placement === "bottom";
    const left = alignCenter ? buttonRect.left + buttonRect.width / 2 - width / 2 : alignRight ? buttonRect.right - width : buttonRect.left;
    const topPlacement = placement?.startsWith("top");
    const estimatedHeight = 370;
    const topSpace = buttonRect.top - gap - margin;
    const bottomSpace = window.innerHeight - buttonRect.bottom - gap - margin;
    const placeAbove = topPlacement ? topSpace >= estimatedHeight || topSpace >= bottomSpace : bottomSpace < estimatedHeight && topSpace > bottomSpace;
    const docked = dock === "end";
    const style = {
        position: "fixed",
        zIndex: "var(--z-dialog-popover)",
        width: docked ? Math.min(360, window.innerWidth - margin * 2) : width,
        ...(docked
            ? { right: margin, top: Math.max(margin, 72), bottom: margin, left: "auto" as const, maxHeight: "none" as const }
            : {
                left: Math.max(margin, Math.min(window.innerWidth - width - margin, left)),
                ...(placeAbove ? { bottom: window.innerHeight - buttonRect.top + gap, maxHeight: Math.max(260, topSpace) } : { top: buttonRect.bottom + gap, maxHeight: Math.max(260, bottomSpace) }),
            }),
        background: theme.canvas.background,
        border: `1px solid ${theme.toolbar.border}`,
        borderRadius: 10,
        boxShadow: `0 24px 72px ${theme.spatial.shadow}`,
        padding: 12,
        overflowY: "auto",
        color: theme.node.text,
    } as const;

    return createPortal(
        <div
            ref={panelRef}
            className="canvas-image-settings-popover aceternity-floating-panel backdrop-blur-2xl"
            data-dock={dock}
            style={style}
            onPointerDown={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
        >
            <div className="mb-3 border-b pb-3" style={{ borderColor: theme.toolbar.border }}>
                <LocalEnginePresetPanel
                    kind="video"
                    modelRef={config.model || config.videoModel}
                    theme={theme}
                    onSelect={(preset) => onConfigChange("model", preset.modelRef)}
                />
            </div>
            <VideoSettingsPanel config={config} onConfigChange={(key, value) => onConfigChange(key, value)} theme={theme} className="space-y-3" taskConstraints={taskConstraints} />
        </div>,
        document.body,
    );
}
