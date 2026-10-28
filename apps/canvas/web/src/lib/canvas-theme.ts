export type CanvasColorTheme = "light" | "dark";
export type CanvasBackgroundMode = "dots" | "lines" | "blank";

/**
 * Canvas theme — R5 Freezone glass / accent select.
 * Selection + ports + edges use accent `#4A7FC1` (A6 `--toiv-accent`).
 * Adult curtain = neutral grey `#6B7280`; selection/playhead = accent `#4A7FC1`.
 */
export const canvasThemes = {
    light: {
        canvas: {
            background: "#f0f0f0",
            dot: "rgba(0,0,0,.80)",
            line: "rgba(0,0,0,.80)",
            selectionFill: "rgba(74,127,193,.12)",
        },
        node: {
            label: "#4b5563",
            agentUserMessage: "#edf6ff",
            fill: "#ffffff",
            panel: "#ffffff",
            stroke: "#e2e4e8",
            edge: "rgba(74,127,193,.28)",
            shadow: "0 6px 18px rgba(15,23,42,.08), inset 0 1px 0 rgba(255,255,255,.8)",
            hoverShadow: "0 10px 24px rgba(15,23,42,.12), 0 0 0 1px rgba(74,127,193,.28)",
            activeStroke: "#4A7FC1",
            placeholder: "#9ca3af",
            text: "#111827",
            muted: "#6b7280",
            faint: "#9ca3af",
        },
        frame: {
            fill: "rgba(17,24,39,.025)",
            stroke: "rgba(17,24,39,.18)",
            activeFill: "rgba(74,127,193,.06)",
            activeStroke: "#4A7FC1",
            preview: "rgba(255,255,255,.82)",
        },
        toolbar: {
            panel: "rgba(255,255,255,.94)",
            border: "rgba(17,24,39,.10)",
            item: "#4b5563",
            itemHover: "rgba(17,24,39,.06)",
            activeBg: "rgba(74,127,193,.12)",
            activeText: "#111827",
        },
        spatial: {
            surface: "rgba(255,255,255,.72)",
            elevated: "rgba(255,255,255,.94)",
            dropzone: "rgba(248,250,252,.78)",
            glow: "transparent",
            glowStrong: "transparent",
            shadow: "rgba(15,23,42,.18)",
        },
        timeline: {
            trackFill: "#f6f8fb",
            trackBorder: "rgba(17,24,39,.08)",
            clipVideo: "rgba(79,110,232,.16)",
            clipAudio: "rgba(16,185,129,.14)",
            clipSubtitle: "rgba(245,158,11,.16)",
            clipSelectedBorder: "#4A7FC1",
            handle: "rgba(255,255,255,.72)",
            rulerTick: "rgba(17,24,39,.28)",
            rulerLabel: "#6b7280",
            playhead: "#4A7FC1",
            entryActive: "rgba(74,127,193,.12)",
            entryHover: "rgba(17,24,39,.05)",
        },
        accent: {
            primary: "#4A7FC1",
            primarySoft: "rgba(74,127,193,.14)",
            onPrimary: "#ffffff",
            danger: "#f87171",
        },
    },
    dark: {
        canvas: {
            // Freezone DNA — align with --toiv-bg (not LibTV #141414 gray slab)
            background: "#0b0c0f",
            dot: "rgba(175,175,175,.18)",
            line: "rgba(175,175,175,.14)",
            selectionFill: "rgba(74,127,193,.14)",
        },
        node: {
            label: "#8b8e98",
            agentUserMessage: "#182b40",
            fill: "rgba(20, 21, 26, 0.92)",
            panel: "#1a1b21",
            stroke: "rgba(255,255,255,.10)",
            edge: "rgba(74,127,193,.32)",
            shadow: "0 10px 28px rgba(0,0,0,.42), inset 0 1px 0 rgba(255,255,255,.07)",
            hoverShadow: "0 14px 36px rgba(0,0,0,.52), 0 0 0 1px rgba(74,127,193,.28), inset 0 1px 0 rgba(255,255,255,.09)",
            activeStroke: "#4A7FC1",
            placeholder: "#8b8e98",
            text: "#f4f6f7",
            muted: "#8b8e98",
            faint: "#4a4b52",
        },
        frame: {
            fill: "rgba(255,255,255,.03)",
            stroke: "rgba(190,198,210,.14)",
            activeFill: "rgba(74,127,193,.08)",
            activeStroke: "#4A7FC1",
            preview: "rgba(11,12,15,.94)",
        },
        toolbar: {
            panel: "rgba(20,21,26,.97)",
            border: "rgba(255,255,255,.1)",
            item: "#a3a6b0",
            itemHover: "rgba(255,255,255,.07)",
            activeBg: "rgba(74,127,193,.14)",
            activeText: "#f4f6f7",
        },
        spatial: {
            surface: "rgba(20,21,26,.84)",
            elevated: "rgba(15,16,22,.97)",
            dropzone: "rgba(8,9,14,.92)",
            glow: "transparent",
            glowStrong: "transparent",
            shadow: "rgba(0,0,0,.6)",
        },
        timeline: {
            trackFill: "#101114",
            trackBorder: "rgba(255,255,255,.08)",
            clipVideo: "rgba(96,126,234,.22)",
            clipAudio: "rgba(16,185,129,.20)",
            clipSubtitle: "rgba(245,158,11,.20)",
            clipSelectedBorder: "#4A7FC1",
            handle: "rgba(255,255,255,.5)",
            rulerTick: "rgba(255,255,255,.26)",
            rulerLabel: "#a3a3a3",
            playhead: "#4A7FC1",
            entryActive: "rgba(74,127,193,.12)",
            entryHover: "rgba(255,255,255,.06)",
        },
        accent: {
            primary: "#4A7FC1",
            primarySoft: "rgba(74,127,193,.16)",
            onPrimary: "#f4f6f7",
            danger: "#B85C5C",
        },
    },
} as const;

export type CanvasTheme = (typeof canvasThemes)[CanvasColorTheme];
