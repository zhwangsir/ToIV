export const THEME_IDS = ["light", "aurora", "black", "cyber"] as const;
export type ThemeId = (typeof THEME_IDS)[number];

export const THEME_TOKEN_KEYS = [
    "--pf-bg",
    "--pf-card",
    "--pf-ink",
    "--pf-muted",
    "--pf-line",
    "--pf-lime",
    "--pf-lime-soft",
    "--pf-shadow",
    "--text-secondary",
    "--bg-canvas",
    "--grid-color",
    "--node-border-selected",
    "--toiv-danger",
    "--toiv-success",
    "--toiv-warning",
    "--toiv-info",
    "--toiv-scrim",
    "--toiv-shadow-float",
] as const;
export type ThemeTokenKey = (typeof THEME_TOKEN_KEYS)[number];
export type ThemeTokens = Record<ThemeTokenKey, string>;

export interface ThemeDefinition {
    id: ThemeId;
    name: string;
    description: string;
    dark: boolean;
    tokens: ThemeTokens;
}

export const DEFAULT_THEME: ThemeId = "light";

export const THEMES: Record<ThemeId, ThemeDefinition> = {
    light: {
        id: "light",
        name: "浅色清爽",
        description: "纸张底与薄荷绿，适合白天长时段创作。",
        dark: false,
        tokens: {
            "--pf-bg": "#f7f8fa",
            "--pf-card": "#ffffff",
            "--pf-ink": "#111318",
            "--pf-muted": "#5b6778",
            "--pf-line": "rgba(17, 19, 24, 0.1)",
            "--pf-lime": "#b6ff00",
            "--pf-lime-soft": "#eefcc8",
            "--pf-shadow": "0 8px 28px rgba(17, 19, 24, 0.06)",
            "--text-secondary": "#4b5563",
            "--bg-canvas": "#eef0f3",
            "--grid-color": "rgba(17, 19, 24, 0.08)",
            "--node-border-selected": "#111318",
            "--toiv-danger": "#b42318",
            "--toiv-success": "#0f766e",
            "--toiv-warning": "#b45309",
            "--toiv-info": "#1d4ed8",
            "--toiv-scrim": "rgba(17, 19, 24, 0.5)",
            "--toiv-shadow-float": "0 18px 48px rgba(17, 19, 24, 0.18)",
        },
    },
    aurora: {
        id: "aurora",
        name: "极光深色",
        description: "深蓝夜幕与极光绿，画布主体更聚焦。",
        dark: true,
        tokens: {
            "--pf-bg": "#0b1020",
            "--pf-card": "#121a2b",
            "--pf-ink": "#e8eef2",
            "--pf-muted": "#9fb0c4",
            "--pf-line": "rgba(148, 163, 184, 0.2)",
            "--pf-lime": "#b6ff00",
            "--pf-lime-soft": "#26371a",
            "--pf-shadow": "0 8px 28px rgba(0, 0, 0, 0.45)",
            "--text-secondary": "#a9b8c9",
            "--bg-canvas": "#070b16",
            "--grid-color": "rgba(148, 163, 184, 0.16)",
            "--node-border-selected": "#b6ff00",
            "--toiv-danger": "#ff8a8a",
            "--toiv-success": "#4ade80",
            "--toiv-warning": "#fbbf24",
            "--toiv-info": "#60a5fa",
            "--toiv-scrim": "rgba(2, 6, 23, 0.68)",
            "--toiv-shadow-float": "0 18px 48px rgba(0, 0, 0, 0.55)",
        },
    },
    black: {
        id: "black",
        name: "纯黑极简",
        description: "纯黑底与荧光黄，降低夜间眩光。",
        dark: true,
        tokens: {
            "--pf-bg": "#000000",
            "--pf-card": "#0b0b0b",
            "--pf-ink": "#f5f5f5",
            "--pf-muted": "#a3a3a3",
            "--pf-line": "rgba(255, 255, 255, 0.14)",
            "--pf-lime": "#d4ff4d",
            "--pf-lime-soft": "#232b0d",
            "--pf-shadow": "0 8px 28px rgba(0, 0, 0, 0.6)",
            "--text-secondary": "#bdbdbd",
            "--bg-canvas": "#000000",
            "--grid-color": "rgba(255, 255, 255, 0.09)",
            "--node-border-selected": "#ffffff",
            "--toiv-danger": "#ff7a7a",
            "--toiv-success": "#6ee7b7",
            "--toiv-warning": "#fbbf24",
            "--toiv-info": "#93c5fd",
            "--toiv-scrim": "rgba(0, 0, 0, 0.72)",
            "--toiv-shadow-float": "0 18px 48px rgba(0, 0, 0, 0.7)",
        },
    },
    cyber: {
        id: "cyber",
        name: "赛博霓虹",
        description: "紫黑底色与青粉霓虹，强风格化的夜场。",
        dark: true,
        tokens: {
            "--pf-bg": "#070312",
            "--pf-card": "#120824",
            "--pf-ink": "#f2e9ff",
            "--pf-muted": "#b3a0d6",
            "--pf-line": "rgba(180, 120, 255, 0.24)",
            "--pf-lime": "#21f3ff",
            "--pf-lime-soft": "#123043",
            "--pf-shadow": "0 8px 32px rgba(33, 243, 255, 0.12)",
            "--text-secondary": "#c9b6e8",
            "--bg-canvas": "#05010d",
            "--grid-color": "rgba(33, 243, 255, 0.18)",
            "--node-border-selected": "#ff2bd6",
            "--toiv-danger": "#ff4d6d",
            "--toiv-success": "#39ff88",
            "--toiv-warning": "#ffd166",
            "--toiv-info": "#21f3ff",
            "--toiv-scrim": "rgba(3, 0, 12, 0.72)",
            "--toiv-shadow-float": "0 18px 48px rgba(255, 43, 214, 0.22)",
        },
    },
};

export const EDITABLE_TOKENS = [
    { key: "--pf-lime", label: "主色" },
    { key: "--pf-bg", label: "背景" },
    { key: "--pf-card", label: "卡片" },
    { key: "--pf-ink", label: "文字" },
    { key: "--text-secondary", label: "次要文字" },
    { key: "--bg-canvas", label: "画布" },
] as const satisfies readonly { key: ThemeTokenKey; label: string }[];

export function isHexColor(value: string): boolean {
    return /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value.trim());
}

function hexToRgb(value: string): [number, number, number] | null {
    const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
    if (!match) return null;
    const raw = match[1].length === 3
        ? match[1].split("").map((char) => char + char).join("")
        : match[1];
    return [parseInt(raw.slice(0, 2), 16), parseInt(raw.slice(2, 4), 16), parseInt(raw.slice(4, 6), 16)];
}

function relativeLuminance([red, green, blue]: [number, number, number]): number {
    const channel = (value: number) => {
        const scaled = value / 255;
        return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue);
}

export function contrastRatio(foreground: string, background: string): number {
    const left = hexToRgb(foreground);
    const right = hexToRgb(background);
    if (!left || !right) return 1;
    const [lighter, darker] = [relativeLuminance(left), relativeLuminance(right)].sort((a, b) => b - a);
    return (lighter + 0.05) / (darker + 0.05);
}
