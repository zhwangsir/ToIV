export type CanvasColorTheme = "light" | "dark";
export type CanvasBackgroundMode = "dots" | "lines" | "blank";

/**
 * Canvas theme — R5 Freezone glass / accent select.
 * Selection + ports + edges use accent `#5ba0ff` (R1 `--toiv-accent`).
 * Adult `#4f8cff` is reserved for light-curtain / director — never node select.
 */
export const canvasThemes = {
    light: {
        canvas: {
            background: "#f0f0f0",
            dot: "rgba(0,0,0,.80)",
            line: "rgba(0,0,0,.80)",
            selectionFill: "rgba(91,160,255,.12)",
        },
        node: {
            label: "#4b5563",
            agentUserMessage: "#edf6ff",
            fill: "#ffffff",
            panel: "#ffffff",
            stroke: "#e2e4e8",
            edge: "rgba(91,160,255,.28)",
            shadow: "0 6px 18px rgba(15,23,42,.08), inset 0 1px 0 rgba(255,255,255,.8)",
            hoverShadow: "0 10px 24px rgba(15,23,42,.12), 0 0 0 1px rgba(91,160,255,.28)",
            activeStroke: "#5ba0ff",
            placeholder: "#9ca3af",
            text: "#111827",
            muted: "#6b7280",
            faint: "#9ca3af",
        },
        frame: {
            fill: "rgba(17,24,39,.025)",
            stroke: "rgba(17,24,39,.18)",
            activeFill: "rgba(91,160,255,.06)",
            activeStroke: "#5ba0ff",
            preview: "rgba(255,255,255,.82)",
        },
        toolbar: {
            panel: "rgba(255,255,255,.94)",
            border: "rgba(17,24,39,.10)",
            item: "#4b5563",
            itemHover: "rgba(17,24,39,.06)",
            activeBg: "rgba(91,160,255,.12)",
            activeText: "#111827",
        },
        spatial: {
            surface: "rgba(255,255,255,.72)",
            elevated: "rgba(255,255,255,.94)",
            dropzone: "rgba(248,250,252,.78)",
            glow: "rgba(91,160,255,.18)",
            glowStrong: "rgba(91,160,255,.36)",
            shadow: "rgba(15,23,42,.18)",
        },
        timeline: {
            trackFill: "#f6f8fb",
            trackBorder: "rgba(17,24,39,.08)",
            clipVideo: "rgba(79,110,232,.16)",
            clipAudio: "rgba(16,185,129,.14)",
            clipSubtitle: "rgba(245,158,11,.16)",
            clipSelectedBorder: "#5ba0ff",
            handle: "rgba(255,255,255,.72)",
            rulerTick: "rgba(17,24,39,.28)",
            rulerLabel: "#6b7280",
            playhead: "#5ba0ff",
            entryActive: "rgba(91,160,255,.12)",
            entryHover: "rgba(17,24,39,.05)",
        },
        accent: {
            primary: "#5ba0ff",
            primarySoft: "rgba(91,160,255,.14)",
            onPrimary: "#ffffff",
            danger: "#f87171",
        },
    },
    dark: {
        canvas: {
            // Freezone DNA — align with --toiv-bg (not LibTV #141414 gray slab)
            background: "#0a0c12",
            dot: "rgba(175,175,175,.18)",
            line: "rgba(175,175,175,.14)",
            selectionFill: "rgba(91,160,255,.14)",
        },
        node: {
            label: "#6f7079",
            agentUserMessage: "#182b40",
            fill: "rgba(21, 22, 29, 0.92)",
            panel: "#1b1c23",
            stroke: "#22232c",
            edge: "rgba(91,160,255,.32)",
            shadow: "0 10px 28px rgba(0,0,0,.42), inset 0 1px 0 rgba(255,255,255,.07)",
            hoverShadow: "0 14px 36px rgba(0,0,0,.52), 0 0 0 1px rgba(91,160,255,.28), inset 0 1px 0 rgba(255,255,255,.09)",
            activeStroke: "#5ba0ff",
            placeholder: "#6f7079",
            text: "#e8eaf0",
            muted: "#6f7079",
            faint: "#4a4b52",
        },
        frame: {
            fill: "rgba(255,255,255,.03)",
            stroke: "rgba(190,198,210,.14)",
            activeFill: "rgba(91,160,255,.08)",
            activeStroke: "#5ba0ff",
            preview: "rgba(10,12,18,.94)",
        },
        toolbar: {
            panel: "rgba(21,22,29,.97)",
            border: "rgba(255,255,255,.1)",
            item: "#c8cad3",
            itemHover: "rgba(255,255,255,.07)",
            activeBg: "rgba(91,160,255,.14)",
            activeText: "#e8eaf0",
        },
        spatial: {
            surface: "rgba(21,22,29,.84)",
            elevated: "rgba(15,16,22,.97)",
            dropzone: "rgba(8,9,14,.92)",
            glow: "rgba(91,160,255,.16)",
            glowStrong: "rgba(91,160,255,.34)",
            shadow: "rgba(0,0,0,.6)",
        },
        timeline: {
            trackFill: "#101114",
            trackBorder: "rgba(255,255,255,.08)",
            clipVideo: "rgba(96,126,234,.22)",
            clipAudio: "rgba(16,185,129,.20)",
            clipSubtitle: "rgba(245,158,11,.20)",
            clipSelectedBorder: "#5ba0ff",
            handle: "rgba(255,255,255,.5)",
            rulerTick: "rgba(255,255,255,.26)",
            rulerLabel: "#a3a3a3",
            playhead: "#5ba0ff",
            entryActive: "rgba(91,160,255,.12)",
            entryHover: "rgba(255,255,255,.06)",
        },
        accent: {
            primary: "#5ba0ff",
            primarySoft: "rgba(91,160,255,.16)",
            onPrimary: "#0a0c12",
            danger: "#ea4335",
        },
    },
} as const;

export type CanvasTheme = (typeof canvasThemes)[CanvasColorTheme];
