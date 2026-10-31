import {
    DEFAULT_THEME, THEMES, THEME_IDS, THEME_TOKEN_KEYS, isHexColor,
    type ThemeId, type ThemeTokenKey, type ThemeTokens,
} from "./tokens";

export const THEME_KEY = "toiv_theme";
export const OVERRIDES_KEY = "toiv_theme_overrides";

export type ThemeOverrides = Partial<ThemeTokens>;
export type ThemeOverrideMap = Partial<Record<ThemeId, ThemeOverrides>>;

export interface ThemeState {
    theme: ThemeId;
    overrides: ThemeOverrideMap;
}

function storage(): Storage | null {
    try {
        return (globalThis as { localStorage?: Storage }).localStorage ?? null;
    } catch {
        return null;
    }
}

export function isThemeId(value: unknown): value is ThemeId {
    return typeof value === "string" && (THEME_IDS as readonly string[]).includes(value);
}

export function sanitizeThemeId(value: unknown): ThemeId {
    return isThemeId(value) ? value : DEFAULT_THEME;
}

function isThemeTokenKey(value: string): value is ThemeTokenKey {
    return (THEME_TOKEN_KEYS as readonly string[]).includes(value);
}

export function sanitizeOverrides(input: unknown): ThemeOverrideMap {
    if (!input || typeof input !== "object" || Array.isArray(input)) return {};
    const result: ThemeOverrideMap = {};
    for (const [theme, raw] of Object.entries(input as Record<string, unknown>)) {
        if (!isThemeId(theme) || !raw || typeof raw !== "object" || Array.isArray(raw)) continue;
        const tokens: ThemeOverrides = {};
        for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
            if (isThemeTokenKey(key) && typeof value === "string" && isHexColor(value)) tokens[key] = value.trim();
        }
        if (Object.keys(tokens).length) result[theme] = tokens;
    }
    return result;
}

export function readThemeState(): ThemeState {
    const store = storage();
    if (!store) return { theme: DEFAULT_THEME, overrides: {} };
    let theme: ThemeId = DEFAULT_THEME;
    let overrides: ThemeOverrideMap = {};
    try {
        theme = sanitizeThemeId(store.getItem(THEME_KEY));
    } catch {
        theme = DEFAULT_THEME;
    }
    try {
        const raw = store.getItem(OVERRIDES_KEY);
        overrides = raw ? sanitizeOverrides(JSON.parse(raw)) : {};
    } catch {
        overrides = {};
    }
    return { theme, overrides };
}

export function saveThemeState(theme: ThemeId, overrides: ThemeOverrideMap): ThemeState {
    const safeTheme = sanitizeThemeId(theme);
    const safeOverrides = sanitizeOverrides(overrides);
    const store = storage();
    if (store) {
        try {
            store.setItem(THEME_KEY, safeTheme);
            if (Object.keys(safeOverrides).length) store.setItem(OVERRIDES_KEY, JSON.stringify(safeOverrides));
            else store.removeItem(OVERRIDES_KEY);
        } catch {
            // Storage unavailable: the palette still applies for this session.
        }
    }
    return { theme: safeTheme, overrides: safeOverrides };
}

export function resolveTokens(theme: ThemeId, overrides: ThemeOverrideMap): ThemeTokens {
    const safeTheme = sanitizeThemeId(theme);
    return { ...THEMES[safeTheme].tokens, ...(overrides[safeTheme] ?? {}) };
}

export function applyThemeTo(root: HTMLElement, theme: ThemeId, overrides: ThemeOverrideMap): void {
    const safeTheme = sanitizeThemeId(theme);
    root.dataset.theme = safeTheme;
    root.style.colorScheme = THEMES[safeTheme].dark ? "dark" : "light";
    for (const key of THEME_TOKEN_KEYS) root.style.removeProperty(key);
    const custom = sanitizeOverrides({ [safeTheme]: overrides[safeTheme] })[safeTheme] ?? {};
    for (const [key, value] of Object.entries(custom)) root.style.setProperty(key, value);
}

export function applyThemeState(theme: ThemeId, overrides: ThemeOverrideMap): ThemeId {
    const safeTheme = sanitizeThemeId(theme);
    if (typeof document !== "undefined") applyThemeTo(document.documentElement, safeTheme, overrides);
    return safeTheme;
}

export function applyStoredTheme(): ThemeId {
    const state = readThemeState();
    return applyThemeState(state.theme, state.overrides);
}
