import {
    EDITABLE_COLOR_TOKENS, THEMES, isCssColor,
    type ThemeId, type ThemeTokenKey, type ThemeTokens,
} from "./tokens";
import {
    applyThemeTo, isThemeId, readThemeState, resolveTokens, sanitizeThemeId,
    type ThemeOverrideMap, type ThemeOverrides,
} from "./apply";

export const APPEARANCE_KEY = "toiv_appearance";
export const IMPORT_SCHEMA = "toiv.appearance";
export const IMPORT_VERSION = 2;
export const MAX_CUSTOM_THEMES = 24;
export const MAX_IMPORT_BYTES = 64 * 1024;
export const MAX_THEME_NAME = 40;

export type Density = "compact" | "regular" | "relaxed";
export type RadiusStyle = "square" | "classic" | "round";
export type NavHeight = "compact" | "standard" | "relaxed";
export type ContentWidth = "focus" | "standard" | "wide" | "full";
export type LineHeight = "tight" | "normal" | "loose";
export type TextScale = "sm" | "md" | "lg";
export type MotionPreference = "full" | "reduced" | "system";

export interface LayoutPreferences {
    density: Density;
    radius: RadiusStyle;
    navHeight: NavHeight;
    contentWidth: ContentWidth;
    lineHeight: LineHeight;
    textScale: TextScale;
    motion: MotionPreference;
}

export interface LayoutPreset extends LayoutPreferences {
    id: LayoutPresetId;
    label: string;
}
export type LayoutPresetId = "compact" | "standard" | "relaxed";

export interface CustomTheme {
    id: string;
    name: string;
    base: ThemeId;
    tokens: ThemeOverrides;
    createdAt: string;
}

export interface AppearanceState {
    activeTheme: string;
    overrides: ThemeOverrideMap;
    customThemes: CustomTheme[];
    layout: LayoutPreferences;
}

export interface ResolvedTheme {
    id: string;
    name: string;
    description: string;
    base: ThemeId;
    dark: boolean;
    custom: boolean;
    tokens: ThemeTokens;
    inlineTokens: ThemeOverrides;
}

export interface ImportedAppearance {
    state: AppearanceState;
    theme: CustomTheme;
    appliedLayout: boolean;
}

export const DEFAULT_LAYOUT: LayoutPreferences = {
    density: "regular",
    radius: "classic",
    navHeight: "standard",
    contentWidth: "wide",
    lineHeight: "normal",
    textScale: "md",
    motion: "system",
};

export const LAYOUT_PRESETS: readonly LayoutPreset[] = [
    {
        ...DEFAULT_LAYOUT, id: "compact", label: "紧凑",
        density: "compact", navHeight: "compact", contentWidth: "standard", lineHeight: "tight",
    },
    { ...DEFAULT_LAYOUT, id: "standard", label: "标准" },
    {
        ...DEFAULT_LAYOUT, id: "relaxed", label: "舒展",
        density: "relaxed", radius: "round", navHeight: "relaxed", contentWidth: "full", lineHeight: "loose",
    },
];

const DENSITY_SPACE: Record<Density, string> = { compact: "0.85", regular: "1", relaxed: "1.2" };
const RADIUS: Record<RadiusStyle, readonly [string, string]> = {
    square: ["4px", "3px"],
    classic: ["14px", "10px"],
    round: ["22px", "16px"],
};
const NAV_HEIGHT: Record<NavHeight, string> = { compact: "44px", standard: "48px", relaxed: "56px" };
const CONTENT_MAX: Record<ContentWidth, string> = {
    focus: "1080px", standard: "1280px", wide: "1440px", full: "1680px",
};
const LINE_HEIGHT: Record<LineHeight, string> = { tight: "1.4", normal: "1.5", loose: "1.7" };
const ROOT_FONT: Record<TextScale, string> = { sm: "14.4px", md: "16px", lg: "17.6px" };

const EDITABLE = new Set<string>(EDITABLE_COLOR_TOKENS);

function storage(): Storage | null {
    try {
        return (globalThis as { localStorage?: Storage }).localStorage ?? null;
    } catch {
        return null;
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
    return typeof value === "string" && (allowed as readonly string[]).includes(value) ? value as T : fallback;
}

function newCustomId(): string {
    return `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function uniqueName(taken: readonly string[], desired: string): string {
    if (!taken.includes(desired)) return desired;
    let counter = 2;
    while (taken.includes(`${desired} ${counter}`)) counter += 1;
    return `${desired} ${counter}`;
}

export function sanitizeThemeTokens(input: unknown): ThemeOverrides {
    if (!isRecord(input)) return {};
    const result: ThemeOverrides = {};
    for (const [key, value] of Object.entries(input)) {
        if (!EDITABLE.has(key) || typeof value !== "string") continue;
        const trimmed = value.trim();
        if (isCssColor(trimmed)) result[key as ThemeTokenKey] = trimmed;
    }
    return result;
}

function sanitizeOverridesByTheme(input: unknown): ThemeOverrideMap {
    if (!isRecord(input)) return {};
    const result: ThemeOverrideMap = {};
    for (const [theme, raw] of Object.entries(input)) {
        if (!isThemeId(theme)) continue;
        const tokens = sanitizeThemeTokens(raw);
        if (Object.keys(tokens).length) result[theme] = tokens;
    }
    return result;
}

export function sanitizeLayout(input: unknown): LayoutPreferences {
    const source = isRecord(input) ? input : {};
    return {
        density: pick(source.density, ["compact", "regular", "relaxed"] as const, DEFAULT_LAYOUT.density),
        radius: pick(source.radius, ["square", "classic", "round"] as const, DEFAULT_LAYOUT.radius),
        navHeight: pick(source.navHeight, ["compact", "standard", "relaxed"] as const, DEFAULT_LAYOUT.navHeight),
        contentWidth: pick(source.contentWidth, ["focus", "standard", "wide", "full"] as const, DEFAULT_LAYOUT.contentWidth),
        lineHeight: pick(source.lineHeight, ["tight", "normal", "loose"] as const, DEFAULT_LAYOUT.lineHeight),
        textScale: pick(source.textScale, ["sm", "md", "lg"] as const, DEFAULT_LAYOUT.textScale),
        motion: pick(source.motion, ["full", "reduced", "system"] as const, DEFAULT_LAYOUT.motion),
    };
}

function sanitizeCustomThemes(input: unknown): CustomTheme[] {
    if (!Array.isArray(input)) return [];
    const seen = new Set<string>();
    const result: CustomTheme[] = [];
    for (const raw of input) {
        if (result.length >= MAX_CUSTOM_THEMES) break;
        if (!isRecord(raw)) continue;
        const name = typeof raw.name === "string" ? raw.name.trim().slice(0, MAX_THEME_NAME) : "";
        if (!name) continue;
        let id = typeof raw.id === "string" ? raw.id.trim() : "";
        if (!/^custom-[a-z0-9-]{1,50}$/i.test(id)) id = newCustomId();
        if (seen.has(id)) continue;
        seen.add(id);
        result.push({
            id,
            name,
            base: sanitizeThemeId(raw.base),
            tokens: sanitizeThemeTokens(raw.tokens),
            createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString(),
        });
    }
    return result;
}

export function defaultAppearance(): AppearanceState {
    return { activeTheme: "light", overrides: {}, customThemes: [], layout: { ...DEFAULT_LAYOUT } };
}

export function sanitizeAppearance(input: unknown): AppearanceState {
    const source = isRecord(input) ? input : {};
    const customThemes = sanitizeCustomThemes(source.customThemes);
    const active = typeof source.activeTheme === "string" ? source.activeTheme : "";
    const activeTheme = isThemeId(active) || customThemes.some((theme) => theme.id === active) ? active : "light";
    return {
        activeTheme,
        overrides: sanitizeOverridesByTheme(source.overrides),
        customThemes,
        layout: sanitizeLayout(source.layout),
    };
}

export function readAppearance(): AppearanceState {
    const store = storage();
    if (!store) return defaultAppearance();
    let raw: string | null = null;
    try {
        raw = store.getItem(APPEARANCE_KEY);
    } catch {
        raw = null;
    }
    if (raw) {
        try {
            return sanitizeAppearance(JSON.parse(raw));
        } catch {
            // Fall through to the v1 theme keys.
        }
    }
    const legacy = readThemeState();
    return sanitizeAppearance({ activeTheme: legacy.theme, overrides: legacy.overrides });
}

export function saveAppearance(state: AppearanceState): AppearanceState {
    const safe = sanitizeAppearance(state);
    const store = storage();
    if (store) {
        try {
            store.setItem(APPEARANCE_KEY, JSON.stringify(safe));
        } catch {
            // Storage unavailable: the appearance still applies for this session.
        }
    }
    return safe;
}

export function resolveTheme(state: AppearanceState): ResolvedTheme {
    const custom = state.customThemes.find((theme) => theme.id === state.activeTheme);
    if (custom) {
        const base = THEMES[custom.base];
        return {
            id: custom.id,
            name: custom.name,
            description: `基于「${base.name}」的自定义主题`,
            base: custom.base,
            dark: base.dark,
            custom: true,
            tokens: { ...base.tokens, ...custom.tokens },
            inlineTokens: custom.tokens,
        };
    }
    const id = sanitizeThemeId(state.activeTheme);
    const definition = THEMES[id];
    return {
        id,
        name: definition.name,
        description: definition.description,
        base: id,
        dark: definition.dark,
        custom: false,
        tokens: resolveTokens(id, state.overrides),
        inlineTokens: state.overrides[id] ?? {},
    };
}

export function selectTheme(state: AppearanceState, id: string): AppearanceState {
    const known = isThemeId(id) || state.customThemes.some((theme) => theme.id === id);
    return { ...state, activeTheme: known ? id : "light" };
}

export function editActiveToken(state: AppearanceState, key: ThemeTokenKey, value: string): AppearanceState {
    if (!EDITABLE.has(key)) return state;
    const clean = sanitizeThemeTokens({ [key]: value });
    if (!clean[key]) return state;
    const resolved = resolveTheme(state);
    if (resolved.custom) {
        return {
            ...state,
            customThemes: state.customThemes.map((theme) => theme.id === resolved.id
                ? { ...theme, tokens: { ...theme.tokens, [key]: clean[key] } }
                : theme),
        };
    }
    return {
        ...state,
        overrides: {
            ...state.overrides,
            [resolved.base]: { ...(state.overrides[resolved.base] ?? {}), [key]: clean[key] },
        },
    };
}

export function resetActiveTokens(state: AppearanceState): AppearanceState {
    const resolved = resolveTheme(state);
    if (resolved.custom) {
        return {
            ...state,
            customThemes: state.customThemes.map((theme) => theme.id === resolved.id ? { ...theme, tokens: {} } : theme),
        };
    }
    const overrides: ThemeOverrideMap = { ...state.overrides };
    delete overrides[resolved.base];
    return { ...state, overrides };
}

export function createCustomTheme(state: AppearanceState, name: string): { state: AppearanceState; theme: CustomTheme } {
    if (state.customThemes.length >= MAX_CUSTOM_THEMES) {
        throw new Error(`最多保存 ${MAX_CUSTOM_THEMES} 个自定义主题`);
    }
    const active = resolveTheme(state);
    const desired = name.trim().slice(0, MAX_THEME_NAME) || `${active.name} 副本`;
    const theme: CustomTheme = {
        id: newCustomId(),
        name: uniqueName(state.customThemes.map((item) => item.name), desired),
        base: active.base,
        tokens: { ...active.inlineTokens },
        createdAt: new Date().toISOString(),
    };
    const overrides: ThemeOverrideMap = { ...state.overrides };
    if (!active.custom) delete overrides[active.base];
    return {
        state: { ...state, overrides, customThemes: [...state.customThemes, theme], activeTheme: theme.id },
        theme,
    };
}

export function renameCustomTheme(state: AppearanceState, id: string, name: string): AppearanceState {
    const clean = name.trim().slice(0, MAX_THEME_NAME);
    if (!clean) return state;
    return {
        ...state,
        customThemes: state.customThemes.map((theme) => theme.id === id ? { ...theme, name: clean } : theme),
    };
}

export function deleteCustomTheme(state: AppearanceState, id: string): AppearanceState {
    const theme = state.customThemes.find((item) => item.id === id);
    if (!theme) return state;
    return {
        ...state,
        customThemes: state.customThemes.filter((item) => item.id !== id),
        activeTheme: state.activeTheme === id ? theme.base : state.activeTheme,
    };
}

export function applyLayoutTo(root: HTMLElement, layout: LayoutPreferences): void {
    const safe = sanitizeLayout(layout);
    root.dataset.density = safe.density;
    root.dataset.contentWidth = safe.contentWidth;
    root.dataset.motion = safe.motion;
    root.style.setProperty("--pf-radius", RADIUS[safe.radius][0]);
    root.style.setProperty("--pf-radius-sm", RADIUS[safe.radius][1]);
    root.style.setProperty("--pf-nav-h", NAV_HEIGHT[safe.navHeight]);
    root.style.setProperty("--toiv-content-max", CONTENT_MAX[safe.contentWidth]);
    root.style.setProperty("--toiv-space", DENSITY_SPACE[safe.density]);
    root.style.setProperty("--toiv-line-height", LINE_HEIGHT[safe.lineHeight]);
    root.style.fontSize = ROOT_FONT[safe.textScale];
}

export function applyAppearanceTo(root: HTMLElement, state: AppearanceState): void {
    const resolved = resolveTheme(state);
    applyThemeTo(root, resolved.base, { [resolved.base]: resolved.inlineTokens });
    root.dataset.themeKind = resolved.custom ? "custom" : "builtin";
    applyLayoutTo(root, state.layout);
}

export function applyStoredAppearance(): AppearanceState {
    const state = readAppearance();
    if (typeof document !== "undefined") applyAppearanceTo(document.documentElement, state);
    return state;
}

export function exportAppearance(state: AppearanceState): string {
    const resolved = resolveTheme(state);
    return JSON.stringify({
        schema: IMPORT_SCHEMA,
        version: IMPORT_VERSION,
        exportedAt: new Date().toISOString(),
        theme: { name: resolved.name, base: resolved.base, tokens: resolved.inlineTokens },
        layout: state.layout,
    }, null, 2);
}

export function importAppearance(text: string, state: AppearanceState): ImportedAppearance {
    if (typeof text !== "string" || text.length > MAX_IMPORT_BYTES) {
        throw new Error(`外观文件超过 ${MAX_IMPORT_BYTES / 1024}KB 上限`);
    }
    let payload: unknown;
    try {
        payload = JSON.parse(text);
    } catch {
        throw new Error("不是合法的 JSON 文件");
    }
    if (!isRecord(payload) || payload.schema !== IMPORT_SCHEMA) {
        throw new Error("外观文件 schema 不匹配");
    }
    if (payload.version !== IMPORT_VERSION) {
        throw new Error("外观文件 version 不受支持");
    }
    const theme = isRecord(payload.theme) ? payload.theme : null;
    const name = theme && typeof theme.name === "string" ? theme.name.trim().slice(0, MAX_THEME_NAME) : "";
    if (!theme || !name) throw new Error("外观文件缺少主题名称");
    if (state.customThemes.length >= MAX_CUSTOM_THEMES) {
        throw new Error(`最多保存 ${MAX_CUSTOM_THEMES} 个自定义主题`);
    }
    const imported: CustomTheme = {
        id: newCustomId(),
        name: uniqueName(state.customThemes.map((item) => item.name), name),
        base: sanitizeThemeId(theme.base),
        tokens: sanitizeThemeTokens(theme.tokens),
        createdAt: new Date().toISOString(),
    };
    const appliedLayout = isRecord(payload.layout);
    return {
        state: {
            ...state,
            customThemes: [...state.customThemes, imported],
            activeTheme: imported.id,
            layout: appliedLayout ? sanitizeLayout(payload.layout) : state.layout,
        },
        theme: imported,
        appliedLayout,
    };
}
